import { fileURLToPath } from 'node:url';
import {
  characterSchema,
  relationshipSchema,
  type Character,
  type Relationship,
} from '@hs/core/characters';
import { loadScenarioFromDir, type ScenarioContent } from '@hs/core/content';
import { InvestigationBuilder } from '@hs/core/game';
import { createRng } from '@hs/core/rng';
import { checkTruthInvariants, factId, TruthModel, type Fact } from '@hs/core/truth';
import { describe, expect, test } from 'vitest';
import {
  ADULT_AGE,
  castGen,
  MAX_PARENT_AGE_GAP,
  MAX_SIBLING_AGE_GAP,
  MIN_PARENT_AGE_GAP,
  MIN_RELATIONSHIP_PARTNERS,
  MIN_SECRETS_PER_CHARACTER,
  RELATIONSHIP_EVENT_VERB,
  runPipeline,
  SECRET_EVENT_VERB,
  SIGNIFICANT_INTENSITY,
  socialGen,
  worldGen,
  type SocialWorld,
} from '../index.ts';

const content = loadScenarioFromDir(
  fileURLToPath(new URL('../../../../content/scenarios/sanatorium_winter/', import.meta.url)),
);
const MINUTES_PER_YEAR = 365 * 1440;
const silent = { debug() {} };

function generate(seed: string, scenario = content): { cast: Character[]; social: SocialWorld } {
  const cast = runPipeline([castGen], undefined, { seed, content: scenario, now: () => 0 });
  const social = runPipeline([castGen, socialGen], undefined, {
    seed,
    content: scenario,
    now: () => 0,
  });
  if (!cast.ok || !social.ok) throw new Error('Expected generation to succeed');
  return { cast: cast.output, social: social.output };
}

function social(cast: readonly Character[], seed: string, scenario = content): SocialWorld {
  const rng = createRng(seed).fork('gen/SocialGen');
  return socialGen.generate(cast, { rng, content: scenario, logger: silent });
}

/** Everything a SocialWorld determines, as plain data. */
function plain(world: SocialWorld) {
  return {
    characters: world.characters,
    relationships: world.relationships.snapshot(),
    secrets: world.secrets,
    history: world.history,
  };
}

function truthOf(world: SocialWorld): TruthModel {
  const incident = {
    type: 'fixture',
    victimIds: [],
    culpritIds: [],
    motive: 'f_0000000000000000',
    means: 'none',
    keyEventIds: [],
    window: { from: 0, to: 1 },
  };
  return new TruthModel(incident, world.history);
}

const isKin = (type: Relationship['type']) => ['parent', 'child', 'sibling'].includes(type);
const isLove = (type: Relationship['type']) => type === 'spouse' || type === 'romance';

