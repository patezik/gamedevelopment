import { fileURLToPath } from 'node:url';
import type { Character } from '@hs/core/characters';
import { loadScenarioFromDir, type ScenarioContent } from '@hs/core/content';
import { createRng } from '@hs/core/rng';
import {
  castGen,
  conflictGen,
  GenerationRejection,
  incidentSelection,
  runPipeline,
  socialGen,
  worldGen,
  type IncidentSelectionInput,
  type IncidentWorld,
  type MotiveCandidate,
} from '../../src/index.ts';

const root = new URL('../../../../content/scenarios/', import.meta.url);
export const silent = { debug() {} };

export function scenario(id: string): ScenarioContent {
  return loadScenarioFromDir(fileURLToPath(new URL(`${id}/`, root)));
}

export const minimal = scenario('_test_minimal');
export const sanatorium = scenario('sanatorium_winter');

/** The IncidentSelection input of attempt 1 of `seed`, with the streams `runPipeline` would use. */
export function incidentInput(content: ScenarioContent, seed: string): IncidentSelectionInput {
  const world = worldGen.generate(undefined, {
    rng: createRng(`${seed}#1`).fork('gen/WorldGen'),
    content,
    logger: silent,
  });
  const result = runPipeline([castGen, socialGen, conflictGen], undefined, {
    seed,
    content,
    now: () => 0,
  });
  if (!result.ok) throw new Error(`ConflictGen failed for seed ${seed}`);
  return { ...result.output, world };
}

/** Runs the stage with the stream `runPipeline` gives it in attempt 1 of `seed`. */
export function select(
  input: IncidentSelectionInput,
  content: ScenarioContent,
  seed = 'select',
): IncidentWorld {
  return incidentSelection.generate(input, {
    rng: createRng(`${seed}#1`).fork('gen/IncidentSelection'),
    content,
    logger: silent,
  });
}

export function trySelect(
  input: IncidentSelectionInput,
  content: ScenarioContent,
  seed = 'select',
): IncidentWorld | GenerationRejection {
  try {
    return select(input, content, seed);
  } catch (error) {
    if (error instanceof GenerationRejection) return error;
    throw error;
  }
}

/** A motive of `who` against `against` (for fixtures that control motives directly). */
export function motive(who: string, against: string, strength = 0.5): MotiveCandidate {
  return { who, against, motiveType: 'protect_record', strength, basis: [] };
}

/** Every ordered pair has a motive of the given strength. */
export function everyMotive(input: IncidentSelectionInput, strength = 0.5): MotiveCandidate[] {
  return input.characters.flatMap((c) =>
    input.characters.filter((v) => v.id !== c.id).map((v) => motive(c.id, v.id, strength)),
  );
}

/** A routine with one block for the whole day. */
export function stay(location: string, activity = 'wait'): Character['routine'] {
  return [{ from: 0, to: 1440, location, activity, flexibility: 0 }];
}

export function withRoutine(
  input: IncidentSelectionInput,
  routines: Readonly<Record<string, Character['routine']>>,
): IncidentSelectionInput {
  return {
    ...input,
    characters: input.characters.map((c) =>
      routines[c.id] ? { ...c, routine: routines[c.id]! } : c,
    ),
  };
}

type Crime = ScenarioContent['crimes'][number];

export function withCrime(content: ScenarioContent, change: (crime: Crime) => Crime) {
  return { ...content, crimes: content.crimes.map(change) };
}

export function withIncident(
  content: ScenarioContent,
  incident: Partial<ScenarioContent['preset']['incident']>,
): ScenarioContent {
  return {
    ...content,
    preset: { ...content.preset, incident: { ...content.preset.incident, ...incident } },
  };
}
