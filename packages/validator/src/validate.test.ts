import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@hs/core/common';
import { cleanInvestigation } from '../test/mutations.ts';
import type { Check } from './check.ts';
import { DEFAULT_CHECKS } from './checks/index.ts';
import { validateInvestigation } from './validate.ts';

const investigation = cleanInvestigation();
const check = (id: string, run: Check['run']): Check => ({ id, description: id, run });
const fail = (code = 'X'): ReturnType<Check['run']> => [
  { severity: 'error', code, message: 'something is wrong', eventIds: ['ev_1'] },
];

describe('validateInvestigation', () => {
  it('reports ok with nothing to say when no check finds anything', () => {
    const report = validateInvestigation(investigation, { checks: [check('V-A', () => [])] });
    expect(report).toEqual({
      ok: true,
      errorCount: 0,
      warningCount: 0,
      checks: [{ id: 'V-A', passed: true, findings: [] }],
      findings: [],
    });
  });

  it('accepts an empty registry', () => {
    const report = validateInvestigation(investigation, { checks: [] });
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual([]);
  });

  it('puts id, severity, message and event links on every finding', () => {
    const report = validateInvestigation(investigation, {
      checks: [check('V-A', () => fail('BAD'))],
    });
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      {
        checkId: 'V-A',
        severity: 'error',
        code: 'BAD',
        message: 'something is wrong',
        eventIds: ['ev_1'],
      },
    ]);
  });

  it('does not fail on warnings, but counts them', () => {
    const warn = check('V-W', () => [
      { severity: 'warning', code: 'W', message: 'hmm', eventIds: [] },
    ]);
    const report = validateInvestigation(investigation, { checks: [warn] });
    expect(report).toMatchObject({ ok: true, errorCount: 0, warningCount: 1 });
    expect(report.checks[0]?.passed).toBe(true);
  });

  it('fails a check that errors even next to warnings', () => {
    const mixed = check('V-M', () => [
      { severity: 'warning', code: 'W', message: 'hmm', eventIds: [] },
      ...fail(),
    ]);
    const report = validateInvestigation(investigation, { checks: [mixed] });
    expect(report).toMatchObject({ ok: false, errorCount: 1, warningCount: 1 });
    expect(report.checks[0]?.passed).toBe(false);
  });

  it('runs the checks in the order given and keeps findings in that order', () => {
    const report = validateInvestigation(investigation, {
      checks: [check('V-B', () => fail('B')), check('V-A', () => fail('A'))],
    });
    expect(report.checks.map(({ id }) => id)).toEqual(['V-B', 'V-A']);
    expect(report.findings.map(({ code }) => code)).toEqual(['B', 'A']);
  });

  it('a check that throws fails the report instead of passing it, and the rest still run', () => {
    const report = validateInvestigation(investigation, {
      checks: [
        check('V-BOOM', () => {
          throw new Error('kaboom');
        }),
        check('V-OK', () => []),
      ],
    });
    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      checkId: 'V-BOOM',
      code: 'CHECK_CRASHED',
      severity: 'error',
    });
    expect(report.findings[0]?.message).toContain('kaboom');
    expect(report.checks.map(({ id, passed }) => [id, passed])).toEqual([
      ['V-BOOM', false],
      ['V-OK', true],
    ]);
  });

  it('checks are independent: adding one does not change what another reports', () => {
    const alone = validateInvestigation(investigation, { checks: DEFAULT_CHECKS });
    const extra = check('V-EXTRA', () => fail());
    const together = validateInvestigation(investigation, { checks: [...DEFAULT_CHECKS, extra] });
    expect(together.checks.slice(0, DEFAULT_CHECKS.length)).toEqual(alone.checks);
    expect(together.ok).toBe(false);
  });

  it('passes the context to every check', () => {
    const seen: unknown[] = [];
    validateInvestigation(investigation, {
      checks: [check('V-A', (_i, context) => (seen.push(context), []))],
      context: { historyStartMinutes: -60 },
    });
    expect(seen).toEqual([{ historyStartMinutes: -60 }]);
  });

  it('gives checks an empty context when none is supplied', () => {
    const seen: unknown[] = [];
    validateInvestigation(investigation, {
      checks: [check('V-A', (_i, context) => (seen.push(context), []))],
    });
    expect(seen).toEqual([{}]);
  });

  it('produces a report that is canonical JSON', () => {
    const report = validateInvestigation(investigation, { checks: [check('V-A', () => fail())] });
    expect(() => canonicalJson(report)).not.toThrow();
  });

  it.each(['A', 'v-a', 'V-', 'V-a', 'V--A', 'X-A', '', 'V-A B'])('rejects check id %j', (id) => {
    expect(() => validateInvestigation(investigation, { checks: [check(id, () => [])] })).toThrow(
      RangeError,
    );
  });

  it('rejects a duplicate check id', () => {
    expect(() =>
      validateInvestigation(investigation, {
        checks: [check('V-A', () => []), check('V-A', () => [])],
      }),
    ).toThrow(/Duplicate check id V-A/);
  });

  it('accepts ids with digits and several words', () => {
    expect(() =>
      validateInvestigation(investigation, {
        checks: [check('V-TIME-FEASIBLE', () => []), check('V-R2D2', () => [])],
      }),
    ).not.toThrow();
  });
});
