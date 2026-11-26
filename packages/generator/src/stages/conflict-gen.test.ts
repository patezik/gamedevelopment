import { fileURLToPath } from 'node:url';
import { RelationshipGraph, type Character, type RelationType } from '@hs/core/characters';
import { PERSONALITY_TRAITS } from '@hs/core/common';
import { loadScenarioFromDir, type ScenarioContent } from '@hs/core/content';
import { GameEngine, InvestigationBuilder } from '@hs/core/game';
import { createRng } from '@hs/core/rng';
import {
  checkTruthInvariants,
  factId,
  TruthLog,
  TruthModel,
  type Fact,
  type TruthEvent,
} from '@hs/core/truth';
import { describe, expect, test } from 'vitest';
import {
  castGen,
  conflictGen,
  MOTIVE_EVENT_VERB,
  MOTIVE_HISTOGRAM_BINS,
  motiveFact,
  runPipeline,
  socialGen,
  worldGen,
  type ConflictWorld,
  type MotiveCandidate,
  type SocialSecret,
  type SocialWorld,
} from '../index.ts';

const content = loadScenarioFromDir(
  fileURLToPath(new URL('../../../../content/scenarios/sanatorium_winter/', import.meta.url)),
);
const silent = { debug() {} };
type Rule = ScenarioContent['motives'][number];
type Personality = Character['personality'];

function sanatorium(seed: string): ConflictWorld {
  const result = runPipeline([castGen, socialGen, conflictGen], undefined, {
    seed,
    content,
    now: () => 0,
  });
  if (!result.ok) throw new Error('Expected generation to succeed');
  return result.output;
}

function conflicts(world: SocialWorld, motives: readonly Rule[], minMotive = 0.4, seed = 'x') {
  const scenario: ScenarioContent = {
    ...content,
    motives: [...motives],
    preset: { ...content.preset, incident: { ...content.preset.incident, minMotive } },
  };
  const rng = createRng(seed).fork('gen/ConflictGen');
  return conflictGen.generate(world, { rng, content: scenario, logger: silent });
}

const castTemplate = sanatorium('cast').characters[0]!;
const neutral = Object.fromEntries(PERSONALITY_TRAITS.map((trait) => [trait, 0.5])) as Personality;

function person(id: string, traits: Partial<Personality> = {}): Character {
  return { ...castTemplate, id, secrets: [], personality: { ...neutral, ...traits } };
}

interface FixtureRelation {
  readonly a: string;
  readonly b: string;
  readonly type: RelationType;
}
interface FixtureSecret {
  readonly about: string;
  readonly kind: string;
  readonly knownBy: readonly string[];
}

/** A hand-built SocialWorld in the SocialGen shape: every relation and secret is a history fact. */
function fixture(
  characters: readonly Character[],
  relations: readonly FixtureRelation[],
  secrets: readonly FixtureSecret[] = [],
): SocialWorld {
  const log = new TruthLog();
  const base = { duration: 0, actorIds: [], location: 'loc_lobby', causes: [], traceIds: [] };
  const relationEvents = relations.map(({ a, b, type }, index) =>
    log.append({
      ...base,
      t: -10_000 + index,
      verb: 'form_relationship',
      targets: [],
      facts: [{ kind: 'relation', a, b, relType: type, since: -10_000 + index }],
      visibility: 'private',
    }),
  );
  const socialSecrets = secrets.map(({ about, kind, knownBy }, index): SocialSecret => {
    const fact: Fact = {
      kind: 'state',
      entity: { kind: 'character', id: about },
      property: kind,
      value: true,
      interval: { from: -5_000 + index, to: 0 },
    };
    log.append({
      ...base,
      t: -5_000 + index,
      verb: 'keep_secret',
      targets: [{ kind: 'character', id: about }],
      facts: [fact],
      visibility: 'covert',
    });
    return {
      id: `sec_${index + 1}`,
      fact,
      knownBy: [...knownBy].sort(),
      kind,
      template: `t_${kind}`,
      about,
      origin: { templateId: 'fixture', a: about, b: knownBy[0]!, type: 'friendship' },
    };
  });
  return {
    characters: characters.map((character) => ({
      ...character,
      secrets: socialSecrets.filter(({ about }) => about === character.id).map(({ id }) => id),
    })),
    relationships: new RelationshipGraph(
      relations.map(({ a, b, type }, index) => ({
        a,
        b,
        type,
        trust: 0,
        valence: 0.5,
        intensity: 0.5,
        history: [relationEvents[index]!.id],
      })),
    ),
    secrets: socialSecrets,
    history: log.inAppendOrder(),
  };
}

