import { readFileSync } from 'node:fs';
import {
  EndingView,
  ENDING_IDS,
  FORBIDDEN_VIEW_KEYS,
  PlayerView,
  type PlayerAction,
} from '@hs/protocol';
import { describe, expect, test } from 'vitest';
import { tinyManor } from '../../test/fixtures/tiny-manor.ts';
import { deriveClues, type Clue } from '../evidence/index.ts';
import {
  compileDeductionRules,
  type AccusationOutcome,
  type CaseFile,
} from '../investigation/index.ts';
import { GameEngine, type EnginePorts } from './engine.ts';
import type { Investigation } from './investigation.ts';

const investigation: Investigation = tinyManor();
const { culpritIds, victimIds, window } = investigation.truth.incident;
const culprit = culpritIds[0]!;
const victim = victimIds[0]!;
const cook = 'ch_cook';

const rulesFile = (scenario: string): object[] =>
  JSON.parse(
    readFileSync(`content/scenarios/${scenario}/deduction-rules.json`, 'utf8'),
  ) as object[];
const [opportunityRule, , motiveRule] = rulesFile('sanatorium_winter') as [object, object, object];
const rules = compileDeductionRules([opportunityRule, ...rulesFile('_test_minimal'), motiveRule]);

const keyEvent = investigation.truth.incident.keyEventIds[0]!;
const clueSpecs = [
  ['doc_ledger', `presence(${culprit},loc_study,${window.from})`],
  ['doc_debt', `knows(${culprit},sec_debt)`, `about(sec_debt,${victim})`],
  ['doc_log', `access_to_record(${culprit})`],
] as const;
const clues: readonly Clue[] = deriveClues(
  clueSpecs.map(([template, ...supports]) => ({
    id: `trace_${template}`,
    kind: 'document' as const,
    sourceEventId: keyEvent,
    template,
    supports: [...supports],
    captureMode: 'auto' as const,
    location: 'loc_study',
    availableFrom: 0,
  })),
  new Map(
    clueSpecs.map(([template]) => [
      template,
      { action: { type: 'read', documentId: template } } as const,
    ]),
  ),
);

const ports = (extra: Partial<EnginePorts> = {}): EnginePorts => ({
  startLocationId: 'loc_study',
  clues,
  accusation: { rules, incident: { location: 'loc_study', window } },
  ...extra,
});

/** An engine in the study that has read every document. */
function found(extra: Partial<EnginePorts> = {}): GameEngine {
  const engine = GameEngine.create(investigation, ports(extra));
  for (const [template] of clueSpecs) {
    expect(engine.dispatch('desktop', { type: 'read', documentId: template }).ok).toBe(true);
  }
  return engine;
}

const clueIds = clues.map(({ id }) => id);
const fullCase: CaseFile = {
  accusedIds: [culprit],
  motive: `motive(${culprit},${victim})`,
  means: `means(${culprit})`,
  opportunity: `opportunity(${culprit})`,
  evidence: clueIds,
};
const accuseWith = (engine: GameEngine, caseFile: CaseFile, confirm = true) =>
  engine.dispatch('desktop', {
    type: 'accuse',
    caseFile: {
      accusedIds: [...caseFile.accusedIds],
      evidence: [...caseFile.evidence],
      ...(caseFile.motive && { motive: caseFile.motive }),
      ...(caseFile.means && { means: caseFile.means }),
      ...(caseFile.opportunity && { opportunity: caseFile.opportunity }),
    },
    confirm,
  });
const wrongCase: CaseFile = { accusedIds: [cook], evidence: [] };

