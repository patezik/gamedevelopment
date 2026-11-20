import { PROTOCOL_VERSION } from '@hs/protocol';
import Fastify from 'fastify';
import serverPackage from '../package.json' with { type: 'json' };
import type { ServerConfig } from './config/index.ts';

export function buildApp(config: ServerConfig) {
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

  return app;
}
