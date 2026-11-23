import { readFileSync } from 'node:fs';
import { PhoneView, PlayerView } from '@hs/protocol';
import { vi } from 'vitest';
import { buildApp } from '../../../apps/server/src/app.ts';
import { readConfig } from '../../../apps/server/src/config/index.ts';
import { SessionGateway } from '../../../apps/server/src/gateway/index.ts';
import { issueToken, PairingService } from '../../../apps/server/src/pairing/index.ts';
import { QrService } from '../../../apps/server/src/qr/index.ts';
import { SessionManager } from '../../../apps/server/src/sessions/index.ts';
import { tinyManor } from '../../../packages/core/test/fixtures/tiny-manor.ts';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../../packages/protocol/fixtures/views/${name}`, import.meta.url),
      'utf8',
    ),
  );

export const playerView = PlayerView.parse(fixture('player-view.start.json'));
export const phoneView = PhoneView.parse(fixture('phone-view.start.json'));

/** A real server app on a random port, with a stub engine; the pieces tests may need to poke. */
export async function startServer(options: { replayLimit?: number } = {}) {
  const dispatch = vi.fn(() => ({ ok: true, minutesSpent: 15, events: [] }));
  const sessions = new SessionManager(
    { create: () => ({ investigation: tinyManor(), ports: { startLocationId: 'loc_hall' } }) },
    { createEngine: () => ({ dispatch }) },
  );
  const session = await sessions.create('tiny-manor', 'fake-client');
  await session.activate();
  const desktopToken = issueToken(session, 'desktop');
  const pairing = new PairingService(sessions, { host: () => 'localhost', port: 7420 });
  const gateway = new SessionGateway({
    serverVersion: '0.0.0',
    sessions,
    snapshot: (_session, role) => (role === 'desktop' ? playerView : phoneView),
    ...options,
  });
  const qr = new QrService({ gameMinute: () => 0 });
  const store = qr.createStore();
  qr.attach(session, store);
  const app = buildApp(readConfig({ HS_LOG_LEVEL: 'silent' }), {
    pairing,
    gateway,
    qr: {
      qr,
      authorizeDesktop: pairing.authorizeDesktop.bind(pairing),
      activePairingCode: pairing.activeCode.bind(pairing),
    },
  });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, baseUrl, dispatch, gateway, session, desktopToken, store, pairing };
}
