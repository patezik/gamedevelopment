import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Personality } from '../characters/index.ts';
import { answer, KnowledgeStore, type Belief, type Question } from '../knowledge/index.ts';
import { createRng } from '../rng/index.ts';
import { renderTemplate, renderTestimony } from '../text/index.ts';
import type { Proposition, PropositionPattern } from '../truth/index.ts';
import { createContentRepo, type ScenarioContent } from './index.ts';

const root = fileURLToPath(new URL('../../../../content/scenarios/', import.meta.url));
const content: ScenarioContent = createContentRepo(root).load('sanatorium_winter');
const ru = content.text['ru'] ?? {};
const keys = new Map<string, readonly string[]>(
  Object.values(ru).flatMap((file) => Object.entries(file)),
);

const speakerId = 'ch_a';
const otherId = 'ch_b';
const place = 'loc_hall';
const span = { from: 0, to: 60 };
const beliefOf = (proposition: Proposition): Belief => ({
  proposition,
  confidence: 1,
  source: 'observed',
  acquiredAt: 0,
  fuzzMinutes: 0,
});

/** One belief per proposition kind, for the speaker and for another character. */
const knowledge = new KnowledgeStore();
for (const who of [speakerId, otherId]) {
  const self = { kind: 'character', id: who } as const;
  for (const proposition of [
    { kind: 'at', who, where: place, interval: span },
    { kind: 'did', who, verb: 'take', at: 10, where: place },
    { kind: 'possessed', who, item: 'it_key', interval: span },
    { kind: 'relation', a: who, b: who === speakerId ? otherId : speakerId, relType: 'friend' },
    { kind: 'motive', who, against: 'ch_c', motiveType: 'envy', basis: [] },
    { kind: 'state', entity: self, property: 'mood', value: 'calm', interval: span },
  ] satisfies Proposition[])
    knowledge.add(beliefOf(proposition));
}
const everyKind: readonly PropositionPattern[] = [
  { kind: 'at' },
  { kind: 'did' },
  { kind: 'possessed' },
  { kind: 'relation' },
  { kind: 'motive' },
  { kind: 'state' },
];
const questions = [
  { type: 'whereWereYou', interval: span },
  { type: 'whatDoYouKnowAbout', characterId: speakerId },
  { type: 'whatIsThis', clue: { id: 'cl_1', subjects: everyKind } },
  { type: 'aboutYourself' },
  { type: 'sawAnything', interval: span, location: place },
] as const satisfies readonly Question[];
// Keep the list exhaustive: a new question type fails type checking here.
const _exhaustive: Record<Question['type'], true> = {
  whereWereYou: true,
  whatDoYouKnowAbout: true,
  whatIsThis: true,
  aboutYourself: true,
  sawAnything: true,
};
void _exhaustive;

/** Statement keys the knowledge module really builds, with topic and proposition kind. */
const emitted = questions.flatMap((question) =>
  answer(question, {
    character: { id: speakerId, personality: { honesty: 1, courage: 1 } as Personality },
    knowledge,
    policy: { conceal: [], fabricate: [] },
    now: 100,
  }).map(({ templateKey, proposition }) => ({
    key: templateKey,
    kind: proposition.kind,
  })),
);
const testimonyKeys = [...new Set(emitted.map(({ key }) => key))];

/** Placeholders the future template engine must supply, per proposition kind. */
const speaker = ['who', 'who_f', 'me_f'];
const testimonyPlaceholders: Record<Proposition['kind'], string[]> = {
  at: [...speaker, 'where', 'from', 'to'],
  did: [...speaker, 'where', 'time', 'action'],
  possessed: [...speaker, 'item', 'from', 'to'],
  relation: [...speaker, 'a', 'b', 'relation'],
  motive: [...speaker, 'against', 'motive'],
  state: [...speaker, 'subject', 'state', 'from', 'to'],
};
const fixedTestimonyKeys = [
  'testimony_unknown',
  'testimony_evasion',
  'rebuttal_admit',
  'rebuttal_change',
  'rebuttal_refuse',
];
const reactionKeys = ['present_clue', 'present_document', 'accusation'].flatMap((name) =>
  ['calm', 'nervous', 'hostile'].map((tone) => `reaction_${name}_${tone}`),
);
const speakerOnly = [...speaker];

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1] ?? '');
}

function variants(key: string): readonly string[] {
  const found = keys.get(key);
  expect(found, `missing template key ${key}`).toBeDefined();
  return found ?? [];
}

