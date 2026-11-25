import { FORBIDDEN_VIEW_KEYS, PlayerView } from '@hs/protocol';
import { expect, test } from 'vitest';
import { tinyManor, tinyManorWithClues } from '../../../test/fixtures/tiny-manor.ts';
import { deriveClues } from '../../evidence/index.ts';
import { GameEngine } from '../engine.ts';

const ports = { startLocationId: 'loc_study' };

test('markSuspicion maps wire levels, costs no time, and reaches the case board', () => {
  const investigation = tinyManorWithClues();
  const engine = GameEngine.create(investigation, ports);
  const before = engine.playerView().clock.t;
  const mark = (characterId: string, level: number, note?: string) =>
    engine.dispatch('desktop', {
      type: 'markSuspicion',
      characterId,
      level,
      ...(note !== undefined && { note }),
    });

  expect(mark('ch_cook', 1, 'nervous')).toEqual({ ok: true, minutesSpent: 0, events: [] });
  expect(mark('ch_porter', 2).ok).toBe(true);
  expect(engine.playerView().caseBoard.suspicions).toEqual([
    { characterId: 'ch_cook', level: 'possible', note: 'nervous' },
    { characterId: 'ch_porter', level: 'prime' },
  ]);
  expect(mark('ch_cook', 0).ok).toBe(true);
  expect(engine.playerView().caseBoard.suspicions).toEqual([
    { characterId: 'ch_cook', level: 'none', note: 'nervous' },
    { characterId: 'ch_porter', level: 'prime' },
  ]);
  expect(mark('ch_cook', 0, '').ok).toBe(true);
  expect(engine.playerView().caseBoard.suspicions.map(({ characterId }) => characterId)).toEqual([
    'ch_porter',
  ]);

  const hash = engine.stateHash();
  for (const bad of [3, 99]) {
    expect(mark('ch_cook', bad)).toMatchObject({ ok: false, error: 'ACTION_INVALID' });
  }
  expect(mark('ch_nobody', 1)).toMatchObject({ ok: false, error: 'ACTION_INVALID' });
  expect(engine.stateHash()).toBe(hash);
  expect(
    engine.dispatch('phone', { type: 'markSuspicion', characterId: 'ch_cook', level: 1 }),
  ).toMatchObject({ ok: false, error: 'ACTION_INVALID' });

  const view = engine.playerView();
  expect(view.clock.t).toBe(before);
  const json = JSON.stringify(view);
  expect(PlayerView.parse(JSON.parse(json))).toEqual(view);
  for (const key of FORBIDDEN_VIEW_KEYS) expect(json).not.toContain(`"${key}":`);

  const restored = GameEngine.restore(engine.snapshot(), investigation, ports);
  expect(restored.playerView().caseBoard.suspicions).toEqual(view.caseBoard.suspicions);
  expect(restored.stateHash()).toBe(engine.stateHash());
});

test('persons of interest come from found clues and carry names and linked clue ids', () => {
  const investigation = tinyManor();
  const clues = deriveClues(
    [
      {
        id: 'trace_note',
        kind: 'document',
        sourceEventId: investigation.truth.incident.keyEventIds[0]!,
        template: 'ledger_note',
        supports: ['means(ch_bursar)'],
        captureMode: 'auto',
        location: 'loc_study',
        availableFrom: 0,
      },
    ],
    new Map([['ledger_note', { action: { type: 'read', documentId: 'ledger_note' } } as const]]),
  );
  const engine = GameEngine.create(investigation, { ...ports, clues });
  expect(engine.playerView().caseBoard.personsOfInterest).toEqual([]);
  expect(engine.dispatch('desktop', { type: 'read', documentId: 'ledger_note' }).ok).toBe(true);
  const board = engine.playerView().caseBoard;
  const bursarName = investigation.characters.find(({ id }) => id === 'ch_bursar')!.name;
  expect(board.clues).toHaveLength(1);
  expect(board.personsOfInterest).toEqual([
    { characterId: 'ch_bursar', name: bursarName, linkedClueIds: [clues[0]!.id] },
  ]);
  // A mark neither adds nor removes persons of interest.
  engine.dispatch('desktop', { type: 'markSuspicion', characterId: 'ch_cook', level: 1 });
  expect(engine.playerView().caseBoard.personsOfInterest).toEqual(board.personsOfInterest);
});
