import { GameEngine, serializeInvestigation } from '@hs/core/game';
import { compileDeductionRules, evaluateClaims, PlayerKnowledge } from '@hs/core/investigation';
import type { Clue } from '@hs/core/evidence';
import { createActionCostTable } from '@hs/core/time';
import { buildLiePolicy, KnowledgeStore } from '@hs/core/knowledge';
import { expect, it } from 'vitest';
import { tinyManor } from '../../../core/test/fixtures/tiny-manor.ts';
import { clue } from '../../test/mutations.ts';
import { GENERATION_CHECKS, solve, timeFeasibleCheck, validateInvestigation } from '../index.ts';

const rules = compileDeductionRules([
  { id: 'motive_debt', establishes: 'motive($c)', requires: ['debt($c)'] },
  { id: 'means_key', establishes: 'means($c)', requires: ['has_key($c)'] },
  {
    id: 'opportunity_seen',
    establishes: 'opportunity($c)',
    requires: ['presence($c,$incident.location,$incident.window)'],
  },
]);
const incident = { location: 'loc_study', window: { from: -30, to: -5 } };
const startLocationId = 'loc_hall';
function document(id: string, supports: string[], locationId: string): Clue {
  return {
    ...clue(id, 'auto'),
    supports,
    discovery: {
      locationId,
      availableFrom: 0,
      requires: [],
      action: { type: 'read', documentId: id },
    },
  };
}
const clues = [
  document('ledger', ['debt(ch_bursar)', 'has_key(ch_bursar)'], 'loc_hall'),
  document('register', ['presence(ch_bursar,loc_study,-15)'], 'loc_study'),
];
const options = { clues, deductionRules: rules, startLocationId, knownIncident: incident };
const manor = (durationMinutes: number) => {
  const inv = tinyManor();
  return { ...inv, world: { ...inv.world, durationMinutes } };
};

it('replays the returned actions in a fresh engine and proves all three elements from acquired evidence', () => {
  const inv = manor(40);
  const before = serializeInvestigation(inv);
  const histories: number[][] = [];
  const path = solve(inv, {
    ...options,
    timeBudget: 28,
    createSimulationPorts: () => {
      const times: number[] = [];
      histories.push(times);
      return { simulation: { onPlayerAction: (event) => times.push(event.at) } };
    },
  });
  expect(histories.length).toBeGreaterThan(1);
  for (const times of histories) {
    expect(times[0]).toBe(0);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  }
  expect(path).not.toBeNull();
  expect(solve(inv, { ...options, timeBudget: 28 })).toEqual(path);
  const engine = GameEngine.create(inv, { startLocationId, clues });
  for (const action of path!) expect(engine.dispatch('desktop', action).ok).toBe(true);
  const knowledge = PlayerKnowledge.restore(engine.snapshot().desktop?.knowledge);
  const claims = evaluateClaims(knowledge, rules, {
    clues: new Map(clues.map((c) => [c.id, c])),
    incident,
  });
  expect(claims.map((c) => [c.subject, c.kind]).sort()).toEqual([
    ['ch_bursar', 'means'],
    ['ch_bursar', 'motive'],
    ['ch_bursar', 'opportunity'],
  ]);
  expect(engine.playerView().clock.t).toBeLessThanOrEqual(28);
  expect(serializeInvestigation(inv)).toBe(before);
});

it('accepts exactly 70% and rejects one minute less, including two individually affordable branches', () => {
  const custom = {
    ...options,
    createSimulationPorts: () => ({ actionCosts: createActionCostTable({ read: { base: 9 } }) }),
  };
  const check = (duration: number) =>
    validateInvestigation(manor(duration), { checks: [timeFeasibleCheck], context: custom });
  expect(check(30).ok).toBe(true); // two reads at 9 and one move at 3
  expect(check(29).findings.map((f) => f.code)).toEqual(['TIME_PATH_NOT_FOUND']);
});

