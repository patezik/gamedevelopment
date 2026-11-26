import { readFileSync } from 'node:fs';
import { deriveClues, type Clue } from '@hs/core/evidence';
import type { Investigation } from '@hs/core/game';
import { compileDeductionRules } from '@hs/core/investigation';
import { describe, expect, it } from 'vitest';
import { tinyManor } from '../../../core/test/fixtures/tiny-manor.ts';
import type { ValidationContext } from '../check.ts';
import { validateInvestigation } from '../validate.ts';
import {
  ROBUSTNESS_CHECKS,
  cleanupCheck,
  redundancyCheck,
  strictRedundancyCheck,
  tSafe,
} from './robustness.ts';

const file = (scenario: string): object[] =>
  JSON.parse(
    readFileSync(`content/scenarios/${scenario}/deduction-rules.json`, 'utf8'),
  ) as object[];
const [opportunity, , motive] = file('sanatorium_winter') as [object, object, object];
const deductionRules = compileDeductionRules([
  opportunity,
  { id: 'means_from_log', establishes: 'means($actor)', requires: ['access_to_record($actor)'] },
  motive,
]);

type Element = 'opportunity' | 'motive' | 'means';

/** One clue per supports list; every spec gets its own template so the clues are independent. */
function cluesFor(investigation: Investigation, specs: readonly (readonly [string, string[]])[]) {
  const sourceEventId = investigation.truth.incident.keyEventIds[0]!;
  return deriveClues(
    specs.map(([template, supports]) => ({
      id: `trace_${template}`,
      kind: 'document' as const,
      sourceEventId,
      template,
      supports,
      captureMode: 'qr' as const,
      location: 'loc_study',
      availableFrom: 0,
    })),
    new Map(
      specs.map(([template]) => [
        template,
        { action: { type: 'read' as const, documentId: template } },
      ]),
    ),
  );
}

/** Evidence of each guilt element, `copies` independent times. */
function evidence(investigation: Investigation, copies: Record<Element, number>) {
  const { incident } = investigation.truth;
  const who = incident.culpritIds[0]!;
  const victim = incident.victimIds[0]!;
  const specs: (readonly [string, string[]])[] = [];
  for (let n = 1; n <= copies.opportunity; n++) {
    specs.push([`ledger_${n}`, [`presence(${who},loc_study,${incident.window.from})`]]);
  }
  for (let n = 1; n <= copies.motive; n++) {
    specs.push([`debt_${n}`, [`knows(${who},sec_manor_debt)`, `about(sec_manor_debt,${victim})`]]);
  }
  for (let n = 1; n <= copies.means; n++) specs.push([`log_${n}`, [`access_to_record(${who})`]]);
  return cluesFor(investigation, specs);
}

const context = (clues: Clue[]): ValidationContext => ({ clues, deductionRules });
const run = (investigation: Investigation, clues: Clue[], checks = ROBUSTNESS_CHECKS) =>
  validateInvestigation(investigation, { checks, context: context(clues) });
const codes = (investigation: Investigation, clues: Clue[], checks = ROBUSTNESS_CHECKS) =>
  run(investigation, clues, checks).findings.map(
    ({ checkId, code, data }) => `${checkId}:${code}:${data?.element ?? ''}`,
  );

/** Clues of one element (their templates start with `prefix`) with an end of availability. */
const expiring = (clues: Clue[], prefix: string, until: number): Clue[] =>
  clues.map((clue) =>
    clue.presentation.startsWith(prefix)
      ? { ...clue, discovery: { ...clue.discovery, availableUntil: until } }
      : clue,
  );

const doubled = { opportunity: 2, motive: 2, means: 2 };

