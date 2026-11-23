import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import type { Personality } from '../../characters/index.ts';
import { PERSONALITY_TRAITS } from '../../common/index.ts';
import { loadScenarioFromDir } from '../../content/index.ts';
import { compileTraceRules, type Trace } from '../../evidence/index.ts';
import { KnowledgeStore, type Belief } from '../../knowledge/index.ts';
import { createRng } from '../../rng/index.ts';
import { TruthLog } from '../../truth/index.ts';
import { ItemRegistry } from '../../world/index.ts';
import {
  concealEvidence,
  distortRumor,
  meetCharacter,
  protectSelf,
  seekInformation,
  spreadRumor,
  type NpcContext,
  type NpcState,
} from './index.ts';

const minimal = loadScenarioFromDir(
  fileURLToPath(new URL('../../../../../content/scenarios/_test_minimal', import.meta.url)),
);
const rules = compileTraceRules(minimal.traceRules);
const items = new ItemRegistry({ locations: minimal.locations, items: minimal.items });
const hall = 'loc_hall';

const personality = (value: number, overrides: Partial<Personality> = {}): Personality =>
  ({
    ...Object.fromEntries(PERSONALITY_TRAITS.map((name) => [name, value])),
    ...overrides,
  }) as Personality;

const state = (overrides: Partial<NpcState> = {}): NpcState => ({
  personality: personality(0.5),
  stress: 0.3,
  wariness: 0.8,
  knowledge: new KnowledgeStore(),
  ...overrides,
});
const ctx = (s: NpcState, now = 100): NpcContext => ({
  agentId: 'ch_a',
  state: s,
  now,
  endAt: 1_000_000,
});
const unused = () => {
  throw new Error('unused');
};

test('ConcealEvidence property: every concealment leaves a secondary trace (500 seeds)', () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1 }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.integer({ min: 0, max: 5000 }),
      (seed, impulsivity, conscientiousness, now) => {
        const log = new TruthLog();
        const got: Trace[][] = [];
        const itemId = minimal.items[0]!.id;
        const goal = concealEvidence({
          incriminating: () => [{ entity: { kind: 'item', id: itemId }, location: hall }],
          record: (input) => log.append(input),
          rules,
          items,
          truth: log,
          onTraces: (_c, _e, traces) => got.push([...traces]),
        });
        const c = ctx(
          state({ personality: personality(0.5, { impulsivity, conscientiousness }) }),
          now,
        );
        expect(goal.score(c)).toBeGreaterThan(0);
        goal.plan(c, createRng(seed))!.start();
        expect(got).toHaveLength(1);
        expect(got[0]!.length).toBeGreaterThanOrEqual(1);
        const [event] = log.events();
        expect(['hide', 'destroy']).toContain(event!.verb);
      },
    ),
    { numRuns: 500 },
  );
});

test('ConcealEvidence needs wariness above 0.5 and a known target', () => {
  const target = { entity: { kind: 'item' as const, id: 'it_log' }, location: hall };
  const base = { record: unused, rules, items, truth: new TruthLog(), onTraces() {} };
  const empty = concealEvidence({ ...base, incriminating: () => [] });
  const goal = concealEvidence({ ...base, incriminating: () => [target] });
  expect(empty.score(ctx(state()))).toBe(-Infinity);
  expect(goal.score(ctx(state({ wariness: 0.5 })))).toBe(-Infinity);
  expect(goal.score(ctx(state({ wariness: 0.9 })))).toBeGreaterThan(
    goal.score(ctx(state({ wariness: 0.6 }))),
  );
});

const rumor = (at: number): Belief => ({
  proposition: { kind: 'did', who: 'ch_b', verb: 'hide', at, where: hall },
  confidence: 0.9,
  source: 'observed',
  acquiredAt: at,
  fuzzMinutes: 0,
});

