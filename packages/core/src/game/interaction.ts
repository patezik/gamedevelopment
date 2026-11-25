import type { PlayerAction } from '@hs/protocol';

type ActionType = PlayerAction['type'];

/** What occupies the hero right now: an open conversation on desktop, a call on the phone. */
export interface InteractionContext {
  /** The open conversation: a talk, or an interrogation that holds the hero in place. */
  readonly dialogue?: 'talk' | 'interrogation' | undefined;
  /** The phone call state, if there is a call. */
  readonly call?: 'ringing' | 'active' | undefined;
}

export type BlockReason = 'dialogue_open' | 'interrogation_open' | 'call_ringing' | 'call_active';

/** A conversation and a phone call do not overlap. */
const BLOCKED_BY_DIALOGUE: ReadonlySet<ActionType> = new Set(['call', 'answerCall']);
/** An interrogation also holds the hero in place; any other action ends it. */
const BLOCKED_BY_INTERROGATION: ReadonlySet<ActionType> = new Set(['move', 'pickLock', 'rest']);
/** A call blocks starting a face-to-face conversation. */
const BLOCKED_BY_CALL: ReadonlySet<ActionType> = new Set(['talk', 'interrogate']);
/** A ringing phone also blocks placing another call. */
const BLOCKED_BY_RINGING: ReadonlySet<ActionType> = new Set(['call']);

/**
 * The compatibility matrix of the open interaction against a new action (modules.md section 12).
 * Returns the reason for `ACTION_BLOCKED`, or `undefined` when the action may go ahead. Pure:
 * it reads nothing but its arguments, so the same state always arbitrates the same way.
 */
export function blockReason(
  action: ActionType,
  context: InteractionContext,
): BlockReason | undefined {
  if (context.dialogue === 'interrogation' && BLOCKED_BY_INTERROGATION.has(action))
    return 'interrogation_open';
  if (context.dialogue && BLOCKED_BY_DIALOGUE.has(action)) return 'dialogue_open';
  if (context.call === 'active' && BLOCKED_BY_CALL.has(action)) return 'call_active';
  if (context.call === 'ringing' && (BLOCKED_BY_CALL.has(action) || BLOCKED_BY_RINGING.has(action)))
    return 'call_ringing';
  return undefined;
}
