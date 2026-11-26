import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { loadScenarioFromDir } from '@hs/core/content';
import {
  DEFAULT_SWEEP_THRESHOLDS,
  aggregateSweep,
  sweepRecord,
  type SweepRecord,
  type SweepReport,
  type SweepThresholds,
} from '../src/index.ts';

export const SCENARIOS_DIR = fileURLToPath(new URL('../../../content/scenarios/', import.meta.url));
/** Seeds handed to a worker at once: small enough to balance, large enough to amortise messages. */
const BATCH = 8;

export interface SweepOptions {
  readonly scenarioId: string;
  readonly count: number;
  readonly from: number;
  readonly workers: number;
  readonly contentDir?: string;
  readonly thresholds?: SweepThresholds;
}

export interface Timed {
  readonly record: SweepRecord;
  readonly ms: number;
}

const clock = () => Number(process.hrtime.bigint()) / 1e6;

/**
 * Generates seeds on this thread. The generator is imported dynamically: `@hs/generator` depends
 * on `@hs/validator`, so a static import would close a package cycle.
 */
export async function generateSeeds(
  scenarioId: string,
  contentDir: string,
): Promise<{ generatorVersion: string; run: (seeds: readonly string[]) => Timed[] }> {
  const { generateInvestigation, GENERATOR_VERSION } = await import('@hs/generator');
  const content = loadScenarioFromDir(`${contentDir.replace(/\/$/, '')}/${scenarioId}`);
  return {
    generatorVersion: GENERATOR_VERSION,
    run: (seeds) =>
      seeds.map((seed) => {
        const started = clock();
        const result = generateInvestigation({ scenarioId, seed }, content);
        const ms = clock() - started;
        return { record: sweepRecord(seed, result), ms };
      }),
  };
}

function runInWorkers(
  options: SweepOptions,
  contentDir: string,
  seeds: readonly string[],
): Promise<Timed[]> {
  const workerUrl = new URL('./sweep-worker.ts', import.meta.url);
  const batches: string[][] = [];
  for (let i = 0; i < seeds.length; i += BATCH) batches.push(seeds.slice(i, i + BATCH));
  const results: Timed[] = [];
  let next = 0;
  return new Promise((resolve, reject) => {
    let running = Math.min(options.workers, batches.length);
    if (running === 0) {
      resolve(results);
      return;
    }
    for (let n = 0; n < running; n++) {
      const worker = new Worker(workerUrl, {
        workerData: { scenarioId: options.scenarioId, contentDir },
      });
      const feed = () => {
        const batch = batches[next++];
        if (batch) worker.postMessage(batch);
        else void worker.terminate();
      };
      worker.on('message', (message: Timed[]) => {
        results.push(...message);
        feed();
      });
      worker.on('error', reject);
      worker.on('exit', () => {
        if (--running === 0) resolve(results);
      });
      feed();
    }
  });
}

export const defaultWorkers = () => Math.min(4, availableParallelism());

/** Runs the sweep. The report does not depend on `workers` (timing aside). */
export async function runSweep(options: SweepOptions): Promise<SweepReport> {
  const started = clock();
  const contentDir = options.contentDir ?? SCENARIOS_DIR;
  const seeds = Array.from({ length: options.count }, (_, n) => String(options.from + n));
  const { generatorVersion, run } = await generateSeeds(options.scenarioId, contentDir);
  const timed = options.workers <= 1 ? run(seeds) : await runInWorkers(options, contentDir, seeds);
  const slowest = timed.reduce<Timed | undefined>(
    (worst, entry) => (worst && worst.ms >= entry.ms ? worst : entry),
    undefined,
  );
  const total = timed.reduce((sum, { ms }) => sum + ms, 0);
  return aggregateSweep(
    timed.map(({ record }) => record),
    { scenarioId: options.scenarioId, from: options.from, generatorVersion },
    {
      meanMs: timed.length === 0 ? 0 : total / timed.length,
      maxMs: slowest?.ms ?? 0,
      maxSeed: slowest?.record.seed ?? '',
      wallMs: clock() - started,
    },
    options.thresholds ?? DEFAULT_SWEEP_THRESHOLDS,
  );
}
