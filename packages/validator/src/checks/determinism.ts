import { stateHash } from '@hs/core/common';
import { snapshotInvestigation, type Investigation } from '@hs/core/game';
import type { Check } from '../check.ts';

/** Hash of everything the investigation consists of (its canonical snapshot). */
export const investigationHash = (investigation: Investigation): string =>
  stateHash(snapshotInvestigation(investigation));

/**
 * V-DETERMINISM: generating again with the same inputs gives the same investigation. The context
 * supplies `regenerate`; the hashes of the two investigations must be equal.
 */
export const determinismCheck: Check = {
  id: 'V-DETERMINISM',
  description: 'A second generation with the same seed gives the same investigationHash',
  run(investigation, { regenerate }) {
    if (regenerate === undefined) {
      return [
        {
          severity: 'error',
          code: 'DETERMINISM_INPUT_MISSING',
          message: 'V-DETERMINISM needs regenerate in the validation context',
          eventIds: [],
        },
      ];
    }
    let again: Investigation;
    try {
      again = regenerate();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return [
        {
          severity: 'error',
          code: 'DETERMINISM_REGENERATION_FAILED',
          message: `Generating the investigation again failed: ${reason}`,
          eventIds: [],
        },
      ];
    }
    const first = investigationHash(investigation);
    const second = investigationHash(again);
    if (first === second) return [];
    return [
      {
        severity: 'error',
        code: 'DETERMINISM_HASH_MISMATCH',
        message: `Two generations of seed ${investigation.seed} differ: ${first} against ${second}`,
        eventIds: [],
        data: { first, second },
      },
    ];
  },
};
