import { GameEngine, serializeInvestigation, type Investigation } from '@hs/core/game';
import { compileDeductionRules, evaluateClaims, PlayerKnowledge } from '@hs/core/investigation';
import type { Clue } from '@hs/core/evidence';
import { createActionCostTable } from '@hs/core/time';
import { buildLiePolicy, KnowledgeStore } from '@hs/core/knowledge';
import { TruthModel } from '@hs/core/truth';
import { expect, it } from 'vitest';
import { tinyManor } from '../../../core/test/fixtures/tiny-manor.ts';
import { clue } from '../../test/mutations.ts';
import {
  GENERATION_CHECKS,
  solutionSource,
  solve,
  timeFeasibleCheck,
  validateInvestigation,
  type SolutionPath,
} from '../index.ts';

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

it('cannot use a locked clue, a QR without a phone, a wrong subject, or the true incident in place of a public briefing', () => {
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

function proven(inv: Investigation, path: SolutionPath, caseClues: readonly Clue[]) {
  const engine = GameEngine.create(inv, { startLocationId, clues: caseClues });
  for (const action of path) expect(engine.dispatch('desktop', action).ok).toBe(true);
  const knowledge = PlayerKnowledge.restore(engine.snapshot().desktop?.knowledge);
  return evaluateClaims(knowledge, rules, {
    clues: new Map(caseClues.map((c) => [c.id, c])),
    incident,
  })
    .map((c) => `${c.subject}:${c.kind}`)
    .sort();
}

it('requires a complete proof for every culprit of a shared crime', () => {
  const inv = manor(60);
  const truth = new TruthModel(
    { ...inv.truth.incident, culpritIds: ['ch_bursar', 'ch_cook'] },
    inv.truth.events(),
  );
  const shared = { ...inv, truth } as Investigation;
  // The bursar's proof is complete after the hall and the study; the cook's needs the pantry too.
  expect(solve(shared, { ...options, timeBudget: 42 })).toBeNull();
  const caseClues = [
    ...clues,
    document(
      'note',
      ['debt(ch_cook)', 'has_key(ch_cook)', 'presence(ch_cook,loc_study,-12)'],
      'loc_pantry',
    ),
  ];
  expect(solve(shared, { ...options, clues: caseClues, timeBudget: 36 })).toBeNull();
  // A larger budget must not lose the 37-minute route (re-reading a document used to crowd it out).
  for (let timeBudget = 37; timeBudget <= 60; timeBudget++) {
    expect(solve(shared, { ...options, clues: caseClues, timeBudget })).toHaveLength(6);
  }
  const path = solve(shared, { ...options, clues: caseClues, timeBudget: 42 });
  expect(path).not.toBeNull();
  expect(path!.some((a) => a.type === 'read' && a.documentId === 'note')).toBe(true);
  expect(proven(shared, path!, caseClues)).toEqual([
    'ch_bursar:means',
    'ch_bursar:motive',
    'ch_bursar:opportunity',
    'ch_cook:means',
    'ch_cook:motive',
    'ch_cook:opportunity',
  ]);
});

it('rejects a proof whose last action ends the scenario', () => {
  // Two reads at 9 and one move at 3: the last clue is found exactly at minute 21.
  const createSimulationPorts = () => ({
    actionCosts: createActionCostTable({ read: { base: 9 } }),
  });
  const settings = { ...options, createSimulationPorts, timeBudget: 21 };
  expect(solve(manor(21), settings)).toBeNull(); // The game is over: no accusation is possible.
  const path = solve(manor(22), settings);
  expect(path).not.toBeNull();
  const engine = GameEngine.create(manor(22), {
    ...createSimulationPorts(),
    startLocationId,
    clues,
  });
  for (const action of path!) expect(engine.dispatch('desktop', action).ok).toBe(true);
  expect(engine.playerView().clock.t).toBe(21);
});

it('does not repeat a free action at the same minute and exhausts the search instead of its work limit', () => {
  // Reading is free and the opportunity clue is missing. Moves and waiting still spend the budget.
  const context = {
    ...options,
    clues: clues.slice(0, 1),
    createSimulationPorts: () => ({ actionCosts: createActionCostTable({ read: { base: 0 } }) }),
  };
  expect(timeFeasibleCheck.run(manor(10), context).map((f) => f.code)).toEqual([
    'TIME_PATH_NOT_FOUND',
  ]);
});

it('captures a QR clue with the phone and replays the capture from the phone role', () => {
  const inv = manor(40);
  const qr = { ...clues[1]!, captureMode: 'qr' as const };
  const caseClues = [clues[0]!, qr];
  let issued = 0;
  const createSimulationPorts = () => {
    let next = 0;
    return {
      phone: {},
      evidenceTokens: {
        issue: () => {
          issued++;
          return `tok_${++next}`;
        },
        revoke: () => {},
      },
    };
  };
  const path = solve(inv, { ...options, clues: caseClues, createSimulationPorts, timeBudget: 28 });
  expect(path).not.toBeNull();
  expect(issued).toBeGreaterThan(0);
  const capture = path!.findIndex((a) => a.type === 'captureEvidence');
  expect(path![capture - 1]).toEqual({ type: 'read', documentId: 'register' });
  expect(path!.map(solutionSource).filter((s) => s === 'phone')).toHaveLength(1);
  const engine = GameEngine.create(inv, {
    ...createSimulationPorts(),
    startLocationId,
    clues: caseClues,
  });
  for (const action of path!) expect(engine.dispatch(solutionSource(action), action).ok).toBe(true);
  expect(engine.playerView().caseBoard.clues).toContainEqual(
    expect.objectContaining({ id: 'register', captured: true }),
  );
  expect(engine.playerView().clock.t).toBeLessThanOrEqual(28);
});
