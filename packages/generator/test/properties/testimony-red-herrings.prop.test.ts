import type { ScenarioContent } from '@hs/core/content';
import { answer, KnowledgeStore, type LiePolicy } from '@hs/core/knowledge';
import { createRng } from '@hs/core/rng';
import { checkTruthInvariants } from '@hs/core/truth';
import { factId } from '@hs/core/truth/facts';
import { expect, test } from 'vitest';
import {
  MAX_RED_HERRINGS,
  MIN_RED_HERRINGS,
  redHerrings,
  type EvidenceWorld,
  type TestimonyWorld,
} from '../../src/index.ts';
import { evidenceSamples, testimony } from '../support/evidence.ts';
import { minimal, sanatorium, silent } from '../support/incident.ts';

const COUNT = 60;

function herrings(world: TestimonyWorld, content: ScenarioContent, seed: string) {
  return redHerrings.generate(world, {
    rng: createRng(`${seed}#1`).fork('gen/RedHerrings'),
    content,
    logger: silent,
  });
}

const sanatoriumInputs = () => evidenceSamples(sanatorium, 'sanatorium', 'tg-prop', COUNT);

test(`${COUNT} seeds: a character hides only what they know and have a motive to hide`, () => {
  let culpritsHiding = 0;
  let lies = 0;
  const samples = sanatoriumInputs();
  expect(samples.length).toBe(COUNT);
  for (const { seed, world } of samples) {
    const before = [...world.knowledge].map(([id, store]) => [id, store.serialize()]);
    const result = testimony(world, sanatorium, seed);
    // The input stores are untouched; the output has its own.
    expect([...world.knowledge].map(([id, store]) => [id, store.serialize()])).toEqual(before);
    expect(result.liePolicies.size, seed).toBe(world.characters.length);
    const culprit = world.truth.incident.culpritIds[0]!;
    for (const character of world.characters) {
      const policy = result.liePolicies.get(character.id)!;
      const store = result.knowledge.get(character.id)!;
      const protectedByMotive = (result.lieMotives.get(character.id) ?? []).flatMap(
        ({ protect }) => protect,
      );
      // Every concealed pattern is one of the character's motives and is known to them.
      for (const pattern of policy.conceal) {
        expect(protectedByMotive, `${seed} ${character.id}`).toContainEqual(pattern);
        expect(store.query(pattern).length, `${seed} ${character.id}`).toBeGreaterThan(0);
      }
      // A scrupulously honest character never fabricates.
      if (character.personality.honesty >= 0.75) expect(policy.fabricate, seed).toEqual([]);
      // Every lie of an interview is an authorised alternative.
      const statements = answer(
        { type: 'aboutYourself' },
        { character, knowledge: store, policy, now: 0 },
      );
      for (const statement of statements) {
        if (statement.veracity !== 'lie') continue;
        lies++;
        expect(
          policy.fabricate.some(
            ({ proposition }) => factId(proposition) === factId(statement.proposition),
          ),
          seed,
        ).toBe(true);
      }
      if (
        character.id === culprit &&
        policy.conceal.some(
          ({ kind }) => kind === 'motive' || kind === 'did' || kind === 'possessed',
        )
      )
        culpritsHiding++;
    }

    // Without a motive there is nothing to hide: the same character with no secrets is open.
    const free = world.characters.find(({ id }) => !world.truth.incident.culpritIds.includes(id))!;
    const open: EvidenceWorld = {
      ...world,
      secrets: world.secrets.filter(({ about }) => about !== free.id),
    };
    const openResult = testimony(open, sanatorium, seed);
    expect(openResult.liePolicies.get(free.id), seed).toEqual({ conceal: [], fabricate: [] });
    expect(testimony(world, sanatorium, seed).liePolicies, seed).toEqual(result.liePolicies);
  }
  expect(culpritsHiding).toBeGreaterThan(0);
  expect(lies).toBeGreaterThan(0);
}, 120_000);

