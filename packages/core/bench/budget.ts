import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

// QA-002: performance budgets. A row passes when it is under its absolute budget (ADR 0006/0013)
// AND has not regressed more than TOLERANCE against the stored baseline. Raw milliseconds differ
// between machines, so the baseline stores time relative to a fixed calibration workload run on
// the same machine. Refresh the baseline deliberately with `BENCH_UPDATE=1`.
export const TOLERANCE = 0.2;
const BASELINE = new URL('./baseline.json', import.meta.url);

interface Baseline {
  rows: Record<string, number>;
}

function readBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;
}

function calibrationRun(): number {
  const begin = process.hrtime.bigint();
  let hash = 1;
  const values = new Array<number>(50_000);
  for (let round = 0; round < 40; round++) {
    for (let index = 0; index < values.length; index++) {
      hash = (Math.imul(hash, 1664525) + 1013904223) >>> 0;
      values[index] = hash;
    }
    values.sort((a, b) => a - b);
  }
  return Number(process.hrtime.bigint() - begin) / 1e6;
}

let calibration: number | undefined;
/** Best of several runs of a fixed workload, in ms; the unit of the relative baseline. */
export function calibrationMs(): number {
  if (calibration === undefined) {
    calibrationRun();
    calibration = Math.min(...Array.from({ length: 5 }, calibrationRun));
  }
  return calibration;
}

/** Throws when `ms` exceeds the budget or regresses over the baseline by more than 20 %. */
export function checkBudget(name: string, ms: number, budgetMs: number): void {
  const relative = ms / calibrationMs();
  const update = process.env['BENCH_UPDATE'] === '1';
  const baseline = readBaseline();
  const stored = baseline.rows[name];
  if (update) {
    baseline.rows[name] = Number(relative.toPrecision(3));
    writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
  }
  const note = stored === undefined ? 'no baseline' : `baseline ${stored.toPrecision(3)}`;
  console.log(
    `${name}: ${ms.toFixed(2)} ms (budget ${budgetMs} ms), relative ${relative.toPrecision(3)} (${note})`,
  );
  assert.ok(ms < budgetMs, `${name} took ${ms.toFixed(2)} ms, budget ${budgetMs} ms`);
  if (update) return;
  assert.ok(stored !== undefined, `${name}: no baseline; run with BENCH_UPDATE=1`);
  assert.ok(
    relative <= stored * (1 + TOLERANCE),
    `${name}: relative time ${relative.toPrecision(3)} is over baseline ${stored} by more than ${TOLERANCE * 100}%`,
  );
}
