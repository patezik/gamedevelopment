import { createRng } from '@hs/core/rng';
import type { ScenarioContent } from '@hs/core/content';
import { expect } from 'vitest';
import { GenerationRejection, plotPlanning, verifyPlot } from '../../src/index.ts';
import { incidentInput, silent, trySelect } from './incident.ts';

/** Attempt 1 up to PlotPlanning. Only an expected generation rejection skips a seed. */
function plan(content: ScenarioContent, seed: string) {
  let input;
  try {
    input = incidentInput(content, seed);
  } catch (error) {
    if (error instanceof GenerationRejection) return undefined;
    throw error;
  }
  const world = trySelect(input, content, seed);
  if (world instanceof GenerationRejection) return undefined;
  const { plot } = plotPlanning.generate(world, {
    rng: createRng(`${seed}#1`).fork('gen/PlotPlanning'),
    content,
    logger: silent,
  });
  return { world, plot };
}

export function checkPlotSeeds(content: ScenarioContent, from: number, to: number): void {
  let planned = 0;
  for (let n = from; n < to; n++) {
    const seed = `plot-prop-${n}`;
    const result = plan(content, seed);
    if (!result) continue;
    planned++;
    expect(verifyPlot(result.world, result.plot), seed).toEqual([]);
  }
  expect(planned).toBeGreaterThan(0);
}
