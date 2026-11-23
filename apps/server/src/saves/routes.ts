import type { ErrorCode } from '@hs/protocol';
import type { FastifyInstance } from 'fastify';
import { issueToken, type PairingService } from '../pairing/index.ts';
import { SessionIdInUseError, type SessionManager } from '../sessions/index.ts';
import { SaveError, type SaveService } from './service.ts';

export interface SaveRouteDependencies {
  readonly saves: SaveService;
  readonly sessions: Pick<SessionManager, 'adopt'>;
  readonly pairing: Pick<PairingService, 'createCode'>;
  /** Removes temporary files a crash left behind; run once when the server is ready. */
  readonly cleanup?: () => Promise<unknown>;
}

/** `GET /saves` and `POST /saves/:saveId/load`. The server is local: no authentication (backend.md §3). */
export function registerSaveRoutes(
  app: FastifyInstance,
  { saves, sessions, pairing, cleanup }: SaveRouteDependencies,
): void {
  app.register(
    (routes, _options, done) => {
      routes.setErrorHandler((error, _request, reply) => {
        if (error instanceof SaveError) {
          reply.code(error.status).send({
            error: {
              code: error.code,
              message: error.message,
              ...(error.atAction !== undefined && { atAction: error.atAction }),
            },
          });
        } else if (error instanceof SessionIdInUseError) {
          const code: ErrorCode = 'ACTION_NOT_AVAILABLE';
          reply.code(409).send({ error: { code, message: error.message } });
        } else {
          throw error;
        }
      });
      // The answer carries a desktop token.
      routes.addHook('onSend', (_request, reply, payload, next) => {
        reply.header('Cache-Control', 'no-store');
        next(null, payload);
      });
      if (cleanup) routes.addHook('onReady', async () => void (await cleanup()));

      routes.get('/saves', () => saves.list());

      routes.post<{ Params: { saveId: string } }>('/saves/:saveId/load', async (request) => {
        const { saveId } = request.params;
        const engine = await saves.restore(saveId);
        const session = await sessions.adopt(saveId, engine);
        engine.claim();
        const desktopToken = issueToken(session, 'desktop');
        return { sessionId: session.id, desktopToken, pairing: pairing.createCode(session) };
      });
      done();
    },
    { prefix: '/api/v1' },
  );
}
