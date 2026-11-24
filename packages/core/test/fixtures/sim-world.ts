import type { RoutineBlock } from '../../src/characters/index.ts';
import type { ScenarioContent } from '../../src/content/index.ts';
import { createRng } from '../../src/rng/index.ts';
import { SimulationRunner, type SimulationLod } from '../../src/simulation/index.ts';
import { Calendar, TimeSystem } from '../../src/time/index.ts';
import { TruthModel } from '../../src/truth/index.ts';
import { ItemRegistry, LocationGraph } from '../../src/world/index.ts';

type Location = ScenarioContent['locations'][number];

export const startDateTime = '2026-01-14T00:00:00';
/** Rooms in a ring: every room connects to both neighbours, two minutes each way. */
export const roomIds = Array.from({ length: 8 }, (_, index) => `loc_room_${index}`);

const rooms: Location[] = roomIds.map((id, index) => ({
  id,
  name: id,
  description: id,
  tags: [],
  lighting: { morning: 'dim', day: 'bright', evening: 'dim', night: 'dark' },
  access: [],
  connections: [-1, 1].map((step) => ({
    to: roomIds[(index + step + roomIds.length) % roomIds.length]!,
    minutes: 2,
  })),
  hotspots: [],
}));

/** A day of six blocks that walks the character around the ring; `shift` varies characters. */
function routine(shift: number): RoutineBlock[] {
  const bounds = [0, 360, 600, 840, 1080, 1260, 1440];
  return bounds.slice(0, -1).map((from, index) => ({
    from,
    to: bounds[index + 1]!,
    location: roomIds[(shift + index * 3) % roomIds.length]!,
    activity: 'idle',
    flexibility: 0,
  }));
}

export interface SimWorldOptions {
  readonly npcs?: number;
  readonly start?: number;
  readonly endAt: number;
  readonly lod?: Pick<SimulationLod, 'level'>;
  readonly seed?: string;
}

export function createSimWorld({
  npcs = 8,
  start = 0,
  endAt,
  lod,
  seed = 'sim-world',
}: SimWorldOptions) {
  const calendar = new Calendar(startDateTime);
  const time = new TimeSystem(calendar, endAt, start);
  const preset: ScenarioContent['preset'] = {
    id: 'sim_world',
    version: 1,
    title: { ru: 'Симуляция' },
    time: { startDateTime, durationMinutes: endAt, historyStartMinutes: start },
    cast: { min: 2, max: 2, quotas: [] },
    incident: {
      types: ['theft'],
      templates: ['missing_record'],
      minMotive: 0.4,
      victimConstraints: { excludeArchetypes: [] },
    },
    criticalEvents: [],
    deadlines: [],
    endings: ['solved'],
    survival: { startVitals: { health: 10, sanity: 8, fatigue: 0 }, staticCurve: 'default' },
    phone: { minQrShare: 0 },
  };
  const world = new LocationGraph({ preset, locations: rooms });
  const items = new ItemRegistry({ locations: rooms, items: [] }, undefined, start);
  const truth = new TruthModel({
    type: 'theft',
    victimIds: ['ch_0'],
    culpritIds: ['ch_1'],
    motive: 'f_0000000000000000',
    means: 'it_record',
    keyEventIds: [],
    window: { from: -10, to: -1 },
  });
  const characters = Array.from({ length: npcs }, (_, index) => ({
    id: `ch_${index}`,
    routine: routine(index),
    access: [],
    archetypeId: 'staff',
  }));
  const runner = new SimulationRunner({
    time,
    calendar,
    world,
    items,
    truth,
    rng: createRng(seed),
    characters,
    endAt,
    ...(lod && { lod }),
  });
  return { runner, time, truth, world, items, characters };
}
