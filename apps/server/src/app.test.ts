import { PROTOCOL_VERSION } from '@hs/protocol';
import { expect, test } from 'vitest';
import serverPackage from '../package.json' with { type: 'json' };
import { buildApp } from './app.ts';
import { readConfig } from './config/index.ts';

test('reports server and protocol versions without opening a port', async () => {
  const app = buildApp(readConfig({ HS_LOG_LEVEL: 'silent' }));
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      version: serverPackage.version,
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(app.server.listening).toBe(false);
  } finally {
    await app.close();
  }
});
