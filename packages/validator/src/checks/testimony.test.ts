import { deriveClues, type Clue } from '@hs/core/evidence';
import type { Investigation } from '@hs/core/game';
import { KnowledgeStore, type Statement } from '@hs/core/knowledge';
import type { Proposition } from '@hs/core/truth/facts';
import { describe, expect, it } from 'vitest';
import { tinyManor } from '../../../core/test/fixtures/tiny-manor.ts';
import type { ValidationContext } from '../check.ts';
import { validateInvestigation } from '../validate.ts';
import { collectTestimony, liesBreakableCheck, testimonyCheck } from './testimony.ts';

const investigation = tinyManor();
const culprit = investigation.truth.incident.culpritIds[0]!;
const keyEvent = investigation.truth
  .events()
  .find(({ id }) => id === investigation.truth.incident.keyEventIds[0])!;

let counter = 0;
const stmt = (
  speakerId: string,
  veracity: Statement['veracity'],
  proposition: Proposition,
): Statement => ({
  id: `st_${++counter}`,
  speakerId,
  proposition,
  veracity,
  topic: 'whereWereYou',
  at: 1,
  templateKey: 't',
});
const at = (who: string, where: string, from: number, to: number): Proposition => ({
  kind: 'at',
  who,
  where,
  interval: { from, to },
});

/** A clue showing `presence` at the study; `requires` makes it unreachable when it names nothing. */
function presenceClue(presence: string, requires: Clue['discovery']['requires'] = []): Clue[] {
  const [clue] = deriveClues(
    [
      {
        id: 'trace_ledger',
        kind: 'document' as const,
        sourceEventId: investigation.truth.incident.keyEventIds[0]!,
        template: 'ledger',
        supports: [presence],
        captureMode: 'qr' as const,
        location: 'loc_study',
        availableFrom: 0,
      },
    ],
    new Map([['ledger', { action: { type: 'read' as const, documentId: 'ledger' }, requires }]]),
  );
  return [clue!];
}

const lies = (testimony: Statement[], clues: Clue[], extra: ValidationContext = {}) =>
  validateInvestigation(investigation, {
    checks: [liesBreakableCheck],
    context: { testimony, clues, ...extra },
  }).findings.map(({ code, data }) => [code, data?.statementId]);
const honest = (testimony: Statement[]) =>
  validateInvestigation(investigation, { checks: [testimonyCheck], context: { testimony } })
    .findings;

// The bursar's false alibi: at the archive for a long stretch around the theft in the study.
const falseAlibi = () => stmt(culprit, 'lie', at(culprit, 'loc_archive', -100, 60));
const bursarInStudy = 'presence(ch_bursar,loc_study,-20..-12)';

describe('V-LIES-BREAKABLE', () => {
  it('passes when a reachable clue refutes the culprit false alibi', () => {
    expect(lies([falseAlibi()], presenceClue(bursarInStudy))).toEqual([]);
  });

  it('catches an irrefutable false alibi of the culprit (mutation: the refuting clue is gone)', () => {
    const lie = falseAlibi();
    expect(lies([lie], [])).toEqual([['LIE_UNBREAKABLE', lie.id]]);
  });

  it('catches a refuting clue that cannot be reached', () => {
    const lie = falseAlibi();
    const blocked = presenceClue(bursarInStudy, [{ kind: 'item', id: 'it_nothing' }]);
    expect(lies([lie], blocked)).toEqual([['LIE_UNBREAKABLE', lie.id]]);
  });

  it('catches a clue that does not contradict the lie (the person is where they said)', () => {
    const lie = falseAlibi();
    expect(lies([lie], presenceClue('presence(ch_bursar,loc_archive,-20..-12)'))).toEqual([
      ['LIE_UNBREAKABLE', lie.id],
    ]);
  });

  it('does not take a short statement for refuted: the memory blur forgives it', () => {
    const lie = stmt(culprit, 'lie', at(culprit, 'loc_archive', -30, 0));
    expect(lies([lie], presenceClue(bursarInStudy))).toEqual([['LIE_UNBREAKABLE', lie.id]]);
  });

  it('ignores a lie that does not hamper the solution', () => {
    const harmless = stmt('ch_cook', 'lie', at('ch_cook', 'loc_hall', -100, 60));
    expect(lies([harmless], [])).toEqual([]);
  });

  it('requires a lie that throws suspicion on somebody else to be refutable too', () => {
    const slander = stmt('ch_cook', 'lie', at('ch_porter', 'loc_study', -100, 60));
    expect(lies([slander], [])).toEqual([['LIE_UNBREAKABLE', slander.id]]);
    expect(lies([slander], presenceClue('presence(ch_porter,loc_hall,-20..-12)'))).toEqual([]);
  });

  it('refutes a "did" lie by a reachable clue whose event shows the actor elsewhere', () => {
    const who = keyEvent.actorIds[0]!;
    const did = (where: string, at: number) =>
      stmt(culprit, 'lie', { kind: 'did', who, verb: 'rest', where, at });
    const clues = presenceClue(bursarInStudy);
    expect(lies([did('loc_nowhere', keyEvent.t)], clues)).toEqual([]);
    const sameRoom = did(keyEvent.location, keyEvent.t);
    expect(lies([sameRoom], clues)).toEqual([['LIE_UNBREAKABLE', sameRoom.id]]);
    const earlier = did('loc_nowhere', keyEvent.t - 1);
    expect(lies([earlier], clues)).toEqual([['LIE_UNBREAKABLE', earlier.id]]);
    const later = did('loc_nowhere', keyEvent.t + Math.max(1, keyEvent.duration));
    expect(lies([later], clues)).toEqual([['LIE_UNBREAKABLE', later.id]]);
    const nobody = did('loc_nowhere', keyEvent.t);
    expect(lies([nobody], [])).toEqual([['LIE_UNBREAKABLE', nobody.id]]);
  });

  it('does not read honest statements, and reports missing input', () => {
    const truthful = stmt(culprit, 'true', at(culprit, 'loc_archive', -100, 60));
    expect(lies([truthful], [])).toEqual([]);
    const report = validateInvestigation(investigation, { checks: [liesBreakableCheck] });
    expect(report.findings.map(({ code }) => code)).toEqual(['TESTIMONY_INPUT_MISSING']);
  });
});

