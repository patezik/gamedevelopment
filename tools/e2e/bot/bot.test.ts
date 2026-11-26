import { afterEach, describe, expect, test } from 'vitest';
import { runBot } from './bot.ts';
import { buildOracle, SeedUnavailableError } from './oracle.ts';
import { startBotServer, type BotServer } from './server.ts';

// Seeds of sanatorium_winter that generate and that the planner solves quickly (3 and 11 have
// the shortest paths); `npm run e2e:bot` plays ten, `--count` more.
const SEED = '3';
const CHAOS_SEED = '11';

const servers: BotServer[] = [];
// Pairing is rate limited per address: one server per game.
async function server(options?: Parameters<typeof startBotServer>[0]) {
  const started = await startBotServer(options);
  servers.push(started);
  return started;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('E2E bot on the production server assembly', () => {
  test('plays the planner path through WebSocket and phone QR scans to the solved ending', async () => {
    const result = await runBot(await server(), { seed: SEED });
    expect(result.endingId).toBe('solved');
    expect(result.captures).toBeGreaterThan(0);
    expect(result.minute).toBeLessThanOrEqual(result.budget);
    expect(result.drops).toBe(0);
  }, 60_000);

  test('random connection drops give the same final state hash as a clean run', async () => {
    const clean = await runBot(await server(), { seed: CHAOS_SEED });
    const chaotic = await runBot(await server(), {
      seed: CHAOS_SEED,
      chaos: { seed: 7, dropProbability: 0.3 },
    });
    expect(chaotic.drops).toBeGreaterThan(0);
    expect(chaotic.endingId).toBe('solved');
    expect(chaotic.stateHash).toBe(clean.stateHash);
  }, 60_000);

  test('a path without the QR captures ends partial, not solved', async () => {
    const result = await runBot(await server(), {
      seed: CHAOS_SEED,
      // Stops before the first capture: later steps of the planner path rely on captured evidence.
      path: ({ path }) => {
        const first = path.findIndex(({ type }) => type === 'captureEvidence');
        return first < 0 ? path : path.slice(0, first);
      },
    });
    expect(result.endingId).toBe('partial');
  }, 60_000);

  test('without the NPC simulation port the planner path is refused (OQ-27)', async () => {
    await expect(
      runBot(await server({ npcSimulation: false }), { seed: CHAOS_SEED }),
    ).rejects.toThrow(/was refused: ACTION_NOT_AVAILABLE/);
  }, 60_000);

  test('a seed the generator refuses has no game to play', () => {
    // Which seeds the gate refuses changes with the scenario content: look one up, do not pin it.
    for (let seed = 0; seed < 60; seed++) {
      try {
        buildOracle(String(seed));
      } catch (error) {
        expect(error).toBeInstanceOf(SeedUnavailableError);
        return;
      }
    }
    throw new Error('no refused seed among 0..59: the generator accepts everything now');
  }, 60_000);
});
