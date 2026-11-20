import { readFile } from 'node:fs/promises';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, test } from 'vitest';

// Lint each fixture as a source file in its target module without resolving its imports.
const eslint = new ESLint({ overrideConfig: tseslint.configs.disableTypeChecked });

async function lintFixture(fixture: string, filePath: string) {
  const source = await readFile(new URL(fixture, import.meta.url), 'utf8');
  const [result] = await eslint.lintText(source, { filePath });
  return result?.messages ?? [];
}

test.each(['core', 'generator', 'validator'])(
  'rejects nondeterministic APIs in %s',
  async (pkg) => {
    const messages = await lintFixture('nondeterministic.ts.txt', `packages/${pkg}/src/example.ts`);
    expect(messages.map(({ ruleId }) => ruleId)).toEqual([
      'no-restricted-properties',
      'no-restricted-properties',
      'no-restricted-properties',
      'no-restricted-syntax',
      'no-restricted-syntax',
    ]);
    expect(
      messages.every(({ message, severity }) => severity === 2 && message.includes('ADR 0004')),
    ).toBe(true);
  },
);

test('allows wall time in the server and explicit timestamps in the core', async () => {
  expect(await lintFixture('nondeterministic.ts.txt', 'apps/server/src/example.ts')).toEqual([]);
  const [result] = await eslint.lintText('export const value = new Date(0);', {
    filePath: 'packages/core/src/example.ts',
  });
  expect(result?.messages).toEqual([]);
});

test('rejects mobile imports of server-only packages and allows protocol imports', async () => {
  const messages = await lintFixture('mobile-imports.ts.txt', 'apps/mobile/src/example.tsx');
  expect(messages.map(({ line }) => line)).toEqual([1, 2, 3, 4]);
  for (const { ruleId, severity, message } of messages) {
    expect(ruleId).toBe('@typescript-eslint/no-restricted-imports');
    expect(severity).toBe(2);
    expect(message).toContain('ADR 0001, ADR 0002');
  }
});

test('blocks direct truth imports in investigation with an exception for accusation.ts', async () => {
  const messages = await lintFixture(
    'truth-imports.ts.txt',
    'packages/core/src/investigation/view.ts',
  );
  expect(messages.map(({ line }) => line)).toEqual([1, 2]);
  for (const { ruleId, severity, message } of messages) {
    expect(ruleId).toBe('@typescript-eslint/no-restricted-imports');
    expect(severity).toBe(2);
    expect(message).toContain('ADR 0005');
  }
  expect(
    await lintFixture('truth-imports.ts.txt', 'packages/core/src/investigation/accusation.ts'),
  ).toEqual([]);
});
