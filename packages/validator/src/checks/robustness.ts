import type { Clue } from '@hs/core/evidence';
import type { Investigation } from '@hs/core/game';
import type { HeardStatement } from '@hs/core/investigation';
import type { Check, FindingInput, Severity, ValidationContext } from '../check.ts';
import { GUILT_KINDS, solveDeduction, type Solution } from '../solver/index.ts';

/** Share of the scenario duration the case must stay solvable for a passive player (validation.md §1). */
export const T_SAFE_SHARE = 0.25;

const missing = (check: string): FindingInput[] => [
  {
    severity: 'error',
    code: 'SOLVER_INPUT_MISSING',
    message: `${check} needs clues and deductionRules in the validation context`,
    eventIds: [],
  },
];

function solve(
  investigation: Investigation,
  context: Required<Pick<ValidationContext, 'clues' | 'deductionRules'>> & ValidationContext,
  clues: readonly Clue[],
  statements: readonly HeardStatement[],
): Solution {
  const { deductionRules, startLocationId } = context;
  return solveDeduction({
    investigation,
    clues,
    rules: deductionRules,
    statements,
    ...(startLocationId !== undefined && { startLocationId }),
  });
}

/** A piece of evidence the player may lose: a clue or one statement of a witness. */
type Unit =
  | { readonly kind: 'clue'; readonly id: string }
  | { readonly kind: 'statement'; readonly id: string };

/**
 * The evidence the guilt claims of the culprits stand on, directly or through earlier claims, and
 * the clues those clues wait for. Losing anything else cannot change a guilt claim, so the search
 * for single cuts skips it (a full sweep of every clue and statement costs seconds per case).
 */
function relevantUnits(
  solution: Solution,
  clues: readonly Clue[],
  statements: readonly HeardStatement[],
): Unit[] {
  const byText = new Map(solution.claims.map((claim) => [claim.claim, claim]));
  const known = new Map(clues.map((clue) => [clue.id, clue]));
  const clueIds = new Set<string>();
  const statementIds = new Set<string>();
  const seen = new Set<string>();
  const queue = solution.claims
    .filter(
      ({ kind, subject }) =>
        solution.culpritIds.includes(subject) && GUILT_KINDS.some((k) => k === kind),
    )
    .map(({ claim }) => claim);
  for (let text = queue.pop(); text !== undefined; text = queue.pop()) {
    if (seen.has(text)) continue;
    seen.add(text);
    const claim = byText.get(text);
    if (!claim) continue;
    claim.support.clueIds.forEach((id) => clueIds.add(id));
    claim.support.statementIds.forEach((id) => statementIds.add(id));
    queue.push(...claim.support.claims);
  }
  const pending = [...clueIds];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const { kind, id: needed } of known.get(id)?.discovery.requires ?? []) {
      if ((kind === 'clue' || kind === 'password') && !clueIds.has(needed)) {
        clueIds.add(needed);
        pending.push(needed);
      }
    }
  }
  return [
    ...[...clueIds].sort().map((id): Unit => ({ kind: 'clue', id })),
    ...statements
      .filter(({ id }) => statementIds.has(id))
      .map(({ id }): Unit => ({ kind: 'statement', id })),
  ];
}

/**
 * V-REDUNDANCY (minimal cut): for every culprit, the motive, the means and the opportunity must
 * each survive the loss of any single piece of evidence (one clue or one statement). A piece whose
 * loss removes the element is a cut of size 1, that is, the element has no second independent
 * path. Dependants of a lost clue (`requires: clue`) fall with it. Elements the culprit does not
 * establish at all are `V-CULPRIT-PROVABLE`'s business and are skipped here.
 *
 * `severity` is `warning` by default and `error` for the MVP preset (validation.md §1).
 */
