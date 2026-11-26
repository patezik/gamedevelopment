import { readFileSync } from 'node:fs';
import { FORBIDDEN_VIEW_KEYS } from '@hs/protocol';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../common/index.ts';
import type { Statement } from '../knowledge/index.ts';
import { PlayerKnowledge, PlayerKnowledgeError, type HeardStatement } from './player-knowledge.ts';
import {
  motiveTargets,
  personsOfInterest,
  SUSPICION_LEVELS,
  type SuspicionLevel,
} from './suspicion.ts';

const said = (
  id: string,
  speakerId: string,
  proposition: Record<string, unknown>,
  at = 100,
): HeardStatement => ({
  id,
  speakerId,
  proposition: proposition as HeardStatement['proposition'],
  topic: 'whereWereYou',
  at,
  templateKey: 't',
});
const at = (who: string, where = 'loc_hall') => ({
  kind: 'at',
  who,
  where,
  interval: { from: 60, to: 120 },
});
const found = (pk: PlayerKnowledge, clueId: string, discoveredAt = 10) =>
  pk.addClue({ clueId, discoveredAt, location: 'loc_study' });

/** The clues' references, as the server keeps them (`Clue.supports`). */
const clues = new Map<string, { supports: string[] }>([
  ['cl_vial', { supports: ['means(ch_nurse)'] }],
  ['cl_boots', { supports: ['presence(ch_cook,loc_cellar,130)'] }],
  ['cl_letter', { supports: ['motive(ch_bursar,ch_victim)'] }],
  ['cl_both', { supports: ['means(ch_nurse)', 'presence(ch_nurse,loc_ward,90..100)'] }],
  ['cl_twice', { supports: ['means(ch_nurse)', 'means(ch_nurse)'] }],
  ['cl_debt', { supports: ['knows(ch_cook,sec_debt)', 'about(sec_debt,ch_owner)'] }],
  ['cl_debt2', { supports: ['about(sec_other,ch_owner)', 'about(sec_x,ch_maid)'] }],
  ['cl_vague', { supports: ['contradiction(st_1,f_1)', 'weather(snow)', 'means($actor)', 'about(sec_z,$v)'] }],
]);
const context = { clues };
const ids = (pk: PlayerKnowledge) => personsOfInterest(pk, context).map((p) => p.characterId);

const code = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error instanceof PlayerKnowledgeError ? error.code : error;
  }
  return 'did not throw';
};

