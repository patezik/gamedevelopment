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
  determinismCheck,
  investigationHash,
  phoneRequiredCheck,
  timelineCheck,
  truthInvariantsCheck,
} from './checks/index.ts';
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
