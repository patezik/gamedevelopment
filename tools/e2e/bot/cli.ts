import { parseArgs } from 'node:util';
import { runBot, type BotResult } from './bot.ts';
import { SeedUnavailableError } from './oracle.ts';
import { startBotServer } from './server.ts';

/**
 * `npm run e2e:bot -- [--seeds 1,2,3 | --count 200] [--chaos]`: the bot plays each seed on a real
 * server. `--count N` takes seeds 1..N and skips those with no game to play (the generator gate
 * refuses them or the planner finds no path); the default is a fixed set of ten playable seeds.
 * With `--chaos` every seed is played twice (clean and with random drops) and the final state
 * hashes must match. Exits non-zero unless every game played ends `solved` within the budget.
 */
const DEFAULT_SEEDS = '1,2,3,6,9,11,14,15,16,22';
const { values } = parseArgs({
  options: {
    seeds: { type: 'string' },
    count: { type: 'string' },
    chaos: { type: 'boolean' },
  },
});
const count = values.count === undefined ? undefined : Number(values.count);
if (count !== undefined && !(Number.isInteger(count) && count > 0)) {
  throw new RangeError('--count needs a positive integer');
}
const seeds =
  count === undefined
    ? (values.seeds ?? DEFAULT_SEEDS).split(',').filter(Boolean)
    : Array.from({ length: count }, (_, i) => String(i + 1));

const rows: (BotResult & { run: string })[] = [];
const skipped: string[] = [];
let failed = false;
// Pairing is rate limited per address, so every game gets its own server.
const play = async (options: Parameters<typeof runBot>[1]) => {
  const server = await startBotServer();
  try {
    return await runBot(server, options);
  } finally {
    await server.close();
  }
};
for (const seed of seeds) {
  try {
    const clean = await play({ seed });
    rows.push({ run: 'clean', ...clean });
    if (clean.endingId !== 'solved' || clean.minute > clean.budget) failed = true;
    if (values.chaos) {
      const chaotic = await play({ seed, chaos: { seed: 7, dropProbability: 0.3 } });
      rows.push({ run: 'chaos', ...chaotic });
      if (chaotic.endingId !== 'solved' || chaotic.stateHash !== clean.stateHash) failed = true;
    }
  } catch (error) {
    if (error instanceof SeedUnavailableError) {
      skipped.push(seed);
      continue;
    }
    console.error(`Seed ${seed}:`, error);
    failed = true;
  }
}
console.table(rows.map(({ stateHash, ...row }) => ({ ...row, stateHash: stateHash.slice(0, 12) })));
if (skipped.length > 0) console.log(`Skipped (no game to play): ${skipped.join(', ')}`);
console.log(`Played ${new Set(rows.map((r) => r.seed)).size}/${seeds.length} seeds`);
process.exitCode = failed || rows.length === 0 ? 1 : 0;
