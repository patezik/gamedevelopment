import { PROTOCOL_VERSION } from '@hs/protocol';
import Fastify from 'fastify';
import os from 'node:os';
import serverPackage from '../package.json' with { type: 'json' };
import type { ServerConfig } from './config/index.ts';
import { listNetworkCandidates, type NetworkInterfaces } from './config/network.ts';

import { registerPairingRoutes, type PairingService } from './pairing/index.ts';
import { registerQrRoutes, type QrRouteDependencies } from './qr/index.ts';

export interface AppDependencies {
  /** Defaults to `os.networkInterfaces`; replaced in tests. */
  networkInterfaces?: () => NetworkInterfaces;
  pairing?: PairingService;
  qr?: QrRouteDependencies;
}

export function buildApp(
  config: ServerConfig,
  { networkInterfaces = os.networkInterfaces, pairing, qr }: AppDependencies = {},
) {
  const app = Fastify({
    logger: { level: config.logLevel },
    logController: new Fastify.LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
  });

  app.addHook('onResponse', (request, reply, done) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime,
      },
      'request completed',
    );
    done();
  });

  app.get('/api/v1/health', () => ({
    status: 'ok',
    version: serverPackage.version,
    protocolVersion: PROTOCOL_VERSION,
  }));

  app.get('/api/v1/network', () => ({
    candidates: listNetworkCandidates(networkInterfaces(), config.publicHost),
  }));

  if (pairing) registerPairingRoutes(app, pairing);
  if (qr) registerQrRoutes(app, qr);

  return app;
}
