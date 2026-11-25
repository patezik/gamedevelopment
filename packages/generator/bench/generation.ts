import { fileURLToPath } from 'node:url';
import { loadScenarioFromDir } from '@hs/core/content';
import { generateInvestigation } from '../src/index.ts';
import { checkBudget } from '../../core/bench/budget.ts';

// ADR 0006: generating one MVP investigation (the whole generateInvestigation call, gate and
// repair attempts included) takes <= 500 ms. Best of several runs per seed, median across seeds.
const BUDGET_MS = 500;
const SEEDS = 8;
const scenarios = new URL('../../../content/scenarios/', import.meta.url);

for (const id of ['_test_minimal', 'sanatorium_winter']) {
  const content = loadScenarioFromDir(fileURLToPath(new URL(`${id}/`, scenarios)));
  const times = Array.from({ length: SEEDS }, (_, n) => {
    const request = { scenarioId: id, seed: `bench-${n}` };
    generateInvestigation(request, content);
    return Math.min(
      ...Array.from({ length: 3 }, () => {
        const begin = process.hrtime.bigint();
        generateInvestigation(request, content);
        return Number(process.hrtime.bigint() - begin) / 1e6;
      }),
    );
  }).sort((a, b) => a - b);
  checkBudget(`generate ${id} (median of ${SEEDS})`, times[SEEDS >> 1]!, BUDGET_MS);
  console.log(`  max ${times.at(-1)!.toFixed(2)} ms`);
}
