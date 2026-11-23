import { expect, test } from 'vitest';
import { tinyManorWitness } from '../../test/fixtures/tiny-manor.ts';
import { createRng } from '../rng/index.ts';
import { KnowledgeStore } from './store.ts';
import { answer, buildLiePolicy, reactToRebuttal } from './testimony.ts';

const whereabouts = { type: 'whereWereYou', interval: { from: -30, to: -10 } } as const;

test('witness uses authorized alternatives and can admit, change or refuse when confronted', () => {
  const ctx = tinyManorWitness();
  const [lie] = answer(whereabouts, ctx);
  expect(lie).toMatchObject({ veracity: 'lie', proposition: { where: 'loc_archive' } });
  expect(answer(whereabouts, ctx)).toEqual([lie]);
  const original = { kind: 'at', who: ctx.character.id, where: 'loc_study' } as const;
  expect(reactToRebuttal(lie!, original, ctx)).toMatchObject({
    kind: 'change',
    statement: { veracity: 'lie', proposition: { where: 'loc_hall' } },
  });
  const honest = { ...ctx.character, personality: { ...ctx.character.personality, honesty: 0.7 } };
  expect(reactToRebuttal(lie!, original, { ...ctx, character: honest })).toMatchObject({
    kind: 'admit',
    statement: { veracity: 'true', proposition: { where: 'loc_study' } },
  });
  const policy = { ...ctx.policy, fabricate: ctx.policy.fabricate.slice(0, 1) };
  expect(reactToRebuttal(lie!, original, { ...ctx, policy })).toEqual({ kind: 'refuse' });
});

test('200 innocents without secrets never lie and their memory errors stay within fuzz', () => {
  const fixture = tinyManorWitness();
  const id = fixture.character.id;
  for (let seed = 0; seed < 200; seed++) {
    const rng = createRng(String(seed));
    const from = rng.int(-120, 120);
    const to = from + rng.int(1, 90);
    const fuzzMinutes = rng.int(0, 80);
    const knowledge = new KnowledgeStore();
    knowledge.add({
      proposition: { kind: 'at', who: id, where: 'room', interval: { from, to } },
      source: 'observed',
      confidence: 1,
      acquiredAt: to,
      fuzzMinutes,
    });
    const character = {
      ...fixture.character,
      personality: { ...fixture.character.personality, honesty: rng.float() },
    };
    const [reply] = answer(
      { type: 'whereWereYou', interval: { from, to } },
      {
        character,
        knowledge,
        policy: buildLiePolicy(character, knowledge, []),
        now: to,
      },
    );
    expect(reply!.veracity).not.toBe('lie');
    if (reply?.proposition.kind !== 'at') throw new Error('Expected whereabouts');
    expect(Math.abs(reply.proposition.interval.from - from)).toBeLessThanOrEqual(fuzzMinutes);
    expect(Math.abs(reply.proposition.interval.to - to)).toBeLessThanOrEqual(fuzzMinutes);
  }
});

test('questions select relevant and acquired knowledge, and witnesses report only firsthand observations', () => {
  const fixture = tinyManorWitness();
  const knowledge = new KnowledgeStore();
  for (const [who, source, acquiredAt] of [
    ['witnessed', 'observed', -2],
    ['rumor', 'told', -2],
    ['future', 'observed', 1],
  ] as const) {
    knowledge.add({
      proposition: { kind: 'did', who, verb: 'read', where: 'room', at: -3 },
      confidence: 1,
      source,
      acquiredAt,
      fuzzMinutes: 0,
    });
  }
  const ctx = { ...fixture, knowledge, policy: { conceal: [], fabricate: [] } };
  expect(
    answer({ type: 'sawAnything', interval: { from: -5, to: 0 }, location: 'room' }, ctx),
  ).toMatchObject([{ proposition: { who: 'witnessed' } }]);
  expect(
    answer(
      { type: 'whatDoYouKnowAbout', characterId: 'rumor' },
      {
        ...ctx,
        isAccurate: () => false,
      },
    ),
  ).toMatchObject([{ proposition: { who: 'rumor' }, veracity: 'mistaken' }]);
  expect(
    answer(
      { type: 'whatIsThis', clue: { id: 'clue', subjects: [{ kind: 'did', who: 'witnessed' }] } },
      ctx,
    ),
  ).toHaveLength(1);
  expect(answer({ type: 'aboutYourself' }, ctx)).toEqual([]);
});
