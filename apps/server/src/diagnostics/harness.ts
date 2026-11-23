import { GameEngine } from '@hs/core/game';
import { tinyManor } from '../../../../packages/core/test/fixtures/tiny-manor.ts';
import { buildApp } from '../app.ts';
import { readConfig } from '../config/index.ts';
import { issueToken, PairingService } from '../pairing/index.ts';
import { Session } from '../sessions/index.ts';

export const EXPORTED_AT = new Date('2026-01-01T00:00:00.000Z');

export interface HarnessOptions {
  /** `HS_DEBUG_TRUTH`; default off. */
  readonly debugTruth?: boolean;
  /** Give the app the debug dependencies (the flag alone is not enough). Default true. */
  readonly withDiagnostics?: boolean;
  readonly logStream?: { write(line: string): void };
  readonly logLevel?: string;
  /** Use an engine that cannot be inspected instead of the real one. */
  readonly opaqueEngine?: boolean;
  readonly sessionId?: string;
}

/** One real session on tiny-manor, a pairing service, and an app wired the way the server is. */
export async function createHarness(options: HarnessOptions = {}) {
  const investigation = tinyManor('harness-seed');
  const ports = { startLocationId: 'loc_hall' };
  const engine = GameEngine.create(investigation, ports);
  const session = new Session(
    options.sessionId ?? 'session-a',
    options.opaqueEngine
      ? { dispatch: () => ({ ok: false, error: 'INTERNAL', minutesSpent: 0, events: [] }) }
      : engine,
    () => 0,
  );
  await session.activate();
  const pairing = new PairingService(
    { get: (id) => (id === session.id ? session : undefined) },
    { host: () => 'game-pc.local', port: 7420, now: () => 1_000_000 },
  );
  const env = {
    HS_LOG_LEVEL: options.logLevel ?? (options.logStream ? 'info' : 'silent'),
    ...(options.debugTruth ? { HS_DEBUG_TRUTH: '1' } : {}),
  };
  const app = buildApp(readConfig(env), {
    pairing,
    ...(options.withDiagnostics === false
      ? {}
      : {
          diagnostics: {
            authorizeDesktop: (id, authorization) => pairing.authorizeDesktop(id, authorization),
            now: () => EXPORTED_AT,
          },
        }),
    ...(options.logStream ? { logStream: options.logStream } : {}),
  });
  const desktopToken = issueToken(session, 'desktop');
  const phoneToken = issueToken(session, 'phone');
  return {
    app,
    engine,
    ports,
    investigation,
    session,
    pairing,
    desktopToken,
    phoneToken,
    desktop: { authorization: `Bearer ${desktopToken}` },
    phone: { authorization: `Bearer ${phoneToken}` },
    url: (path: string) => `/api/v1/sessions/${session.id}${path}`,
  };
}

/** A log stream that keeps every line for inspection. */
export function captureLogs() {
  const lines: string[] = [];
  return {
    stream: { write: (line: string) => void lines.push(line) },
    text: () => lines.join(''),
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
