import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RelationshipGraph } from '../characters/index.ts';
import { KnowledgeStore, type Belief } from '../knowledge/index.ts';
import { factId, TruthModel, type Proposition, type PropositionPattern } from '../truth/index.ts';
import {
  converse,
  detectEncounters,
  runEncounters,
  type Encounter,
  type Stay,
  type Talker,
} from './encounters.ts';

const room = 'loc_room';
const stay = (characterId: string, from: number, to: number, location = room): Stay => ({
  characterId,
  location,
  interval: { from, to },
});
const encounter: Encounter = { a: 'ch_a', b: 'ch_b', location: room, from: 100, to: 120 };

const seen = (who: string, where = 'loc_x'): Proposition => ({
  kind: 'at',
  who,
  where,
  interval: { from: 50, to: 51 },
});
const motive = (who: string): Proposition => ({
  kind: 'motive',
  who,
  against: 'ch_v',
  motiveType: 'greed',
  basis: [],
});
const belief = (proposition: Proposition, confidence = 1, extra: Partial<Belief> = {}): Belief => ({
  proposition,
  confidence,
  source: 'observed',
  acquiredAt: 50,
  fuzzMinutes: 0,
  ...extra,
});

function truthModel(): TruthModel {
  return new TruthModel({
    type: 'theft',
    victimIds: [],
    culpritIds: [],
    motive: 'f_0000000000000000',
    means: 'it_x',
    keyEventIds: [],
    window: { from: 0, to: 1 },
  });
}

function talker(
  id: string,
  beliefs: Belief[] = [],
  conceal: readonly PropositionPattern[] = [],
): Talker & { readonly knowledge: KnowledgeStore } {
  const knowledge = new KnowledgeStore();
  for (const b of beliefs) knowledge.add(b);
  return { id, knowledge, conceal };
}

const friends = (trust: number, a = 'ch_a', b = 'ch_b') =>
  new RelationshipGraph([{ a, b, type: 'friendship', trust, valence: 0.5, intensity: 0.5 }]);

describe('detectEncounters', () => {
  it('requires at least ten shared minutes in one location', () => {
    expect(detectEncounters([stay('ch_a', 0, 30), stay('ch_b', 20, 40)])).toEqual([
      { a: 'ch_a', b: 'ch_b', location: room, from: 20, to: 30 },
    ]);
    expect(detectEncounters([stay('ch_a', 0, 30), stay('ch_b', 21, 40)])).toEqual([]);
    expect(detectEncounters([stay('ch_a', 0, 30), stay('ch_b', 0, 30, 'loc_other')])).toEqual([]);
  });

  it('merges touching stays of one character and ignores self pairs and empty stays', () => {
    const result = detectEncounters([
      stay('ch_a', 0, 6),
      stay('ch_a', 6, 12),
      stay('ch_a', 3, 4),
      stay('ch_b', 0, 12),
      stay('ch_b', 5, 5),
    ]);
    expect(result).toEqual([{ a: 'ch_a', b: 'ch_b', location: room, from: 0, to: 12 }]);
  });

  it('does not merge stays with a gap and sorts the result', () => {
    const result = detectEncounters([
      stay('ch_c', 0, 100, 'loc_z'),
      stay('ch_d', 50, 100, 'loc_z'),
      stay('ch_b', 0, 100),
      stay('ch_a', 0, 5),
      stay('ch_a', 6, 100),
    ]);
    expect(result.map(({ a, b, from }) => [a, b, from])).toEqual([
      ['ch_a', 'ch_b', 6],
      ['ch_c', 'ch_d', 50],
    ]);
  });

  it('honors a custom threshold and rejects a non-positive one', () => {
    const stays = [stay('ch_a', 0, 5), stay('ch_b', 0, 5)];
    expect(detectEncounters(stays)).toEqual([]);
    expect(detectEncounters(stays, 5)).toHaveLength(1);
    expect(() => detectEncounters(stays, 0)).toThrow(RangeError);
    expect(() => detectEncounters(stays, Number.NaN)).toThrow(RangeError);
  });

  it('is independent of input order (property)', () => {
    const stayArb = fc.record({
      characterId: fc.constantFrom('ch_a', 'ch_b', 'ch_c'),
      location: fc.constantFrom('loc_1', 'loc_2'),
      from: fc.integer({ min: -50, max: 50 }),
      length: fc.integer({ min: 0, max: 40 }),
    });
    fc.assert(
      fc.property(fc.array(stayArb, { maxLength: 12 }), (raw) => {
        const stays = raw.map((s) => stay(s.characterId, s.from, s.from + s.length, s.location));
        const found = detectEncounters(stays);
        expect(detectEncounters([...stays].reverse())).toEqual(found);
        for (const e of found) {
          expect(e.to - e.from).toBeGreaterThanOrEqual(10);
          expect(e.a < e.b).toBe(true);
        }
      }),
      { seed: 3003 },
    );
  });
});

