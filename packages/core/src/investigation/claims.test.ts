import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tinyManorWithClues } from '../../test/fixtures/tiny-manor.ts';
import {
  compileDeductionRules,
  DeductionRulesError,
  evaluateClaims,
  type ClaimContext,
} from './claims.ts';
import { PlayerKnowledge } from './player-knowledge.ts';

const rulesFile = (scenario: string): unknown =>
  JSON.parse(readFileSync(`content/scenarios/${scenario}/deduction-rules.json`, 'utf8'));
const sanatorium = compileDeductionRules(rulesFile('sanatorium_winter'));
const [opportunityRule, , motiveRule] = rulesFile('sanatorium_winter') as object[];
const minimal = compileDeductionRules([
  opportunityRule,
  {
    id: 'alibi_from_witness',
    establishes: 'alibi($c,$i)',
    requires: ['testimony($w,presence($c,$l,$i))', 'neq($l,$incident.location)'],
  },
  ...(rulesFile('_test_minimal') as object[]),
  motiveRule,
]);

const bursar = 'ch_bursar';
const cook = 'ch_cook';
const incident = { location: 'loc_study', window: { from: -20, to: -8 } };
const clueSupports = new Map([
  ['cl_ledger', { supports: [`presence(${bursar},loc_study,-20)`] }],
  ['cl_debt_note', { supports: [`knows(${bursar},sec_debt)`, 'about(sec_debt,ch_owner)'] }],
  ['cl_log', { supports: [`access_to_record(${bursar})`] }],
  ['cl_cook', { supports: [`presence(${cook},loc_study,-15)`] }],
]);
const context: ClaimContext = { clues: clueSupports, incident };
const knowledgeWith = (...clueIds: string[]) => {
  const knowledge = new PlayerKnowledge();
  clueIds.forEach((clueId, i) => knowledge.addClue({ clueId, discoveredAt: i, location: 'loc_x' }));
  return knowledge;
};
const said = (
  id: string,
  speakerId: string,
  who: string,
  where: string,
  from: number,
  to: number,
) => ({
  id,
  speakerId,
  proposition: { kind: 'at', who, where, interval: { from, to } },
  topic: 'whereWereYou',
  at: 1,
  templateKey: 't',
});