describe('personsOfInterest', () => {
  it('names no one before the player holds anything', () => {
    expect(personsOfInterest(new PlayerKnowledge(), context)).toEqual([]);
  });

  it('adds a character once a clue linked to them is found, with the reason', () => {
    const pk = new PlayerKnowledge();
    expect(ids(pk)).toEqual([]);
    found(pk, 'cl_vial');
    expect(personsOfInterest(pk, context)).toEqual([
      {
        characterId: 'ch_nurse',
        linkedClueIds: ['cl_vial'],
        linkedStatementIds: [],
        links: [{ source: 'clue', clueId: 'cl_vial', claim: 'means(ch_nurse)', role: 'subject' }],
      },
    ]);
  });

  it('adds a character once a heard statement is about them, with the reason', () => {
    const pk = new PlayerKnowledge();
    pk.addStatement(said('st_1', 'ch_maid', at('ch_cook')));
    expect(personsOfInterest(pk, context)).toEqual([
      {
        characterId: 'ch_cook',
        linkedClueIds: [],
        linkedStatementIds: ['st_1'],
        links: [{ source: 'statement', statementId: 'st_1', proposition: 'at', role: 'subject' }],
      },
    ]);
  });

  it('links a self-report to the speaker', () => {
    const pk = new PlayerKnowledge();
    pk.addStatement(said('st_1', 'ch_cook', at('ch_cook')));
    expect(ids(pk)).toEqual(['ch_cook']);
  });

  it('links the victim of a motive as the target', () => {
    const pk = new PlayerKnowledge();
    found(pk, 'cl_letter');
    pk.addStatement(
      said('st_1', 'ch_maid', {
        kind: 'motive',
        who: 'ch_doctor',
        against: 'ch_victim',
        motiveType: 'debt',
        basis: [],
      }),
    );
    const people = personsOfInterest(pk, context);
    expect(people.map((p) => p.characterId)).toEqual(['ch_bursar', 'ch_victim', 'ch_doctor']);
    expect(people.find((p) => p.characterId === 'ch_victim')?.links).toEqual([
      { source: 'clue', clueId: 'cl_letter', claim: 'motive(ch_bursar,ch_victim)', role: 'target' },
      { source: 'statement', statementId: 'st_1', proposition: 'motive', role: 'target' },
    ]);
  });

  it('reads characters from every kind of heard proposition, and only characters', () => {
    const pk = new PlayerKnowledge();
    pk.addStatement(
      said('st_did', 'ch_x', {
        kind: 'did',
        who: 'ch_a',
        verb: 'take',
        target: { kind: 'character', id: 'ch_b' },
        at: 5,
        where: 'loc_hall',
      }),
    );
    pk.addStatement(
      said('st_item', 'ch_x', {
        kind: 'did',
        who: 'ch_c',
        verb: 'take',
        target: { kind: 'item', id: 'it_knife' },
        at: 5,
        where: 'loc_hall',
      }),
    );
    pk.addStatement(
      said('st_has', 'ch_x', {
        kind: 'possessed',
        who: 'ch_d',
        item: 'it_key',
        interval: { from: 0, to: 9 },
      }),
    );
    pk.addStatement(
      said('st_rel', 'ch_x', { kind: 'relation', a: 'ch_e', b: 'ch_f', relType: 'lovers' }),
    );
    pk.addStatement(
      said('st_state', 'ch_x', {
        kind: 'state',
        entity: { kind: 'character', id: 'ch_g' },
        property: 'drunk',
        value: true,
        interval: { from: 0, to: 9 },
      }),
    );
    pk.addStatement(
      said('st_door', 'ch_x', {
        kind: 'state',
        entity: { kind: 'location', id: 'loc_cellar' },
        property: 'locked',
        value: true,
        interval: { from: 0, to: 9 },
      }),
    );
    expect(ids(pk)).toEqual(['ch_a', 'ch_b', 'ch_c', 'ch_d', 'ch_e', 'ch_f', 'ch_g']);
  });

  it('does not add characters the player holds nothing about', () => {
    const pk = new PlayerKnowledge();
    pk.addContact('ch_doctor', 1); // a contact is not a link
    pk.addStatement(said('st_1', 'ch_maid', at('ch_cook'))); // the speaker is only a witness
    found(pk, 'cl_boots'); // a location in a reference is not a character
    found(pk, 'cl_vague'); // a contradiction, an unknown reference, an unbound variable
    found(pk, 'cl_unreferenced'); // no references known for this clue
    expect(ids(pk)).toEqual(['ch_cook']);
    // A clue the server knows about but the player has not found links no one.
    expect(ids(pk)).not.toContain('ch_nurse');
    expect(ids(pk)).not.toContain('ch_bursar');
  });

  it('lists each person and each reason once, however often it comes up', () => {
    const pk = new PlayerKnowledge();
    found(pk, 'cl_vial', 10);
    found(pk, 'cl_vial', 20); // known already: ignored by PlayerKnowledge
    found(pk, 'cl_twice', 30); // the same reference twice
    found(pk, 'cl_both', 40); // two reasons in one clue
    pk.addStatement(said('st_1', 'ch_maid', at('ch_nurse'), 50));
    pk.addStatement(said('st_1', 'ch_maid', at('ch_nurse'), 50));
    pk.addStatement(
      said('st_2', 'ch_maid', { kind: 'relation', a: 'ch_nurse', b: 'ch_nurse', relType: 'x' }),
    );
    const people = personsOfInterest(pk, context);
    expect(people).toHaveLength(1);
    const [nurse] = people;
    expect(nurse?.linkedClueIds).toEqual(['cl_vial', 'cl_twice', 'cl_both']);
    expect(nurse?.linkedStatementIds).toEqual(['st_1', 'st_2']);
    expect(nurse?.links).toHaveLength(6);
    const keys = nurse?.links.map((link) => canonicalJson(link)) ?? [];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('follows game time, not the order of calls, and gives the same answer every time', () => {
    const build = (order: 'a' | 'b') => {
      const pk = new PlayerKnowledge();
      const steps = [
        () => found(pk, 'cl_vial', 300),
        () => pk.addStatement(said('st_1', 'ch_maid', at('ch_cook'), 200)),
        () => found(pk, 'cl_letter', 100),
      ];
      (order === 'a' ? steps : [...steps].reverse()).forEach((step) => step());
      return pk;
    };
    const a = personsOfInterest(build('a'), context);
    const b = personsOfInterest(build('b'), context);
    expect(a.map((p) => p.characterId)).toEqual(['ch_bursar', 'ch_victim', 'ch_cook', 'ch_nurse']);
    expect(canonicalJson(b)).toBe(canonicalJson(a));
    expect(canonicalJson(personsOfInterest(build('a'), context))).toBe(canonicalJson(a));
    const restored = PlayerKnowledge.restore(JSON.parse(JSON.stringify(build('a').serialize())));
    expect(canonicalJson(personsOfInterest(restored, context))).toBe(canonicalJson(a));
  });

  it('is not changed by the player marks: the game marks no one', () => {
    const pk = new PlayerKnowledge();
    found(pk, 'cl_vial');
    const before = canonicalJson(personsOfInterest(pk, context));
    pk.markSuspicion('ch_stranger', 'prime');
    pk.markSuspicion('ch_nurse', 'possible');
    expect(canonicalJson(personsOfInterest(pk, context))).toBe(before);
    expect(personsOfInterest(pk, context)[0]).not.toHaveProperty('level');
  });
});

describe('markSuspicion', () => {
  const marked = () => {
    const pk = new PlayerKnowledge();
    pk.markSuspicion('ch_cook', 'possible', 'lied about the pantry');
    return pk;
  };

  it('records the player mark with a note', () => {
    expect(marked().suspicions).toEqual([
      { characterId: 'ch_cook', level: 'possible', note: 'lied about the pantry' },
    ]);
  });

  it('accepts every level', () => {
    for (const level of SUSPICION_LEVELS) {
      const pk = new PlayerKnowledge();
      expect(pk.markSuspicion('ch_a', level, 'n')).toBe(true);
      expect(pk.suspicions[0]?.level).toBe(level);
    }
  });

  it('can mark anyone, linked to the evidence or not', () => {
    const pk = new PlayerKnowledge();
    expect(pk.markSuspicion('ch_never_met', 'prime')).toBe(true);
    expect(personsOfInterest(pk, context)).toEqual([]);
  });

  it('changes the level and keeps the note when no note is given', () => {
    const pk = marked();
    expect(pk.markSuspicion('ch_cook', 'prime')).toBe(true);
    expect(pk.suspicions).toEqual([
      { characterId: 'ch_cook', level: 'prime', note: 'lied about the pantry' },
    ]);
  });

  it('replaces the note, and an empty note removes it', () => {
    const pk = marked();
    expect(pk.markSuspicion('ch_cook', 'possible', 'boots in the cellar')).toBe(true);
    expect(pk.suspicions[0]?.note).toBe('boots in the cellar');
    expect(pk.markSuspicion('ch_cook', 'possible', '')).toBe(true);
    expect(pk.suspicions).toEqual([{ characterId: 'ch_cook', level: 'possible' }]);
  });

  it('removes the mark when it is none without a note, and keeps a note of none', () => {
    const pk = marked();
    expect(pk.markSuspicion('ch_cook', 'none')).toBe(true);
    expect(pk.suspicions).toEqual([
      { characterId: 'ch_cook', level: 'none', note: 'lied about the pantry' },
    ]);
    expect(pk.markSuspicion('ch_cook', 'none', '')).toBe(true);
    expect(pk.suspicions).toEqual([]);
    expect(pk.markSuspicion('ch_cook', 'none')).toBe(false);
  });

  it('returns false and changes nothing when the mark is the same', () => {
    const pk = marked();
    const before = canonicalJson(pk.serialize());
    expect(pk.markSuspicion('ch_cook', 'possible')).toBe(false);
    expect(pk.markSuspicion('ch_cook', 'possible', 'lied about the pantry')).toBe(false);
    expect(canonicalJson(pk.serialize())).toBe(before);
  });

  it('keeps one mark per character, in the order first marked', () => {
    const pk = marked();
    pk.markSuspicion('ch_maid', 'possible');
    pk.markSuspicion('ch_cook', 'prime');
    pk.markSuspicion('ch_maid', 'prime');
    expect(pk.suspicions.map((s) => [s.characterId, s.level])).toEqual([
      ['ch_cook', 'prime'],
      ['ch_maid', 'prime'],
    ]);
  });

  it('costs no game time: the journal and its counter stay as they were', () => {
    const pk = new PlayerKnowledge();
    found(pk, 'cl_vial', 10);
    pk.addStatement(said('st_1', 'ch_maid', at('ch_cook'), 20));
    const { journal, nextSeq } = pk.serialize();
    pk.markSuspicion('ch_cook', 'prime', 'note');
    pk.markSuspicion('ch_nurse', 'possible');
    pk.markSuspicion('ch_nurse', 'none');
    expect(pk.serialize().journal).toEqual(journal);
    expect(pk.serialize().nextSeq).toBe(nextSeq);
    // Marking takes no time argument and the modules involved never reach for the clock.
    expect(pk.markSuspicion.length).toBe(3);
    for (const file of ['./suspicion.ts', './player-knowledge.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toMatch(/from '\.\.\/time|TimeSystem|Date\.now|new Date\(/);
    }
  });

  it.each<[string, () => unknown]>([
    ['an empty character', () => new PlayerKnowledge().markSuspicion('', 'prime')],
    [
      'an unknown level',
      () => new PlayerKnowledge().markSuspicion('ch_a', 'culprit' as SuspicionLevel),
    ],
    [
      'a numeric level',
      () => new PlayerKnowledge().markSuspicion('ch_a', 2 as unknown as SuspicionLevel),
    ],
    [
      'a note that is not text',
      () => new PlayerKnowledge().markSuspicion('ch_a', 'prime', 7 as unknown as string),
    ],
  ])('refuses %s', (_name, mark) => {
    expect(code(mark)).toBe('INVESTIGATION_INVALID_INPUT');
  });

  it('gives frozen marks that cannot be changed from outside', () => {
    const pk = marked();
    const [mark] = pk.suspicions;
    expect(Object.isFrozen(mark)).toBe(true);
    (pk.suspicions as unknown[]).length = 0;
    expect(pk.suspicions).toHaveLength(1);
  });
});

describe('marks in a save', () => {
  const populated = () => {
    const pk = new PlayerKnowledge();
    found(pk, 'cl_vial', 10);
    pk.markSuspicion('ch_nurse', 'prime', 'the vial');
    pk.markSuspicion('ch_cook', 'none', 'cleared by the boots');
    pk.markSuspicion('ch_maid', 'possible');
    return pk;
  };

  it('round-trips through JSON', () => {
    const pk = populated();
    const restored = PlayerKnowledge.restore(JSON.parse(JSON.stringify(pk.serialize())));
    expect(restored.suspicions).toEqual(pk.suspicions);
    expect(canonicalJson(restored.serialize())).toBe(canonicalJson(pk.serialize()));
    expect(restored.markSuspicion('ch_nurse', 'prime')).toBe(false);
  });

  it('restores a save made before marks existed, with no marks', () => {
    const old: Record<string, unknown> = { ...populated().serialize() };
    delete old.suspicions;
    const restored = PlayerKnowledge.restore(old);
    expect(restored.suspicions).toEqual([]);
    expect(restored.clues.has('cl_vial')).toBe(true);
    expect(restored.serialize().suspicions).toEqual([]);
  });

  type Marks = Record<string, unknown>[];
  it.each<[string, (marks: Marks) => void]>([
    ['a duplicate mark', (m) => m.push({ ...m[0] })],
    ['an unknown level', (m) => (m[0]!.level = 'culprit')],
    ['an empty note', (m) => (m[0]!.note = '')],
    ['a mark of none without a note', (m) => m.push({ characterId: 'ch_x', level: 'none' })],
    ['an empty character', (m) => (m[0]!.characterId = '')],
    ['a truth key on a mark', (m) => (m[0]!.culpritIds = ['ch_nurse'])],
  ])('refuses a save with %s', (_name, damage) => {
    const saved = structuredClone(populated().serialize()) as unknown as { suspicions: Marks };
    damage(saved.suspicions);
    expect(code(() => PlayerKnowledge.restore(saved))).toBe('INVESTIGATION_INVALID_STATE');
  });
});

describe('the truth stays out', () => {
  it('this module imports nothing from the truth model', () => {
    const source = readFileSync(new URL('./suspicion.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((specifier) => /truth|accusation/.test(specifier))).toEqual([]);
  });

  it('gives the same people whether a statement was true or a lie', () => {
    const asSaid = (veracity: Statement['veracity']): Statement => ({
      ...(said('st_1', 'ch_maid', at('ch_cook')) as Statement),
      veracity,
    });
    const result = (veracity: Statement['veracity']) => {
      const pk = new PlayerKnowledge();
      pk.addStatement(asSaid(veracity));
      found(pk, 'cl_vial');
      pk.markSuspicion('ch_cook', 'prime');
      return pk;
    };
    const honest = result('true');
    const lying = result('lie');
    expect(canonicalJson(personsOfInterest(lying, context))).toBe(
      canonicalJson(personsOfInterest(honest, context)),
    );
    for (const key of FORBIDDEN_VIEW_KEYS) {
      expect(JSON.stringify(personsOfInterest(lying, context))).not.toContain(`"${key}"`);
      expect(JSON.stringify(lying.serialize())).not.toContain(`"${key}"`);
    }
  });
});

describe('motiveTargets (ENG-013)', () => {
  const targets = (pk: PlayerKnowledge) => motiveTargets(pk, context);

  it('is empty before the player holds anything', () => {
    expect(targets(new PlayerKnowledge())).toEqual([]);
  });

  it('names only the target of a motive or a secret, never whose it is', () => {
    const pk = new PlayerKnowledge();
    found(pk, 'cl_letter');
    found(pk, 'cl_debt', 20);
    // ch_bursar and ch_cook hold the motive; only the victim side is listed.
    expect(targets(pk)).toEqual(['ch_victim', 'ch_owner']);
  });

  it('lists a target once, in the order learned, from clues not yet found as well as none', () => {
    const pk = new PlayerKnowledge();
    found(pk, 'cl_debt', 5);
    found(pk, 'cl_debt2', 6);
    expect(targets(pk)).toEqual(['ch_owner', 'ch_maid']);
  });

  it('ignores claims that are not aimed at anyone and unbound variables', () => {
    const pk = new PlayerKnowledge();
    found(pk, 'cl_vial');
    found(pk, 'cl_vague', 11);
    expect(targets(pk)).toEqual([]);
  });

  it('reads the target of a heard motive', () => {
    const pk = new PlayerKnowledge();
    pk.addStatement(
      said('st_1', 'ch_maid', { kind: 'motive', who: 'ch_cook', against: 'ch_owner' }),
    );
    pk.addStatement(said('st_2', 'ch_maid', at('ch_cook')));
    expect(targets(pk)).toEqual(['ch_owner']);
  });
});
