import { ACTIONS_BY_ROLE, type PlayerAction } from '@hs/protocol';
import { describe, expect, test } from 'vitest';
import { tinyManor } from '../../test/fixtures/tiny-manor.ts';
import { GameEngine } from './engine.ts';
import { blockReason, type BlockReason, type InteractionContext } from './interaction.ts';

type ActionType = PlayerAction['type'];

const idle: InteractionContext = {};
const talking: InteractionContext = { dialogue: 'talk' };
const interrogating: InteractionContext = { dialogue: 'interrogation' };
const ringing: InteractionContext = { call: 'ringing' };
const calling: InteractionContext = { call: 'active' };

const everyAction: ActionType[] = [...ACTIONS_BY_ROLE.desktop, ...ACTIONS_BY_ROLE.phone];

/** Every action not listed for the context is allowed. */
const matrix: ReadonlyArray<
  [string, InteractionContext, Partial<Record<ActionType, BlockReason>>]
> = [
  ['idle', idle, {}],
  ['dialogue open', talking, { call: 'dialogue_open', answerCall: 'dialogue_open' }],
  [
    'interrogation open',
    interrogating,
    {
      move: 'interrogation_open',
      pickLock: 'interrogation_open',
      rest: 'interrogation_open',
      call: 'dialogue_open',
      answerCall: 'dialogue_open',
    },
  ],
  [
    'call ringing',
    ringing,
    { talk: 'call_ringing', interrogate: 'call_ringing', call: 'call_ringing' },
  ],
  ['call active', calling, { talk: 'call_active', interrogate: 'call_active' }],
  [
    'interrogation and ringing call',
    { dialogue: 'interrogation', call: 'ringing' },
    {
      move: 'interrogation_open',
      pickLock: 'interrogation_open',
      rest: 'interrogation_open',
      call: 'dialogue_open',
      answerCall: 'dialogue_open',
      talk: 'call_ringing',
      interrogate: 'call_ringing',
    },
  ],
];

describe('interaction matrix', () => {
  for (const [name, context, blocked] of matrix) {
    test(name, () => {
      for (const action of everyAction) {
        expect(blockReason(action, context), `${name}: ${action}`).toBe(blocked[action]);
      }
    });
  }
});

describe('GameEngine arbitration', () => {
  const ports = { startLocationId: 'loc_hall' };
  const talk = { type: 'talk', characterId: 'ch_owner', topicId: 'self' } as const;

  test('an open talk does not trap the hero: moving ends it', () => {
    const engine = GameEngine.create(tinyManor(), ports);
    expect(engine.dispatch('desktop', talk).ok).toBe(true);
    expect(engine.dispatch('desktop', { type: 'move', locationId: 'loc_study' }).ok).toBe(true);
  });

  test('an active call blocks starting a conversation', () => {
    let call: 'ringing' | 'active' | undefined = 'active';
    const engine = GameEngine.create(tinyManor(), { ...ports, callState: () => call });
    expect(engine.dispatch('desktop', talk)).toMatchObject({
      ok: false,
      error: 'ACTION_BLOCKED',
      blockedReason: 'call_active',
    });
    call = undefined;
    expect(engine.dispatch('desktop', talk).ok).toBe(true);
  });

  test('a phone call is blocked during a dialogue', () => {
    const engine = GameEngine.create(tinyManor(), ports);
    engine.dispatch('desktop', talk);
    expect(engine.dispatch('phone', { type: 'call', contactId: 'ch_owner' })).toMatchObject({
      error: 'ACTION_BLOCKED',
      blockedReason: 'dialogue_open',
    });
  });
});
