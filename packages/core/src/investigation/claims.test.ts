import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveClues } from '../evidence/index.ts';
import { tinyManorWithClues } from '../../test/fixtures/tiny-manor.ts';
import {
  compileDeductionRules,
  DeductionRulesError,
  evaluateClaims,
  type ClaimContext,
} from './claims.ts';
import { PlayerKnowledge, type HeardStatement } from './player-knowledge.ts';

const rulesFile = (scenario: string): unknown =>
  JSON.parse(readFileSync(`content/scenarios/${scenario}/deduction-rules.json`, 'utf8'));
const sanatorium = compileDeductionRules(rulesFile('sanatorium_winter'));
/** The means rule these tests combine with the sanatorium rules (not a shipped file). */
const MEANS_FROM_LOG = {
  id: 'means_from_log',
  establishes: 'means($actor)',
  requires: ['access_to_record($actor)'],
};
const [opportunityRule, , motiveRule] = rulesFile('sanatorium_winter') as object[];
const minimal = compileDeductionRules([
  opportunityRule,
  {
    id: 'alibi_from_witness',
    establishes: 'alibi($c,$i)',
    requires: ['testimony($w,presence($c,$l,$i))', 'neq($l,$incident.location)'],
  },
  MEANS_FROM_LOG,
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
): HeardStatement => ({
  id,
  speakerId,
  proposition: { kind: 'at', who, where, interval: { from, to } },
  topic: 'whereWereYou',
  at: 1,
  templateKey: 't',
});

describe('evaluateClaims', () => {
  it('establishes motive, means and opportunity of the culprit from the scenario clues', () => {
    // Clues are derived from the tiny-manor scenario's own events and ids (evidence module); the
    // evaluation sees only their `supports`, never the truth.
    const manor = tinyManorWithClues();
    const culprit = manor.truth.incident.culpritIds[0]!;
    const victim = manor.truth.incident.victimIds[0]!;
    const [taken] = manor.truth.incident.keyEventIds;
    const { window } = manor.truth.incident;
    const trace = (id: string, supports: string[]) => ({
      id: `trace_${id}`,
      kind: 'document' as const,
      sourceEventId: taken!,
      template: id,
      supports,
      captureMode: 'qr' as const,
      location: 'loc_study',
      availableFrom: 0,
    });
    const found = deriveClues(
      [
        trace('ledger', [`presence(${culprit},loc_study,${window.from})`]),
        trace('debt', [`knows(${culprit},sec_manor_debt)`, `about(sec_manor_debt,${victim})`]),
        trace('log', [`access_to_record(${culprit})`]),
      ],
      new Map(
        ['ledger', 'debt', 'log'].map((t) => [
          t,
          { action: { type: 'read' as const, documentId: t } },
        ]),
      ),
    );
    const knowledge = new PlayerKnowledge();
    for (const clue of found)
      knowledge.addClue({ clueId: clue.id, discoveredAt: 0, location: 'loc_study' });
    const claims = evaluateClaims(knowledge, minimal, {
      clues: new Map(found.map((clue) => [clue.id, clue])),
      incident: { location: 'loc_study', window },
    });

    const byKind = Object.fromEntries(claims.map((c) => [c.kind, c]));
    expect(Object.keys(byKind).sort()).toEqual(['means', 'motive', 'opportunity']);
    expect(claims.every((c) => c.subject === culprit)).toBe(true);
    expect(byKind.opportunity?.claim).toBe(`opportunity(${culprit})`);
    expect(byKind.motive?.claim).toBe(`motive(${culprit},${victim})`);
    // Every established claim says what it stands on.
    for (const claim of claims) expect(claim.support.clueIds.length).toBeGreaterThan(0);
    expect(byKind.opportunity?.support.clueIds).toEqual([found[0]?.id]);
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
    expect(compileDeductionRules(rulesFile('_test_minimal')).rules).toHaveLength(6);
    expect(sanatorium.rules).toHaveLength(7);
    const stratum = (id: string) => sanatorium.rules.find((rule) => rule.id === id)?.stratum;
    expect(stratum('opportunity_from_presence')).toBeGreaterThan(stratum('alibi_from_witness')!);
  });

  it('establishes no_access and no_means with the clues they stand on, and withholds them on contrary evidence', () => {
    const rules = compileDeductionRules([
      {
        id: 'na',
        establishes: 'no_access($c,$i)',
        requires: ['presence($c,$l,$i)', 'neq($l,$incident.location)'],
      },
      {
        id: 'nm',
        establishes: 'no_means($c)',
        requires: ['lacks_means($c)'],
        excludes: ['means($c)'],
      },
      { id: 'm', establishes: 'means($c)', requires: ['access_to_record($c)'] },
    ]);
    const clues = new Map([
      ['cl_away', { supports: [`presence(${cook},loc_pantry,-20..-8)`] }],
      ['cl_scene', { supports: [`presence(${bursar},loc_study,-20..-8)`] }],
      ['cl_lacks', { supports: [`lacks_means(${cook})`, `lacks_means(${bursar})`] }],
      ['cl_log', { supports: [`access_to_record(${bursar})`] }],
    ]);
    const claims = evaluateClaims(
      knowledgeWith('cl_away', 'cl_scene', 'cl_lacks', 'cl_log'),
      rules,
      {
        clues,
        incident,
      },
    );
    const text = claims.map(({ claim }) => claim).sort();
    // The cook is clear; the bursar was at the scene and has the means, so neither is excused.
    expect(text).toEqual([`means(${bursar})`, `no_access(${cook},-20..-8)`, `no_means(${cook})`]);
    const noAccess = claims.find(({ kind }) => kind === 'no_access');
    expect(noAccess?.support.clueIds).toEqual(['cl_away']);
    expect(claims.find(({ kind }) => kind === 'no_means')?.support.clueIds).toEqual(['cl_lacks']);
  });

  it('lets a rule turn a reference a clue supports into the claim itself, once', () => {
    const rules = compileDeductionRules([
      { id: 'means_from_trace', establishes: 'means($c)', requires: ['means($c)'] },
    ]);
    const clues = new Map([
      ['cl_a', { supports: [`means(${cook})`] }],
      ['cl_b', { supports: [`means(${cook})`] }],
    ]);
    const claims = evaluateClaims(knowledgeWith('cl_a', 'cl_b'), rules, { clues });
    expect(claims.map(({ claim }) => claim)).toEqual([`means(${cook})`]);
    expect(claims[0]?.support.clueIds).toEqual(['cl_a', 'cl_b']);
    // Without the clue there is no claim: the rule does not invent the reference.
    expect(evaluateClaims(new PlayerKnowledge(), rules, { clues })).toEqual([]);
  });

  it('applies an exclusion regardless of rule order in the file', () => {
    const opportunity = {
      id: 'o',
      establishes: 'opportunity($c)',
      requires: ['presence($c,$incident.location,$incident.window)'],
      excludes: ['alibi($c,$incident.window)'],
    };
    const alibi = {
      id: 'a',
      establishes: 'alibi($c,$i)',
      requires: ['testimony($w,presence($c,$l,$i))'],
    };
    const knowledge = knowledgeWith('cl_cook');
    knowledge.addStatement(said('st_1', 'ch_porter', cook, 'loc_pantry', -20, -8));
    for (const order of [
      [opportunity, alibi],
      [alibi, opportunity],
    ])
      expect(
        evaluateClaims(knowledge, compileDeductionRules(order), context).map((c) => c.kind),
      ).toEqual(['alibi']);
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
    ['bad syntax in requires', [{ id: 'x', establishes: 'means($c)', requires: ['a($c))'] }]],
    ['empty argument', [{ id: 'x', establishes: 'means($c)', requires: ['a($c,)'] }]],
    [
      'bad syntax in excludes',
      [{ id: 'x', establishes: 'means($c)', requires: ['a($c)'], excludes: ['alibi($c'] }],
    ],
    [
      'unbound variable in neq',
      [{ id: 'x', establishes: 'means($c)', requires: ['a($c)', 'neq($c,$d)'] }],
    ],
    [
      'unknown incident path',
      [{ id: 'x', establishes: 'means($c)', requires: ['a($c,$incident.foo)'] }],
    ],
    [
      'unknown path in excludes',
      [
        {
          id: 'x',
          establishes: 'means($c)',
          requires: ['a($c)'],
          excludes: ['b($incident.place)'],
        },
      ],
    ],
  ])('rejects %s', (_name, input) => {
    expect(() => compileDeductionRules(input)).toThrow(DeductionRulesError);
  });
});