describe('V-TESTIMONY', () => {
  // tiny-manor: the cook is in the pantry from -50 to 1.
  const cook = (veracity: Statement['veracity'], where: string, from: number, to: number) =>
    stmt('ch_cook', veracity, at('ch_cook', where, from, to));

  it('accepts statements that match the truth, with or without a blurred time', () => {
    expect(honest([cook('true', 'loc_pantry', -50, 1)])).toEqual([]);
    expect(honest([cook('mistaken', 'loc_pantry', -30, 1)])).toEqual([]);
    expect(honest([cook('mistaken', 'loc_pantry', -50, 25)])).toEqual([]);
  });

  it('catches a "true" statement about the wrong place', () => {
    const wrong = cook('true', 'loc_hall', -50, 1);
    expect(honest([wrong]).map(({ code, data }) => [code, data?.statementId])).toEqual([
      ['TESTIMONY_CONTRADICTS_TRUTH', wrong.id],
    ]);
  });

  it('catches a statement whose time is off by more than the memory blur', () => {
    expect(honest([cook('mistaken', 'loc_pantry', 40, 90)])).toHaveLength(1);
    expect(honest([cook('true', 'loc_pantry', -50, 60)])).toHaveLength(1);
    expect(honest([cook('true', 'loc_pantry', -100, 1)])).toHaveLength(1);
  });

  it('compares a "did" statement with the did facts of the truth', () => {
    const withDid = tinyManor();
    const didFact = {
      kind: 'did' as const,
      who: 'ch_porter',
      verb: 'sweep',
      where: 'loc_hall',
      at: -30,
    };
    withDid.truth.append({
      t: -30,
      duration: 5,
      verb: 'sweep',
      actorIds: ['ch_porter'],
      location: 'loc_hall',
      targets: [],
      causes: [],
      facts: [didFact],
      traceIds: [],
      visibility: 'public',
    });
    const honest = (testimony: Statement[]) =>
      validateInvestigation(withDid, { checks: [testimonyCheck], context: { testimony } }).findings;
    expect(honest([stmt(didFact.who, 'true', didFact)])).toEqual([]);
    expect(honest([stmt(didFact.who, 'true', { ...didFact, at: didFact.at + 31 })])).toHaveLength(
      1,
    );
    expect(honest([stmt(didFact.who, 'true', { ...didFact, where: 'loc_nowhere' })])).toHaveLength(
      1,
    );
  });

  it('does not compare lies, and reports missing input', () => {
    expect(honest([cook('lie', 'loc_hall', 300, 400)])).toEqual([]);
    const report = validateInvestigation(investigation, { checks: [testimonyCheck] });
    expect(report.findings.map(({ code }) => code)).toEqual(['TESTIMONY_INPUT_MISSING']);
  });
});

describe('collectTestimony', () => {
  const cookCharacter = (inv: Investigation) => inv.characters.find(({ id }) => id === 'ch_cook')!;

  it('asks every witness every question and keeps the veracity', () => {
    const knowledge = new KnowledgeStore();
    knowledge.add({
      proposition: at('ch_cook', 'loc_pantry', -50, 1),
      confidence: 1,
      source: 'observed',
      acquiredAt: 1,
      fuzzMinutes: 0,
    });
    const witness = {
      character: cookCharacter(investigation),
      knowledge,
      policy: { conceal: [], fabricate: [] },
    };
    const questions = [
      { type: 'whereWereYou' as const, interval: { from: -50, to: 1 } },
      { type: 'aboutYourself' as const },
    ];
    const statements = collectTestimony([witness], questions, 1);
    expect(statements.map(({ topic, veracity }) => [topic, veracity]).sort()).toEqual([
      ['aboutYourself', 'true'],
      ['whereWereYou', 'true'],
    ]);
    expect(collectTestimony([witness], questions, 1)).toEqual(statements);
    expect(honest(statements)).toEqual([]);

    const liar = {
      ...witness,
      character: {
        ...witness.character,
        personality: { ...witness.character.personality, honesty: 0 },
      },
      policy: {
        conceal: [{ kind: 'at' as const, who: 'ch_cook' }],
        fabricate: [
          {
            replaces: { kind: 'at' as const, who: 'ch_cook' },
            proposition: at('ch_cook', 'loc_hall', -50, 1),
          },
        ],
      },
    };
    const [lie] = collectTestimony([liar], [questions[0]!], 1);
    expect(lie?.veracity).toBe('lie');
    expect(lies([lie!], [])).toEqual([]);
  });
});