const relationFact = (a: string, b: string, relType: RelationType, index: number) =>
  factId({ kind: 'relation', a, b, relType, since: -10_000 + index });
const secretFact = (world: SocialWorld, about: string, kind: string) =>
  factId(world.secrets.find((secret) => secret.about === about && secret.kind === kind)!.fact);

/**
 * motives.json on main, before CNT-003, frozen here: these fixture tests pin ConflictGen's reading
 * of a known rule set, so tuning the scenario data must not change them.
 */
const fixtureRules: Rule[] = [
  {
    id: 'inheritance',
    when: {
      relation: { type: 'child', from: '$c', to: '$v' },
      secret: { kind: 'will_changed', about: '$v', knownBy: '$c' },
    },
    strength: { base: 0.5, plus: [{ if: { trait: '$c.honesty', lt: 0.4 }, add: 0.2 }] },
    evidenceHints: ['will_document', 'notary_letter'],
  },
  {
    id: 'blackmail',
    when: {
      relation: { type: 'blackmail', from: '$v', to: '$c' },
      secret: { kind: 'blackmail_material', about: '$c', knownBy: '$v' },
    },
    strength: { base: 0.55, plus: [{ if: { trait: '$c.neuroticism', gt: 0.6 }, add: 0.15 }] },
    evidenceHints: ['blackmail_note', 'bank_transfer'],
  },
  {
    id: 'jealousy',
    when: {
      relation: { type: 'spouse', from: '$c', to: '$v' },
      secret: { kind: 'affair', about: '$v', knownBy: '$c' },
    },
    strength: { base: 0.45, plus: [{ if: { trait: '$c.impulsivity', gt: 0.6 }, add: 0.2 }] },
    evidenceHints: ['love_letter', 'phone_messages'],
  },
  {
    id: 'revenge',
    when: {
      relation: { type: 'past_conflict', from: '$c', to: '$v' },
      secret: { kind: 'hit_and_run', about: '$v', knownBy: '$c' },
    },
    strength: { base: 0.5, plus: [{ if: { trait: '$c.agreeableness', lt: 0.3 }, add: 0.2 }] },
    evidenceHints: ['old_newspaper', 'accident_report'],
  },
  {
    id: 'malpractice_coverup',
    when: { secret: { kind: 'malpractice', about: '$c', knownBy: '$v' } },
    strength: { base: 0.5, plus: [{ if: { trait: '$c.honesty', lt: 0.4 }, add: 0.15 }] },
    evidenceHints: ['medical_record_gap', 'archive_missing_folder'],
  },
];

/** The CNT-003 (#58) shape: inheritance written from the parent's side. */
const parentSideInheritance: Rule = {
  id: 'inheritance',
  when: {
    relation: { type: 'parent', from: '$v', to: '$c' },
    secret: { kind: 'will_changed', about: '$v', knownBy: '$c' },
  },
  strength: { base: 0.45, plus: [{ if: { trait: '$c.honesty', lt: 0.4 }, add: 0.2 }] },
  evidenceHints: ['will_document'],
};

