import { checkTruthInvariants } from '@hs/core/truth';
import type { Check, FindingInput } from '../check.ts';

/**
 * V-TRUTH-INV: invariants 1-5 and 7 of the truth model (truth-model.md section 4), by way of
 * `checkTruthInvariants`. Invariant 6 needs character observations and is not checked here:
 * that is the open decision OQ-13.
 */
export const truthInvariantsCheck: Check = {
  id: 'V-TRUTH-INV',
  description: 'Truth model invariants 1-5 and 7',
  run({ truth, world }) {
    return checkTruthInvariants(truth, world).map((violation): FindingInput => ({
      severity: 'error',
      code: violation.code,
      message: violation.message,
      eventIds: violation.eventIds,
      ...(violation.subject ? { subject: violation.subject } : {}),
      ...(violation.minute !== undefined ? { minute: violation.minute } : {}),
      data: { invariant: violation.invariant },
    }));
  },
};
