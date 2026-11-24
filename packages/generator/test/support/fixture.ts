import type { Character } from '@hs/core/characters';
import type { ScenarioContent } from '@hs/core/content';
import { createRng } from '@hs/core/rng';
import { worldGen, type IncidentSelectionInput, type MotiveCandidate } from '../../src/index.ts';
import { incidentInput, minimal, motive, silent } from './incident.ts';

type Location = ScenarioContent['locations'][number];
type Item = ScenarioContent['items'][number];
type Crime = ScenarioContent['crimes'][number];
export type Routine = Character['routine'];

/** The three visitors of `_test_minimal` (ch_1, ch_2, ch_3) with real personalities. */
const base = incidentInput(minimal, 'fixture');

/** A location of a controlled fixture: bright, no hotspots, symmetric links. */
export function place(
  id: string,
  tags: string[],
  links: Readonly<Record<string, number>>,
  access: Location['access'] = [],
  locked: Readonly<Record<string, string>> = {},
): Location {
  return {
    id,
    name: id,
    description: id,
    tags,
    lighting: { morning: 'bright', day: 'bright', evening: 'bright', night: 'bright' },
    access,
    hotspots: [],
    connections: Object.entries(links).map(([to, minutes]) => ({
      to,
      minutes,
      ...(locked[to] !== undefined && { locked: { itemId: locked[to] } }),
    })),
  };
}

/** Routine blocks `[from, to, location, activity?]` in minutes of the day. */
export function routine(...blocks: [number, number, string, string?][]): Routine {
  return blocks.map(([from, to, location, activity = 'wait']) => ({
    from,
    to,
    location,
    activity,
    flexibility: 0,
  }));
}

export interface FixtureOptions {
  /** `preset.time.historyStartMinutes`; the scenario starts at 08:00. */
  readonly historyStart?: number;
  readonly locations?: readonly Location[];
  readonly items?: readonly Item[];
  readonly crime?: Partial<Omit<Crime, 'requires'>> & {
    readonly requires?: Partial<Crime['requires']>;
  };
  /** Routines by character id; others stay in the hall all day. */
  readonly routines?: Readonly<Record<string, Routine>>;
  readonly motives?: readonly MotiveCandidate[];
}

/**
 * A controlled world on top of `_test_minimal`: the hall and the archive (2 minutes apart), the
 * record in the archive, one theft template. Every part can be replaced.
 */
export function fixture(options: FixtureOptions = {}) {
  const template = minimal.crimes[0]!;
  const crime: Crime = {
    ...template,
    ...options.crime,
    requires: { ...template.requires, ...options.crime?.requires },
  };
  const content: ScenarioContent = {
    ...minimal,
    preset: {
      ...minimal.preset,
      time: {
        ...minimal.preset.time,
        historyStartMinutes: options.historyStart ?? minimal.preset.time.historyStartMinutes,
      },
    },
    locations: [...(options.locations ?? minimal.locations)],
    items: [...(options.items ?? minimal.items)],
    crimes: [crime],
  };
  const world = worldGen.generate(undefined, {
    rng: createRng('fixture#1').fork('gen/WorldGen'),
    content,
    logger: silent,
  });
  const routines = options.routines ?? {};
  const input: IncidentSelectionInput = {
    ...base,
    world,
    characters: base.characters.map((c) => ({
      ...c,
      routine: routines[c.id] ?? routine([0, 1440, 'loc_hall']),
    })),
    motives: [...(options.motives ?? [motive('ch_1', 'ch_2')])],
  };
  return { content, input };
}
