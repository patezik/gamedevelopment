import type { ScenarioContent } from '@hs/core/content';
import { createRng } from '@hs/core/rng';
import {
  GenerationRejection,
  historySimulation,
  plotPlanning,
  type HistoryWorld,
  type IncidentSelectionInput,
  type PlotWorld,
} from '../../src/index.ts';
import { incidentInput, select, silent, trySelect } from './incident.ts';

/** PlotPlanning of attempt 1 of `seed` on a prepared IncidentSelection input. */
export function plan(input: IncidentSelectionInput, content: ScenarioContent, seed = 'history') {
  return plotPlanning.generate(select(input, content, seed), {
    rng: createRng(`${seed}#1`).fork('gen/PlotPlanning'),
    content,
    logger: silent,
  });
}

/** Attempt 1 of `seed` up to PlotPlanning; `undefined` when an earlier stage rejects it. */
export function planned(content: ScenarioContent, seed: string): PlotWorld | undefined {
  let input;
  try {
    input = incidentInput(content, seed);
  } catch {
    return undefined;
  }
  const world = trySelect(input, content, seed);
  if (world instanceof GenerationRejection) return undefined;
  try {
    return plotPlanning.generate(world, {
      rng: createRng(`${seed}#1`).fork('gen/PlotPlanning'),
      content,
      logger: silent,
    });
  } catch (error) {
    if (error instanceof GenerationRejection) return undefined;
    throw error;
  }
}

/** HistorySimulation with the stream `runPipeline` gives it in attempt 1 of `seed`. */
export function simulateHistory(
  world: PlotWorld,
  content: ScenarioContent,
  seed = 'history',
): HistoryWorld | GenerationRejection {
  try {
    return historySimulation.generate(world, {
      rng: createRng(`${seed}#1`).fork('gen/HistorySimulation'),
      content,
      logger: silent,
    });
  } catch (error) {
    if (error instanceof GenerationRejection) return error;
    throw error;
  }
}
