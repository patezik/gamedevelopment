import { readFileSync } from 'node:fs';
import { FORBIDDEN_VIEW_KEYS } from '@hs/protocol';
import { describe, expect, it } from 'vitest';
import { canonicalJson, stateHash } from '../common/index.ts';
import type { Statement } from '../knowledge/index.ts';
import { PlayerKnowledge, PlayerKnowledgeError, type HeardStatement } from './player-knowledge.ts';

const stated = (id: string, at = 100, speakerId = 'ch_cook'): Statement => ({
  id,
  speakerId,
  proposition: { kind: 'at', who: speakerId, where: 'loc_pantry', interval: { from: 0, to: 60 } },
  veracity: 'lie',
  topic: 'whereWereYou',
  at,
  templateKey: 'alibi_pantry',
});
/** The same statement as the player knows it: every field but the veracity. */
const heardAs = (s: Statement): HeardStatement => ({
  id: s.id,
  speakerId: s.speakerId,
  proposition: s.proposition,
  topic: s.topic,
  at: s.at,
  templateKey: s.templateKey,
});
const clue = (clueId: string, discoveredAt = 10) => ({
  clueId,
  discoveredAt,
  location: 'loc_study',
});
/** A save as plain JSON that a test may damage. */
interface SavedShape {
  clues: {
    clueId: string;
    discoveredAt: number;
    location: string;
    captured: boolean;
    [key: string]: unknown;
  }[];
  statements: { id: string; proposition: Record<string, unknown>; [key: string]: unknown }[];
  contacts: string[];
  journal: {
    seq: number;
    at: number;
    kind: string;
    clueId?: string;
    statementId?: string;
    characterId?: string;
  }[];
  nextSeq: number;
  [key: string]: unknown;
}

const code = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error instanceof PlayerKnowledgeError ? error.code : error;
  }
  return 'did not throw';
};

describe('statements carry no veracity', () => {
  it.each(['true', 'mistaken', 'lie'] as const)(
    'drops a veracity of "%s" at run time',
    (veracity) => {
      const pk = new PlayerKnowledge();
      pk.addStatement({ ...stated('st_1'), veracity });
      const [heard] = pk.statements;
      expect(heard).toBeDefined();
      expect('veracity' in (heard ?? {})).toBe(false);
      expect(JSON.stringify(pk.serialize())).not.toContain('veracity');
      expect(JSON.stringify(pk.statements)).not.toContain(
        veracity === 'lie' ? '"lie"' : '"mistaken"',
      );
    },
  );

  it('keeps everything else about what was said', () => {
    const pk = new PlayerKnowledge();
    pk.addStatement(stated('st_1'));
    expect(pk.statements).toEqual([heardAs(stated('st_1'))]);
  });

  it('accepts a statement that already has no veracity', () => {
    const pk = new PlayerKnowledge();
    expect(pk.addStatement(heardAs(stated('st_1')))).toBe(true);
  });

  it.each(FORBIDDEN_VIEW_KEYS)('refuses a statement with "%s" hidden inside it', (key) => {
    const pk = new PlayerKnowledge();
    const sneaky = {
      ...stated('st_1'),
      proposition: { ...stated('st_1').proposition, nested: { [key]: true } },
    };
    expect(code(() => pk.addStatement(sneaky as unknown as Statement))).toBe(
      'INVESTIGATION_INVALID_INPUT',
    );
    expect(pk.statements).toEqual([]);
    expect(pk.journal).toEqual([]);
  });

  it('refuses unknown extra fields on the statement itself', () => {
    const pk = new PlayerKnowledge();
    const extra = { ...stated('st_1'), culpritIds: ['ch_bursar'] };
    expect(code(() => pk.addStatement(extra as unknown as Statement))).toBe(
      'INVESTIGATION_INVALID_INPUT',
    );
  });

  it("does not keep a reference to the caller's object", () => {
    const pk = new PlayerKnowledge();
    const original = stated('st_1');
    pk.addStatement(original);
    (original.proposition as { where: string }).where = 'loc_elsewhere';
    expect(pk.statements[0]?.proposition).toMatchObject({ where: 'loc_pantry' });
  });

  it.each<[string, unknown]>([
    ['no id', { ...stated('x'), id: '' }],
    ['no speaker', { ...stated('x'), speakerId: '' }],
    ['a fractional minute', { ...stated('x'), at: 1.5 }],
    ['a proposition that is not an object', { ...stated('x'), proposition: 'at(cook, pantry)' }],
    ['a proposition without a kind', { ...stated('x'), proposition: { who: 'ch_cook' } }],
    ['not an object', 'a statement'],
    ['null', null],
  ])('refuses %s', (_name, input) => {
    expect(code(() => new PlayerKnowledge().addStatement(input as Statement))).toBe(
      'INVESTIGATION_INVALID_INPUT',
    );
  });

  it('knows a statement once: hearing it again changes nothing', () => {
    const pk = new PlayerKnowledge();
    expect(pk.addStatement(stated('st_1'))).toBe(true);
    expect(pk.addStatement(stated('st_1', 999))).toBe(false);
    expect(pk.statements).toHaveLength(1);
    expect(pk.journal).toHaveLength(1);
  });

  it('keeps statements in the order they were heard', () => {
    const pk = new PlayerKnowledge();
    pk.addStatement(stated('st_b', 300));
    pk.addStatement(stated('st_a', 100));
    expect(pk.statements.map(({ id }) => id)).toEqual(['st_b', 'st_a']);
  });

  it('stored statements cannot be changed from outside', () => {
    const pk = new PlayerKnowledge();
    pk.addStatement(stated('st_1'));
    expect(() => {
      (pk.statements[0] as { at: number }).at = 0;
    }).toThrow(TypeError);
  });
});