/** Checks that every candidate cites real history facts and owns exactly its motive fact. */
function expectTruthBacked(world: ConflictWorld, threshold: number) {
  const events = new Map(world.history.map((event) => [event.id, event]));
  const facts = new Map<string, { fact: Fact; event: TruthEvent }>();
  for (const event of world.history) {
    for (const fact of event.facts) facts.set(factId(fact), { fact, event });
  }
  const motiveEvents = world.history.filter(({ verb }) => verb === MOTIVE_EVENT_VERB);
  expect(motiveEvents).toHaveLength(world.motives.filter((m) => m.strength >= threshold).length);
  for (const candidate of world.motives) {
    expect(candidate.who).not.toBe(candidate.against);
    expect(candidate.basis.length).toBeGreaterThan(0);
    expect(candidate.basis).toEqual([...new Set(candidate.basis)].sort());
    for (const id of candidate.basis) {
      const source = facts.get(id);
      expect(source, `basis ${id} of ${candidate.motiveType}`).toBeDefined();
      expect(['relation', 'state']).toContain(source!.fact.kind);
      const fact = source!.fact;
      if (fact.kind === 'relation') {
        expect([fact.a, fact.b].sort()).toEqual([candidate.who, candidate.against].sort());
      } else if (fact.kind === 'state') {
        expect([candidate.who, candidate.against]).toContain(fact.entity.id);
      }
    }
    const motive = facts.get(factId(motiveFact(candidate)));
    if (candidate.strength < threshold) {
      expect(motive).toBeUndefined();
      continue;
    }
    expect(motive!.fact).toEqual(motiveFact(candidate));
    const { event } = motive!;
    expect(event).toMatchObject({ verb: MOTIVE_EVENT_VERB, visibility: 'private', actorIds: [] });
    const causes = event.causes.map((id) => events.get(id)!);
    expect(new Set(causes.flatMap((cause) => cause.facts.map(factId)))).toEqual(
      new Set(candidate.basis),
    );
    for (const cause of causes) expect(cause.t + cause.duration).toBeLessThanOrEqual(event.t);
  }
}

