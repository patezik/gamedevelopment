import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { Calendar } from '../time/index.ts';
import { LocationGraph, type Actor } from '../world/index.ts';
import { loadScenarioFromDir } from './index.ts';

/*
 * Movement safety of the sanatorium_winter world for the player. GameEngine moves the player only
 * through an edge it can open into a location accessible at the minute of departure; the default
 * player actor has no archetype and no keys. Leaving a location is never restricted, so a location
 * becomes a trap when every neighbour is closed while the player is inside (they may wait).
 */

const root = fileURLToPath(new URL('../../../../content/scenarios/', import.meta.url));
const content = loadScenarioFromDir(join(root, 'sanatorium_winter'));
const graph = new LocationGraph(content);
const player: Actor = {};
const calendar = new Calendar(content.preset.time.startDateTime);
const { hh, mm } = calendar.toDisplay(0);
/** Game minute of the first day at a clock time (the game starts at `startDateTime`). */
const at = (hours: number, minutes = 0) => {
  const offset = hours * 60 + minutes - (hh * 60 + mm);
  return offset < 0 ? offset + 1440 : offset;
};
const day = Array.from({ length: 1440 }, (_, minute) => minute);
const start = content.preset.world?.startLocationId ?? content.locations[0]!.id;

function exits(from: string, t: number): string[] {
  return content.locations
    .find(({ id }) => id === from)!
    .connections.filter(
      ({ to }) =>
        graph.directConnection(from, to, player) !== undefined &&
        graph.isAccessible(to, player, t).ok,
    )
    .map(({ to }) => to);
}

/** Locations the player can reach from the start at some minute of the day. */
function reachable(): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const from = queue.shift()!;
    for (const t of day) {
      for (const to of exits(from, t)) {
        if (seen.has(to)) continue;
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return seen;
}

describe('sanatorium_winter movement safety for the player', () => {
  test('every location the player can enter has an open exit at every minute', () => {
    for (const location of reachable()) {
      const stuck = day.filter((t) => exits(location, t).length === 0);
      expect(stuck, `${location} has no exit at these minutes`).toEqual([]);
    }
  });

  test('the daytime stair to the boiler room: open 08:00–21:00, the exit to the hall always', () => {
    const enter = (t: number) => exits('loc_hall', t).includes('loc_boiler');
    expect([at(7, 59), at(8), at(20, 59), at(21), at(23, 30)].map(enter)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
    // After the passage closes the player inside still leaves through the hall.
    for (const t of [at(21), at(23, 30), at(3), at(7, 59)]) {
      expect(exits('loc_boiler', t)).toEqual(['loc_hall']);
    }
  });

  test('the kitchen and treatment doors of the boiler room still need its key', () => {
    const key: Actor = { itemIds: new Set(['it_key_boiler']) };
    for (const from of ['loc_kitchen', 'loc_treatment']) {
      expect(graph.directConnection(from, 'loc_boiler', player)).toBeUndefined();
      expect(graph.directConnection(from, 'loc_boiler', key)).toBeDefined();
      expect(graph.directConnection('loc_boiler', from, player)).toBeUndefined();
    }
  });

  test('at night only the holder of the boiler key enters the boiler room', () => {
    const key: Actor = { itemIds: new Set(['it_key_boiler']) };
    expect(graph.isAccessible('loc_boiler', key, at(3)).ok).toBe(true);
    // Access follows the key, not the archetype: a caretaker whose key was taken stays out.
    expect(graph.isAccessible('loc_boiler', { archetypeId: 'caretaker' }, at(3)).ok).toBe(false);
    expect(graph.isAccessible('loc_boiler', { archetypeId: 'cook' }, at(3)).ok).toBe(false);
  });

  test('visitors without the key come to the boiler room only within 08:00–21:00', () => {
    // Routine blocks are minutes of the day; the key's owner may come at any time.
    const keyOwner = content.items.find(({ id }) => id === 'it_key_boiler')!.ownerArchetype;
    const visits = content.archetypes.flatMap(({ id, routine }) =>
      id === keyOwner
        ? []
        : routine
            .filter(({ locationId }) => locationId === 'loc_boiler')
            .map(({ from, to }) => ({ id, from, to })),
    );
    expect(visits.length).toBeGreaterThan(0);
    for (const { id, from, to } of visits) {
      expect(from < to && from >= 8 * 60 && to <= 21 * 60, `${id} ${from}–${to}`).toBe(true);
    }
  });
});