describe('converse', () => {
  it('tells a belief as told with confidence times 0.8 and the speaker as source', () => {
    const a = talker('ch_a', [belief(seen('ch_z'), 0.9)]);
    const b = talker('ch_b');
    const result = converse(encounter, [a, b], friends(0.5), truthModel());
    expect(result.transfers).toHaveLength(1);
    const [told] = b.knowledge.query({ kind: 'at' });
    expect(told).toMatchObject({
      proposition: seen('ch_z'),
      source: 'told',
      fromCharacter: 'ch_a',
      acquiredAt: 100,
    });
    expect(told?.confidence).toBeCloseTo(0.72, 10);
    expect(a.knowledge.query({ kind: 'at' })[0]?.source).toBe('observed');
  });

  it('applies memory decay of the speaker to the told proposition', () => {
    const old = belief({ kind: 'did', who: 'ch_z', verb: 'read', at: 40, where: 'loc_x' }, 1, {
      acquiredAt: 40,
      fuzzMinutes: 7,
    });
    const b = talker('ch_b');
    converse(encounter, [talker('ch_a', [old]), b], friends(0.9), truthModel());
    const [told] = b.knowledge.query({ kind: 'did' });
    expect(told?.fuzzMinutes).toBe(8);
    expect(told?.proposition).toMatchObject({ at: 45 });
  });

  it('requires trust strictly above the sensitivity of the proposition', () => {
    const beliefs = [belief(seen('ch_z')), belief(motive('ch_z'))];
    const tell = (trust: number) => {
      const b = talker('ch_b');
      converse(encounter, [talker('ch_a', beliefs), b], friends(trust), truthModel());
      return (
        b.knowledge.query({ kind: 'at' }).length + b.knowledge.query({ kind: 'motive' }).length
      );
    };
    expect(tell(0.1)).toBe(0);
    expect(tell(0.11)).toBe(1);
    expect(tell(0.6)).toBe(1);
    expect(tell(0.61)).toBe(2);
    expect(tell(-1)).toBe(0);
  });

  it('tells nothing without a relationship', () => {
    const b = talker('ch_b');
    const result = converse(
      encounter,
      [talker('ch_a', [belief(seen('ch_z'))]), b],
      new RelationshipGraph(),
      truthModel(),
    );
    expect(result.transfers).toEqual([]);
    expect(b.knowledge.serialize()).toBe('[]');
  });

  it('uses the most trusting edge and the speaker-to-listener direction', () => {
    const graph = new RelationshipGraph([
      { a: 'ch_a', b: 'ch_b', type: 'rivalry', trust: -0.5, valence: 0.5, intensity: 0.5 },
      { a: 'ch_a', b: 'ch_b', type: 'debt', trust: 0.9, valence: 0.5, intensity: 0.5 },
      { a: 'ch_b', b: 'ch_a', type: 'employment', trust: -0.9, valence: 0.5, intensity: 0.5 },
    ]);
    const a = talker('ch_a', [belief(seen('ch_z'))]);
    const b = talker('ch_b', [belief(seen('ch_y'))]);
    const result = converse(encounter, [a, b], graph, truthModel());
    expect(result.transfers.map(({ from }) => from)).toEqual(['ch_a']);
  });

  it('never tells concealed propositions', () => {
    const a = talker(
      'ch_a',
      [belief(seen('ch_z')), belief(seen('ch_y'))],
      [{ kind: 'at', who: 'ch_z' }],
    );
    const b = talker('ch_b');
    converse(encounter, [a, b], friends(1), truthModel());
    expect(b.knowledge.query({ kind: 'at' }).map((x) => x.proposition)).toEqual([seen('ch_y')]);
  });

  it('exchanges both ways simultaneously and does not echo back', () => {
    const a = talker('ch_a', [belief(seen('ch_x'))]);
    const b = talker('ch_b', [belief(seen('ch_y'))]);
    const graph = new RelationshipGraph([
      { a: 'ch_a', b: 'ch_b', type: 'friendship', trust: 0.5, valence: 0.5, intensity: 0.5 },
    ]);
    const result = converse(encounter, [a, b], graph, truthModel());
    expect(result.transfers).toHaveLength(2);
    expect(a.knowledge.query({ kind: 'at' })).toHaveLength(2);
    expect(b.knowledge.query({ kind: 'at' })).toHaveLength(2);
    // A second talk adds nothing: what each was told is weaker than what the teller holds.
    expect(converse(encounter, [a, b], graph, truthModel()).transfers).toEqual([]);
  });

  it('does not downgrade a stronger belief and does not retell a listener their own words', () => {
    const strong = belief(seen('ch_z'), 0.95);
    const b = talker('ch_b', [strong]);
    const a = talker('ch_a', [
      belief(seen('ch_z'), 0.5),
      belief(seen('ch_w'), 1, { source: 'told', fromCharacter: 'ch_b' }),
    ]);
    const result = converse(encounter, [a, b], friends(1), truthModel());
    expect(result.transfers.map((t) => t.from)).toEqual(['ch_b']);
    expect(a.knowledge.recall(seen('ch_z') as PropositionPattern, 200)?.confidence).toBeCloseTo(
      0.76,
      10,
    );
    expect(b.knowledge.recall(seen('ch_z') as PropositionPattern, 200)?.source).toBe('observed');
    expect(b.knowledge.query({ kind: 'at' })).toHaveLength(1);
  });

  it('keeps the most confident beliefs when the cap applies', () => {
    const beliefs = ['ch_1', 'ch_2', 'ch_3'].map((who, i) => belief(seen(who), 0.5 + i * 0.1));
    const b = talker('ch_b');
    const result = converse(encounter, [talker('ch_a', beliefs), b], friends(1), truthModel(), {
      maxShares: 2,
    });
    expect(result.transfers.map((t) => (t.proposition as { who: string }).who)).toEqual([
      'ch_3',
      'ch_2',
    ]);
  });

  it('breaks confidence ties across kinds by fact id', () => {
    const did: Proposition = { kind: 'did', who: 'ch_z', verb: 'read', at: 1, where: 'loc_x' };
    const props = [seen('ch_1'), motive('ch_1'), did, seen('ch_2')];
    const result = converse(
      encounter,
      [
        talker(
          'ch_a',
          props.map((p) => belief(p, 0.5)),
        ),
        talker('ch_b'),
      ],
      friends(1),
      truthModel(),
      { maxShares: 3 },
    );
    const expected = props
      .map((p) => factId(p))
      .sort()
      .slice(0, 3);
    expect(result.transfers.map((t) => factId(t.proposition))).toEqual(expected);
  });

  it('recalls a proposition without an optional field as the best belief it matches', () => {
    const bare: Proposition = { kind: 'did', who: 'ch_z', verb: 'take', at: 40, where: 'loc_x' };
    const aimed: Proposition = { ...bare, target: { kind: 'item', id: 'it_log' } };
    const later: Proposition = { ...bare, target: { kind: 'item', id: 'it_pen' } };
    const result = converse(
      encounter,
      [
        talker('ch_a', [
          belief(bare, 0.5),
          belief(aimed, 0.9),
          // Not known yet at the encounter: recall skips it.
          belief(later, 1, { acquiredAt: 110 }),
        ]),
        talker('ch_b'),
      ],
      friends(1),
      truthModel(),
    );
    expect(result.transfers.map((t) => [t.proposition, t.confidence])).toEqual([
      [aimed, 0.9 * 0.8],
    ]);
  });

  it('accepts a custom sensitivity and rejects an out-of-range one', () => {
    const run = (sensitivity: number) =>
      converse(
        encounter,
        [talker('ch_a', [belief(seen('ch_z'))]), talker('ch_b')],
        friends(0.5),
        truthModel(),
        { sensitivity: () => sensitivity },
      ).transfers.length;
    expect(run(0.4)).toBe(1);
    expect(run(0.5)).toBe(0);
    expect(() => run(1.5)).toThrow(RangeError);
    expect(() => run(-0.1)).toThrow(RangeError);
    expect(() => run(Number.NaN)).toThrow(RangeError);
  });

  it('records a talk event with both participants', () => {
    const truth = truthModel();
    const result = converse(encounter, [talker('ch_a'), talker('ch_b')], friends(0), truth);
    const event = truth.events().find(({ id }) => id === result.eventId);
    expect(event).toMatchObject({
      verb: 'talk',
      t: 100,
      duration: 20,
      actorIds: ['ch_a', 'ch_b'],
      location: room,
      visibility: 'covert',
    });
  });
});