export function createRedundancyCheck(severity: Severity = 'warning'): Check {
  return {
    id: 'V-REDUNDANCY',
    description: 'Motive, means and opportunity each have at least two independent paths',
    run(investigation, context) {
      const { clues, deductionRules } = context;
      if (clues === undefined || deductionRules === undefined) return missing('V-REDUNDANCY');
      const input = { ...context, clues, deductionRules };
      const statements = context.statements ?? [];
      const full = solve(investigation, input, clues, statements);
      const units = relevantUnits(full, clues, statements);
      // "culprit|kind" -> the units whose single loss removes the element.
      const cuts = new Map<string, string[]>();
      for (const unit of units) {
        const without = solve(
          investigation,
          input,
          unit.kind === 'clue' ? clues.filter(({ id }) => id !== unit.id) : clues,
          unit.kind === 'statement' ? statements.filter(({ id }) => id !== unit.id) : statements,
        );
        for (const culprit of full.culpritIds) {
          const had = full.kindsBy.get(culprit) ?? new Set<string>();
          const has = without.kindsBy.get(culprit) ?? new Set<string>();
          for (const kind of GUILT_KINDS) {
            if (!had.has(kind) || has.has(kind)) continue;
            const key = `${culprit}|${kind}`;
            cuts.set(key, [...(cuts.get(key) ?? []), `${unit.kind}:${unit.id}`]);
          }
        }
      }
      return [...cuts]
        .sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
        .map(([key, lost]): FindingInput => {
          const [culprit = '', kind = ''] = key.split('|');
          return {
            severity,
            code: 'SINGLE_PATH',
            message: `The ${kind} of culprit ${culprit} rests on a single piece of evidence: losing any of ${lost.slice(0, 3).join(', ')}${lost.length > 3 ? ', ...' : ''} removes it`,
            eventIds: [...investigation.truth.incident.keyEventIds.slice(0, 1)],
            subject: { kind: 'character', id: culprit },
            data: { element: kind, cutSize: lost.length, first: lost[0] ?? '' },
          };
        });
    },
  };
}

export const redundancyCheck: Check = createRedundancyCheck('warning');
/** `V-REDUNDANCY` as an error: for the MVP preset. */
export const strictRedundancyCheck: Check = createRedundancyCheck('error');

/** `floor(durationMinutes * 25 %)`: the case must stay solvable up to this minute. */
export const tSafe = (investigation: Investigation): number =>
  Math.floor(investigation.world.durationMinutes * T_SAFE_SHARE);

/**
 * V-CLEANUP: passive play. Nobody does anything, and the clues fade on their own schedule
 * (`availableUntil` comes from the decay and the `destroy` events of the truth log: concealment
 * and spoilage). The check replays the case at every minute a clue disappears, from 0 up to
 * `t_safe` (inclusive), with only the clues still there, and reports the first minute at which the
 * culprit is no longer provable. A case still provable at `t_safe` passes.
 *
 * Limits: only the concealment already in the truth log is replayed; the live reaction of
 * characters to the player (ConcealEvidence in a running engine) is not simulated here. Statements
 * do not expire. A clue is evaluated as found from scratch at that minute: the player has not
 * found its prerequisites earlier.
 */
export const cleanupCheck: Check = {
  id: 'V-CLEANUP',
  description: 'The case stays solvable for a passive player until t_safe (25% of the scenario)',
  run(investigation, context) {
    const { clues, deductionRules } = context;
    if (clues === undefined || deductionRules === undefined) return missing('V-CLEANUP');
    const input = { ...context, clues, deductionRules };
    const statements = context.statements ?? [];
    const safe = tSafe(investigation);
    // What a player with every clue still in place establishes: only losses against it count here;
    // an element that was never provable is `V-CULPRIT-PROVABLE`'s finding.
    const baseline = solve(investigation, input, clues, statements);
    const minutes = [
      ...new Set([
        0,
        ...clues.flatMap(({ discovery }) =>
          discovery.availableUntil !== undefined &&
          discovery.availableUntil > 0 &&
          discovery.availableUntil <= safe
            ? [discovery.availableUntil]
            : [],
        ),
      ]),
    ].sort((a, b) => a - b);
    for (const minute of minutes) {
      const remaining = clues.filter(
        ({ discovery }) =>
          discovery.availableUntil === undefined || discovery.availableUntil > minute,
      );
      const solution = solve(investigation, input, remaining, statements);
      const lacking = solution.culpritIds.flatMap((id) => {
        const had = baseline.kindsBy.get(id) ?? new Set<string>();
        const have = solution.kindsBy.get(id) ?? new Set<string>();
        return GUILT_KINDS.filter((kind) => had.has(kind) && !have.has(kind)).map(
          (kind) => `${id}:${kind}`,
        );
      });
      if (lacking.length > 0) {
        return [
          {
            severity: 'error',
            code: 'CLEANUP_CASE_LOST',
            message: `With nobody investigating, the case stops being solvable at minute ${minute}, before t_safe ${safe} (${lacking.join(', ')} cannot be established)`,
            eventIds: [...investigation.truth.incident.keyEventIds.slice(0, 1)],
            minute,
            data: { minute, tSafe: safe, missing: lacking.join(',') },
          },
        ];
      }
    }
    return [];
  },
};

export const ROBUSTNESS_CHECKS: readonly Check[] = [redundancyCheck, cleanupCheck];
