import { PlayerKnowledge } from '@hs/core/investigation';
import fc from 'fast-check';
import { expect, test } from 'vitest';

type Op =
  | { op: 'clue'; n: number; at: number }
  | { op: 'capture'; n: number; at: number }
  | { op: 'statement'; n: number; at: number }
  | { op: 'contact'; n: number; at: number };

const at = fc.integer({ min: -60, max: 300 });
const n = fc.integer({ min: 0, max: 6 });
const operation: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant('clue' as const), n, at }),
  fc.record({ op: fc.constant('capture' as const), n, at }),
  fc.record({ op: fc.constant('statement' as const), n, at }),
  fc.record({ op: fc.constant('contact' as const), n, at }),
);

function apply(pk: PlayerKnowledge, step: Op): void {
  switch (step.op) {
    case 'clue':
      pk.addClue({ clueId: `clue_${step.n}`, discoveredAt: step.at, location: 'loc_a' });
      break;
    case 'capture':
      if (pk.clues.has(`clue_${step.n}`)) pk.markCaptured(`clue_${step.n}`, step.at);
      break;
    case 'statement':
      pk.addStatement({
        id: `st_${step.n}`,
        speakerId: 'ch_a',
        proposition: { kind: 'at', who: 'ch_a', where: 'loc_a', interval: { from: 0, to: 10 } },
        veracity: 'lie',
        topic: 'whereWereYou',
        at: step.at,
        templateKey: 'k',
      });
      break;
    case 'contact':
      pk.addContact(`ch_${step.n}`, step.at);
      break;
  }
}

const build = (ops: Op[]): PlayerKnowledge => {
  const pk = new PlayerKnowledge();
  for (const step of ops) apply(pk, step);
  return pk;
};

test('whatever is learned, the journal stays in game-time order with one entry per fact', () => {
  fc.assert(
    fc.property(fc.array(operation, { maxLength: 60 }), (ops) => {
      const pk = build(ops);
      const { journal } = pk;
      for (let i = 1; i < journal.length; i++) {
        const [a, b] = [journal[i - 1], journal[i]];
        expect(
          a !== undefined && b !== undefined && (a.at < b.at || (a.at === b.at && a.seq < b.seq)),
        ).toBe(true);
      }
      const captured = [...pk.clues.values()].filter(({ captured }) => captured).length;
      expect(journal.length).toBe(
        pk.clues.size + captured + pk.statements.length + pk.contacts.size,
      );
      expect(new Set(journal.map(({ seq }) => seq)).size).toBe(journal.length);
    }),
    { seed: 42, numRuns: 300 },
  );
});

test('a save restores to the same knowledge, and then behaves the same', () => {
  fc.assert(
    fc.property(
      fc.array(operation, { maxLength: 40 }),
      fc.array(operation, { maxLength: 10 }),
      (before, after) => {
        const original = build(before);
        const restored = PlayerKnowledge.restore(JSON.parse(JSON.stringify(original.serialize())));
        expect(restored.serialize()).toEqual(original.serialize());
        for (const step of after) {
          apply(original, step);
          apply(restored, step);
        }
        expect(restored.serialize()).toEqual(original.serialize());
      },
    ),
    { seed: 42, numRuns: 300 },
  );
});

test('the player never ends up knowing a veracity', () => {
  fc.assert(
    fc.property(fc.array(operation, { maxLength: 40 }), (ops) => {
      const text = JSON.stringify(build(ops).serialize());
      expect(text).not.toContain('veracity');
      expect(text).not.toContain('"lie"');
    }),
    { seed: 42, numRuns: 200 },
  );
});
