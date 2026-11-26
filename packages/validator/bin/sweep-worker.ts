import { parentPort, workerData } from 'node:worker_threads';
import { generateSeeds } from './sweep-run.ts';

const { scenarioId, contentDir } = workerData as { scenarioId: string; contentDir: string };
const { run } = await generateSeeds(scenarioId, contentDir);
parentPort?.on('message', (seeds: string[]) => parentPort?.postMessage(run(seeds)));