describe('ConflictGen on a hand-built fixture', () => {
  const cast = [
    person('ch_child', { honesty: 0.3 }),
    person('ch_parent'),
    person('ch_victim', { neuroticism: 0.7 }),
    person('ch_spouse_a', { impulsivity: 0.9 }),
    person('ch_spouse_b'),
    person('ch_doctor', { honesty: 0.2 }),
  ];
  const relations: FixtureRelation[] = [
    { a: 'ch_parent', b: 'ch_child', type: 'parent' },
    { a: 'ch_parent', b: 'ch_victim', type: 'blackmail' },
    { a: 'ch_spouse_a', b: 'ch_spouse_b', type: 'spouse' },
    { a: 'ch_victim', b: 'ch_spouse_b', type: 'past_conflict' },
  ];
  const world = fixture(cast, relations, [
    { about: 'ch_parent', kind: 'will_changed', knownBy: ['ch_parent', 'ch_child'] },
    { about: 'ch_victim', kind: 'blackmail_material', knownBy: ['ch_victim', 'ch_parent'] },
    { about: 'ch_spouse_a', kind: 'affair', knownBy: ['ch_spouse_a', 'ch_spouse_b'] },
    { about: 'ch_spouse_b', kind: 'affair', knownBy: ['ch_spouse_b', 'ch_victim'] },
    { about: 'ch_spouse_b', kind: 'hit_and_run', knownBy: ['ch_spouse_b', 'ch_victim'] },
    { about: 'ch_doctor', kind: 'malpractice', knownBy: ['ch_doctor', 'ch_child'] },
  ]);
  const expected: MotiveCandidate[] = [
    {
      who: 'ch_child',
      against: 'ch_parent',
      motiveType: 'inheritance',
      strength: 0.7,
      basis: [
        relationFact('ch_parent', 'ch_child', 'parent', 0),
        secretFact(world, 'ch_parent', 'will_changed'),
      ].sort(),
    },
    {
      who: 'ch_doctor',
      against: 'ch_child',
      motiveType: 'malpractice_coverup',
      strength: 0.65,
      basis: [secretFact(world, 'ch_doctor', 'malpractice')],
    },
    {
      who: 'ch_spouse_b',
      against: 'ch_spouse_a',
      motiveType: 'jealousy',
      strength: 0.45,
      basis: [
        relationFact('ch_spouse_a', 'ch_spouse_b', 'spouse', 2),
        secretFact(world, 'ch_spouse_a', 'affair'),
      ].sort(),
    },
    {
      who: 'ch_victim',
      against: 'ch_parent',
      motiveType: 'blackmail',
      strength: 0.7,
      basis: [
        relationFact('ch_parent', 'ch_victim', 'blackmail', 1),
        secretFact(world, 'ch_victim', 'blackmail_material'),
      ].sort(),
    },
    {
      who: 'ch_victim',
      against: 'ch_spouse_b',
      motiveType: 'revenge',
      strength: 0.5,
      basis: [
        relationFact('ch_victim', 'ch_spouse_b', 'past_conflict', 3),
        secretFact(world, 'ch_spouse_b', 'hit_and_run'),
      ].sort(),
    },
  ];

  test('finds exactly the expected motives with fixed rules', () => {
    const result = conflicts(world, fixtureRules);
    expect(result.motives).toEqual(expected);
    expectTruthBacked(result, 0.4);
    // Directed edges: the spouse whose partner has no known affair and the blackmailer have none.
    expect(result.motives.some(({ who }) => who === 'ch_parent')).toBe(false);
    expect(result.motives.some(({ who }) => who === 'ch_spouse_a')).toBe(false);
  });

  test('parent → child and child → parent rules read the same reverse edge', () => {
    const childSide = fixtureRules.filter(({ id }) => id === 'inheritance');
    const fromChild = conflicts(world, childSide).motives;
    const fromParent = conflicts(world, [parentSideInheritance]).motives;
    expect(fromChild).toEqual([expected[0]]);
    expect(fromParent).toEqual([{ ...expected[0]!, strength: 0.65 }]);
    // The reverse reading of a directed type does not exist.
    const reversedBlackmail: Rule = {
      ...fixtureRules.find(({ id }) => id === 'blackmail')!,
      when: { relation: { type: 'blackmail', from: '$c', to: '$v' } },
    };
    expect(conflicts(world, [reversedBlackmail]).motives).toEqual([
      expect.objectContaining({ who: 'ch_parent', against: 'ch_victim' }),
    ]);
  });

  test('the motive is a fact of the server truth only at or above the threshold', () => {
    const rule = (id: string, base: number): Rule => ({
      id,
      when: { relation: { type: 'friendship', from: '$c', to: '$v' } },
      strength: { base, plus: [] },
      evidenceHints: [],
    });
    const pair = fixture(
      [person('ch_a'), person('ch_b')],
      [{ a: 'ch_a', b: 'ch_b', type: 'friendship' }],
    );
    const result = conflicts(
      pair,
      [rule('low', 0.39), rule('equal', 0.4), rule('high', 0.41)],
      0.4,
    );
    expect(result.motives.map(({ motiveType }) => motiveType)).toEqual([
      'equal',
      'high',
      'low',
      'equal',
      'high',
      'low',
    ]);
    expectTruthBacked(result, 0.4);
    const truth = new TruthModel(
      {
        type: 'fixture',
        victimIds: [],
        culpritIds: [],
        motive: factId(motiveFact(result.motives[0]!)),
        means: 'none',
        keyEventIds: [],
        window: { from: 0, to: 1 },
      },
      result.history,
    );
    expect(
      truth
        .facts({ kind: 'motive' })
        .map((fact) => fact.kind === 'motive' && fact.motiveType)
        .sort(),
    ).toEqual(['equal', 'equal', 'high', 'high']);
    expect(result.history.slice(0, pair.history.length)).toEqual(pair.history);
    expect(result.motiveReport).toMatchObject({ candidates: 6, aboveThreshold: 4, threshold: 0.4 });
  });

  test('evaluates every ordered pair c ≠ v', () => {
    const ids = ['ch_1', 'ch_2', 'ch_3', 'ch_4', 'ch_5'];
    const relations = ids.flatMap((a, i) =>
      ids.slice(i + 1).map((b) => ({ a, b, type: 'friendship' as const })),
    );
    const everyone: Rule = {
      id: 'grudge',
      when: { relation: { type: 'friendship', from: '$c', to: '$v' } },
      strength: { base: 0.5, plus: [] },
      evidenceHints: [],
    };
    const result = conflicts(
      fixture(
        ids.map((id) => person(id)),
        relations,
      ),
      [everyone],
    );
    const pairs = result.motives.map(({ who, against }) => `${who}>${against}`);
    expect(pairs).toEqual(ids.flatMap((c) => ids.filter((v) => v !== c).map((v) => `${c}>${v}`)));
    expect(result.motiveReport).toMatchObject({
      pairsEvaluated: 20,
      pairsWithMotive: 20,
      candidates: 20,
    });
  });
});

