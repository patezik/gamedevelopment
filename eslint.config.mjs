// typescript-eslint presets carry no formatting rules, so Prettier needs no eslint-config-prettier here.
import tseslint from 'typescript-eslint';

const mobileBoundary = 'Use @hs/protocol for mobile contracts (ADR 0001, ADR 0002).';
const truthBoundary = 'Use player knowledge here. Only accusation.ts may read truth (ADR 0005).';
const gameClock = 'Use the game clock for deterministic time (ADR 0004).';

export default tseslint.config(
  { ignores: ['**/dist/', '**/coverage/', 'reports/', 'apps/desktop/'] },
  tseslint.configs.recommendedTypeChecked,
  { languageOptions: { parserOptions: { projectService: true } } },
  { files: ['**/*.mjs'], extends: [tseslint.configs.disableTypeChecked] },
  {
    files: ['packages/{core,generator,validator}/**/*.{js,cjs,mjs,ts,cts,mts,tsx}'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Use Rng and named streams for deterministic randomness (ADR 0004).',
        },
        { object: 'Date', property: 'now', message: gameClock },
        { object: 'performance', property: 'now', message: gameClock },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: 'NewExpression[callee.name="Date"][arguments.length=0]', message: gameClock },
        { selector: 'CallExpression[callee.name="Date"]', message: gameClock },
      ],
    },
  },
  {
    files: ['apps/mobile/**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^@hs/(core|generator|validator)(/|$)', message: mobileBoundary },
            {
              regex: '^(?:\\.\\.?/)+packages/(core|generator|validator)(/|$)',
              message: mobileBoundary,
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/core/src/investigation/**/*.{js,cjs,mjs,ts,cts,mts,tsx}'],
    ignores: ['packages/core/src/investigation/accusation.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?:(?:\\.\\./)+|@hs/core/)truth(?:/|\\.[cm]?[jt]s$|$)',
              message: truthBoundary,
            },
          ],
        },
      ],
    },
  },
);
