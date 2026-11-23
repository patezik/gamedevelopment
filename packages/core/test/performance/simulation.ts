import assert from 'node:assert/strict';
import { SimulationLod } from '../../src/simulation/index.ts';
import { createSimWorld, roomIds } from '../fixtures/sim-world.ts';

// ADR 0013 budgets: 60 game minutes with 8 NPC <= 10 ms; 3 days of history <= 200 ms.
// Vitest 5 has no `bench`, so this follows scheduler.ts: a node script with a warm-up and the
// best of several runs. Only advancing time is measured; building the world is not.
function measure(minutes: number, start: number, focus: boolean): number {
  const lod = new SimulationLod(createSimWorld({ endAt: start + minutes, start }).world);
  if (focus) lod.setFocus(roomIds[0]!);
  const { time } = createSimWorld({ endAt: start + minutes, start, lod });
  const begin = process.hrtime.bigint();
  time.advance(minutes);
  return Number(process.hrtime.bigint() - begin) / 1e6;
}

function best(minutes: number, start: number, focus: boolean): number {
  for (let warmUp = 0; warmUp < 5; warmUp++) measure(minutes, start, focus);
  return Math.min(...Array.from({ length: 15 }, () => measure(minutes, start, focus)));
}

const rows = [
  { name: '60 min x 8 NPC, background', minutes: 60, start: 600, focus: false, budgetMs: 10 },
  { name: '60 min x 8 NPC, focus', minutes: 60, start: 600, focus: true, budgetMs: 10 },
  { name: '24 h history x 8 NPC', minutes: 1440, start: 0, focus: false, budgetMs: 200 },
  { name: '3 days history x 8 NPC', minutes: 4320, start: 0, focus: false, budgetMs: 200 },
];
for (const { name, minutes, start, focus, budgetMs } of rows) {
  const ms = best(minutes, start, focus);
  console.log(`${name}: ${ms.toFixed(2)} ms (budget ${budgetMs} ms)`);
  assert.ok(ms < budgetMs, `${name} took ${ms.toFixed(2)} ms`);
}