describe('RU text templates of sanatorium_winter', () => {
  it('renders a loaded testimony template deterministically', () => {
    const key = 'testimony_whereWereYou_at';
    const values = { where: 'Холл', from: '09:00', to: '10:00', me_f: 'а' };
    const render = () => renderTemplate(keys, key, values, createRng('testimony'));
    const result = render();
    expect(result).toBe(render());
    expect(result).toContain('«Холл»');
    expect(result).toContain('09:00');
    expect(result).toContain('10:00');
    expect(result).not.toMatch(/[{}]/);
    expect(() => renderTemplate(keys, key, {}, createRng('testimony'))).toThrow(key);
    expect(() => renderTemplate(keys, 'missing', values, createRng('testimony'))).toThrow(
      'missing',
    );
  });

  it('define every key only once', () => {
    const all = Object.values(ru).flatMap((file) => Object.keys(file));
    expect(new Set(all).size).toBe(all.length);
  });

  it('chooses testimony variants according to the speaker personality', () => {
    const key = 'testimony_whereWereYou_at';
    const values = { where: 'Холл', from: '09:00', to: '10:00', me_f: 'а' };
    const source = variants(key);
    const profiles = [
      { agreeableness: 0.8, neuroticism: 0.2 },
      { agreeableness: 0.8, neuroticism: 0.8 },
      { agreeableness: 0.2, neuroticism: 0.8 },
    ];
    const expected = source.map((variant) =>
      renderTemplate(new Map([[key, [variant]]]), key, values, createRng('single')),
    );
    for (const [index, profile] of profiles.entries()) {
      const rng = createRng('tone');
      const actual = new Set(
        Array.from({ length: 24 }, () => renderTestimony(keys, key, values, rng, profile)),
      );
      expect(actual).toEqual(new Set([expected[0], expected[index + 1]]));
    }
    const testimony = ru['testimony'] ?? ru['testimony.json'];
    expect(testimony).toBeDefined();
    for (const [name, list] of Object.entries(testimony ?? {})) {
      expect(list, name).toHaveLength(4);
    }
  });

  it('covers every location and hotspot with its canonical description and alternatives', () => {
    for (const location of content.locations) {
      for (const place of [location, ...location.hotspots]) {
        const texts = variants(place.id);
        expect(texts[0], place.id).toBe(place.description);
        expect(texts.length, place.id).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('cover every trace template used by trace rules', () => {
    const used = new Set(
      content.traceRules.flatMap(({ produces }) => produces.map(({ template }) => template)),
    );
    expect(used.size).toBeGreaterThan(0);
    for (const key of used) variants(key);
  });

  it('cover every relationship secret template', () => {
    const used = new Set(
      content.relationships.flatMap(({ secrets = [] }) => secrets.map(({ template }) => template)),
    );
    expect(used.size).toBeGreaterThan(0);
    for (const key of used) variants(key);
  });

  it('cover every testimony key built by the knowledge module', () => {
    expect(testimonyKeys.length).toBeGreaterThan(questions.length);
    for (const key of testimonyKeys) variants(key);
    for (const key of [...fixedTestimonyKeys, ...reactionKeys]) variants(key);
  });

  it('give each key at least three distinct, non-empty variants', () => {
    expect(keys.size).toBeGreaterThan(0);
    for (const [key, list] of keys) {
      expect(list.length, key).toBeGreaterThanOrEqual(3);
      expect(new Set(list).size, `${key} has duplicates`).toBe(list.length);
      for (const text of list) {
        expect(text, key).toBe(text.trim());
        expect(text.length, key).toBeGreaterThan(10);
        expect(text, key).toMatch(/[А-Яа-яЁё]/);
      }
    }
  });

  it('use only placeholders the engine is documented to supply', () => {
    for (const { key, kind } of emitted) {
      for (const text of variants(key)) {
        for (const name of placeholders(text)) {
          expect(testimonyPlaceholders[kind], `${key}: {${name}}`).toContain(name);
        }
      }
    }
    for (const key of [...fixedTestimonyKeys, ...reactionKeys]) {
      for (const text of variants(key)) {
        for (const name of placeholders(text))
          expect(speakerOnly, `${key}: {${name}}`).toContain(name);
      }
    }
    for (const rule of content.traceRules) {
      for (const { template } of rule.produces) {
        for (const text of variants(template)) expect(placeholders(text), template).toEqual([]);
      }
    }
    for (const [key, list] of keys) {
      if (!key.startsWith('secret_')) continue;
      for (const text of list) {
        for (const name of placeholders(text)) {
          expect(['a', 'b', 'a_f', 'b_f'], `${key}: {${name}}`).toContain(name);
        }
      }
    }
    for (const [key, list] of keys) {
      for (const text of list) {
        expect(text.replace(/\{[^{}]*\}/g, ''), `${key}: stray brace`).not.toMatch(/[{}]/);
      }
    }
  });

  it('do not reveal the solution or the truth of a statement', () => {
    for (const [key, list] of keys) {
      for (const text of list) {
        expect(text, key).not.toMatch(/убийц|виновн|преступни|подозреваем/i);
        if (key.startsWith('testimony_') || key.startsWith('rebuttal_')) {
          expect(text, key).not.toMatch(/\bлож|лжив|врал|солгал|ошибся|ошибочн/i);
        }
      }
    }
  });
});
