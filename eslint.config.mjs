// typescript-eslint presets carry no formatting rules, so Prettier needs no eslint-config-prettier here.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/', '**/coverage/', 'reports/', 'apps/desktop/', 'apps/mobile/'] },
  tseslint.configs.recommendedTypeChecked,
  { languageOptions: { parserOptions: { projectService: true } } },
  { files: ['**/*.mjs'], extends: [tseslint.configs.disableTypeChecked] },
);