describe('clues', () => {
  it('stores what the player found and notes it in the journal', () => {
    const pk = new PlayerKnowledge();
    expect(pk.addClue(clue('clue_ledger', 40))).toBe(true);
    expect(pk.clues.get('clue_ledger')).toEqual({
      clueId: 'clue_ledger',
      discoveredAt: 40,
      location: 'loc_study',
      captured: false,
    });
    expect(pk.journal).toEqual([
      { seq: 0, at: 40, kind: 'clue', clueId: 'clue_ledger', location: 'loc_study' },
    ]);
  });

  it('is found once: a second find changes nothing, not even the time', () => {
    const pk = new PlayerKnowledge();
    pk.addClue(clue('c', 40));
    expect(pk.addClue({ ...clue('c', 99), captured: true })).toBe(false);
    expect(pk.clues.get('c')).toMatchObject({ discoveredAt: 40, captured: false });
    expect(pk.journal).toHaveLength(1);
  });

  it('can be found already captured', () => {
    const pk = new PlayerKnowledge();
    pk.addClue({ ...clue('c'), captured: true });
    expect(pk.clues.get('c')?.captured).toBe(true);
  });

  it('is captured by the phone later, once', () => {
    const pk = new PlayerKnowledge();
    pk.addClue(clue('c', 40));
    expect(pk.markCaptured('c', 52)).toBe(true);
    expect(pk.clues.get('c')).toMatchObject({ discoveredAt: 40, captured: true });
    expect(pk.markCaptured('c', 60)).toBe(false);
    expect(pk.journal.map(({ kind, at }) => [kind, at])).toEqual([
      ['clue', 40],
      ['capture', 52],
    ]);
  });

  it('cannot capture a clue the player has not found', () => {
    const pk = new PlayerKnowledge();
    expect(code(() => pk.markCaptured('nope', 5))).toBe('INVESTIGATION_UNKNOWN_CLUE');
    expect(pk.journal).toEqual([]);
  });

  it.each<[string, () => unknown]>([
    ['an empty clue id', () => new PlayerKnowledge().addClue({ ...clue('x'), clueId: '' })],
    ['an empty location', () => new PlayerKnowledge().addClue({ ...clue('x'), location: '' })],
    [
      'a fractional minute',
      () => new PlayerKnowledge().addClue({ ...clue('x'), discoveredAt: 1.5 }),
    ],
    ['NaN', () => new PlayerKnowledge().addClue({ ...clue('x'), discoveredAt: Number.NaN })],
    [
      'a bad capture minute',
      () => {
        const pk = new PlayerKnowledge();
        pk.addClue(clue('x'));
        pk.markCaptured('x', 0.5);
      },
    ],
  ])('refuses %s', (_name, act) => {
    expect(code(act)).toBe('INVESTIGATION_INVALID_INPUT');
  });

  it('allows a find in prehistory (negative minute)', () => {
    expect(new PlayerKnowledge().addClue(clue('c', -30))).toBe(true);
  });
});