describe('accuse', () => {
  test('needs a second confirmation and changes nothing without it', () => {
    const engine = found();
    const hash = engine.stateHash();
    const result = accuseWith(engine, fullCase, false);
    expect(result).toMatchObject({ ok: true, minutesSpent: 0 });
    expect(result.events).toEqual([
      { type: 'AccusationConfirmationRequired', at: engine.playerView().clock.t },
    ]);
    expect(result.outcome).toBeUndefined();
    expect(engine.stateHash()).toBe(hash);
    expect(engine.playerView().ending).toBeUndefined();
  });

  test('a proven case solves; every later action is GAME_OVER', () => {
    const judged: AccusationOutcome[] = [];
    const engine = found({
      simulation: { onPlayerAction: () => {}, onAccusation: (o) => void judged.push(o) },
    });
    const result = accuseWith(engine, fullCase);
    expect(result).toMatchObject({ ok: true, outcome: 'solved', minutesSpent: 0 });
    expect(result.events).toEqual([
      {
        type: 'AccusationMade',
        at: expect.any(Number) as number,
        result: 'solved',
        proven: { motive: true, means: true, opportunity: true },
        final: true,
      },
    ]);
    expect(judged.map(({ endingId }) => endingId)).toEqual(['solved']);
    const view = engine.playerView();
    expect(view.ending).toMatchObject({
      endingId: 'solved',
      proven: { motive: true, means: true, opportunity: true },
      recap: { responsible: [{ id: culprit, name: expect.any(String) as string }] },
    });
    expect(view.availableActions).toEqual([]);
    const later: PlayerAction[] = [
      { type: 'wait', minutes: 15 },
      { type: 'accuse', caseFile: { accusedIds: [culprit], evidence: [] }, confirm: true },
      { type: 'markSuspicion', characterId: cook, level: 1 },
    ];
    for (const action of later) {
      expect(engine.dispatch('desktop', action)).toMatchObject({ ok: false, error: 'GAME_OVER' });
    }
  });

  test('the right person without proof is a partial ending', () => {
    const engine = found();
    const result = accuseWith(engine, { accusedIds: [culprit], evidence: [] });
    expect(result).toMatchObject({ ok: true, outcome: 'partial' });
    expect(engine.playerView().ending).toMatchObject({
      endingId: 'partial',
      proven: { motive: false, means: false, opportunity: false },
    });
  });

  test('a first wrong accusation is forgiven and leaks nobody; a second one ends the game', () => {
    const judged: AccusationOutcome[] = [];
    const engine = GameEngine.create(
      investigation,
      ports({
        startLocationId: 'loc_hall',
        simulation: { onPlayerAction: () => {}, onAccusation: (o) => void judged.push(o) },
      }),
    );
    const first = accuseWith(engine, wrongCase);
    expect(first).toMatchObject({ ok: true, minutesSpent: 0 });
    expect(first.outcome).toBeUndefined();
    expect(first.events).toMatchObject([
      { type: 'AccusationMade', result: 'wrong_accusation', final: false },
    ]);
    // The consequences name the culprit, but only the server-side simulation sees them.
    expect(judged[0]?.consequences).toContainEqual({ kind: 'culprit_freed', characterId: culprit });
    const view = engine.playerView();
    expect(view.ending).toBeUndefined();
    for (const json of [JSON.stringify(first), JSON.stringify(view)]) {
      expect(json).not.toContain(culprit);
      for (const key of FORBIDDEN_VIEW_KEYS) expect(json).not.toContain(`"${key}":`);
    }
    expect(PlayerView.parse(JSON.parse(JSON.stringify(view)))).toEqual(view);

    // The forgiven attempt survives a save.
    const restored = GameEngine.restore(
      engine.snapshot(),
      investigation,
      ports({ startLocationId: 'loc_hall' }),
    );
    const second = accuseWith(restored, wrongCase);
    expect(second).toMatchObject({ ok: true, outcome: 'wrong_accusation' });
    expect(second.events).toMatchObject([{ final: true }]);
    expect(restored.playerView().ending?.endingId).toBe('wrong_accusation');
    expect(accuseWith(restored, wrongCase)).toMatchObject({ error: 'GAME_OVER' });
    // The first engine did not end.
    expect(engine.playerView().ending).toBeUndefined();
  });

  test('a verdict survives save and restore', () => {
    const engine = found();
    accuseWith(engine, fullCase);
    const restored = GameEngine.restore(engine.snapshot(), investigation, ports());
    expect(restored.stateHash()).toBe(engine.stateHash());
    expect(restored.playerView().ending).toEqual(engine.playerView().ending);
  });

  test('refuses what is not a valid case file without changing state', () => {
    const engine = found();
    const hash = engine.stateHash();
    const attempts: CaseFile[] = [
      { accusedIds: [], evidence: [] },
      { accusedIds: ['ch_nobody'], evidence: [] },
      { accusedIds: [culprit], evidence: ['cl_unknown'] },
    ];
    for (const attempt of attempts) {
      expect(accuseWith(engine, attempt)).toMatchObject({ ok: false });
    }
    expect(accuseWith(engine, { accusedIds: [culprit], evidence: ['cl_unknown'] })).toMatchObject({
      error: 'ACTION_INVALID',
    });
    expect(engine.stateHash()).toBe(hash);
  });

  test('is not available without deduction rules, and not to the phone', () => {
    const noRules = GameEngine.create(investigation, { startLocationId: 'loc_study' });
    expect(accuseWith(noRules, wrongCase)).toMatchObject({ error: 'ACTION_NOT_AVAILABLE' });
    const engine = found();
    expect(
      engine.dispatch('phone', {
        type: 'accuse',
        caseFile: { accusedIds: [cook], evidence: [] },
        confirm: true,
      }),
    ).toMatchObject({ error: 'ACTION_INVALID' });
  });
});

