import assert from 'node:assert/strict';
import { createRng } from '@hs/core/rng';
import type { ScenarioContent } from '@hs/core/content';
import { historySimulation, type PlotWorld } from '../../src/index.ts';
import { planned } from '../support/history.ts';
import { minimal, sanatorium, silent } from '../support/incident.ts';

// ADR 0013: the history stage (3 days at most) takes <= 200 ms. Vitest 5 has no `bench`, so this
// follows packages/core/test/performance: a node script with a warm-up and the best of several
// runs per world. Only HistorySimulation is measured; the earlier stages build its input.
const BUDGET_MS = 200;
const WORLDS = 20;

function measure(world: PlotWorld, content: ScenarioContent, seed: string): number {
  const begin = process.hrtime.bigint();
  historySimulation.generate(world, {
    rng: createRng(`${seed}#1`).fork('gen/HistorySimulation'),
    content,
    logger: silent,
  });
  return Number(process.hrtime.bigint() - begin) / 1e6;
}

for (const [name, content] of [
  ['_test_minimal', minimal],
  ['sanatorium_winter', sanatorium],
] as const) {
  const worlds: [string, PlotWorld][] = [];
  for (let n = 0; worlds.length < WORLDS && n < 1000; n++) {
    const seed = `bench-${n}`;
    const world = planned(content, seed);
    if (world) worlds.push([seed, world]);
  }
  const times = worlds.map(([seed, world]) => {
    for (let warmUp = 0; warmUp < 3; warmUp++) measure(world, content, seed);
    return Math.min(...Array.from({ length: 5 }, () => measure(world, content, seed)));
  });
  times.sort((a, b) => a - b);
  const median = times[times.length >> 1]!;
  const max = times.at(-1)!;
  const minutes = -content.preset.time.historyStartMinutes;
  console.log(
    `${name}: ${worlds.length} worlds, ${minutes} min of history, median ${median.toFixed(2)} ms, ` +
      `max ${max.toFixed(2)} ms (budget ${BUDGET_MS} ms)`,
  );
  assert.ok(max < BUDGET_MS, `${name}: HistorySimulation took ${max.toFixed(2)} ms`);
}
