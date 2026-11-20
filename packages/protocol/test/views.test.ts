import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { FORBIDDEN_VIEW_KEYS, PhoneView, PlayerView, ServerMessage } from '@hs/protocol';
import { renderSchemas } from '../scripts/schemas.ts';

type Path = (string | number)[];
const REMOVE = Symbol('remove');

const dir = new URL('../fixtures/views/', import.meta.url);
const load = (file: string): unknown => JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
const names = readdirSync(dir)
  .filter((file) => file.endsWith('.json'))
  .sort();
const playerFiles = names.filter((file) => file.startsWith('player-view.'));
const phoneFiles = names.filter((file) => file.startsWith('phone-view.'));
const player = (stage: string): PlayerView => PlayerView.parse(load(`player-view.${stage}.json`));
const phone = (stage: string): PhoneView => PhoneView.parse(load(`phone-view.${stage}.json`));

/** Every object in a JSON value, with the path to it. */
function objects(value: unknown, path: Path = []): Path[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => objects(item, [...path, i]));
  if (typeof value !== 'object' || value === null) return [];
  return [path, ...Object.entries(value).flatMap(([key, child]) => objects(child, [...path, key]))];
}

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
}

/** A copy of `base` with the value at `path` replaced (or removed). */
function edit(base: unknown, path: Path, value: unknown): unknown {
  const copy = structuredClone(base) as Record<string | number, unknown>;
  const parent = path
    .slice(0, -1)
    .reduce<Record<string | number, unknown>>(
      (node, step) => node[step] as Record<string | number, unknown>,
      copy,
    );
  const last = path[path.length - 1] as string | number;
  if (value === REMOVE) delete parent[last];
  else parent[last] = value;
  return copy;
}

const withKey = (base: unknown, path: Path, key: string): unknown =>
  edit(base, [...path, key], 'x');

function schemaPropertyNames(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(schemaPropertyNames);
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) =>
    key === 'properties' && typeof child === 'object' && child !== null
      ? [...Object.keys(child), ...schemaPropertyNames(Object.values(child))]
      : schemaPropertyNames(child),
  );
}

describe('fixtures', () => {
  it('has at least 3 fixtures per view, including start, mid-game and ending', () => {
    expect(playerFiles.length).toBeGreaterThanOrEqual(3);
    expect(phoneFiles.length).toBeGreaterThanOrEqual(3);
    for (const stage of ['start', 'mid', 'end']) {
      expect(playerFiles).toContain(`player-view.${stage}.json`);
      expect(phoneFiles).toContain(`phone-view.${stage}.json`);
    }
  });

  it.each(playerFiles)('%s is a valid PlayerView and not a PhoneView', (file) => {
    expect(PlayerView.safeParse(load(file)).success).toBe(true);
    expect(PhoneView.safeParse(load(file)).success).toBe(false);
  });

  it.each(phoneFiles)('%s is a valid PhoneView and not a PlayerView', (file) => {
    expect(PhoneView.safeParse(load(file)).success).toBe(true);
    expect(PlayerView.safeParse(load(file)).success).toBe(false);
  });

  it('the view.update message fixture carries the start PhoneView', () => {
    const messages = JSON.parse(
      readFileSync(new URL('../fixtures/server-messages.json', import.meta.url), 'utf8'),
    ) as { type: string; payload: { view: unknown } }[];
    expect(messages.find(({ type }) => type === 'view.update')?.payload.view).toEqual(
      phone('start'),
    );
  });
});