/** Checks every SocialGen invariant on one result. */
function expectConsistent(input: readonly Character[], world: SocialWorld, scenario = content) {
  const historyStart = scenario.preset.time.historyStartMinutes;
  const ages = new Map(input.map(({ id, age }) => [id, age]));
  const birth = (id: string) => historyStart - ages.get(id)! * MINUTES_PER_YEAR;
  const edges = world.relationships.snapshot();
  const truth = truthOf(world);
  const events = new Map(truth.events().map((event) => [event.id, event]));
  const facts = truth.facts().map((fact) => JSON.stringify(fact));

  expect(world.characters.map(({ id }) => id)).toEqual(input.map(({ id }) => id));
  const partners = new Map(input.map(({ id }) => [id, new Set<string>()]));
  const spouses = new Map<string, number>();
  const parents = new Map<string, number>();
  const pairs = new Map<string, Relationship['type'][]>();
  for (const edge of edges) {
    relationshipSchema.parse(edge);
    const { a, b, type, intensity, history } = edge;
    expect(a).not.toBe(b);
    expect(intensity).toBeGreaterThanOrEqual(SIGNIFICANT_INTENSITY);
    partners.get(a)!.add(b);
    partners.get(b)!.add(a);
    const key = [a, b].sort().join('|');
    pairs.set(key, [...(pairs.get(key) ?? []), type === 'child' ? 'parent' : type]);
    if (type === 'spouse') {
      spouses.set(a, (spouses.get(a) ?? 0) + 1);
      spouses.set(b, (spouses.get(b) ?? 0) + 1);
    }

    // The relationship is a fact of a backstory event.
    expect(history).toHaveLength(1);
    const event = events.get(history[0]!)!;
    expect(event.verb).toBe(RELATIONSHIP_EVENT_VERB);
    expect(event.facts).toEqual([{ kind: 'relation', a, b, relType: type, since: event.t }]);
    expect(event.t).toBeLessThanOrEqual(historyStart);

    if (type === 'parent' || type === 'child') {
      const [parent, child] = type === 'parent' ? [a, b] : [b, a];
      const gap = ages.get(parent)! - ages.get(child)!;
      expect(gap).toBeGreaterThanOrEqual(MIN_PARENT_AGE_GAP);
      expect(gap).toBeLessThanOrEqual(MAX_PARENT_AGE_GAP);
      expect(event.t).toBe(birth(child));
      parents.set(child, (parents.get(child) ?? 0) + 1);
    } else if (type === 'sibling') {
      expect(Math.abs(ages.get(a)! - ages.get(b)!)).toBeLessThanOrEqual(MAX_SIBLING_AGE_GAP);
      expect(event.t).toBe(Math.max(birth(a), birth(b)));
    } else {
      // Both sides are adults when a non-kinship relationship begins.
      expect(event.t).toBeGreaterThanOrEqual(
        Math.max(birth(a), birth(b)) + ADULT_AGE * MINUTES_PER_YEAR,
      );
      expect(event.t).toBeLessThan(historyStart);
    }
  }
  for (const count of spouses.values()) expect(count).toBe(1);
  for (const count of parents.values()) expect(count).toBeLessThanOrEqual(2);
  for (const types of pairs.values()) {
    expect(new Set(types).size).toBe(types.length);
    expect(types.filter((type) => isKin(type) || isLove(type)).length).toBeLessThanOrEqual(1);
  }
  for (const set of partners.values())
    expect(set.size).toBeGreaterThanOrEqual(MIN_RELATIONSHIP_PARTNERS);

  const secretIds = new Set(world.secrets.map(({ id }) => id));
  expect(secretIds.size).toBe(world.secrets.length);
  const kinds = new Set<string>();
  for (const secret of world.secrets) {
    const { about, knownBy, fact, origin, kind } = secret;
    expect(kinds.has(`${about}/${kind}`)).toBe(false);
    kinds.add(`${about}/${kind}`);
    // The relationship the secret came from exists, and only its two sides know the secret.
    expect(world.relationships.get(origin.a, origin.b, origin.type)).toBeDefined();
    expect([origin.a, origin.b]).toContain(about);
    expect(knownBy).toEqual([origin.a, origin.b].sort());
    const template = scenario.relationships.find(({ id }) => id === origin.templateId)!;
    expect(template.secrets).toContainEqual({ kind, template: secret.template });
    // The secret is a fact of a covert backstory event, no earlier than its relationship.
    expect(fact).toMatchObject({ kind: 'state', entity: { kind: 'character', id: about } });
    expect(facts).toContain(JSON.stringify(fact));
    const event = truth
      .events()
      .find(({ facts }) => facts.some((f) => factId(f) === factId(fact)))!;
    expect(event).toMatchObject({ verb: SECRET_EVENT_VERB, visibility: 'covert' });
    const since = world.relationships.get(origin.a, origin.b, origin.type)!.history[0]!;
    expect(event.t).toBeGreaterThanOrEqual(events.get(since)!.t);
    expect(event.t).toBeLessThan(historyStart);
  }
  for (const character of world.characters) {
    characterSchema.parse(character);
    expect(character.secrets.length).toBeGreaterThanOrEqual(MIN_SECRETS_PER_CHARACTER);
    expect(character.secrets).toEqual(
      world.secrets.filter(({ about }) => about === character.id).map(({ id }) => id),
    );
  }
  expect(JSON.stringify(plain(world))).not.toMatch(/culprit|suspect/i);
}

