import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { PERSONALITY_TRAITS } from '../../common/index.ts';
import type { Personality } from '../../characters/index.ts';
import { loadScenarioFromDir } from '../../content/index.ts';
import { compileTraceRules, type Trace } from '../../evidence/index.ts';
import { KnowledgeStore } from '../../knowledge/index.ts';
import { createRng } from '../../rng/index.ts';
import { createInventory, createVitalsState, type ThreatResolution } from '../../survival/index.ts';
import { TruthLog } from '../../truth/index.ts';
import { ItemRegistry } from '../../world/index.ts';
import { confrontPlayer, scoreConfrontPlayer, type ConfrontPorts } from './confront-player.ts';
import { GoalPlanner } from './planner.ts';
import type { NpcContext, NpcState } from './npc-goals.ts';

const minimal = loadScenarioFromDir(
  fileURLToPath(new URL('../../../../../content/scenarios/_test_minimal', import.meta.url)),
);
const items = new ItemRegistry({ locations: minimal.locations, items: minimal.items });
const attackRule = {
  verb: 'attack',
  produces: [
    {
      kind: 'physical' as const,
      at: '$location',
      template: 'struggle_marks',
      supports: ['presence($actor,$location,$t)'],
    },
  ],
};
const withRule = compileTraceRules([...minimal.traceRules, attackRule]);
const withoutRule = compileTraceRules(minimal.traceRules);

const personality = Object.fromEntries(PERSONALITY_TRAITS.map((n) => [n, 0.5])) as Personality;
const state = (wariness: number): NpcState => ({
  personality,
  stress: 0.3,
  wariness,
  knowledge: new KnowledgeStore(),
});
const ctx = (wariness: number, now = 1380): NpcContext => ({
  agentId: 'ch_culprit',
  state: state(wariness),
  now,
  endAt: 100_000,
});
const dark = { night: true, playerAlone: true, locationDark: true };

function setup(rules = withRule) {
  const log = new TruthLog();
  const got: {
    resolution: ThreatResolution;
    traces: readonly Trace[];
    actors: readonly string[];
  }[] = [];
  const ports: ConfrontPorts = {
    setting: () => dark,
    player: () => ({
      vitals: createVitalsState({ health: 10, sanity: 10, fatigue: 0 }),
      inventory: createInventory([{ id: 'mk', kind: 'medkit' }]),
      location: 'loc_hall',
    }),
    record: (input) => log.append(input),
    rules,
    items,
    truth: log,
    onAttack: (_c, resolution, event, traces) =>
      got.push({ resolution, traces, actors: event.actorIds }),
  };
  return { log, got, goal: confrontPlayer(ports) };
}

test('score: only for a wary culprit in a dark, lonely night', () => {
  expect(scoreConfrontPlayer(state(0.9), dark)).toBeGreaterThan(0.6);
  expect(scoreConfrontPlayer(state(0.69), dark)).toBe(-Infinity);
  expect(scoreConfrontPlayer(state(0.9), { ...dark, night: false })).toBe(-Infinity);
  expect(scoreConfrontPlayer(state(0.9), { ...dark, playerAlone: false })).toBe(-Infinity);
  expect(scoreConfrontPlayer(state(0.9), { ...dark, locationDark: false })).toBe(-Infinity);
  expect(scoreConfrontPlayer(state(0.9), undefined)).toBe(-Infinity);
});

test('every attack is a truth event with at least one trace and a client-safe notice', () => {
  for (let i = 0; i < 100; i += 1) {
    const { goal, got, log } = setup();
    const context = ctx(0.9, 1380 + i);
    const plan = goal.plan(context, createRng(`a${i}`));
    expect(plan?.duration).toBe(3);
    plan?.start();
    expect(got).toHaveLength(1);
    expect(got[0]!.traces.length).toBeGreaterThan(0);
    expect(got[0]!.actors).toEqual(['ch_culprit']);
    expect(log.events().map((e) => e.verb)).toEqual(['attack']);
    expect(JSON.stringify(got[0]!.resolution.notice)).not.toContain('ch_culprit');
    expect(got[0]!.resolution.interrupted).toBe(true);
  }
});

test('an attack whose rules leave no trace is rejected', () => {
  const { goal } = setup(withoutRule);
  const plan = goal.plan(ctx(0.9), createRng('x'));
  expect(() => plan?.start()).toThrow(/left no trace/);
});

test('same seed gives the same outcome; planner picks the goal only when conditions hold', () => {
  const outcome = (seed: string) => {
    const { goal, got } = setup();
    goal.plan(ctx(0.9), createRng(seed))?.start();
    return JSON.stringify(got[0]!.resolution);
  };
  expect(outcome('same')).toBe(outcome('same'));
  const planner = new GoalPlanner<NpcState>().register(setup().goal);
  expect(planner.choose(ctx(0.9), createRng('p'))?.id).toBe('ConfrontPlayer');
  expect(planner.choose(ctx(0.2), createRng('p'))).toBeUndefined();
});