describe('fixtures tell the stories they are named for', () => {
  it('start: nothing found yet, game just begun', () => {
    const view = player('start');
    expect(view.clock.t).toBe(0);
    expect(view.caseBoard.clues).toHaveLength(0);
    expect(view.ending).toBeUndefined();
    expect(phone('start').contacts.length).toBeGreaterThan(0);
  });

  it('mid: 5 clues and a call in progress', () => {
    expect(player('mid').caseBoard.clues).toHaveLength(5);
    expect(phone('mid').activeCall?.state).toBe('active');
  });

  it('capture: a clue waits for the phone camera', () => {
    const view = player('capture');
    expect(view.pendingCapture?.tokenId).toBeTruthy();
    expect(view.caseBoard.clues.some((clue) => !clue.captured)).toBe(true);
  });

  it('end: only the ending fixture ends the game', () => {
    expect(player('end').ending?.endingId).toBe('solved');
    for (const file of playerFiles.filter((f) => f !== 'player-view.end.json')) {
      expect(PlayerView.parse(load(file)).ending).toBeUndefined();
    }
  });

  it('references between parts of the case board resolve', () => {
    for (const file of playerFiles) {
      const view = PlayerView.parse(load(file));
      const { clues, statements, contradictions, personsOfInterest, timeline } = view.caseBoard;
      const clueIds = new Set(clues.map(({ id }) => id));
      const statementIds = new Set(statements.map(({ id }) => id));
      const contradictionIds = new Set(contradictions.map(({ id }) => id));
      const known = new Set([...clueIds, ...statementIds]);
      for (const c of contradictions) {
        expect(statementIds.has(c.statementId), `${file} ${c.id}`).toBe(true);
        expect(known.has(c.againstId), `${file} ${c.id}`).toBe(true);
      }
      for (const p of personsOfInterest) {
        for (const id of p.linkedClueIds) expect(clueIds.has(id), `${file} ${id}`).toBe(true);
      }
      for (const t of timeline) {
        for (const id of t.sourceIds) expect(known.has(id), `${file} ${id}`).toBe(true);
      }
      for (const item of view.interaction?.presentable ?? []) {
        const pool = item.type === 'evidence' ? clueIds : contradictionIds;
        expect(pool.has(item.id), `${file} ${item.id}`).toBe(true);
      }
    }
  });
});

describe('no truth in views (AGENTS.md rule 1)', () => {
  it('forbids exactly the four truth keys', () => {
    expect([...FORBIDDEN_VIEW_KEYS].sort()).toEqual([
      'culpritIds',
      'hallucination',
      'truth',
      'veracity',
    ]);
  });

  it.each(['player-view.json', 'phone-view.json'])('%s declares no truth-like property', (file) => {
    const properties = schemaPropertyNames(JSON.parse(renderSchemas()[file] ?? '{}'));
    expect(properties.length).toBeGreaterThan(20); // the walk really reached the nested types
    for (const key of FORBIDDEN_VIEW_KEYS) expect(properties).not.toContain(key);
    expect(properties.filter((name) => /veracity|culprit|hallucinat|truth/i.test(name))).toEqual(
      [],
    );
  });

  it('no fixture contains a forbidden key at any depth', () => {
    for (const file of names) {
      const keys = keysOf(load(file));
      for (const key of FORBIDDEN_VIEW_KEYS) expect(keys, `${file}: ${key}`).not.toContain(key);
    }
  });

  const cases: [string, z.ZodType][] = [
    ...playerFiles.map((file): [string, z.ZodType] => [file, PlayerView]),
    ...phoneFiles.map((file): [string, z.ZodType] => [file, PhoneView]),
  ];
  it.each(cases)('%s: a forbidden or unknown key is rejected in every object', (file, schema) => {
    const fixture = load(file);
    const places = objects(fixture);
    expect(places.length).toBeGreaterThan(5);
    for (const path of places) {
      for (const key of [...FORBIDDEN_VIEW_KEYS, 'extra']) {
        const result = schema.safeParse(withKey(fixture, path, key));
        expect(result.success, `${file} at ${path.join('.')} + ${key}`).toBe(false);
      }
    }
  });

  it('the ending reveals the solution only under `recap`, and only in an ending', () => {
    expect(player('end').ending?.recap?.responsible.length).toBeGreaterThan(0);
    expect(JSON.stringify(player('mid'))).not.toContain('responsible');
  });
});

