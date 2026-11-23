import type { Check, FindingInput, ValidationContext } from '../check.ts';
import { GUILT_KINDS, discover, solveDeduction } from './solver.ts';

const missing = (check: string, what: string): FindingInput[] => [
  {
    severity: 'error',
    code: 'SOLVER_INPUT_MISSING',
    message: `${check} needs ${what} in the validation context`,
    eventIds: [],
  },
];

function solveFrom(investigation: Parameters<Check['run']>[0], context: ValidationContext) {
  const { clues, deductionRules, statements, startLocationId } = context;
  if (clues === undefined || deductionRules === undefined) return undefined;
  return solveDeduction({
    investigation,
    clues,
    rules: deductionRules,
    ...(statements && { statements }),
    ...(startLocationId !== undefined && { startLocationId }),
  });
}

/**
 * V-REACHABLE: every mandatory clue (all clues when `requiredClueIds` is absent) can be found by
 * a player who knows the discovery rules but not the truth: its location is connected to the
 * start and its prerequisites are satisfiable without a cycle. Time is not considered (VAL-003).
 */
export const reachableCheck: Check = {
  id: 'V-REACHABLE',
  description: 'All mandatory clues are reachable',
  run(investigation, { clues, requiredClueIds, startLocationId }) {
    if (clues === undefined) return missing('V-REACHABLE', 'clues');
    const { reachable, unreachable } = discover({
      investigation,
      clues,
      ...(startLocationId !== undefined && { startLocationId }),
    });
    const known = new Set(clues.map(({ id }) => id));
    const reached = new Set(reachable);
    const findings: FindingInput[] = [];
    for (const id of [...new Set(requiredClueIds ?? clues.map((clue) => clue.id))].sort()) {
      if (!known.has(id)) {
        findings.push({
          severity: 'error',
          code: 'REACHABLE_UNKNOWN_CLUE',
          message: `The mandatory clue ${id} is not among the clues of the case`,
          eventIds: [],
        });
      } else if (!reached.has(id)) {
        const reason = unreachable.get(id);
        const why =
          reason?.kind === 'location'
            ? `its location ${reason.locationId} cannot be reached`
            : reason?.kind === 'requirement'
              ? `its prerequisite ${reason.requirement} cannot be met`
              : 'its prerequisites form a cycle';
        const sourceEventId = clues.find((clue) => clue.id === id)?.sourceEventId;
        findings.push({
          severity: 'error',
          code: 'CLUE_UNREACHABLE',
          message: `The mandatory clue ${id} cannot be found: ${why}`,
          eventIds: sourceEventId ? [sourceEventId] : [],
          data: { clueId: id, reason: reason?.kind ?? 'cycle' },
        });
      }
    }
    return findings;
  },
};

/**
 * V-CULPRIT-PROVABLE: with everything reachable, the deduction rules establish motive, means and
 * opportunity for every culprit.
 */
export const culpritProvableCheck: Check = {
  id: 'V-CULPRIT-PROVABLE',
  description: 'Reachable evidence establishes motive, means and opportunity of the culprit',
  run(investigation, context) {
    const solution = solveFrom(investigation, context);
    if (!solution) return missing('V-CULPRIT-PROVABLE', 'clues and deductionRules');
    return solution.culpritIds.flatMap((id): FindingInput[] => {
      const have = solution.kindsBy.get(id) ?? new Set<string>();
      const lacking = GUILT_KINDS.filter((kind) => !have.has(kind));
      return lacking.length === 0
        ? []
        : [
            {
              severity: 'error',
              code: 'CULPRIT_NOT_PROVABLE',
              message: `Reachable evidence does not establish ${lacking.join(', ')} of culprit ${id}`,
              eventIds: [...investigation.truth.incident.keyEventIds.slice(0, 1)],
              subject: { kind: 'character', id },
              data: { missing: lacking.join(',') },
            },
          ];
    });
  },
};

/**
 * V-UNIQUE: nobody but the culprit has motive, means and opportunity all established. An alibi,
 * or the lack of a means or a motive in the evidence, is what excludes a character.
 */
export const uniqueCheck: Check = {
  id: 'V-UNIQUE',
  description: 'Every other character is excluded by reachable evidence',
  run(investigation, context) {
    const solution = solveFrom(investigation, context);
    if (!solution) return missing('V-UNIQUE', 'clues and deductionRules');
    const culprits = new Set(solution.culpritIds);
    return solution.provable
      .filter((id) => !culprits.has(id))
      .map((id): FindingInput => ({
        severity: 'error',
        code: 'NOT_UNIQUE',
        message: `Character ${id} is not excluded: motive, means and opportunity are all provable for them`,
        eventIds: [...investigation.truth.incident.keyEventIds.slice(0, 1)],
        subject: { kind: 'character', id },
      }));
  },
};

export const SOLVER_CHECKS: readonly Check[] = [reachableCheck, culpritProvableCheck, uniqueCheck];
