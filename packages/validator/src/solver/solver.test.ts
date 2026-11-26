import { readFileSync } from 'node:fs';
import { deriveClues, type Clue } from '@hs/core/evidence';
import type { Investigation } from '@hs/core/game';
import { compileDeductionRules, type HeardStatement } from '@hs/core/investigation';
import { describe, expect, it } from 'vitest';
import { tinyManor } from '../../../core/test/fixtures/tiny-manor.ts';
import type { ValidationContext } from '../check.ts';
import { validateInvestigation } from '../validate.ts';
import { SOLVER_CHECKS, discover, solveDeduction } from './index.ts';

const file = (scenario: string): object[] =>
  JSON.parse(
    readFileSync(`content/scenarios/${scenario}/deduction-rules.json`, 'utf8'),
  ) as object[];
/** The means rule these tests combine with the sanatorium rules (not a shipped file). */
const MEANS_FROM_LOG = {
  id: 'means_from_log',
  establishes: 'means($actor)',
  requires: ['access_to_record($actor)'],
};
const [opportunity, , motive] = file('sanatorium_winter') as [object, object, object];
const deductionRules = compileDeductionRules([
  opportunity,
  {
    id: 'alibi_from_witness',
    establishes: 'alibi($c,$i)',
    requires: ['testimony($w,presence($c,$l,$i))', 'neq($l,$incident.location)'],
  },
  MEANS_FROM_LOG,
  motive,
]);

interface Spec {
  readonly template: string;
  readonly supports: string[];
  readonly location?: string;
  readonly requires?: { kind: 'item' | 'password' | 'contact' | 'clue'; id: string }[];
}

/** A clue with prerequisites the derivation would reject (unknown clue ids). */
const requiring = (clue: Clue, ...requires: Clue['discovery']['requires']): Clue => ({
  ...clue,
  discovery: { ...clue.discovery, requires },
});

function clues(investigation: Investigation, specs: readonly Spec[]): Clue[] {
  const sourceEventId = investigation.truth.incident.keyEventIds[0]!;
  return deriveClues(
    specs.map((spec) => ({
      id: `trace_${spec.template}`,
      kind: 'document' as const,
      sourceEventId,
      template: spec.template,
      supports: spec.supports,
      captureMode: 'qr' as const,
      location: spec.location ?? 'loc_study',
      availableFrom: 0,
    })),
    new Map(
      specs.map((spec) => [
        spec.template,
        {
          action: { type: 'read' as const, documentId: spec.template },
          ...(spec.requires && { requires: spec.requires }),
        },
      ]),
    ),
  );
}

/** Evidence the full set of which proves the culprit, and only the culprit. */
function evidenceFor(investigation: Investigation, who: string): Spec[] {
  const { incident } = investigation.truth;
  const victim = incident.victimIds[0]!;
  return [
    { template: `ledger_${who}`, supports: [`presence(${who},loc_study,${incident.window.from})`] },
    {
      template: `debt_${who}`,
      supports: [`knows(${who},sec_manor_debt)`, `about(sec_manor_debt,${victim})`],
    },
    { template: `log_${who}`, supports: [`access_to_record(${who})`] },
  ];
}

/** A witness saying where `who` was for `[from, to)`: the alibi rule turns it into an `alibi`. */
const witnessed = (
  who: string,
  witness: string,
  window: { from: number; to: number },
): HeardStatement => ({
  id: `st_${who}`,
  speakerId: witness,
  proposition: {
    kind: 'at',
    who,
    where: 'loc_pantry',
    interval: { from: window.from, to: window.to },
  },
  topic: 'whereWereYou',
  at: 1,
  templateKey: 't',
});
const alibis = (investigation: Investigation, only?: string[]) => {
  const { window } = investigation.truth.incident;
  return [
    witnessed('ch_cook', 'ch_porter', window),
    witnessed('ch_porter', 'ch_cook', window),
  ].filter(({ proposition }) => !only || only.includes((proposition as { who: string }).who));
};

