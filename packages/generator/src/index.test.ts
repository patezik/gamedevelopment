import { CORE_PACKAGE_NAME } from '@hs/core';
import { VALIDATOR_PACKAGE_NAME } from '@hs/validator';
import { expect, test } from 'vitest';
import { GENERATOR_PACKAGE_NAME } from './index.js';

test('resolves @hs/core and @hs/validator through the workspace', () => {
  expect(GENERATOR_PACKAGE_NAME).toBe('@hs/generator');
  expect(CORE_PACKAGE_NAME).toBe('@hs/core');
  expect(VALIDATOR_PACKAGE_NAME).toBe('@hs/validator');
});