describe('V-REDUNDANCY', () => {
  it('passes a case in which every element has two independent paths', () => {
    const investigation = tinyManor();
    expect(codes(investigation, evidence(investigation, doubled))).toEqual([]);
  });

  it.each(['opportunity', 'motive', 'means'] as const)(
    'catches the mutation "a single clue of the %s"',
    (element) => {
      const investigation = tinyManor();
      const clues = evidence(investigation, { ...doubled, [element]: 1 });
      expect(codes(investigation, clues)).toEqual([`V-REDUNDANCY:SINGLE_PATH:${element}`]);
    },
  );

  it('is a warning by default and an error for the MVP preset', () => {
    const investigation = tinyManor();
    const clues = evidence(investigation, { ...doubled, means: 1 });
    const [warning] = run(investigation, clues, [redundancyCheck]).findings;
    expect(warning).toMatchObject({ severity: 'warning', data: { element: 'means', cutSize: 1 } });
    const strict = run(investigation, clues, [strictRedundancyCheck]);
    expect(strict.ok).toBe(false);
    expect(strict.findings[0]?.severity).toBe('error');
    expect(run(investigation, clues, [redundancyCheck]).ok).toBe(true);
  });

  it('reports every element that rests on one piece of evidence, and names the culprit', () => {
    const investigation = tinyManor();
    const culprit = investigation.truth.incident.culpritIds[0]!;
    const report = run(
      investigation,
      evidence(investigation, { opportunity: 1, motive: 1, means: 1 }),
    );
    expect(report.findings.map(({ data }) => data?.element)).toEqual([
      'means',
      'motive',
      'opportunity',
    ]);
    expect(report.findings.every(({ subject }) => subject?.id === culprit)).toBe(true);
  });

  it('counts a dependant of a lost clue as lost with it', () => {
    const investigation = tinyManor();
    const all = evidence(investigation, doubled);
    const first = all.find((clue) => clue.presentation === 'log_1')!;
    // log_2 can only be found after log_1: two clues, but one path.
    const chained = all.map((clue) =>
      clue.presentation === 'log_2'
        ? {
            ...clue,
            discovery: {
              ...clue.discovery,
              requires: [{ kind: 'clue' as const, id: first.id }],
            },
          }
        : clue,
    );
    expect(codes(investigation, chained)).toEqual(['V-REDUNDANCY:SINGLE_PATH:means']);
  });

  it('skips an element the case does not establish: that is V-CULPRIT-PROVABLE', () => {
    const investigation = tinyManor();
    const clues = evidence(investigation, { ...doubled, means: 0 });
    expect(codes(investigation, clues)).toEqual([]);
  });

  it('reports missing input instead of passing', () => {
    const investigation = tinyManor();
    const report = validateInvestigation(investigation, { checks: ROBUSTNESS_CHECKS });
    expect(report.findings.map(({ code }) => code)).toEqual([
      'SOLVER_INPUT_MISSING',
      'SOLVER_INPUT_MISSING',
    ]);
  });
});

describe('V-CLEANUP', () => {
  const investigation = tinyManor();
  const safe = tSafe(investigation);
  const clues = evidence(investigation, doubled);

  it('t_safe is a quarter of the scenario duration', () => {
    expect(safe).toBe(Math.floor(investigation.world.durationMinutes / 4));
    expect(safe).toBeGreaterThan(2);
  });

  it('passes while the clues last past t_safe, or never expire', () => {
    expect(codes(investigation, clues, [cleanupCheck])).toEqual([]);
    const lasting = expiring(clues, 'log_', safe + 1);
    expect(codes(investigation, lasting, [cleanupCheck])).toEqual([]);
  });

  it('finds the minute the case is lost: the last means clue disappears', () => {
    const lost = expiring(expiring(clues, 'log_1', safe - 2), 'log_2', safe - 1);
    const [finding] = run(investigation, lost, [cleanupCheck]).findings;
    expect(finding).toMatchObject({
      checkId: 'V-CLEANUP',
      severity: 'error',
      code: 'CLEANUP_CASE_LOST',
      minute: safe - 1,
      data: { minute: safe - 1, tSafe: safe },
    });
    expect(finding?.message).toContain('means');
  });

  it('stays solvable while a second path remains', () => {
    const half = expiring(clues, 'log_1', 1);
    expect(codes(investigation, half, [cleanupCheck])).toEqual([]);
  });

  it('counts t_safe itself: a clue gone exactly at t_safe is lost at that minute', () => {
    const [finding] = run(investigation, expiring(clues, 'debt_', safe), [cleanupCheck]).findings;
    expect(finding).toMatchObject({ code: 'CLEANUP_CASE_LOST', minute: safe });
    expect(finding?.message).toContain('motive');
  });

  it('ignores losses after t_safe', () => {
    expect(codes(investigation, expiring(clues, 'debt_', safe + 1), [cleanupCheck])).toEqual([]);
  });

  it('reports a case already unprovable at minute 0', () => {
    const [finding] = run(investigation, expiring(clues, 'ledger_', 0), [cleanupCheck]).findings;
    expect(finding).toMatchObject({ code: 'CLEANUP_CASE_LOST', minute: 0 });
  });
});
