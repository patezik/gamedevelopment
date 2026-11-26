import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadScenarioFromDir, type ScenarioContent } from '@hs/core/content';
import { LocationGraph, WorldError } from '@hs/core/world';

const fixture = fileURLToPath(
  new URL('../../../../content/scenarios/_test_minimal', import.meta.url),
);
const content = loadScenarioFromDir(fixture);
const hall = content.locations.find(({ id }) => id === 'loc_hall')!;
const archive = content.locations.find(({ id }) => id === 'loc_archive')!;

function graph(locations: ScenarioContent['locations']): LocationGraph {
  return new LocationGraph({ preset: content.preset, locations });
}

describe('LocationGraph', () => {
  it('keeps repeated route answers independent from caller mutation and other graphs', () => {
    const world = new LocationGraph(content);
    const original = world.path(hall.id, archive.id);
    original.length = 0;
    expect(world.path(hall.id, archive.id)).toEqual([hall.id, archive.id]);
    const step = world.nextTimedStep(hall.id, archive.id, {}, 0)!;
    const expected = { ...step };
    Object.assign(step, { destination: 'changed', arriveAt: 999 });
    expect(world.nextTimedStep(hall.id, archive.id, {}, 0)).toEqual(expected);
    const disconnected = graph(
      content.locations.map((location) => ({ ...location, connections: [] })),
    );
    expect(disconnected.travelTime(hall.id, archive.id)).toBeNull();
  });
  it('uses the loaded scenario for paths, travel time, public access and lighting', () => {
    const world = new LocationGraph(content);
    expect(world.path(hall.id, archive.id)).toEqual([hall.id, archive.id]);
    expect(world.travelTime(hall.id, archive.id)).toBe(2);
    expect(world.path(hall.id, hall.id)).toEqual([hall.id]);
    expect(world.travelTime(hall.id, hall.id)).toBe(0);
    expect(world.isAccessible(hall.id, {}, 0)).toEqual({ ok: true });
    expect(world.lightingAt(hall.id, 'morning')).toBe('bright');
    expect(world.lightingAt(hall.id, 'evening')).toBe('dim');
    expect(world.lightingAt(hall.id, 'night')).toBe('dark');
  });

  it('computes the cheapest route and breaks equal costs by predecessor id', () => {
    const edges = [
      { to: 'loc_b', minutes: 1 },
      { to: 'loc_a', minutes: 2 },
      { to: archive.id, minutes: 6 },
    ];
    const locations = [
      { ...archive, connections: [] },
      { ...hall, id: 'loc_a', connections: [{ to: archive.id, minutes: 2 }] },
      { ...hall, id: 'loc_b', connections: [{ to: archive.id, minutes: 3 }] },
    ];
    for (const connections of [edges, [...edges].reverse()]) {
      const world = graph([{ ...hall, connections }, ...locations]);
      expect(world.path(hall.id, archive.id)).toEqual([hall.id, 'loc_a', archive.id]);
      expect(world.travelTime(hall.id, archive.id)).toBe(4);
    }
  });

  it('skips locked connections and preserves direction', () => {
    const world = graph([
      { ...hall, connections: [{ to: archive.id, minutes: 2, locked: { itemId: 'it_key' } }] },
      { ...archive, connections: [{ to: hall.id, minutes: 2, locked: {} }] },
    ]);
    const actor = { itemIds: new Set(['it_key']) };
    expect(world.travelTime(hall.id, archive.id, { itemIds: new Set(['it_wrong']) })).toBeNull();
    expect(() => world.path(hall.id, archive.id)).toThrow(
      expect.objectContaining({ code: 'WORLD_NO_PATH' }),
    );
    expect(world.path(hall.id, archive.id, actor)).toEqual([hall.id, archive.id]);
    expect(world.travelTime(archive.id, hall.id, actor)).toBeNull();
    expect(() => world.path(hall.id, 'loc_unknown')).toThrow(WorldError);
    expect(() => world.travelTime('loc_unknown', hall.id)).toThrow(
      expect.objectContaining({ code: 'WORLD_UNKNOWN_LOCATION' }),
    );
  });

  it('combines conditions inside a rule and permits any matching alternative', () => {
    const world = graph([
      hall,
      {
        ...archive,
        access: [
          { from: 22 * 60, to: 6 * 60, archetypes: ['guard'], itemId: 'it_key' },
          { from: 9 * 60, to: 10 * 60 },
        ],
      },
    ]);
    const guard = { archetypeId: 'guard', itemIds: new Set(['it_key']) };
    // The fixture starts at 08:00.
    for (const minute of [14 * 60, 16 * 60, 22 * 60 - 1, -121]) {
      expect(world.isAccessible(archive.id, guard, minute)).toEqual({ ok: true });
    }
    expect(world.isAccessible(archive.id, guard, 22 * 60)).toEqual({
      ok: false,
      reason: 'outside_hours',
    });
    expect(world.isAccessible(archive.id, { archetypeId: 'guard' }, 14 * 60)).toEqual({
      ok: false,
      reason: 'missing_item',
    });
    expect(world.isAccessible(archive.id, {}, 14 * 60)).toEqual({
      ok: false,
      reason: 'archetype_not_allowed',
    });
    expect(world.isAccessible(archive.id, {}, 60)).toEqual({ ok: true });
  });
});