const base = () => {
  const investigation = tinyManor();
  const culprit = investigation.truth.incident.culpritIds[0]!;
  return { investigation, culprit, specs: evidenceFor(investigation, culprit) };
};
const contextFor = (all: Clue[], extra: ValidationContext = {}): ValidationContext => ({
  clues: all,
  deductionRules,
  ...extra,
});
const codes = (investigation: Investigation, context: ValidationContext) =>
  validateInvestigation(investigation, { checks: SOLVER_CHECKS, context }).findings.map(
    ({ checkId, code }) => `${checkId}:${code}`,
  );

describe('solver on tiny-manor', () => {
  it('is solvable: reachable, culprit provable, everyone else has an alibi', () => {
    const { investigation, specs } = base();
    const report = validateInvestigation(investigation, {
      checks: SOLVER_CHECKS,
      context: contextFor(clues(investigation, specs), { statements: alibis(investigation) }),
    });
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('rejects a case with neither accusing nor exonerating evidence (V-UNIQUE)', () => {
    const { investigation } = base();
    const found = validateInvestigation(investigation, {
      checks: SOLVER_CHECKS,
      context: contextFor(clues(investigation, [])),
    }).findings.map(({ checkId, code, subject }) => [checkId, code, subject?.id]);
    expect(found).toEqual([
      ['V-CULPRIT-PROVABLE', 'CULPRIT_NOT_PROVABLE', 'ch_bursar'],
      ['V-UNIQUE', 'NOT_UNIQUE', 'ch_cook'],
      ['V-UNIQUE', 'NOT_UNIQUE', 'ch_porter'],
    ]);
  });

  it('rejects an innocent the evidence does not clear, even with no evidence against them', () => {
    const { investigation, specs } = base();
    const report = validateInvestigation(investigation, {
      checks: SOLVER_CHECKS,
      context: contextFor(clues(investigation, specs), {
        statements: alibis(investigation, ['ch_porter']),
      }),
    });
    expect(report.findings.map(({ code, subject }) => [code, subject?.id])).toEqual([
      ['NOT_UNIQUE', 'ch_cook'],
    ]);
  });

  it('accepts the case once a verifiable alibi covers the window', () => {
    const { investigation, specs } = base();
    const context = (statements: HeardStatement[]) =>
      contextFor(clues(investigation, specs), { statements });
    expect(codes(investigation, context(alibis(investigation)))).toEqual([]);
    // An alibi that leaves part of the window uncovered does not clear anyone.
    const { window } = investigation.truth.incident;
    const partial = [
      witnessed('ch_cook', 'ch_porter', { from: window.from, to: window.to - 1 }),
      witnessed('ch_porter', 'ch_cook', window),
    ];
    expect(codes(investigation, context(partial))).toEqual(['V-UNIQUE:NOT_UNIQUE']);
  });

  it('catches the removal of a key clue (means, motive or opportunity)', () => {
    const { investigation, culprit, specs } = base();
    for (const [i, kind] of ['opportunity', 'motive', 'means'].entries()) {
      const rest = specs.filter((_, j) => j !== i);
      const context = contextFor(clues(investigation, rest), {
        statements: alibis(investigation),
      });
      const findings = validateInvestigation(investigation, {
        checks: SOLVER_CHECKS,
        context,
      }).findings;
      expect(
        findings.map(({ code }) => code),
        kind,
      ).toEqual(['CULPRIT_NOT_PROVABLE']);
      expect(findings[0]?.data?.missing).toBe(kind);
      expect(findings[0]?.subject).toEqual({ kind: 'character', id: culprit });
    }
  });

  it('flags an innocent with the same evidence and no alibi, marking that evidence accuses them', () => {
    const { investigation, specs } = base();
    const all = clues(investigation, [...specs, ...evidenceFor(investigation, 'ch_cook')]);
    const report = validateInvestigation(investigation, {
      checks: SOLVER_CHECKS,
      context: contextFor(all, { statements: alibis(investigation, ['ch_porter']) }),
    });
    expect(
      report.findings.map(({ code, subject, data }) => [code, subject?.id, data?.accused]),
    ).toEqual([['NOT_UNIQUE', 'ch_cook', 1]]);
  });

  it('reports unreachable clues with the reason', () => {
    const { investigation, specs } = base();
    const reasons = (spec: Spec) => {
      const all = clues(investigation, [...specs, spec]);
      const report = validateInvestigation(investigation, {
        checks: SOLVER_CHECKS,
        context: contextFor(all),
      });
      return report.findings
        .filter(({ checkId }) => checkId === 'V-REACHABLE')
        .map(({ code, data }) => [code, data?.reason]);
    };
    expect(reasons({ template: 'far', supports: [], location: 'loc_nowhere' })).toEqual([
      ['CLUE_UNREACHABLE', 'location'],
    ]);
    // A password is carried by a clue; one nobody carries cannot be found.
    expect(
      reasons({ template: 'locked', supports: [], requires: [{ kind: 'password', id: 'x' }] }),
    ).toEqual([['CLUE_UNREACHABLE', 'requirement']]);
    expect(
      reasons({ template: 'ghost', supports: [], requires: [{ kind: 'item', id: 'it_none' }] }),
    ).toEqual([['CLUE_UNREACHABLE', 'requirement']]);
    expect(
      codes(investigation, {
        clues: [
          ...clues(investigation, specs),
          requiring(clues(investigation, [{ template: 'gate', supports: [] }])[0]!, {
            kind: 'clue',
            id: 'cl_missing',
          }),
        ],
      }).filter((c) => c.startsWith('V-REACHABLE')),
    ).toEqual(['V-REACHABLE:CLUE_UNREACHABLE']);
  });

  it('chains clue prerequisites in BFS order', () => {
    const { investigation, specs } = base();
    const first = clues(investigation, [specs[0] as Spec])[0]!;
    const chained = requiring(clues(investigation, [{ template: 'second', supports: [] }])[0]!, {
      kind: 'clue',
      id: first.id,
    });
    // Listed before its prerequisite on purpose: the fixed point still finds both.
    const result = discover({ investigation, clues: [chained, first] });
    expect(result.reachable).toEqual([first.id, chained.id]);
  });

  it('reports a prerequisite cycle as unreachable', () => {
    const { investigation } = base();
    const [a, b] = clues(investigation, [
      { template: 'a', supports: [] },
      { template: 'b', supports: [] },
    ]) as [Clue, Clue];
    const result = discover({
      investigation,
      clues: [requiring(a, { kind: 'clue', id: b.id }), requiring(b, { kind: 'clue', id: a.id })],
    });
    expect(result.reachable).toEqual([]);
    expect([...result.unreachable.values()]).toEqual([{ kind: 'cycle' }, { kind: 'cycle' }]);
  });

  it('tells a cycle from a dependency on an unreachable clue', () => {
    const { investigation } = base();
    const [far, dependent] = clues(investigation, [
      { template: 'far', supports: [], location: 'loc_nowhere' },
      { template: 'dependent', supports: [] },
    ]) as [Clue, Clue];
    const result = discover({
      investigation,
      clues: [far, requiring(dependent, { kind: 'clue', id: far.id })],
    });
    expect(result.unreachable.get(far.id)).toEqual({ kind: 'location', locationId: 'loc_nowhere' });
    expect(result.unreachable.get(dependent.id)).toEqual({
      kind: 'requirement',
      requirement: `clue:${far.id}`,
    });
  });

  describe('no_access and no_means exonerate (OQ-19)', () => {
    const excusing = compileDeductionRules([
      opportunity,
      MEANS_FROM_LOG,
      motive,
      {
        id: 'no_access_from_record',
        establishes: 'no_access($c,$i)',
        requires: ['presence($c,$l,$i)', 'neq($l,$incident.location)'],
      },
      {
        id: 'no_means_from_record',
        establishes: 'no_means($c)',
        requires: ['lacks_means($c)'],
        excludes: ['means($c)'],
      },
    ]);
    const check = (extra: Spec[]) => {
      const { investigation, specs } = base();
      const all = clues(investigation, [...specs, ...extra]);
      return validateInvestigation(investigation, {
        checks: SOLVER_CHECKS,
        context: contextFor(all, { deductionRules: excusing }),
      }).findings.map(({ code, subject }) => [code, subject?.id]);
    };
    const record = (who: string, where: string, from: number, to: number): Spec => ({
      template: `register_${who}_${where}`,
      supports: [`presence(${who},${where},${from}..${to})`],
    });
    const { window } = base().investigation.truth.incident;

    it('a record that puts them elsewhere for the whole window clears an innocent', () => {
      expect(
        check([
          record('ch_cook', 'loc_pantry', window.from - 5, window.to + 5),
          record('ch_porter', 'loc_pantry', window.from, window.to),
        ]),
      ).toEqual([]);
    });

    it('a record that leaves part of the window, or places them at the scene, clears no one', () => {
      expect(
        check([
          record('ch_cook', 'loc_pantry', window.from, window.to - 1),
          record('ch_porter', 'loc_pantry', window.from, window.to),
        ]),
      ).toEqual([['NOT_UNIQUE', 'ch_cook']]);
      expect(
        check([
          record('ch_cook', 'loc_study', window.from, window.to),
          record('ch_porter', 'loc_pantry', window.from, window.to),
        ]),
      ).toEqual([['NOT_UNIQUE', 'ch_cook']]);
    });

    it('no_means clears an innocent, and is withheld from one the evidence gives the means', () => {
      const lacks = (who: string): Spec => ({
        template: `lacks_${who}`,
        supports: [`lacks_means(${who})`],
      });
      const porter = record('ch_porter', 'loc_pantry', window.from, window.to);
      expect(check([lacks('ch_cook'), porter])).toEqual([]);
      const takes: Spec = { template: 'log_cook', supports: ['access_to_record(ch_cook)'] };
      expect(check([lacks('ch_cook'), takes, porter])).toEqual([['NOT_UNIQUE', 'ch_cook']]);
    });

    it('no_access of the culprit does not make a proven culprit disappear', () => {
      const { investigation, culprit } = base();
      const away = record(culprit, 'loc_pantry', window.from, window.to);
      const solution = solveDeduction({
        investigation,
        clues: clues(investigation, [...base().specs, away]),
        rules: excusing,
      });
      // The opportunity rule is blocked by the covering no_access, so the culprit is not provable:
      // evidence that clears the culprit is a defect the gate must report, not hide.
      expect(solution.provable).not.toContain(culprit);
      expect(solution.exonerated).toContain(culprit);
    });
  });

  it('fails instead of passing when its input is missing', () => {
    const { investigation } = base();
    expect(codes(investigation, {})).toEqual([
      'V-REACHABLE:SOLVER_INPUT_MISSING',
      'V-CULPRIT-PROVABLE:SOLVER_INPUT_MISSING',
      'V-UNIQUE:SOLVER_INPUT_MISSING',
    ]);
  });

  it('is deterministic and fast (MVP investigation under 50 ms)', () => {
    const { investigation, specs } = base();
    const all = clues(investigation, specs);
    const first = solveDeduction({ investigation, clues: all, rules: deductionRules });
    const started = Number(process.hrtime.bigint()) / 1e6;
    const runs = 20;
    for (let i = 0; i < runs; i++) {
      expect(solveDeduction({ investigation, clues: all, rules: deductionRules }).claims).toEqual(
        first.claims,
      );
    }
    expect((Number(process.hrtime.bigint()) / 1e6 - started) / runs).toBeLessThan(50);
  });
});