describe('contacts', () => {
  it('are remembered once and noted in the journal', () => {
    const pk = new PlayerKnowledge();
    expect(pk.addContact('ch_doctor', 70)).toBe(true);
    expect(pk.addContact('ch_doctor', 80)).toBe(false);
    expect([...pk.contacts]).toEqual(['ch_doctor']);
    expect(pk.journal).toEqual([{ seq: 0, at: 70, kind: 'contact', characterId: 'ch_doctor' }]);
  });

  it('refuse bad input', () => {
    expect(code(() => new PlayerKnowledge().addContact('', 1))).toBe('INVESTIGATION_INVALID_INPUT');
    expect(code(() => new PlayerKnowledge().addContact('ch_a', 1.5))).toBe(
      'INVESTIGATION_INVALID_INPUT',
    );
  });
});

describe('the journal is in game-time order', () => {
  it('sorts entries that arrive out of order', () => {
    const pk = new PlayerKnowledge();
    pk.addClue(clue('late', 500));
    pk.addContact('ch_a', 20);
    pk.addStatement(stated('st_mid', 300));
    pk.addClue(clue('early', 5));
    expect(pk.journal.map(({ at }) => at)).toEqual([5, 20, 300, 500]);
  });

  it('keeps insertion order for entries of the same minute', () => {
    const pk = new PlayerKnowledge();
    pk.addClue(clue('first', 100));
    pk.addContact('ch_second', 100);
    pk.addStatement(stated('third', 100));
    pk.addClue(clue('before', 99));
    expect(pk.journal.map((entry) => entry.seq)).toEqual([3, 0, 1, 2]);
    expect(pk.journal.map(({ at }) => at)).toEqual([99, 100, 100, 100]);
  });

  it('puts a capture at the minute it happened, not where the clue was found', () => {
    const pk = new PlayerKnowledge();
    pk.addClue(clue('c', 10));
    pk.addContact('ch_a', 30);
    pk.markCaptured('c', 20);
    expect(pk.journal.map(({ kind }) => kind)).toEqual(['clue', 'capture', 'contact']);
  });

  it('has one entry per fact learned', () => {
    const pk = new PlayerKnowledge();
    pk.addClue(clue('a'));
    pk.addClue(clue('b'));
    pk.markCaptured('a', 11);
    pk.addStatement(stated('s'));
    pk.addContact('ch_a', 1);
    expect(pk.journal).toHaveLength(2 + 1 + 1 + 1);
  });

  it('entries cannot be changed from outside', () => {
    const pk = new PlayerKnowledge();
    pk.addClue(clue('c', 10));
    expect(() => {
      (pk.journal[0] as { at: number }).at = 0;
    }).toThrow(TypeError);
  });
});