it('cannot use a locked clue, pending QR, a wrong subject, or the true incident in place of a public briefing', () => {
  const inv = manor(40);
  const hidden = document('register', [...clues[1]!.supports], 'loc_archive');
  const other = document('ledger', ['debt(ch_cook)', 'has_key(ch_cook)'], 'loc_hall');
  for (const changed of [
    [clues[0]!, hidden],
    [other, document('register', ['presence(ch_cook,loc_study,-15)'], 'loc_study')],
  ]) {
    expect(solve(inv, { ...options, clues: changed, timeBudget: 28 })).toBeNull();
  }
  let issued = 0;
  const qr = { ...clues[1]!, captureMode: 'qr' as const };
  expect(
    solve(inv, {
      ...options,
      clues: [clues[0]!, qr],
      timeBudget: 28,
      createSimulationPorts: () => ({
        evidenceTokens: {
          issue: () => {
            issued++;
            return 'test_token';
          },
          revoke: () => {},
        },
      }),
    }),
  ).toBeNull();
  expect(issued).toBeGreaterThan(0);
  expect(solve(inv, { clues, deductionRules: rules, startLocationId, timeBudget: 28 })).toBeNull();
  expect(validateInvestigation(inv, { checks: [timeFeasibleCheck] }).findings[0]?.code).toBe(
    'PLANNER_INPUT_MISSING',
  );
  expect(GENERATION_CHECKS).toContain(timeFeasibleCheck);
});

it('reports an inconclusive bounded search and refuses a case without a producible means claim', () => {
  const impossible = { ...options, clues: clues.slice(0, 1) };
  expect(timeFeasibleCheck.run(manor(4320), impossible)[0]?.code).toBe('TIME_SEARCH_LIMIT');
  expect(
    solve(manor(40), { ...options, deductionRules: compileDeductionRules([]), timeBudget: 28 }),
  ).toBeNull();
});

it('waits for a witness and obtains a statement by asking a visible dialogue topic', () => {
  const inv = manor(70);
  inv.truth.append({
    t: 15,
    duration: 0,
    actorIds: ['ch_cook'],
    location: startLocationId,
    verb: 'work',
    facts: [{ kind: 'at', who: 'ch_cook', where: startLocationId, interval: { from: 15, to: 65 } }],
    targets: [],
    causes: [],
    traceIds: [],
    visibility: 'covert',
  });
  const witness = inv.characters.find((c) => c.id === 'ch_cook')!;
  const createSimulationPorts = () => {
    const memory = new KnowledgeStore();
    memory.add({
      proposition: {
        kind: 'at',
        who: 'ch_bursar',
        where: startLocationId,
        interval: { from: -20, to: -15 },
      },
      source: 'observed',
      confidence: 1,
      acquiredAt: -10,
      fuzzMinutes: 0,
    });
    const policy = buildLiePolicy(witness, memory, []);
    return {
      testimony: {
        witness: (id: string) => (id === witness.id ? { knowledge: memory, policy } : undefined),
      },
    };
  };
  const witnessRules = compileDeductionRules([
    { id: 'motive_debt', establishes: 'motive($c)', requires: ['debt($c)'] },
    { id: 'means_key', establishes: 'means($c)', requires: ['has_key($c)'] },
    {
      id: 'witness',
      establishes: 'opportunity($c)',
      requires: ['testimony($w,presence($c,$incident.location,$incident.window))'],
    },
  ]);
  const settings = {
    ...options,
    clues: [clues[0]!],
    knownIncident: { ...incident, location: startLocationId },
    createSimulationPorts,
    deductionRules: witnessRules,
  };
  const path = solve(inv, { ...settings, timeBudget: 49 });
  expect(path).not.toBeNull();
  const engine = GameEngine.create(inv, {
    ...createSimulationPorts(),
    clues: settings.clues,
    startLocationId,
  });
  for (const action of path!) {
    if (action.type === 'talk' && action.characterId === witness.id) {
      expect(engine.playerView().clock.t).toBeGreaterThanOrEqual(15);
    }
    expect(engine.dispatch('desktop', action).ok).toBe(true);
  }
  const knowledge = PlayerKnowledge.restore(engine.snapshot().desktop?.knowledge);
  const proof = evaluateClaims(knowledge, witnessRules, {
    clues: new Map(settings.clues.map((c) => [c.id, c])),
    incident: settings.knownIncident,
  });
  expect(proof.find((c) => c.kind === 'opportunity')?.support.statementIds).toHaveLength(1);
  expect(solve(inv, { ...settings, timeBudget: 34 })).toBeNull(); // earliest possible second reply at 35
});
