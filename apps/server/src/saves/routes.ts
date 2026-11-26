import { errorCodes, type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import { issueToken, type PairingService } from '../pairing/index.ts';
import { CreateSessionResponse } from '../routes/sessions.ts';
import { SessionIdInUseError, type SessionManager } from '../sessions/index.ts';
import { SaveError, type SaveService } from './service.ts';
import { isSaveId } from './store.ts';

const LoadResponse = CreateSessionResponse.extend({ sessionId: z.string().refine(isSaveId) });

function sendInternal(reply: FastifyReply) {
  return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal error' } });
}

const BODY_ERRORS = [
  [errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY, 400],
  [errorCodes.FST_ERR_CTP_INVALID_JSON_BODY, 400],
  [errorCodes.FST_ERR_CTP_INVALID_CONTENT_LENGTH, 400],
  [errorCodes.FST_ERR_CTP_BODY_TOO_LARGE, 413],
  [errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE, 415],
] as const;

export interface SaveRouteDependencies {
  readonly saves: SaveService;
  readonly sessions: Pick<SessionManager, 'adopt'>;
  readonly pairing: Pick<PairingService, 'prepareCode'>;
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
      // The answer carries a desktop token.
      routes.addHook('onSend', (_request, reply, payload, next) => {
        reply.header('Cache-Control', 'no-store');
        next(null, payload);
      });
      if (cleanup) routes.addHook('onReady', async () => void (await cleanup()));

      routes.get('/saves', () => saves.list());

      routes.post<{ Params: { saveId: string } }>(
        '/saves/:saveId/load',
        {
          errorHandler(error, _request, reply) {
            const bodyError = BODY_ERRORS.find(([BodyError]) => error instanceof BodyError);
            if (bodyError) {
              reply.code(bodyError[1]).send({
                error: { code: 'INVALID_MESSAGE', message: 'Invalid request' },
              });
              return;
            }
            // Includes response hooks and serialization, which run after the swap.
            sendInternal(reply);
          },
        },
        async (request, reply) => {
          const { saveId } = request.params;
          let response: z.infer<typeof LoadResponse> | undefined;
          try {
            await sessions.adopt(
              saveId,
              () => saves.restore(saveId),
              (session, engine) => {
                try {
                  const desktopToken = issueToken(session, 'desktop');
                  const staged = pairing.prepareCode(session);
                  response = LoadResponse.parse({
                    sessionId: session.id,
                    desktopToken,
                    pairing: staged.pairing,
                  });
                  return () => {
                    engine.claim();
                    staged.commit();
                  };
                } catch (error) {
                  session.clearTokenHash('desktop');
                  // A dependency failure here is internal regardless of its original type.
                  throw new Error('Load preparation failed', { cause: error });
                }
              },
            );
          } catch (error) {
            if (
              error instanceof SaveError &&
              ((error.code === 'SAVE_NOT_FOUND' && error.status === 404) ||
                (error.code === 'SAVE_DESYNC' && error.status === 422))
            ) {
              return reply.code(error.status).send({
                error: {
                  code: error.code,
                  message: error.message,
                  ...(error.atAction !== undefined && { atAction: error.atAction }),
                },
              });
            }
            if (error instanceof SessionIdInUseError) {
              return reply
                .code(409)
                .send({ error: { code: 'ACTION_NOT_AVAILABLE', message: error.message } });
            }
            request.log.error(
              { method: request.method, route: request.routeOptions.url, errorCode: 'INTERNAL' },
              'request failed',
            );
            return sendInternal(reply);
          }
          return response;
        },
      );
      done();
    },
    { prefix: '/api/v1' },
  );
}
