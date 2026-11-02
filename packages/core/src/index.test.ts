import { expect, test } from 'vitest';
import { CORE_PACKAGE_NAME } from './index.js';

test('package entry point loads', () => {
  expect(CORE_PACKAGE_NAME).toBe('@hs/core');
});
