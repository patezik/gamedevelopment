import type { Check } from '../check.ts';
import { timelineCheck } from './timeline.ts';
import { truthInvariantsCheck } from './truth-invariants.ts';

export { timelineCheck, truthInvariantsCheck };

/** The checks implemented so far, in the order validation.md lists them. */
export const DEFAULT_CHECKS: readonly Check[] = [truthInvariantsCheck, timelineCheck];
