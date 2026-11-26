/*
 * Incident feasibility sweep (CNT-003 acceptance): for every crime template of a scenario, the share
 * of seeds whose generated world has at least one feasible culprit (some victim, some character).
 *
 *   node --experimental-transform-types --no-warnings packages/generator/scripts/incident-sweep.ts \
 *     --scenario sanatorium_winter --from 0 --count 500 --threshold 0.9
 *
 * Each seed is attempt 1 of the pipeline (WorldGen, CastGen, SocialGen, ConflictGen with
 * `maxAttempts: 1`), assessed by IncidentSelection's `assessIncidents`: the same feasibility the
 * stage uses, with no retries. The chosen incident comes from `selectIncident` on the stage stream.
 * Exit codes: 0 every template passes, 1 a template is below the threshold, 2 invalid arguments or
 * an unexpected error (the sweep stops and prints the seed and the stack). The report holds server
 * truth: keep it out of player and phone views. `--experimental-transform-types` is needed because
 * generator sources use TypeScript parameter properties, which Node's type stripping rejects.
 */
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadScenarioFromDir } from '@hs/core/content';
import { formatReport, sweep, SweepAborted, sweepOptions } from './incident-sweep-lib.ts';

try {
  const { values } = parseArgs({
    strict: true,
    options: {
      scenario: { type: 'string' },
      from: { type: 'string' },
      count: { type: 'string' },
      threshold: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const options = sweepOptions(values);
  const root = new URL('../../../content/scenarios/', import.meta.url);
  const content = loadScenarioFromDir(fileURLToPath(new URL(`${options.scenario}/`, root)));
  const report = sweep(content, options);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
  if (report.results.some(({ pass }) => !pass)) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (error instanceof SweepAborted && error.cause instanceof Error) {
    console.error(error.cause.stack);
  }
  process.exitCode = 2;
}
