import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readConfig } from './index.ts';

test('defaults to the LAN listener with truth debugging disabled', () => {
  expect(readConfig({})).toEqual({
    port: 7420,
    host: '0.0.0.0',
    dataDir: join(homedir(), '.hollow-signal'),
    logLevel: 'info',
    debugTruth: false,
  });
});

test('reads explicit configuration and ignores unrelated environment variables', () => {
  expect(
    readConfig({
      HS_PORT: '8123',
      HS_HOST: '127.0.0.1',
      HS_DATA_DIR: 'custom-data',
      HS_LOG_LEVEL: 'debug',
      HS_DEBUG_TRUTH: '1',
      PATH: '/bin',
    }),
  ).toEqual({
    port: 8123,
    host: '127.0.0.1',
    dataDir: 'custom-data',
    logLevel: 'debug',
    debugTruth: true,
  });
});

test.each(['foo', '0', '65536', '7.5', '', '0x1000'])('rejects invalid ports (%j)', (port) => {
  expect(() => readConfig({ HS_PORT: port })).toThrow(/HS_PORT:/);
});

test('explains each invalid setting without echoing input', () => {
  expect(() =>
    readConfig({
      HS_HOST: ' ',
      HS_DATA_DIR: '',
      HS_LOG_LEVEL: 'unsupported',
      HS_DEBUG_TRUTH: 'true',
    }),
  ).toThrow(/HS_HOST:[\s\S]*HS_DATA_DIR:[\s\S]*HS_LOG_LEVEL:[\s\S]*HS_DEBUG_TRUTH:/);
});
