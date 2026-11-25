import { SUSPICION_LEVELS, type SuspicionLevel } from '../../investigation/index.ts';
import type { PlayerKnowledge } from '../../investigation/index.ts';

/** `markSuspicion.level` on the wire is an index into `SUSPICION_LEVELS`; anything else is invalid. */
export function suspicionLevelOf(level: number): SuspicionLevel | undefined {
  return Number.isInteger(level) ? SUSPICION_LEVELS[level] : undefined;
}

/**
 * Applies `markSuspicion`. Costs no game time: no clock is read or moved. Returns `false` when
 * the request is invalid (unknown character or level outside `SUSPICION_LEVELS`).
 */
export function applyMarkSuspicion(
  knowledge: PlayerKnowledge,
  characterIds: ReadonlySet<string>,
  action: { readonly characterId: string; readonly level: number; readonly note?: string },
): boolean {
  const level = suspicionLevelOf(action.level);
  if (level === undefined || !characterIds.has(action.characterId)) return false;
  knowledge.markSuspicion(action.characterId, level, action.note);
  return true;
}
