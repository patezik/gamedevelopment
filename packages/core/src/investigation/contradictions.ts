import type { GameMinutes } from '../common/index.ts';
import { parsePresence, type ClaimContext } from './claims.ts';
import type { PlayerKnowledge } from './player-knowledge.ts';

/**
 * Memory blur the player must forgive. A statement's time is rounded to a 15, 30 or 60 minute
 * grid for a blur of 7, 15 or 30 minutes, so a truthful witness can be off by up to 30 minutes
 * (character-simulation.md, memory). The player never sees the exact blur, so the largest is used.
 */
export const DEFAULT_TOLERANCE_MINUTES = 30;

/** A statement that a clue contradicts. Both parts are things the player holds. */
export interface Contradiction {
  /** Stable: `ctr_<statementId>_<clueId>`. */
  readonly id: string;
  readonly statementId: string;
  readonly clueId: string;
  readonly subject: string;
  /** What was said: the subject was at `where` throughout `[from, to)`. */
  readonly claimed: {
    readonly where: string;
    readonly from: GameMinutes;
    readonly to: GameMinutes;
  };
  /** What the clue shows: the subject was at `where` during `[from, to)`. */
  readonly found: { readonly where: string; readonly from: GameMinutes; readonly to: GameMinutes };
}

export interface ContradictionFound {
  readonly type: 'ContradictionFound';
  readonly contradictionId: string;
  readonly statementId: string;
  readonly clueId: string;
  readonly at: GameMinutes;
}

/**
 * Statements the player's clues contradict. A contradiction needs both parts: a heard statement
 * that someone was at a place for a time, and a found clue that puts the same person elsewhere
 * at a moment that lies inside the stated time even after it is trimmed by `toleranceMinutes` at
 * both ends. A memory error within the tolerance therefore never shows up as a contradiction
 * (for a truthful witness, whose stated time is off by at most the tolerance, the trimmed span
 * lies within the true stay, where the person cannot also have been elsewhere).
 *
 * Reads only `PlayerKnowledge` and the clues' references; never the truth. Ordered by the
 * statement heard, then the clue found.
 */
export function detectContradictions(
  knowledge: PlayerKnowledge,
  context: Pick<ClaimContext, 'clues'>,
  toleranceMinutes: number = DEFAULT_TOLERANCE_MINUTES,
): Contradiction[] {
  const found: Contradiction[] = [];
  for (const statement of knowledge.statements) {
    const p = statement.proposition as Record<string, unknown>;
    const interval = p.interval as { from?: unknown; to?: unknown } | undefined;
    if (
      p.kind !== 'at' ||
      typeof p.who !== 'string' ||
      typeof p.where !== 'string' ||
      !Number.isSafeInteger(interval?.from) ||
      !Number.isSafeInteger(interval?.to)
    )
      continue;
    const from = interval?.from as number;
    const to = interval?.to as number;
    const [lower, upper] = [from + toleranceMinutes, to - toleranceMinutes];
    if (lower >= upper) continue;

    for (const clueId of knowledge.clues.keys()) {
      for (const reference of context.clues.get(clueId)?.supports ?? []) {
        const seen = parsePresence(reference);
        if (!seen || seen.who !== p.who || seen.where === p.where) continue;
        if (seen.from < lower || seen.to > upper) continue;
        found.push({
          id: `ctr_${statement.id}_${clueId}`,
          statementId: statement.id,
          clueId,
          subject: p.who,
          claimed: { where: p.where, from, to },
          found: { where: seen.where, from: seen.from, to: seen.to },
        });
        break;
      }
    }
  }
  return found;
}

/** The events for contradictions not yet announced; pass the ids already announced as `known`. */
export function contradictionEvents(
  contradictions: readonly Contradiction[],
  known: ReadonlySet<string>,
  at: GameMinutes,
): ContradictionFound[] {
  return contradictions
    .filter(({ id }) => !known.has(id))
    .map(({ id, statementId, clueId }) => ({
      type: 'ContradictionFound',
      contradictionId: id,
      statementId,
      clueId,
      at,
    }));
}
