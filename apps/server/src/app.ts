import { PROTOCOL_VERSION } from '@hs/protocol';
import Fastify from 'fastify';
import os from 'node:os';
import serverPackage from '../package.json' with { type: 'json' };
import type { ServerConfig } from './config/index.ts';
import { listNetworkCandidates, type NetworkInterfaces } from './config/network.ts';

import {
  loggerOptions,
  registerDebugRoutes,
  registerRequestLogging,
  type DebugRouteDependencies,
} from './diagnostics/index.ts';
import { registerPairingRoutes, type PairingService } from './pairing/index.ts';
import { registerGateway, SessionGateway } from './gateway/index.ts';
import { registerQrRoutes, type QrRouteDependencies } from './qr/index.ts';
import { registerSaveRoutes, type SaveRouteDependencies } from './saves/index.ts';
import { registerSessionRoutes, type SessionRouteDependencies } from './routes/sessions.ts';

export interface AppDependencies {
  /** Defaults to `os.networkInterfaces`; replaced in tests. */
  networkInterfaces?: () => NetworkInterfaces;
  pairing?: PairingService;
  /** `GET /scenarios` and `POST /sessions` (SRV-002). */
  sessions?: SessionRouteDependencies;
  gateway?: SessionGateway;
  qr?: QrRouteDependencies;
  /** `GET /saves` and `POST /saves/:saveId/load`. */
  saves?: SaveRouteDependencies;
  /** Debug endpoints; registered only when `HS_DEBUG_TRUTH=1`, otherwise they do not exist. */
  diagnostics?: DebugRouteDependencies;
  /** Where log lines go; defaults to stdout, replaced in tests. */
  logStream?: { write(line: string): void };
}

export function buildApp(
  config: ServerConfig,
  {
    networkInterfaces = os.networkInterfaces,
    pairing,
    sessions,
    qr,
    saves,
    gateway = new SessionGateway({ serverVersion: serverPackage.version }),
    diagnostics,
    logStream,
  }: AppDependencies = {},
) {
  const app = Fastify({
    logger: loggerOptions(config.logLevel, logStream),
    logController: new Fastify.LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
  });

  registerRequestLogging(app);

  registerGateway(app, gateway, qr && ((session, raw) => qr.qr.scan(session, raw)));
  if (pairing) {
    const unsubscribe = pairing.onDeviceRevoked((session) => gateway.revokePhone(session));
    app.addHook('onClose', (_instance, done) => {
      unsubscribe();
      done();
    });
  }

  app.get('/api/v1/health', () => ({
    status: 'ok',
    version: serverPackage.version,
    protocolVersion: PROTOCOL_VERSION,
  }));

  app.get('/api/v1/network', () => ({
    candidates: listNetworkCandidates(networkInterfaces(), config.publicHost),
  }));

  if (sessions) registerSessionRoutes(app, sessions);
  if (pairing) registerPairingRoutes(app, pairing);
  if (qr) registerQrRoutes(app, qr);
  if (saves) registerSaveRoutes(app, saves);
  if (config.debugTruth && diagnostics) registerDebugRoutes(app, diagnostics);

  return app;
}
