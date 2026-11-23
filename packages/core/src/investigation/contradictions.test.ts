import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  contradictionEvents,
  DEFAULT_TOLERANCE_MINUTES,
  detectContradictions,
} from './contradictions.ts';
import { PlayerKnowledge, type HeardStatement } from './player-knowledge.ts';

const said = (
  id: string,
  who: string,
  where: string,
  from: number,
  to: number,
): HeardStatement => ({
  id,
  speakerId: who,
  proposition: { kind: 'at', who, where, interval: { from, to } },
  topic: 'whereWereYou',
  at: 1,
  templateKey: 't',
});
const seenAt = (who: string, where: string, t: number) => ({
  supports: [`presence(${who},${where},${t})`],
});

function knowledgeOf(statement: HeardStatement | undefined, clueIds: string[]) {
  const knowledge = new PlayerKnowledge();
  if (statement) knowledge.addStatement(statement);
  for (const clueId of clueIds) knowledge.addClue({ clueId, discoveredAt: 5, location: 'loc_x' });
  return knowledge;
}

describe('detectContradictions', () => {
  const clues = new Map([['cl_1', seenAt('ch_a', 'loc_study', 120)]]);

  it('finds a statement against a clue when the player holds both', () => {
    const statement = said('st_1', 'ch_a', 'loc_hall', 60, 240);
    expect(detectContradictions(knowledgeOf(statement, ['cl_1']), { clues })).toEqual([
      {
        id: 'ctr_st_1_cl_1',
        statementId: 'st_1',
        clueId: 'cl_1',
        subject: 'ch_a',
        claimed: { where: 'loc_hall', from: 60, to: 240 },
        found: { where: 'loc_study', from: 120, to: 121 },
      },
    ]);
  });

  it('finds nothing with only one part', () => {
    const statement = said('st_1', 'ch_a', 'loc_hall', 60, 240);
    expect(detectContradictions(knowledgeOf(statement, []), { clues })).toEqual([]);
    expect(detectContradictions(knowledgeOf(undefined, ['cl_1']), { clues })).toEqual([]);
    // The catalogue lists a clue the player has not found: it is not a part.
    expect(detectContradictions(knowledgeOf(statement, []), { clues })).toEqual([]);
  });

  it('ignores another person, the same place, and a moment outside the stated time', () => {
    const base = { clues };
    expect(
      detectContradictions(knowledgeOf(said('s', 'ch_b', 'loc_hall', 60, 240), ['cl_1']), base),
    ).toEqual([]);
    expect(
      detectContradictions(knowledgeOf(said('s', 'ch_a', 'loc_study', 60, 240), ['cl_1']), base),
    ).toEqual([]);
    expect(
      detectContradictions(knowledgeOf(said('s', 'ch_a', 'loc_hall', 0, 100), ['cl_1']), base),
    ).toEqual([]);
  });

  it('forgives a memory error within the tolerance at the edge of the stated time', () => {
    const edge = DEFAULT_TOLERANCE_MINUTES;
    const near = new Map([['cl_1', seenAt('ch_a', 'loc_study', 60 + edge - 1)]]);
    const inside = new Map([['cl_1', seenAt('ch_a', 'loc_study', 60 + edge)]]);
    const statement = said('s', 'ch_a', 'loc_hall', 60, 240);
    expect(detectContradictions(knowledgeOf(statement, ['cl_1']), { clues: near })).toEqual([]);
    expect(detectContradictions(knowledgeOf(statement, ['cl_1']), { clues: inside })).toHaveLength(
      1,
    );
  });

  it('never flags a truthful statement blurred within the tolerance (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -2000, max: 2000 }), // true stay start
        fc.integer({ min: 1, max: 600 }), // true stay length
        fc.integer({ min: -DEFAULT_TOLERANCE_MINUTES, max: DEFAULT_TOLERANCE_MINUTES }), // blur
        fc.integer({ min: 1, max: 600 }), // where the clue falls, relative to the stay
        fc.boolean(),
        (start, length, blur, offset, before) => {
          const end = start + length;
          // The person was at loc_hall during [start, end), so a clue elsewhere is outside it.
          const t = before ? start - offset : end - 1 + offset;
          const statement = said('s', 'ch_a', 'loc_hall', start + blur, end + blur);
          const found = detectContradictions(knowledgeOf(statement, ['c']), {
            clues: new Map([['c', seenAt('ch_a', 'loc_study', t)]]),
          });
          expect(found).toEqual([]);
        },
      ),
    );
  });

  it('is built from heard statements, never from veracity', () => {
    const statement = said('st_1', 'ch_a', 'loc_hall', 60, 240);
    const json = JSON.stringify(detectContradictions(knowledgeOf(statement, ['cl_1']), { clues }));
    expect(json).not.toMatch(/veracity|culpritIds|truth|hallucination/);
  });
});

describe('contradictionEvents', () => {
  it('announces each contradiction once', () => {
    const [found] = detectContradictions(
      knowledgeOf(said('st_1', 'ch_a', 'loc_hall', 60, 240), ['cl_1']),
      { clues: new Map([['cl_1', seenAt('ch_a', 'loc_study', 120)]]) },
    );
    expect(contradictionEvents([found!], new Set(), 7)).toEqual([
      {
        type: 'ContradictionFound',
        contradictionId: 'ctr_st_1_cl_1',
        statementId: 'st_1',
        clueId: 'cl_1',
        at: 7,
      },
    ]);
    expect(contradictionEvents([found!], new Set(['ctr_st_1_cl_1']), 8)).toEqual([]);
  });
});
