import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/**
 * Test files that take minutes in CI, started before all others. Without cached durations (a fresh
 * CI checkout) Vitest starts larger files first, and these small files ended up at the tail of the
 * queue: the run took ≈ 430 s on three workers, with ≈ 315 s of it the lower bound. The order
 * changes nothing else: the same files, seeds and assertions run, each file in its own module
 * context.
 */
const SLOW_FILES = [
  'packages/generator/test/properties/evidence-gen.prop.test.ts',
  'packages/generator/test/properties/history-sim.sanatorium.prop.test.ts',
  'packages/generator/test/properties/plot-planning-sanatorium-1.prop.test.ts',
  'packages/generator/test/properties/plot-planning-sanatorium-2.prop.test.ts',
  'packages/generator/test/properties/plot-planning-sanatorium-3.prop.test.ts',
  'packages/generator/test/properties/plot-planning-sanatorium-4.prop.test.ts',
  'packages/generator/test/properties/incident-selection.prop.test.ts',
];

for (const file of SLOW_FILES) {
  if (!existsSync(fileURLToPath(new URL(file, import.meta.url)))) {
    throw new Error(`vitest.config.ts: slow test file ${file} does not exist`);
  }
}

function slowRank({ moduleId }: TestSpecification): number {
  const path = moduleId.replaceAll('\\', '/');
  const index = SLOW_FILES.findIndex((file) => path.endsWith(`/${file}`));
  return index === -1 ? SLOW_FILES.length : index;
}

/** Vitest's order, with the slow files moved to the front in the order of `SLOW_FILES`. */
class SlowFirstSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    return sorted.toSorted((a, b) => slowRank(a) - slowRank(b));
  }
}

// A new package is picked up by these globs without its own config. apps/mobile runs on jest-expo.
export default defineConfig({
  test: {
    include: ['{packages,tools}/**/*.test.ts', 'apps/server/**/*.test.ts'],
    passWithNoTests: true,
    sequence: { sequencer: SlowFirstSequencer },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/server/src/**/*.ts', 'tools/**/*.ts'],
      thresholds: {
        'packages/core/**': { lines: 85 },
        'packages/generator/**': { lines: 80 },
        'packages/validator/**': { lines: 80 },
      },
    },
  },
});
