import type { Investigation } from '@hs/core/game';
import type { Check, CheckResult, Finding, ValidationContext, ValidationReport } from './check.ts';

export interface ValidateOptions {
  readonly checks: readonly Check[];
  readonly context?: ValidationContext;
}

const CHECK_ID = /^V-[A-Z0-9]+(-[A-Z0-9]+)*$/;

function assertRegistry(checks: readonly Check[]): void {
  const seen = new Set<string>();
  for (const { id } of checks) {
    if (!CHECK_ID.test(id)) throw new RangeError(`Invalid check id "${id}": expected V-<NAME>`);
    if (seen.has(id)) throw new RangeError(`Duplicate check id ${id}`);
    seen.add(id);
  }
}

function runCheck(
  check: Check,
  investigation: Investigation,
  context: ValidationContext,
): CheckResult {
  let findings: Finding[];
  try {
    findings = check
      .run(investigation, context)
      .map((finding) => ({ ...finding, checkId: check.id }));
  } catch (error) {
    // A check that cannot run proves nothing, so it must fail the report instead of passing it.
    const reason = error instanceof Error ? error.message : String(error);
    findings = [
      {
        checkId: check.id,
        severity: 'error',
        code: 'CHECK_CRASHED',
        message: `${check.id} could not run: ${reason}`,
        eventIds: [],
      },
    ];
  }
  return { id: check.id, passed: findings.every(({ severity }) => severity !== 'error'), findings };
}

/**
 * Runs the given checks in order and collects their findings into one report. Checks are
 * independent of each other, so adding one never changes what another reports. Throws
 * `RangeError` for a malformed or duplicate check id.
 */
export function validateInvestigation(
  investigation: Investigation,
  { checks, context = {} }: ValidateOptions,
): ValidationReport {
  assertRegistry(checks);
  const results = checks.map((check) => runCheck(check, investigation, context));
  const findings = results.flatMap((result) => result.findings);
  const errorCount = findings.filter(({ severity }) => severity === 'error').length;
  return {
    ok: errorCount === 0,
    errorCount,
    warningCount: findings.length - errorCount,
    checks: results,
    findings,
  };
}
