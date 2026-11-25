import type { PlayerAction } from '@hs/protocol';
import type { Clue } from '../../evidence/index.ts';
import {
  AccusationError,
  evaluateAccusation,
  type AccusationOutcome,
  type CaseFile,
  type ClaimContext,
  type DeductionRules,
} from '../../investigation/index.ts';
import type { Investigation } from '../investigation.ts';
import type { GameEvent } from './events.ts';
import type { DesktopState } from './state.ts';

/** What `accuse` needs beyond the investigation: the compiled deduction rules (INV-004). */
export interface AccusationPort {
  readonly rules: DeductionRules;
  /** Clues that are hallucinations (server side); a case file naming one is refused. */
  readonly hallucinatedClueIds?: ReadonlySet<string>;
  /**
   * The incident as the player has worked it out (location and window), for rules that read
   * `$incident`. Not the true one: the caller derives it from body examination and testimony.
   */
  readonly incident?: ClaimContext['incident'];
}

export type AccuseResult =
  | { readonly ok: false }
  | {
      readonly ok: true;
      readonly events: GameEvent[];
      /** Set when the accusation was judged; goes to the simulation only, never to a client. */
      readonly outcome?: AccusationOutcome;
    };

/**
 * `accuse` (game-design.md section 5). The player confirms twice: a request with `confirm: false`
 * only asks the client to confirm and changes nothing. A confirmed one is judged by
 * `evaluateAccusation`. A correct accusation, a second wrong one, or one with no time left ends
 * the game (`state.verdict`). A first wrong accusation with time left is forgiven once: the
 * investigation goes on. The returned events never name a culprit; `outcome.consequences` do, so
 * the caller hands `outcome` to the server-side simulation only.
 */
export function accuse(
  action: Extract<PlayerAction, { type: 'accuse' }>,
  state: DesktopState,
  env: {
    readonly investigation: Investigation;
    readonly clues: readonly Clue[];
    readonly port: AccusationPort;
    readonly now: number;
  },
): AccuseResult {
  if (!action.confirm) {
    return { ok: true, events: [{ type: 'AccusationConfirmationRequired', at: env.now }] };
  }
  const { caseFile } = action;
  const file: CaseFile = {
    accusedIds: caseFile.accusedIds,
    evidence: caseFile.evidence,
    ...(caseFile.motive !== undefined && { motive: caseFile.motive }),
    ...(caseFile.means !== undefined && { means: caseFile.means }),
    ...(caseFile.opportunity !== undefined && { opportunity: caseFile.opportunity }),
  };
  const known = new Set(env.investigation.characters.map(({ id }) => id));
  if (file.accusedIds.some((id) => !known.has(id))) return { ok: false };

  let outcome: AccusationOutcome;
  try {
    outcome = evaluateAccusation(file, env.investigation.truth.incident, state.knowledge, {
      rules: env.port.rules,
      clues: new Map(env.clues.map((clue) => [clue.id, clue])),
      ...(env.port.incident && { incident: env.port.incident }),
      ...(env.port.hallucinatedClueIds && { hallucinatedClueIds: env.port.hallucinatedClueIds }),
    });
  } catch (error) {
    if (error instanceof AccusationError) return { ok: false };
    throw error;
  }

  const timeLeft = env.now < env.investigation.world.durationMinutes;
  const forgiven =
    outcome.endingId === 'wrong_accusation' && timeLeft && state.failedAccusations === 0;
  if (forgiven) state.failedAccusations += 1;
  else state.verdict = { endingId: outcome.endingId, proven: { ...outcome.proven } };

  return {
    ok: true,
    outcome,
    events: [
      {
        type: 'AccusationMade',
        at: env.now,
        result: outcome.endingId,
        proven: { ...outcome.proven },
        final: !forgiven,
      },
    ],
  };
}
