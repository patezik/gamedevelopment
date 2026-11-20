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

test('GET /network lists LAN candidates from the injected interfaces', async () => {
  const entry = (address: string, mac: string) => ({
    address,
    netmask: '255.255.255.0',
    family: 'IPv4' as const,
    mac,
    internal: false,
    cidr: `${address}/24`,
  });
  const app = buildApp(readConfig({ HS_LOG_LEVEL: 'silent' }), {
    networkInterfaces: () => ({
      wlan0: [entry('192.168.1.42', 'a4:83:e7:11:22:33')],
      docker0: [entry('172.17.0.1', '02:42:6c:aa:bb:cc')],
    }),
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/network' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      candidates: [
        { address: '192.168.1.42', interface: 'wlan0', recommended: true, virtual: false },
        { address: '172.17.0.1', interface: 'docker0', recommended: false, virtual: true },
      ],
    });
  } finally {
    await app.close();
  }
});

test('GET /network puts HS_PUBLIC_HOST first', async () => {
  const app = buildApp(readConfig({ HS_LOG_LEVEL: 'silent', HS_PUBLIC_HOST: 'game-pc.local' }), {
    networkInterfaces: () => ({}),
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/network' });

    expect(response.json()).toEqual({
      candidates: [
        {
          address: 'game-pc.local',
          interface: 'HS_PUBLIC_HOST',
          recommended: true,
          virtual: false,
        },
      ],
    });
  } finally {
    await app.close();
  }
});