describe('relationship drift', () => {
  const driftOf = (type: 'friendship' | 'rivalry' | 'debt', exchange: boolean) => {
    const graph = new RelationshipGraph([
      { a: 'ch_a', b: 'ch_b', type, trust: 0.5, valence: 0.5, intensity: 0.5 },
    ]);
    const a = talker('ch_a', exchange ? [belief(seen('ch_z'))] : []);
    const result = converse(encounter, [a, talker('ch_b')], graph, truthModel());
    return { edge: graph.get('ch_a', 'ch_b'), reverse: graph.get('ch_b', 'ch_a'), result };
  };

  it('warms close ties once per encounter, more when something was told', () => {
    const quiet = driftOf('friendship', false);
    expect(quiet.edge).toMatchObject({ valence: 0.51, intensity: 0.51 });
    expect(quiet.edge?.trust).toBeCloseTo(0.51, 10);
    expect(quiet.edge?.history).toEqual([quiet.result.eventId]);
    const told = driftOf('friendship', true);
    expect(told.edge?.trust).toBeCloseTo(0.52, 10);
    // Symmetric ties share state: one adjustment, not two.
    expect(told.reverse).toMatchObject({ trust: told.edge?.trust, history: told.edge?.history });
  });

  it('cools hostile ties even when something was told, and leaves debt trust alone', () => {
    const hostile = driftOf('rivalry', true);
    expect(hostile.edge?.trust).toBeCloseTo(0.49, 10);
    expect(hostile.edge?.valence).toBeCloseTo(0.49, 10);
    expect(hostile.edge?.intensity).toBeCloseTo(0.51, 10);
    expect(driftOf('debt', false).edge?.trust).toBe(0.5);
    expect(driftOf('debt', true).edge?.trust).toBeCloseTo(0.51, 10);
  });

  it('drifts every original edge of the pair and no other', () => {
    const graph = new RelationshipGraph([
      { a: 'ch_a', b: 'ch_b', type: 'debt', trust: 0, valence: 0.5, intensity: 0 },
      { a: 'ch_b', b: 'ch_a', type: 'employment', trust: 0, valence: 0.5, intensity: 0 },
      { a: 'ch_a', b: 'ch_c', type: 'friendship', trust: 0, valence: 0.5, intensity: 0 },
    ]);
    converse(encounter, [talker('ch_a'), talker('ch_b')], graph, truthModel());
    expect(graph.get('ch_a', 'ch_b')?.intensity).toBe(0.01);
    expect(graph.get('ch_b', 'ch_a')?.intensity).toBe(0.01);
    expect(graph.get('ch_a', 'ch_c')?.history).toEqual([]);
  });
});