describe('SocialGen on the sanatorium', () => {
  test('1,000 seeds: one spouse at most, no young parents, minimums, truth-backed history', () => {
    const types = new Set<string>();
    const kinds = new Set<string>();
    for (let seed = 0; seed < 1000; seed++) {
      const { cast, social: world } = generate(String(seed));
      expectConsistent(cast, world);
      // CastGen gives every character age 45, so a parent cannot be 16 years older (GEN-004).
      expect(world.relationships.byType('parent')).toHaveLength(0);
      world.relationships.snapshot().forEach(({ type }) => types.add(type));
      world.secrets.forEach(({ kind }) => kinds.add(kind));
    }
    expect([...types].sort()).toEqual(
      [
        'blackmail',
        'debt',
        'employment',
        'friendship',
        'past_conflict',
        'rivalry',
        'romance',
        'sibling',
        'spouse',
      ].sort(),
    );
    expect(kinds.size).toBeGreaterThanOrEqual(15);
  }, 60_000);

  test('the same seed gives the same network, a different seed usually does not', () => {
    expect(plain(generate('repeat').social)).toEqual(plain(generate('repeat').social));
    const networks = new Set(
      ['a', 'b', 'c', 'd'].map((seed) =>
        JSON.stringify(generate(seed).social.relationships.snapshot()),
      ),
    );
    expect(networks.size).toBe(4);
  });

  test('does not depend on the order of characters or relationship templates', () => {
    const { cast } = generate('order');
    const reordered: ScenarioContent = {
      ...content,
      relationships: content.relationships
        .toReversed()
        .map((template) => ({ ...template, secrets: template.secrets?.toReversed() })),
    };
    const expected = plain(social(cast, 'order'));
    const actual = plain(social(cast.toReversed(), 'order', reordered));
    expect({ ...actual, characters: actual.characters.toReversed() }).toEqual(expected);
  });

  test('the history fits the world and an investigation', () => {
    for (let seed = 0; seed < 25; seed++) {
      const world = runPipeline([worldGen], undefined, {
        seed: String(seed),
        content,
        now: () => 0,
      });
      const { cast, social: result } = generate(String(seed));
      if (!world.ok) throw new Error('Expected WorldGen to succeed');
      const owners = new Map(cast.map(({ archetypeId, id }) => [archetypeId, id]));
      const state = world.output.createWorldState(owners);
      const truth = truthOf(result);
      expect(checkTruthInvariants(truth, state)).toEqual([]);

      const motive: Fact = {
        kind: 'motive',
        who: cast[0]!.id,
        against: cast[1]!.id,
        motiveType: 'fixture',
        basis: [],
      };
      const withMotive = new TruthModel(
        { ...truth.incident, motive: factId(motive) },
        result.history,
      );
      withMotive.append({
        t: 0,
        duration: 0,
        verb: 'fixture',
        actorIds: [],
        location: world.output.startLocationId,
        targets: [],
        causes: [],
        facts: [motive],
        traceIds: [],
        visibility: 'private',
      });
      const investigation = new InvestigationBuilder({
        scenarioId: content.preset.id,
        seed: String(seed),
        generatorVersion: '0.1.0',
      })
        .withWorld(state)
        .withCharacters(result.characters)
        .withTruth(withMotive)
        .withRelationships(result.relationships)
        .withSecrets(result.secrets.map(({ id, fact, knownBy }) => ({ id, fact, knownBy })))
        .build();
      expect(investigation.relationships.snapshot()).toEqual(result.relationships.snapshot());
    }
  });
});

