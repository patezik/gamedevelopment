import { CORE_PACKAGE_NAME } from '@hs/core';
import { expect, test } from 'vitest';
import { VALIDATOR_PACKAGE_NAME } from './index.js';

test('resolves @hs/core through the workspace', () => {
  expect(VALIDATOR_PACKAGE_NAME).toBe('@hs/validator');
  expect(CORE_PACKAGE_NAME).toBe('@hs/core');
});