describe('runEncounters', () => {
  it('spreads a belief along a chain and skips unknown characters', () => {
    const graph = new RelationshipGraph([
      { a: 'ch_a', b: 'ch_b', type: 'friendship', trust: 1, valence: 0.5, intensity: 0.5 },
      { a: 'ch_b', b: 'ch_c', type: 'friendship', trust: 1, valence: 0.5, intensity: 0.5 },
    ]);
    const talkers = new Map([
      ['ch_a', talker('ch_a', [belief(seen('ch_z'), 1, { acquiredAt: 0 })])],
      ['ch_b', talker('ch_b')],
      ['ch_c', talker('ch_c')],
    ]);
    const encounters = detectEncounters([
      stay('ch_a', 0, 20),
      stay('ch_b', 0, 60),
      stay('ch_c', 30, 60),
      stay('player', 0, 60),
    ]);
    const results = runEncounters(encounters, (id) => talkers.get(id), graph, truthModel());
    expect(results).toHaveLength(2);
    const heard = talkers.get('ch_c')?.knowledge.query({ kind: 'at' })[0];
    expect(heard).toMatchObject({ source: 'told', fromCharacter: 'ch_b' });
    expect(heard?.confidence).toBeCloseTo(0.64, 10);
  });
});

describe('properties', () => {
  const propositions = ['ch_1', 'ch_2', 'ch_3', 'ch_4'].map((who) => seen(who));

  it('never passes on a concealed proposition (property)', () => {
    fc.assert(
      fc.property(
        fc.subarray(propositions),
        fc.subarray(propositions, { minLength: 1 }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: 0.1, max: 1, noNaN: true }),
        (concealed, known, trust, confidence) => {
          const speaker = talker(
            'ch_a',
            known.map((p) => belief(p, confidence)),
            concealed.map((p) => p as PropositionPattern),
          );
          const listener = talker('ch_b');
          converse(encounter, [speaker, listener], friends(trust), truthModel());
          const concealedWho = new Set(concealed.map((p) => (p as { who: string }).who));
          for (const { proposition, source } of listener.knowledge.query({ kind: 'at' })) {
            expect(source).toBe('told');
            expect(concealedWho.has((proposition as { who: string }).who)).toBe(false);
          }
        },
      ),
      { seed: 3004, numRuns: 300 },
    );
  });

  it('is deterministic and keeps scores in range (property)', () => {
    fc.assert(
      fc.property(
        fc.subarray(propositions),
        fc.subarray(propositions),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.integer({ min: 1, max: 4 }),
        (fromA, fromB, trust, rounds) => {
          const run = () => {
            const a = talker(
              'ch_a',
              fromA.map((p) => belief(p, 0.7)),
            );
            const b = talker(
              'ch_b',
              fromB.map((p) => belief(p, 0.6)),
            );
            const graph = friends(trust);
            const truth = truthModel();
            for (let i = 0; i < rounds; i++) converse(encounter, [a, b], graph, truth);
            return [
              a.knowledge.serialize(),
              b.knowledge.serialize(),
              graph.snapshot(),
              truth.events(),
            ];
          };
          expect(run()).toEqual(run());
          const edge = friends(trust);
          for (let i = 0; i < 200; i++) {
            converse(encounter, [talker('ch_a'), talker('ch_b')], edge, truthModel());
          }
          const { trust: t, valence, intensity } = edge.get('ch_a', 'ch_b')!;
          expect(t).toBeLessThanOrEqual(1);
          expect(valence).toBeLessThanOrEqual(1);
          expect(intensity).toBeLessThanOrEqual(1);
        },
      ),
      { seed: 3005, numRuns: 50 },
    );
  });
});