describe('ConflictGen on the sanatorium', () => {
  test('200 seeds: truth-backed candidates, invariants, no culprit or suspect, report', () => {
    const round = (value: number) => Math.round(value * 1e6) / 1e6;
    const bounds = new Map(
      content.motives.map(({ id, strength: { base, plus } }) => [
        id,
        {
          min: round(plus.reduce((sum, { add }) => sum + Math.min(add, 0), base)),
          max: round(plus.reduce((sum, { add }) => sum + Math.max(add, 0), base)),
        },
      ]),
    );
    const histogram = Array.from({ length: MOTIVE_HISTOGRAM_BINS }, () => 0);
    const counts = new Map<string, number>();
    let worldsWithMotive = 0;
    for (let seed = 0; seed < 200; seed++) {
      const world = sanatorium(String(seed));
      const { motiveReport: report, motives } = world;
      expectTruthBacked(world, content.preset.incident.minMotive);
      const n = world.characters.length;
      expect(report.pairsEvaluated).toBe(n * (n - 1));
      expect(report.rules).toBe(content.motives.length);
      expect(report.histogram.reduce((a, b) => a + b, 0)).toBe(motives.length);
      expect(Object.values(report.byType).reduce((sum, { count }) => sum + count, 0)).toBe(
        motives.length,
      );
      for (const { strength, motiveType } of motives) {
        const { min, max } = bounds.get(motiveType)!;
        expect(strength, motiveType).toBeGreaterThanOrEqual(min);
        expect(strength, motiveType).toBeLessThanOrEqual(max);
        counts.set(motiveType, (counts.get(motiveType) ?? 0) + 1);
      }
      report.histogram.forEach((count, bin) => (histogram[bin]! += count));
      if (motives.length > 0) worldsWithMotive++;
      expect(
        JSON.stringify({ ...world, relationships: world.relationships.snapshot() }),
      ).not.toMatch(/culprit|suspect|victim/i);
    }
    // Every rule fires. CastGen gives everyone age 45, so SocialGen creates no parent edge;
    // inheritance rests on the will_changed secret alone, which sibling relationships carry.
    expect([...counts.keys()].sort()).toEqual([
      'blackmail',
      'debt',
      'inheritance',
      'jealousy',
      'malpractice_coverup',
      'revenge',
    ]);
    expect(worldsWithMotive).toBeGreaterThanOrEqual(150);
    // Debt starts at 0.4 and revenge can hit 0.8, which falls in bin 8.
    expect(histogram.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(histogram.slice(9)).toEqual([0]);
  }, 60_000);

  test('the motive history passes truth invariants and builds an investigation', () => {
    for (let seed = 0; seed < 20; seed++) {
      const world = sanatorium(String(seed));
      const generated = runPipeline([worldGen], undefined, {
        seed: String(seed),
        content,
        now: () => 0,
      });
      if (!generated.ok) throw new Error('Expected WorldGen to succeed');
      const owners = new Map(world.characters.map(({ archetypeId, id }) => [archetypeId, id]));
      const state = generated.output.createWorldState(owners);
      const strongest = world.motives.toSorted((a, b) => b.strength - a.strength)[0];
      if (!strongest) continue;
      const truth = new TruthModel(
        {
          type: 'fixture',
          victimIds: [],
          culpritIds: [],
          motive: factId(motiveFact(strongest)),
          means: 'none',
          keyEventIds: [],
          window: { from: 0, to: 1 },
        },
        world.history,
      );
      expect(checkTruthInvariants(truth, state)).toEqual([]);
      const investigation = new InvestigationBuilder({
        scenarioId: content.preset.id,
        seed: String(seed),
        generatorVersion: '0.1.0',
      })
        .withWorld(state)
        .withCharacters(world.characters)
        .withTruth(truth)
        .withRelationships(world.relationships)
        .withSecrets(world.secrets.map(({ id, fact, knownBy }) => ({ id, fact, knownBy })))
        .build();

      // Motives stay on the server: the desktop payload carries none of them.
      const engine = GameEngine.create(investigation, {
        startLocationId: generated.output.startLocationId,
      });
      // `caseBoard.motiveTargets` is a legitimate player-side list of accusation targets (ENG-013):
      // it names no motive and no culprit, so its key is not what this check is looking for.
      const view = JSON.stringify(engine.playerView()).replace('"motiveTargets"', '"targets"');
      expect(view).not.toMatch(/motive|culprit|veracity|truth|hallucination/i);
      expect(view).not.toContain(MOTIVE_EVENT_VERB);
      for (const candidate of world.motives) {
        expect(view).not.toContain(factId(motiveFact(candidate)));
        for (const id of candidate.basis) expect(view).not.toContain(id);
      }
    }
  });
});

describe('ConflictGen strength', () => {
  test('property: strength ∈ [0, 1] and equals the clamped sum for random rules and traits', () => {
    const rng = createRng('strength-property');
    const pair = (personality: Personality) =>
      fixture(
        [person('ch_a', personality), person('ch_b')],
        [{ a: 'ch_a', b: 'ch_b', type: 'rivalry' }],
      );
    for (let round = 0; round < 500; round++) {
      const traits = Object.fromEntries(
        PERSONALITY_TRAITS.map((trait) => [trait, rng.float()]),
      ) as Personality;
      const plus = Array.from({ length: rng.int(0, 4) }, () => {
        const trait = rng.pick(PERSONALITY_TRAITS);
        const bound = rng.float();
        return {
          if: { trait: `$c.${trait}`, ...(rng.chance(0.5) ? { lt: bound } : { gt: bound }) },
          add: rng.float() * 2 - 1,
        };
      });
      const rule: Rule = {
        id: 'random',
        when: { relation: { type: 'rivalry', from: '$c', to: '$v' } },
        strength: { base: rng.float(), plus },
        evidenceHints: [],
      };
      const [motive] = conflicts(pair(traits), [rule]).motives;
      const raw = plus.reduce((sum, { if: condition, add }) => {
        const value = traits[condition.trait.slice(3) as keyof Personality];
        const ok =
          ('lt' in condition ? value < condition.lt : true) &&
          ('gt' in condition ? value > condition.gt : true);
        return ok ? sum + add : sum;
      }, rule.strength.base);
      expect(motive!.strength).toBeGreaterThanOrEqual(0);
      expect(motive!.strength).toBeLessThanOrEqual(1);
      expect(motive!.strength).toBeCloseTo(Math.min(1, Math.max(0, raw)), 5);
    }
  });

  test('clamps sums outside [0, 1] and applies bonuses of $v traits', () => {
    const world = fixture(
      [person('ch_a', { courage: 0.9 }), person('ch_b', { courage: 0.1 })],
      [{ a: 'ch_a', b: 'ch_b', type: 'rivalry' }],
    );
    const rule = (base: number, add: number, trait: string): Rule => ({
      id: 'r',
      when: { relation: { type: 'rivalry', from: '$c', to: '$v' } },
      strength: { base, plus: [{ if: { trait, gt: 0.5 }, add }] },
      evidenceHints: [],
    });
    const strength = (r: Rule) => conflicts(world, [r]).motives.map(({ strength }) => strength);
    expect(strength(rule(0.9, 0.5, '$c.courage'))).toEqual([1, 0.9]);
    expect(strength(rule(0.1, -0.8, '$c.courage'))).toEqual([0, 0.1]);
    expect(strength(rule(0.5, 0.25, '$v.courage'))).toEqual([0.5, 0.75]);
  });
});

describe('ConflictGen determinism', () => {
  test('same input gives the same output; rng, rule and character order do not matter', () => {
    const social = runPipeline([castGen, socialGen], undefined, {
      seed: 'determinism',
      content,
      now: () => 0,
    });
    if (!social.ok) throw new Error('Expected generation to succeed');
    const world = social.output;
    const plain = (result: ConflictWorld) => ({
      motives: result.motives,
      report: result.motiveReport,
      history: result.history,
    });
    const rules = content.motives;
    const expected = plain(conflicts(world, rules, 0.4, 'one'));
    expect(plain(conflicts(world, rules, 0.4, 'one'))).toEqual(expected);
    expect(plain(conflicts(world, rules, 0.4, 'two'))).toEqual(expected);
    const shuffled = { ...world, characters: world.characters.toReversed() };
    expect(plain(conflicts(shuffled, rules.toReversed(), 0.4, 'three'))).toEqual(expected);
    expect(plain(sanatorium('determinism'))).toEqual(plain(conflicts(world, rules)));
  });

  test('refuses a world that already has motive events instead of duplicating them', () => {
    const world = sanatorium('0');
    expect(world.motiveReport.aboveThreshold).toBeGreaterThan(0);
    expect(() => conflicts(world, content.motives)).toThrow(/already has motive events/);
  });
});

describe('ConflictGen rejects empty and invalid rules', () => {
  const world = fixture(
    [person('ch_a'), person('ch_b')],
    [{ a: 'ch_a', b: 'ch_b', type: 'friendship' }],
  );
  const rule = (patch: Partial<Rule>): Rule => ({
    id: 'r',
    when: { relation: { type: 'friendship', from: '$c', to: '$v' } },
    strength: { base: 0.5, plus: [] },
    evidenceHints: [],
    ...patch,
  });
  const bonus = (condition: Rule['strength']['plus'][number]['if']): Partial<Rule> => ({
    strength: { base: 0.5, plus: [{ if: condition, add: 0.1 }] },
  });

  test.each([
    ['an empty condition', rule({ when: {} }), /needs a relation or a secret/],
    [
      'an unknown relation type',
      rule({ when: { relation: { type: 'relative', from: '$c', to: '$v' } } }),
      /unsupported relation type relative/,
    ],
    [
      'a self relation',
      rule({ when: { relation: { type: 'friendship', from: '$c', to: '$c' } } }),
      /must link \$c and \$v/,
    ],
    [
      'an unknown variable',
      rule({ when: { relation: { type: 'friendship', from: '$x', to: '$v' } } }),
      /relation.from must be \$c or \$v/,
    ],
    [
      'a literal secret subject',
      rule({ when: { secret: { kind: 'affair', about: 'ch_a', knownBy: '$c' } } }),
      /secret.about must be/,
    ],
    ['an unknown trait', rule(bonus({ trait: '$c.charm', lt: 0.5 })), /personality trait/],
    ['a trait without a role', rule(bonus({ trait: 'honesty', lt: 0.5 })), /personality trait/],
    ['a condition without bounds', rule(bonus({ trait: '$c.honesty' })), /needs lt or gt/],
    [
      'a condition that never holds',
      rule(bonus({ trait: '$c.honesty', lt: 0.3, gt: 0.6 })),
      /never holds/,
    ],
  ])('%s', (_name, invalid, message) => {
    expect(() => conflicts(world, [invalid])).toThrow(message);
  });

  test('duplicate rule ids, facts missing from history, duplicate characters', () => {
    expect(() => conflicts(world, [rule({}), rule({})])).toThrow(/duplicate id/);
    expect(() => conflicts({ ...world, history: [] }, [rule({})])).toThrow(/no relation fact/);
    const withSecret = fixture(
      [person('ch_a'), person('ch_b')],
      [],
      [{ about: 'ch_a', kind: 'affair', knownBy: ['ch_a', 'ch_b'] }],
    );
    const secretRule = rule({ when: { secret: { kind: 'affair', about: '$v', knownBy: '$c' } } });
    expect(conflicts(withSecret, [secretRule]).motives).toHaveLength(1);
    expect(() => conflicts({ ...withSecret, history: [] }, [secretRule])).toThrow(/not in history/);
    expect(() =>
      conflicts({ ...world, characters: [world.characters[0]!, world.characters[0]!] }, [rule({})]),
    ).toThrow(/unique/);
  });

  test('a condition with both bounds is a range', () => {
    const ranged = fixture(
      [person('ch_a', { honesty: 0.5 }), person('ch_b', { honesty: 0.9 })],
      [{ a: 'ch_a', b: 'ch_b', type: 'friendship' }],
    );
    const motives = conflicts(ranged, [
      rule(bonus({ trait: '$c.honesty', gt: 0.3, lt: 0.6 })),
    ]).motives;
    expect(motives.map(({ who, strength }) => [who, strength])).toEqual([
      ['ch_a', 0.6],
      ['ch_b', 0.5],
    ]);
  });
});