describe('evaluateClaims', () => {
  it('establishes motive, means and opportunity of the culprit from the full set of clues', () => {
    // The culprit comes from the tiny-manor scenario; the evaluation below never sees the truth.
    const { truth } = tinyManorWithClues();
    const culprit = truth.incident.culpritIds[0];
    expect(culprit).toBe(bursar);

    const claims = evaluateClaims(
      knowledgeWith('cl_ledger', 'cl_debt_note', 'cl_log'),
      minimal,
      context,
    );
    const byKind = Object.fromEntries(claims.map((c) => [c.kind, c]));
    expect(Object.keys(byKind).sort()).toEqual(['means', 'motive', 'opportunity']);
    expect(byKind.opportunity).toMatchObject({
      subject: culprit,
      claim: `opportunity(${bursar})`,
      support: { clueIds: ['cl_ledger'], statementIds: [] },
    });
    expect(byKind.motive?.support.clueIds).toEqual(['cl_debt_note']);
    expect(byKind.means?.support.clueIds).toEqual(['cl_log']);
    // Every established claim says what it stands on.
    for (const claim of claims) expect(claim.support.clueIds.length).toBeGreaterThan(0);
  });

  it('establishes nothing from a partial set, or without a known incident window', () => {
    expect(evaluateClaims(knowledgeWith('cl_log'), minimal, context).map((c) => c.kind)).toEqual([
      'means',
    ]);
    expect(evaluateClaims(knowledgeWith('cl_ledger'), minimal, { clues: clueSupports })).toEqual(
      [],
    );
    // A clue the player has not found is not used even though the catalogue lists it.
    expect(evaluateClaims(new PlayerKnowledge(), minimal, context)).toEqual([]);
  });

  it('lets a witness alibi remove opportunity and records the chain', () => {
    const knowledge = knowledgeWith('cl_cook');
    expect(evaluateClaims(knowledge, minimal, context).map((c) => c.claim)).toEqual([
      `opportunity(${cook})`,
    ]);
    knowledge.addStatement(said('st_1', 'ch_porter', cook, 'loc_pantry', -20, -8));
    const claims = evaluateClaims(knowledge, minimal, context);
    expect(claims.map((c) => c.claim)).toEqual([`alibi(${cook},-20..-8)`]);
    expect(claims[0]?.support).toEqual({
      clueIds: [],
      statementIds: ['st_1'],
      claims: [],
    });
  });

  it('does not accept a self-report as an alibi, nor a partial alibi as an excuse', () => {
    const knowledge = knowledgeWith('cl_cook');
    knowledge.addStatement(said('st_self', cook, cook, 'loc_pantry', -20, -8));
    expect(evaluateClaims(knowledge, minimal, context).map((c) => c.kind)).toEqual(['opportunity']);
    knowledge.addStatement(said('st_part', 'ch_porter', cook, 'loc_pantry', -20, -14));
    expect(evaluateClaims(knowledge, minimal, context).map((c) => c.kind)).toEqual([
      'alibi',
      'opportunity',
    ]);
  });

  it('chains derived claims and reports them in the support', () => {
    const rules = compileDeductionRules([
      { id: 'a', establishes: 'means($c)', requires: ['access_to_record($c)'] },
      { id: 'b', establishes: 'motive($c,$v)', requires: ['means($c)', 'about($s,$v)'] },
    ]);
    const claims = evaluateClaims(knowledgeWith('cl_log', 'cl_debt_note'), rules, context);
    expect(claims.map((c) => c.claim)).toEqual([`means(${bursar})`, `motive(${bursar},ch_owner)`]);
    expect(claims[1]?.support).toEqual({
      clueIds: ['cl_debt_note', 'cl_log'],
      statementIds: [],
      claims: [`means(${bursar})`],
    });
  });

  it('finds a contradiction only when the player holds both sides', () => {
    const rules = compileDeductionRules([
      {
        id: 'c',
        establishes: 'contradiction($c)',
        requires: ['statement($c,presence($c,$l,$i))', 'presence($c,$l2,$i)', 'neq($l,$l2)'],
      },
    ]);
    const knowledge = knowledgeWith();
    knowledge.addStatement(said('st_2', bursar, bursar, 'loc_hall', -20, -8));
    expect(evaluateClaims(knowledge, rules, context)).toEqual([]);
    knowledge.addClue({ clueId: 'cl_ledger', discoveredAt: 5, location: 'loc_study' });
    const [claim] = evaluateClaims(knowledge, rules, context);
    expect(claim).toMatchObject({ kind: 'contradiction', subject: bursar });
    expect(claim?.support).toMatchObject({ clueIds: ['cl_ledger'], statementIds: ['st_2'] });
  });

  it('is deterministic and never mentions truth keys', () => {
    const knowledge = knowledgeWith('cl_ledger', 'cl_debt_note', 'cl_log');
    const first = evaluateClaims(knowledge, minimal, context);
    expect(evaluateClaims(knowledge, minimal, context)).toEqual(first);
    expect(JSON.stringify(first)).not.toMatch(/veracity|culpritIds|truth|hallucination/);
  });
});

describe('compileDeductionRules', () => {
  it('accepts the scenario rule files and orders alibi before the rule that excludes it', () => {
    expect(compileDeductionRules(rulesFile('_test_minimal')).rules).toHaveLength(1);
    expect(sanatorium.rules).toHaveLength(4);
    const stratum = (id: string) => sanatorium.rules.find((rule) => rule.id === id)?.stratum;
    expect(stratum('opportunity_from_presence')).toBeGreaterThan(stratum('alibi_from_witness')!);
  });

  it.each([
    ['unknown claim kind', [{ id: 'x', establishes: 'guilt($c)', requires: ['a($c)'] }]],
    ['unbound variable', [{ id: 'x', establishes: 'means($d)', requires: ['a($c)'] }]],
    ['bad syntax', [{ id: 'x', establishes: 'means($c', requires: ['a($c)'] }]],
    ['no real premise', [{ id: 'x', establishes: 'means(a)', requires: ['neq(a,b)'] }]],
    [
      'duplicate id',
      [
        { id: 'x', establishes: 'means($c)', requires: ['a($c)'] },
        { id: 'x', establishes: 'means($c)', requires: ['b($c)'] },
      ],
    ],
    [
      'negative cycle',
      [{ id: 'x', establishes: 'means($c)', requires: ['a($c)'], excludes: ['means($c)'] }],
    ],
    ['not rules', { id: 'x' }],
  ])('rejects %s', (_name, input) => {
    expect(() => compileDeductionRules(input)).toThrow(DeductionRulesError);
  });
});
