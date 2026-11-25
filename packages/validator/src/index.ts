export const VALIDATOR_PACKAGE_NAME = '@hs/validator';

export type {
  Check,
  CheckResult,
  Finding,
  FindingInput,
  Severity,
  ValidationContext,
  ValidationReport,
} from './check.ts';
export {
  DEFAULT_CHECKS,
  TESTIMONY_CHECKS,
  collectTestimony,
  liesBreakableCheck,
  testimonyCheck,
  determinismCheck,
  hallucinationCheck,
  investigationHash,
  phoneRequiredCheck,
  timelineCheck,
  truthInvariantsCheck,
} from './checks/index.ts';
export type { TestimonyWitness } from './checks/testimony.ts';
export { validateInvestigation, type ValidateOptions } from './validate.ts';
export {
  SOLVER_CHECKS,
  culpritProvableCheck,
  discover,
  reachableCheck,
  reachableLocations,
  solveDeduction,
  uniqueCheck,
  type Solution,
} from './solver/index.ts';
