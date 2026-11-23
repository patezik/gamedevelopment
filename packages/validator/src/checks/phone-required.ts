import type { Check, FindingInput } from '../check.ts';

/**
 * V-PHONE-REQUIRED: the phone is not optional. At least `minQrShare` of the mandatory clues must
 * be captured by QR (`captureMode: qr`). Needs `clues`, `requiredClueIds` and `minQrShare` in the
 * context; without them the check cannot prove anything and fails.
 */
export const phoneRequiredCheck: Check = {
  id: 'V-PHONE-REQUIRED',
  description: 'At least minQrShare of the mandatory clues are captured by QR',
  run(_investigation, { clues, requiredClueIds, minQrShare }) {
    if (clues === undefined || requiredClueIds === undefined || minQrShare === undefined) {
      return [
        {
          severity: 'error',
          code: 'PHONE_INPUT_MISSING',
          message:
            'V-PHONE-REQUIRED needs clues, requiredClueIds and minQrShare in the validation context',
          eventIds: [],
        },
      ];
    }
    if (!Number.isFinite(minQrShare) || minQrShare < 0 || minQrShare > 1) {
      return [
        {
          severity: 'error',
          code: 'PHONE_INVALID_MIN_SHARE',
          message: `minQrShare must be between 0 and 1, got ${minQrShare}`,
          eventIds: [],
        },
      ];
    }

    const byId = new Map(clues.map((clue) => [clue.id, clue]));
    const required = [...new Set(requiredClueIds)].sort();
    const findings: FindingInput[] = [];
    let qr = 0;
    for (const id of required) {
      const clue = byId.get(id);
      if (clue === undefined) {
        findings.push({
          severity: 'error',
          code: 'PHONE_UNKNOWN_REQUIRED_CLUE',
          message: `The mandatory clue ${id} is not among the clues of the case`,
          eventIds: [],
        });
      } else if (clue.captureMode === 'qr') {
        qr++;
      }
    }
    if (findings.length > 0) return findings;

    if (required.length === 0) {
      // Nothing is mandatory, so no clue can need the phone: that only passes when none is asked for.
      return minQrShare > 0
        ? [
            {
              severity: 'error',
              code: 'PHONE_NO_REQUIRED_CLUES',
              message: `There are no mandatory clues, so the QR share ${minQrShare} cannot be met`,
              eventIds: [],
              data: { minQrShare },
            },
          ]
        : [];
    }
    // Division, not `required * minQrShare`: 3 / 10 equals 0.3, while 10 * 0.3 is 3.0000000000000004.
    if (qr / required.length >= minQrShare) return [];
    const first = byId.get(required[0] ?? '');
    return [
      {
        severity: 'error',
        code: 'PHONE_QR_SHARE_TOO_LOW',
        message: `Only ${qr} of ${required.length} mandatory clues are captured by QR; the share must be at least ${minQrShare}`,
        eventIds: first ? [first.sourceEventId] : [],
        data: { qr, required: required.length, minQrShare },
      },
    ];
  },
};
