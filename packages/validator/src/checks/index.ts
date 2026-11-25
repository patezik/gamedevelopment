import type { Check } from '../check.ts';
import { determinismCheck, investigationHash } from './determinism.ts';
import { phoneRequiredCheck } from './phone-required.ts';
import {
  liesBreakableCheck,
  testimonyCheck,
  collectTestimony,
  TESTIMONY_CHECKS,
} from './testimony.ts';
import { timelineCheck } from './timeline.ts';
import { truthInvariantsCheck } from './truth-invariants.ts';

export {
  TESTIMONY_CHECKS,
  collectTestimony,
  liesBreakableCheck,
  testimonyCheck,
  determinismCheck,
  investigationHash,
  phoneRequiredCheck,
  timelineCheck,
  truthInvariantsCheck,
};

/** The checks implemented so far, in the order validation.md lists them. */
export const DEFAULT_CHECKS: readonly Check[] = [
  truthInvariantsCheck,
  timelineCheck,
  phoneRequiredCheck,
  determinismCheck,
];
