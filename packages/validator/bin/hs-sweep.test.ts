import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runSweep } from './sweep-run.ts';

const bin = fileURLToPath(new URL('./hs-sweep.ts', import.meta.url));
const withoutTiming = <T extends object>(report: T) => ({ ...report, timing: undefined });
const hsSweep = (args: string[]) =>
  spawnSync(process.execPath, ['--experimental-transform-types', bin, ...args], {
    encoding: 'utf8',
  });

describe('hs-sweep on _test_minimal', () => {
  it('gives the same report with 1 and with 4 workers (timing aside)', async () => {
    const options = { scenarioId: '_test_minimal', count: 50, from: 0 };
    const single = await runSweep({ ...options, workers: 1 });
    const parallel = await runSweep({ ...options, workers: 4 });
    expect(single.count).toBe(50);
    expect(single.succeeded).toBeGreaterThan(0);
    expect(withoutTiming(parallel)).toEqual(withoutTiming(single));
  }, 120_000);

  it('shifts the seed range with --from', async () => {
    const shifted = await runSweep({ scenarioId: '_test_minimal', count: 3, from: 2, workers: 1 });
    expect(shifted.from).toBe(2);
    expect(shifted.count).toBe(3);
  });

  it('writes JSON and Markdown and exits non-zero when a threshold is violated', () => {
    const out = mkdtempSync(join(tmpdir(), 'hs-sweep-'));
    try {
      const args = ['--scenario', '_test_minimal', '--count', '4', '--workers', '1', '--out', out];
      expect(hsSweep([...args, '--min-entropy-ratio', '0']).status).toBe(0);
      expect(readdirSync(out).sort()).toEqual([
        'sweep-_test_minimal-0-4.json',
        'sweep-_test_minimal-0-4.md',
      ]);
      const json = JSON.parse(readFileSync(join(out, 'sweep-_test_minimal-0-4.json'), 'utf8')) as {
        count: number;
      };
      expect(json.count).toBe(4);
      // "Below 0 %" cannot hold: the exit code reports the violation.
      const violated = hsSweep([...args, '--min-entropy-ratio', '0', '--max-failure-rate', '0']);
      expect(violated.status).toBe(1);
      expect(violated.stderr).toContain('Thresholds violated');
    } finally {
      rmSync(out, { recursive: true });
    }
  }, 60_000);

  it('rejects bad arguments and an unknown scenario with exit code 2', () => {
    expect(hsSweep([]).status).toBe(2);
    expect(hsSweep(['--scenario', 'x', '--bogus', '1']).status).toBe(2);
    expect(hsSweep(['--scenario', 'x', '--count', '0']).status).toBe(2);
    expect(hsSweep(['--scenario', 'no_such_scenario', '--count', '1']).status).toBe(2);
  }, 60_000);
});