describe('endings', () => {
  test('TruthRecap does not exist until the game is over', () => {
    const engine = found();
    for (let step = 0; step < 5; step++) {
      const view = engine.playerView();
      expect(view.ending).toBeUndefined();
      expect(JSON.stringify(view)).not.toContain('recap');
      engine.dispatch('desktop', { type: 'wait', minutes: 15 });
    }
    accuseWith(engine, wrongCase);
    expect(engine.playerView().ending).toBeUndefined();
  });

  test('the ending appears exactly when the clock reaches the end', () => {
    const { durationMinutes } = investigation.world;
    const engine = GameEngine.create(investigation, ports());
    let remaining = engine.playerView().clock.remainingMinutes;
    expect(remaining).toBe(durationMinutes);
    while (remaining > 15) {
      const step = Math.min(120, remaining - 15);
      expect(engine.dispatch('desktop', { type: 'wait', minutes: step }).ok).toBe(true);
      remaining = engine.playerView().clock.remainingMinutes;
    }
    expect(engine.playerView().ending).toBeUndefined();
    expect(engine.dispatch('desktop', { type: 'wait', minutes: 15 })).toMatchObject({
      ok: true,
      outcome: 'time_expired',
    });
    expect(engine.playerView().ending?.endingId).toBe('time_up');
  });

  test('time running out ends the game with the recap', () => {
    const { durationMinutes } = investigation.world;
    const engine = GameEngine.create(investigation, ports());
    let last = engine.dispatch('desktop', { type: 'wait', minutes: 1 });
    while (!last.outcome) {
      last = engine.dispatch('desktop', { type: 'wait', minutes: 120 });
      if (!last.ok) break;
    }
    expect(last.outcome).toBe('time_expired');
    const ending = engine.playerView().ending;
    expect(ending?.endingId).toBe('time_up');
    expect(ending?.recap?.responsible).toEqual([
      { id: culprit, name: expect.any(String) as string },
    ]);
    expect(engine.playerView().clock.remainingMinutes).toBeLessThanOrEqual(0);
    expect(durationMinutes).toBeGreaterThan(0);
    expect(engine.dispatch('desktop', { type: 'wait', minutes: 15 })).toMatchObject({
      error: 'GAME_OVER',
    });
  });

  for (const [endingId, vitals] of [
    ['death', { health: 0, sanity: 5, fatigue: 0 }],
    ['madness', { health: 5, sanity: 0, fatigue: 0 }],
  ] as const) {
    test(`${endingId} ends the game`, () => {
      const engine = GameEngine.create(investigation, ports({ startVitals: vitals }));
      const view = engine.playerView();
      expect(view.ending?.endingId).toBe(endingId);
      expect(engine.dispatch('desktop', { type: 'wait', minutes: 15 })).toMatchObject({
        error: 'GAME_OVER',
      });
    });
  }

  test('the vitals reaching zero during an action report the outcome', () => {
    const engine = GameEngine.create(
      investigation,
      ports({ startVitals: { health: 5, sanity: 1, fatigue: 100 } }),
    );
    let result = engine.dispatch('desktop', { type: 'wait', minutes: 60 });
    for (let step = 0; step < 30 && !result.outcome && result.ok; step++) {
      result = engine.dispatch('desktop', { type: 'wait', minutes: 60 });
    }
    expect(['death', 'madness', 'time_expired']).toContain(result.outcome);
  });

  test('all six endings are reachable and well formed', () => {
    const reached = new Set<string>();
    const note = (engine: GameEngine) => {
      const ending = engine.playerView().ending;
      if (ending) {
        expect(EndingView.parse(ending)).toEqual(ending);
        reached.add(ending.endingId);
      }
    };
    const solved = found();
    accuseWith(solved, fullCase);
    note(solved);
    const partial = found();
    accuseWith(partial, { accusedIds: [culprit], evidence: [] });
    note(partial);
    const wrong = found();
    accuseWith(wrong, wrongCase);
    accuseWith(wrong, wrongCase);
    note(wrong);
    const late = GameEngine.create(investigation, ports());
    for (let step = 0; step < 40; step++) {
      if (late.dispatch('desktop', { type: 'wait', minutes: 120 }).outcome) break;
    }
    note(late);
    note(
      GameEngine.create(
        investigation,
        ports({ startVitals: { health: 0, sanity: 5, fatigue: 0 } }),
      ),
    );
    note(
      GameEngine.create(
        investigation,
        ports({ startVitals: { health: 5, sanity: 0, fatigue: 0 } }),
      ),
    );
    expect([...reached].sort()).toEqual([...ENDING_IDS].sort());
  });
});
