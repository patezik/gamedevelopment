import type { GameMinutes } from '@hs/core/common';
import type { Investigation } from '@hs/core/game';
import type { EntityRef } from '@hs/core/truth/facts';

export type Severity = 'error' | 'warning';

/** One problem a check found. `eventIds` link it to the truth log (the first is where it shows). */
export interface Finding {
  readonly checkId: string;
  readonly severity: Severity;
  /** Stable machine-readable code; tests and the repair step match on it, never on `message`. */
  readonly code: string;
  readonly message: string;
  readonly eventIds: readonly string[];
  readonly subject?: EntityRef;
  readonly minute?: GameMinutes;
  /** Extra numbers or labels for the code, e.g. which invariant was broken. */
  readonly data?: Readonly<Record<string, string | number>>;
}

/** A finding as a check writes it: the runner adds `checkId`. */
export type FindingInput = Omit<Finding, 'checkId'>;

/** Facts about the scenario that the investigation itself does not carry. */
export interface ValidationContext {
  /**
   * First minute of the generated prehistory (the preset's `time.historyStartMinutes`, 0 or
   * below). `Investigation` stores the scenario end but not this, so checks that need it skip it
   * when it is absent.
   */
  readonly historyStartMinutes?: GameMinutes;
}

/** One validation rule from docs/investigation/validation.md; checks are independent. */
export interface Check {
  /** `V-` followed by upper-case words, e.g. `V-TIMELINE`. Unique within one run. */
  readonly id: string;
  readonly description: string;
  /** Must be deterministic and must not modify the investigation. */
  run(investigation: Investigation, context: ValidationContext): readonly FindingInput[];
}

export interface CheckResult {
  readonly id: string;
  /** True when the check reported no `error` finding (warnings do not fail a check). */
  readonly passed: boolean;
  readonly findings: readonly Finding[];
}

export interface ValidationReport {
  /** True when no check reported an `error`: the investigation may be handed to a player. */
  readonly ok: boolean;
  readonly errorCount: number;
  readonly warningCount: number;
  /** One entry per check, in the order the checks were given. */
  readonly checks: readonly CheckResult[];
  /** Every finding of every check, in the same order. */
  readonly findings: readonly Finding[];
}
