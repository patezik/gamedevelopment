export const VALIDATOR_PACKAGE_NAME = '@hs/validator';
export {
  solutionSource,
  solve,
  timeFeasibleCheck,
  type PlannerOptions,
  type SolutionPath,
} from './planner/planner.ts';

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
  GENERATION_CHECKS,
  TESTIMONY_CHECKS,
  collectTestimony,
  liesBreakableCheck,
  testimonyCheck,
  determinismCheck,
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