describe('PlayerView rejects invalid data', () => {
  it.each<[string, Path, unknown]>([
    ['health above 10', ['vitals', 'health'], 11],
    ['negative sanity', ['vitals', 'sanity'], -1],
    ['fatigue above 100', ['vitals', 'fatigue'], 101],
    ['static above 100', ['static'], 101],
    ['fractional health', ['vitals', 'health'], 7.5],
    ['clock face 24:00', ['clock', 'time'], '24:00'],
    ['clock face without zero padding', ['clock', 'time'], '8:00'],
    ['unknown period', ['clock', 'period'], 'dawn'],
    ['negative remaining time', ['clock', 'remainingMinutes'], -1],
    ['unknown lighting', ['location', 'lighting'], 'pitch_black'],
    ['cost preview min above max', ['availableActions', 0, 'costPreview'], { min: 30, max: 20 }],
    ['action that is not a PlayerAction', ['availableActions', 0, 'action'], { type: 'teleport' }],
    ['unknown clue kind', ['caseBoard', 'clues', 0, 'kind'], 'rumour'],
    ['unknown suspicion level', ['caseBoard', 'suspicions', 0, 'level'], 'guilty'],
    ['unknown ending', ['ending'], { endingId: 'victory', title: 't', text: 't' }],
    ['missing case board', ['caseBoard'], REMOVE],
    ['missing vitals', ['vitals'], REMOVE],
    ['empty id', ['location', 'id'], ''],
    ['phone battery above 100', ['phone', 'battery'], 101],
  ])('%s', (_name, path, value) => {
    expect(PlayerView.safeParse(edit(player('mid'), path, value)).success).toBe(false);
  });

  it('accepts optional parts being absent', () => {
    let view: unknown = player('mid');
    for (const key of ['interaction', 'pendingCapture', 'ending']) view = edit(view, [key], REMOVE);
    expect(PlayerView.safeParse(view).success).toBe(true);
  });
});

describe('PhoneView rejects invalid data', () => {
  it.each<[string, Path, unknown]>([
    ['battery above 100', ['status', 'battery'], 101],
    ['signal below 0', ['status', 'signal'], -1],
    ['glitch above 100', ['effects', 'glitchLevel'], 101],
    ['negative badge', ['apps', 0, 'badge'], -1],
    ['unknown call state', ['activeCall', 'state'], 'on_hold'],
    ['unknown message author', ['threads', 0, 'messages', 0, 'from'], 'system'],
    ['unknown call direction', ['callLog', 0, 'direction'], 'forwarded'],
    ['note without a source', ['notes', 0, 'source'], REMOVE],
    ['missing contacts', ['contacts'], REMOVE],
    ['a locked file that still carries its content', ['files', 1, 'content'], 'secret'],
  ])('%s', (_name, path, value) => {
    expect(PhoneView.safeParse(edit(phone('mid'), path, value)).success).toBe(false);
  });

  it('an unlocked file carries its content; a locked one only a hint', () => {
    const [open, locked] = phone('mid').files;
    expect(open).toMatchObject({ locked: false });
    expect(open?.content).toBeTruthy();
    expect(locked).toMatchObject({ locked: true });
    expect(typeof locked?.passwordHint).toBe('string');
    expect(locked?.content).toBeUndefined();
  });

  it('gallery items share one shape: nothing marks a photo as evidence or not', () => {
    const shapes = phoneFiles.flatMap((file) =>
      PhoneView.parse(load(file)).gallery.map((item) =>
        Object.keys(item)
          .filter((key) => key !== 'caption')
          .sort()
          .join(),
      ),
    );
    expect(shapes.length).toBeGreaterThan(0);
    expect(new Set(shapes).size).toBe(1);
  });
});

describe('view.update carries either view', () => {
  const envelope = (view: unknown) => ({
    v: 1,
    type: 'view.update',
    id: 's-9',
    payload: { stateVersion: 3, view },
  });

  it('accepts a PlayerView and a PhoneView', () => {
    expect(ServerMessage.safeParse(envelope(player('mid'))).success).toBe(true);
    expect(ServerMessage.safeParse(envelope(phone('mid'))).success).toBe(true);
  });

  it.each([
    ['an empty object', {}],
    ['a list', []],
    ['a PlayerView with a phone-only part', { ...player('mid'), apps: [] }],
    ['a PhoneView with a player-only part', { ...phone('mid'), clock: player('mid').clock }],
  ])('rejects %s', (_name, view) => {
    expect(ServerMessage.safeParse(envelope(view)).success).toBe(false);
  });
});
