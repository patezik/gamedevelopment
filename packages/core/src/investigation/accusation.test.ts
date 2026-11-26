import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tinyManor } from '../../test/fixtures/tiny-manor.ts';
import {
  AccusationError,
  evaluateAccusation,
  type AccusationContext,
  type AccusationOutcome,
  type CaseFile,
} from './accusation.ts';
import { compileDeductionRules } from './claims.ts';
import { PlayerKnowledge } from './player-knowledge.ts';

const manor = tinyManor();
const { culpritIds, victimIds, window } = manor.truth.incident;
const culprit = culpritIds[0]!;
const victim = victimIds[0]!;
const cook = 'ch_cook';

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
const [opportunityRule, , motiveRule] = file('sanatorium_winter') as [object, object, object];
const rules = compileDeductionRules([opportunityRule, MEANS_FROM_LOG, motiveRule]);

const clues = new Map([
  ['cl_ledger', { supports: [`presence(${culprit},loc_study,${window.from})`] }],
  ['cl_debt', { supports: [`knows(${culprit},sec_debt)`, `about(sec_debt,${victim})`] }],
  ['cl_log', { supports: [`access_to_record(${culprit})`] }],
  ['cl_cook_log', { supports: [`access_to_record(${cook})`] }],
]);
const context: AccusationContext = {
  clues,
  rules,
  incident: { location: 'loc_study', window },
};

const knowledge = new PlayerKnowledge();
for (const clueId of [...clues.keys(), 'cl_fake'])
  knowledge.addClue({ clueId, discoveredAt: 1, location: 'loc_x' });

const full: CaseFile = {
  accusedIds: [culprit],
  motive: `motive(${culprit},${victim})`,
  means: `means(${culprit})`,
  opportunity: `opportunity(${culprit})`,
  evidence: ['cl_ledger', 'cl_debt', 'cl_log'],
};
const run = (caseFile: CaseFile, extra: Partial<AccusationContext> = {}) =>
  evaluateAccusation(caseFile, manor.truth.incident, knowledge, { ...context, ...extra });

const withoutMotive: CaseFile = { ...full };
delete (withoutMotive as { motive?: string }).motive;
const allProven = { motive: true, means: true, opportunity: true };

describe('evaluateAccusation outcomes', () => {
  const cases: [string, CaseFile, Pick<AccusationOutcome, 'correct' | 'proven' | 'endingId'>][] = [
    [
      'right person, all parts proven',
      full,
      { correct: true, proven: allProven, endingId: 'solved' },
    ],
    [
      'right person, motive not claimed',
      withoutMotive,
      { correct: true, proven: { ...allProven, motive: false }, endingId: 'partial' },
    ],
    [
      'right person, motive claim without its clue attached',
      { ...full, evidence: ['cl_ledger', 'cl_log'] },
      { correct: true, proven: { ...allProven, motive: false }, endingId: 'partial' },
    ],
    [
      'right person, no evidence at all',
      { accusedIds: [culprit], evidence: [] },
      {
        correct: true,
        proven: { motive: false, means: false, opportunity: false },
        endingId: 'partial',
      },
    ],
    [
      'right person, claim about another character',
      { ...full, means: `means(${cook})`, evidence: [...full.evidence, 'cl_cook_log'] },
      { correct: true, proven: { ...allProven, means: false }, endingId: 'partial' },
    ],
    [
      'wrong person with a fully proven case against the culprit',
      { ...full, accusedIds: [cook] },
      {
        correct: false,
        proven: { motive: false, means: false, opportunity: false },
        endingId: 'wrong_accusation',
      },
    ],
    [
      'culprit and an innocent together',
      { ...full, accusedIds: [culprit, cook] },
      { correct: false, proven: allProven, endingId: 'wrong_accusation' },
    ],
  ];
  it.each(cases)('%s', (_name, caseFile, expected) => {
    const outcome = run(caseFile);
    expect({
      correct: outcome.correct,
      proven: outcome.proven,
      endingId: outcome.endingId,
    }).toEqual(expected);
  });

  it('attaches the consequences of each ending', () => {
    expect(run(full).consequences).toEqual([]);
    expect(run(withoutMotive).consequences).toEqual([
      { kind: 'culprit_destroys_evidence', characterId: culprit },
    ]);
    expect(run({ ...full, accusedIds: [cook] }).consequences).toEqual([
      { kind: 'refuses_to_talk', characterId: cook },
      { kind: 'trust_falls' },
      { kind: 'culprit_freed', characterId: culprit },
    ]);
  });

  it('does not let the order or repeats of the accused or the evidence matter', () => {
    const shuffled = {
      ...full,
      accusedIds: [culprit, culprit],
      evidence: [...full.evidence].reverse(),
    };
    expect(run(shuffled).endingId).toBe('solved');
  });
});

describe('evaluateAccusation refusals', () => {
  const refusal = (caseFile: CaseFile, extra?: Partial<AccusationContext>) => {
    try {
      run(caseFile, extra);
    } catch (error) {
      return error as AccusationError;
    }
    return undefined;
  };

  it('refuses a case file that accuses nobody', () => {
    const error = refusal({ ...full, accusedIds: [] });
    expect(error).toBeInstanceOf(AccusationError);
    expect(error?.code).toBe('CASEFILE_INCOMPLETE');
  });

  it('refuses clues the player never found', () => {
    const error = refusal({ ...full, evidence: [...full.evidence, 'cl_unseen'] });
    expect(error?.code).toBe('CASEFILE_UNKNOWN_EVIDENCE');
    expect(error?.evidenceIds).toEqual(['cl_unseen']);
  });

  it('refuses hallucinated clues even if the player holds them', () => {
    const error = refusal(
      { ...full, evidence: [...full.evidence, 'cl_fake'] },
      { hallucinatedClueIds: new Set(['cl_fake']) },
    );
    expect(error?.code).toBe('CASEFILE_UNKNOWN_EVIDENCE');
    expect(error?.evidenceIds).toEqual(['cl_fake']);
  });
});