describe('serialize and restore', () => {
  const populated = () => {
    const pk = new PlayerKnowledge();
    pk.addClue(clue('clue_a', 40));
    pk.addStatement(stated('st_1', 55));
    pk.addContact('ch_doctor', 12);
    pk.markCaptured('clue_a', 61);
    pk.addClue({ ...clue('clue_b', 5), captured: true });
    return pk;
  };

  it('round-trips through JSON to the same knowledge', () => {
    const pk = populated();
    const saved: unknown = JSON.parse(JSON.stringify(pk.serialize()));
    const restored = PlayerKnowledge.restore(saved);
    expect(restored.serialize()).toEqual(pk.serialize());
    expect(restored.journal).toEqual(pk.journal);
    expect([...restored.clues]).toEqual([...pk.clues]);
    expect(stateHash(restored.serialize())).toBe(stateHash(pk.serialize()));
  });

  it('is canonical JSON, with no undefined and no truth keys', () => {
    const text = canonicalJson(populated().serialize());
    for (const key of FORBIDDEN_VIEW_KEYS) expect(text).not.toContain(key);
  });

  it('keeps counting where it left off, so a restored journal stays ordered', () => {
    const restored = PlayerKnowledge.restore(populated().serialize());
    restored.addContact('ch_new', 40);
    const seqs = restored.journal.map((entry) => entry.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(restored.journal.map(({ at }) => at)).toEqual(
      [...restored.journal.map(({ at }) => at)].sort((a, b) => a - b),
    );
  });

  it('restored knowledge still ignores what it already knows', () => {
    const restored = PlayerKnowledge.restore(populated().serialize());
    expect(restored.addClue(clue('clue_a'))).toBe(false);
    expect(restored.addStatement(stated('st_1'))).toBe(false);
    expect(restored.addContact('ch_doctor', 1)).toBe(false);
  });

  it('restores an empty knowledge', () => {
    expect(PlayerKnowledge.restore(new PlayerKnowledge().serialize()).journal).toEqual([]);
  });

  it('gives a copy: changing it does not change the knowledge', () => {
    const pk = populated();
    const before = canonicalJson(pk.serialize());
    const snapshot = pk.serialize() as unknown as SavedShape;
    snapshot.clues[0]!.captured = !snapshot.clues[0]!.captured;
    snapshot.journal.length = 0;
    expect(canonicalJson(pk.serialize())).toBe(before);
  });

  const good = () => structuredClone(populated().serialize()) as unknown as SavedShape;
  const entry = (s: SavedShape, kind: string) => {
    const found = s.journal.find((e) => e.kind === kind);
    if (!found) throw new Error(`no ${kind} entry`);
    return found;
  };
  it.each<[string, (s: SavedShape) => void]>([
    ['a statement that carries veracity', (s) => (s.statements[0]!.veracity = 'lie')],
    ['a truth key hidden in a proposition', (s) => (s.statements[0]!.proposition.truth = true)],
    ['an extra top-level field', (s) => (s.culpritIds = ['ch_x'])],
    ['an extra field on a clue', (s) => (s.clues[0]!.sourceEventId = 'ev_1')],
    ['a duplicate clue', (s) => s.clues.push({ ...s.clues[0]! })],
    ['a duplicate statement', (s) => s.statements.push({ ...s.statements[0]! })],
    ['a duplicate contact', (s) => s.contacts.push(s.contacts[0]!)],
    ['a duplicate journal number', (s) => (s.journal[1]!.seq = s.journal[0]!.seq)],
    ['a journal number at or above nextSeq', (s) => (s.nextSeq = 1)],
    ['a journal out of game-time order', (s) => s.journal.reverse()],
    ['a journal entry about an unknown clue', (s) => (entry(s, 'clue').clueId = 'ghost')],
    [
      'a journal entry about an unknown statement',
      (s) => (entry(s, 'statement').statementId = 'ghost'),
    ],
    [
      'a journal entry about an unknown contact',
      (s) => (entry(s, 'contact').characterId = 'ghost'),
    ],
    [
      'a clue the journal never noted',
      (s) => (s.journal = s.journal.filter((e) => !(e.kind === 'clue' && e.clueId === 'clue_a'))),
    ],
    [
      'a statement the journal never noted',
      (s) => (s.journal = s.journal.filter((e) => e.kind !== 'statement')),
    ],
    [
      'a contact the journal never noted',
      (s) => (s.journal = s.journal.filter((e) => e.kind !== 'contact')),
    ],
    [
      'a capture entry for a clue that is not captured',
      (s) => (s.clues.find((c) => c.clueId === 'clue_a')!.captured = false),
    ],
    ['an unknown journal kind', (s) => (s.journal[0]!.kind = 'rumour')],
    ['a fractional minute', (s) => (s.clues[0]!.discoveredAt = 1.5)],
    ['a missing part', (s) => delete (s as Partial<SavedShape>).contacts],
  ])('refuses a save with %s', (_name, damage) => {
    const saved = good();
    damage(saved);
    expect(code(() => PlayerKnowledge.restore(saved))).toBe('INVESTIGATION_INVALID_STATE');
  });

  it.each([null, undefined, 42, 'save', []])('refuses %j', (input) => {
    expect(code(() => PlayerKnowledge.restore(input))).toBe('INVESTIGATION_INVALID_STATE');
  });
});

describe('the truth stays out', () => {
  it('this module imports nothing from the truth model', () => {
    const source = readFileSync(new URL('./player-knowledge.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((specifier) => /truth/.test(specifier))).toEqual([]);
  });
});
