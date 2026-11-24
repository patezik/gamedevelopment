import { createRng } from '@hs/core/rng';
import type { ScenarioContent } from '@hs/core/content';
import { describe, expect, test } from 'vitest';
import { GenerationRejection, plotPlanning, verifyPlot } from '../../src/index.ts';
import { incidentInput, minimal, sanatorium, silent, trySelect } from '../support/incident.ts';

/** Attempt 1 of `seed` up to PlotPlanning; `undefined` when an earlier stage rejects it. */
function plan(content: ScenarioContent, seed: string) {
  let input;
  try {
    input = incidentInput(content, seed);
  } catch {
    return undefined;
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

describe.each([
  ['_test_minimal', minimal, 1000],
  ['sanatorium_winter', sanatorium, 1000],
])('plotPlanning property on %s', (_name, content, count) => {
  test(`${count} seeds: every plan is feasible`, () => {
    let planned = 0;
    for (let n = 0; n < count; n++) {
      const result = plan(content, `plot-prop-${n}`);
      if (!result) continue;
      planned++;
      expect(verifyPlot(result.world, result.plot)).toEqual([]);
    }
    expect(planned).toBeGreaterThan(0);
    // With the CNT-003 sanatorium data most seeds have motives and feasible culprits, so
    // IncidentSelection assesses many more pairs per world (about 170 s for 1000 seeds locally).
  }, 600_000);
});