describe('SocialGen with kinship and varied ages', () => {
  const kin: ScenarioContent = {
    ...content,
    relationships: [
      { id: 'kin_parent', type: 'parent', secrets: [{ kind: 'will_changed', template: 't_will' }] },
      { id: 'kin_child', type: 'child', secrets: [{ kind: 'adopted', template: 't_adopted' }] },
      {
        id: 'kin_sibling',
        type: 'sibling',
        secrets: [{ kind: 'false_identity', template: 't_id' }],
      },
      { id: 'love_spouse', type: 'spouse', secrets: [{ kind: 'affair', template: 't_affair' }] },
      { id: 'love_romance', type: 'romance', secrets: [{ kind: 'affair', template: 't_affair' }] },
      { id: 'friends', type: 'friendship', secrets: [{ kind: 'addiction', template: 't_add' }] },
    ],
  };
  const { cast: base } = generate('kin');

  test('1,000 seeds: parents are 16–60 years older, at most two parents and one spouse', () => {
    let parents = 0;
    let siblings = 0;
    for (let seed = 0; seed < 1000; seed++) {
      const ages = createRng(`ages/${seed}`);
      const cast = base.map((character) => ({ ...character, age: ages.int(20, 90) }));
      const world = social(cast, String(seed), kin);
      expectConsistent(cast, world, kin);
      parents += world.relationships.byType('parent').length;
      siblings += world.relationships.byType('sibling').length;
    }
    expect(parents).toBeGreaterThan(1000);
    expect(siblings).toBeGreaterThan(1000);
  }, 60_000);

  test('applies maxCount and age-gap constraints from the template', () => {
    // Without kin_child, every parent relationship comes from kin_parent.
    const limited: ScenarioContent = {
      ...kin,
      relationships: kin.relationships.flatMap((template) =>
        template.id === 'kin_child'
          ? []
          : template.id === 'kin_parent'
            ? [{ ...template, constraints: { maxCount: 1, minAgeGap: 30 } }]
            : [template],
      ),
    };
    let parents = 0;
    for (let seed = 0; seed < 200; seed++) {
      const ages = createRng(`ages/${seed}`);
      const cast = base.map((character) => ({ ...character, age: ages.int(20, 90) }));
      const age = (id: string) => cast.find((character) => character.id === id)!.age;
      const world = social(cast, String(seed), limited);
      const edges = world.relationships.byType('parent');
      expect(edges.length).toBeLessThanOrEqual(1);
      for (const { a, b } of edges) expect(age(a) - age(b)).toBeGreaterThanOrEqual(30);
      parents += edges.length;
    }
    expect(parents).toBeGreaterThan(0);
  });
});

describe('SocialGen rejects inputs it cannot satisfy', () => {
  const { cast } = generate('errors');
  const only = (...relationships: ScenarioContent['relationships']): ScenarioContent => ({
    ...content,
    relationships,
  });

  test('unknown relation types and constraints', () => {
    expect(() => social(cast, 'x', only({ id: 'r', type: 'relative' }))).toThrow(
      /unsupported type/,
    );
    expect(() =>
      social(cast, 'x', only({ id: 'r', type: 'friendship', constraints: { gender: 'any' } })),
    ).toThrow(/unsupported constraints gender/);
    expect(() =>
      social(cast, 'x', only({ id: 'r', type: 'friendship', constraints: { maxCount: -1 } })),
    ).toThrow(/maxCount/);
  });

  test('too few partners, no secrets, impossible kinship and duplicate ids', () => {
    const secrets = [{ kind: 'affair', template: 't' }];
    expect(() => social(cast, 'x', only({ id: 'r', type: 'spouse', secrets }))).toThrow(
      /2 distinct partners/,
    );
    expect(() => social(cast, 'x', only({ id: 'r', type: 'friendship' }))).toThrow(/secret/);
    // Everyone is 45: a parent template never produces a parent younger than 16 years older.
    expect(() => social(cast, 'x', only({ id: 'r', type: 'parent', secrets }))).toThrow(
      /distinct partners/,
    );
    expect(() => social([cast[0]!, cast[0]!], 'x')).toThrow(/unique/);
  });
});
