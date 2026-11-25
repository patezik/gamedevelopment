import type { Check } from '../check.ts';
import { timeFeasibleCheck } from '../planner/planner.ts';
import { SOLVER_CHECKS } from '../solver/index.ts';
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

/** Complete validation of a generated case when its clues and deduction rules are available. */
export const GENERATION_CHECKS: readonly Check[] = [
  ...DEFAULT_CHECKS,
  ...SOLVER_CHECKS,
  timeFeasibleCheck,
];
