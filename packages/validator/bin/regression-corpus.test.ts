import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCorpus, parseBaseline, parseCorpus } from '../src/index.ts';
import { SCENARIOS_DIR, generateSeeds } from './sweep-run.ts';

const file = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const sweepCheck = fileURLToPath(new URL('./sweep-check.ts', import.meta.url));

describe('regression corpus (VAL-008)', () => {
  const corpus = parseCorpus(readFileSync(file('regression-seeds.json'), 'utf8'));

  it('keeps the recorded outcome of every seed', async () => {
    expect(corpus.seeds.some(({ expect: expectation }) => expectation === 'pass')).toBe(true);
    const { run } = await generateSeeds(corpus.scenarioId, SCENARIOS_DIR);
    const outcomes = new Map(
      run(corpus.seeds.map(({ seed }) => seed)).map(({ record }) => [record.seed, record.ok]),
    );
    const verdict = checkCorpus(corpus, outcomes);
    // A known failure that generates now is an improvement: move it to `pass` (testing-strategy.md).
    expect(verdict.regressions, 'seeds of the corpus that stopped generating').toEqual([]);
  }, 180_000);

  it('has a readable baseline for the same scenario', () => {
    const baseline = parseBaseline(readFileSync(file('sweep-baseline.json'), 'utf8'));
    expect(baseline.scenarioId).toBe(corpus.scenarioId);
  });
});

describe('sweep-check', () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, ['--experimental-transform-types', sweepCheck, ...args], {
      encoding: 'utf8',
    });

  it('exits 1 on a regression, 0 otherwise and 2 for a missing baseline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-check-'));
    try {
      const write = (failureRate: number) => {
        const path = join(dir, `report-${failureRate}.json`);
        writeFileSync(
          path,
          JSON.stringify({
            scenarioId: 's',
            from: 0,
            count: 100,
            failureRate,
            entropy: { ratio: 0.99 },
            failedSeeds: [{ seed: '9', firstError: 'X:Y' }],
            verdict: { ok: true, violations: [] },
          }),
        );
        return path;
      };
      const baseline = join(dir, 'baseline.json');
      const corpus = join(dir, 'corpus.json');
      writeFileSync(
        baseline,
        JSON.stringify({
          scenarioId: 's',
          from: 0,
          count: 100,
          failureRate: 0.04,
          entropyRatio: 0.99,
        }),
      );
      writeFileSync(corpus, JSON.stringify({ scenarioId: 's', seeds: [] }));
      const args = (path: string) => ['--report', path, '--baseline', baseline, '--corpus', corpus];

      const same = run(args(write(0.04)));
      expect(same.status).toBe(0);
      expect(same.stdout).toContain('1 failed seed(s) outside the corpus: 9');
      const worse = run(args(write(0.1)));
      expect(worse.status).toBe(1);
      expect(worse.stdout).toContain('REGRESSION');
      expect(run(args(write(0.01))).status).toBe(0);

      const missing = run([
        '--report',
        write(0.04),
        '--baseline',
        join(dir, 'none.json'),
        '--corpus',
        corpus,
      ]);
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain('Cannot read the baseline');

      expect(run([...args(write(0.04)), '--add-failed']).status).toBe(0);
      expect(parseCorpus(readFileSync(corpus, 'utf8')).seeds).toEqual([
        { seed: '9', expect: 'fail', note: 'X:Y' },
      ]);
      expect(run(args(write(0.04))).stdout).toContain('No failed seeds outside the corpus');
    } finally {
      rmSync(dir, { recursive: true });
    }
  }, 60_000);
});