test(`${COUNT} seeds: every red herring is a real event of the truth of an innocent`, () => {
  let total = 0;
  const samples = sanatoriumInputs();
  for (const { seed, world } of samples) {
    const base = testimony(world, sanatorium, seed);
    const eventsBefore = world.truth.events().length;
    const result = herrings(base, sanatorium, seed);
    expect(world.truth.events().length, `${seed}: input truth is not changed`).toBe(eventsBefore);
    const { culpritIds, victimIds, window } = result.truth.incident;
    const byId = new Map(result.truth.events().map((event) => [event.id, event]));

    expect(result.redHerrings.length, seed).toBeGreaterThanOrEqual(MIN_RED_HERRINGS);
    expect(result.redHerrings.length, seed).toBeLessThanOrEqual(MAX_RED_HERRINGS);
    expect(result.redHerringReport.count, seed).toBe(result.redHerrings.length);
    const clueIds = new Set(result.redHerrings.flatMap(({ clueIds: ids }) => ids));
    expect(result.redHerringReport.clues, seed).toBe(clueIds.size);
    expect(clueIds.size, seed).toBeGreaterThan(0);
    total += clueIds.size;

    // The incident's evidence is as it was; red herrings only add.
    expect(result.requiredClueIds, seed).toEqual(world.requiredClueIds);
    expect(result.clues.slice(0, world.clues.length), seed).toEqual(world.clues);
    expect(result.clues.length, seed).toBe(world.clues.length + clueIds.size);
    expect(result.clues.filter(({ id }) => clueIds.has(id)).length, seed).toBe(clueIds.size);

    const characters = new Set<string>();
    for (const herring of result.redHerrings) {
      const secret = world.secrets.find(({ id }) => id === herring.secretId)!;
      expect(secret.about, seed).toBe(herring.characterId);
      expect(culpritIds, seed).not.toContain(herring.characterId);
      expect(victimIds, seed).not.toContain(herring.characterId);
      expect(characters.has(herring.characterId), `${seed}: one misdeed per character`).toBe(false);
      characters.add(herring.characterId);

      const event = byId.get(herring.eventId);
      expect(event, `${seed}: ${herring.eventId} is in the truth`).toBeDefined();
      expect(event!.actorIds, seed).toEqual([herring.characterId]);
      expect(result.truth.incident.keyEventIds, seed).not.toContain(herring.eventId);
      expect(
        event!.t + event!.duration <= window.from - 60 || event!.t >= window.to + 60,
        `${seed}: misdeed away from the incident`,
      ).toBe(true);
      // The character really was there.
      expect(result.truth.whereWas(herring.characterId, event!.t), seed).toBe(event!.location);

      // Every false trail refers to that real event, and says only that someone was there.
      for (const clue of result.clues.filter(({ id }) => herring.clueIds.includes(id))) {
        expect(clue.sourceEventId, seed).toBe(herring.eventId);
        expect(byId.has(clue.sourceEventId), seed).toBe(true);
      }
      for (const trace of result.traces.filter(({ id }) => herring.traceIds.includes(id))) {
        expect(trace.sourceEventId, seed).toBe(herring.eventId);
        expect(
          trace.supports.every((claim) => claim.startsWith('presence(')),
          seed,
        ).toBe(true);
      }
    }

    // The truth with the misdeeds still satisfies its invariants.
    expect(checkTruthInvariants(result.truth, world.worldState), seed).toEqual([]);

    // The innocent hides the misdeed: concealment, and a lie when their honesty allows it.
    for (const herring of result.redHerrings) {
      const character = world.characters.find(({ id }) => id === herring.characterId)!;
      const event = byId.get(herring.eventId)!;
      const policy: LiePolicy = result.liePolicies.get(herring.characterId)!;
      const store: KnowledgeStore = result.knowledge.get(herring.characterId)!;
      const said = answer(
        { type: 'aboutYourself' },
        { character, knowledge: store, policy, now: 0 },
      ).filter(
        ({ proposition }) =>
          proposition.kind === 'did' &&
          proposition.at === event.t &&
          proposition.where === event.location,
      );
      expect(
        said.some(
          ({ proposition }) => proposition.kind === 'did' && proposition.verb === event.verb,
        ),
        seed,
      ).toBe(false);
      if (character.personality.honesty < 0.75) {
        expect(
          said.map(({ veracity, proposition }) => [
            veracity,
            proposition.kind === 'did' && proposition.verb,
          ]),
          `${seed}: ${character.id} covers`,
        ).toEqual([['lie', 'stay']]);
      } else {
        expect(said, `${seed}: ${character.id} keeps silent`).toEqual([]);
      }
    }
    expect(
      redHerrings.generate(base, {
        rng: createRng(`${seed}#1`).fork('gen/RedHerrings'),
        content: sanatorium,
        logger: silent,
      }).redHerrings,
      seed,
    ).toEqual(result.redHerrings);
  }
  expect(total).toBeGreaterThan(0);
}, 120_000);

test('_test_minimal: a short scenario may leave no room, and the truth stays valid', () => {
  const samples = evidenceSamples(minimal, 'minimal', 'tg-min', 30);
  expect(samples.length).toBe(30);
  for (const { seed, world } of samples) {
    const result = herrings(testimony(world, minimal, seed), minimal, seed);
    expect(checkTruthInvariants(result.truth, world.worldState), seed).toEqual([]);
    expect(result.redHerringReport.count, seed).toBe(result.redHerrings.length);
    expect(result.redHerrings.length, seed).toBeLessThanOrEqual(MAX_RED_HERRINGS);
    expect(result.clues.length, seed).toBe(world.clues.length + result.redHerringReport.clues);
  }
}, 120_000);

test('without a verb for a misdeed no red herring is placed', () => {
  const { seed, world } = sanatoriumInputs()[0]!;
  const quiet = {
    verb: 'hide',
    produces: [{ kind: 'testimonial' as const, at: '$location', template: 'rumour', supports: [] }],
  };
  const content: ScenarioContent = {
    ...sanatorium,
    traceRules: [
      ...sanatorium.traceRules.filter(({ verb }) => verb !== 'hide' && verb !== 'destroy'),
      quiet,
      { ...quiet, verb: 'destroy' },
    ],
  };
  const result = herrings(testimony(world, content, seed), content, seed);
  expect(result.redHerrings).toEqual([]);
  expect(result.redHerringReport).toEqual({ count: 0, clues: 0, traces: 0 });
  expect(result.truth.events().length).toBe(world.truth.events().length);
});

test('the culprit and the victim never get a red herring even when they hold all the secrets', () => {
  const { seed, world } = sanatoriumInputs()[0]!;
  const { culpritIds, victimIds } = world.truth.incident;
  const only = new Set([...culpritIds, ...victimIds]);
  const restricted = { ...world, secrets: world.secrets.filter(({ about }) => only.has(about)) };
  const result = herrings(testimony(restricted, sanatorium, seed), sanatorium, seed);
  expect(result.redHerrings).toEqual([]);
});
