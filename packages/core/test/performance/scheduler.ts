import assert from 'node:assert/strict';
import { checkBudget } from '../../bench/budget.ts';
import { Scheduler, type TickPhase } from '../../src/time/scheduler.ts';

const eventCount = 100_000;
const budgetMs = 200;

function measureScheduler(): number {
  const scheduler = new Scheduler();
  let seed = 12345;
  const start = process.hrtime.bigint();
  for (let index = 0; index < eventCount; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    scheduler.schedule({
      at: seed % 4320,
      phase: ((seed >>> 12) % 7) as TickPhase,
      priority: (seed >>> 20) % 5,
      kind: 'e',
      payload: null,
    });
  }
  let popped = 0;
  while (scheduler.popNext(Number.MAX_SAFE_INTEGER)) popped++;
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(popped, eventCount);
  return elapsedMs;
}

measureScheduler(); // Warm up the JIT.
const samples = Array.from({ length: 9 }, measureScheduler);
const bestMs = Math.min(...samples);
console.log(
  `Scheduler: ${samples.map((ms) => ms.toFixed(1)).join(', ')} ms (limit: ${budgetMs} ms)`,
);
checkBudget('scheduler 100k events', bestMs, budgetMs);