test('rumor distortion is deterministic, lossy and marked as told', () => {
  fc.assert(
    fc.property(fc.string(), fc.integer({ min: 0, max: 3000 }), (seed, at) => {
      const a = distortRumor(rumor(at), createRng(seed));
      expect(distortRumor(rumor(at), createRng(seed))).toEqual(a);
      expect(a.proposition).not.toEqual(rumor(at).proposition);
      expect(a.confidence).toBeCloseTo(0.72);
      expect(a.source).toBe('told');
    }),
    { numRuns: 100 },
  );
});

test('SpreadRumor retells a juicy belief with distortion to a listener', () => {
  const knowledge = new KnowledgeStore();
  knowledge.add(rumor(50));
  const told: [string, Belief][] = [];
  const goal = spreadRumor({
    listeners: () => ['ch_z', 'ch_y'],
    tell: (_c, who, belief) => told.push([who, belief]),
  });
  const talkative = state({ knowledge, personality: personality(0.5, { extraversion: 0.9 }) });
  expect(goal.score(ctx(talkative))).toBeGreaterThan(0);
  expect(goal.score(ctx(state({ knowledge, personality: personality(0.1) })))).toBe(-Infinity);
  expect(goal.score(ctx(state({ personality: personality(0.9) })))).toBe(-Infinity);
  goal.plan(ctx(talkative), createRng('r'))!.start();
  const [[listener, belief]] = told as [[string, Belief]];
  expect(['ch_y', 'ch_z']).toContain(listener);
  expect(belief.fromCharacter).toBe('ch_a');
  expect(belief.proposition).not.toEqual(rumor(50).proposition);
});

test('ProtectSelf activates on Static >= 75 or a secondary incident and scales with fear', () => {
  let threat = { static: 50, secondaryIncident: false };
  const locked: string[] = [];
  const goal = protectSelf({ threat: () => threat, lockIn: (c) => locked.push(c.agentId) });
  const timid = state({ personality: personality(0.5, { courage: 0.1, neuroticism: 0.9 }) });
  const bold = state({ personality: personality(0.5, { courage: 0.9, neuroticism: 0.1 }) });
  expect(goal.score(ctx(timid))).toBe(-Infinity);
  threat = { static: 90, secondaryIncident: false };
  expect(goal.score(ctx(timid))).toBeGreaterThan(goal.score(ctx(bold)));
  threat = { static: 0, secondaryIncident: true };
  expect(goal.score(ctx(bold))).toBeGreaterThan(0);
  goal.plan(ctx(bold), createRng('p'))!.start();
  expect(locked).toEqual(['ch_a']);
});

test('MeetCharacter prefers the strongest reason', () => {
  const met: string[] = [];
  const goal = meetCharacter({
    candidates: () => [
      { characterId: 'ch_b', reason: 'anxiety', location: hall },
      { characterId: 'ch_c', reason: 'collusion', location: hall },
    ],
    meet: (_c, candidate) => met.push(candidate.characterId),
  });
  goal.plan(ctx(state()), createRng('m'))!.start();
  expect(met).toEqual(['ch_c']);
  const none = meetCharacter({ candidates: () => [], meet() {} });
  expect(none.score(ctx(state()))).toBe(-Infinity);
  expect(none.plan(ctx(state()), createRng('m'))).toBeNull();
});

test('SeekInformation asks about a death before a rumor and grows with stress', () => {
  const asked: [string, string][] = [];
  const goal = seekInformation({
    topics: () => [
      { subjectId: 'ch_r', trigger: 'rumor' },
      { subjectId: 'ch_d', trigger: 'death' },
    ],
    askable: () => ['ch_q'],
    ask: (_c, who, topic) => asked.push([who, topic.subjectId]),
  });
  goal.plan(ctx(state()), createRng('s'))!.start();
  expect(asked).toEqual([['ch_q', 'ch_d']]);
  expect(goal.score(ctx(state({ stress: 0.9 })))).toBeGreaterThan(
    goal.score(ctx(state({ stress: 0 }))),
  );
  const lonely = seekInformation({
    topics: () => [{ subjectId: 'x', trigger: 'death' }],
    askable: () => [],
    ask() {},
  });
  expect(lonely.score(ctx(state()))).toBe(-Infinity);
});
