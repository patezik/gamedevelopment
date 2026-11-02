import { defineConfig } from 'vitest/config';

// A new package is picked up by these globs without its own config. apps/mobile runs on jest-expo.
export default defineConfig({
  test: {
    include: ['{packages,tools}/**/*.test.ts', 'apps/server/**/*.test.ts'],
    passWithNoTests: true,
  },
});
