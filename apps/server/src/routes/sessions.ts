import { ErrorCode } from '@hs/protocol';
import { errorCodes, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isPairingHost } from '../config/index.ts';
import { issueToken, type PairingService } from '../pairing/index.ts';
import type { Session, SessionManager } from '../sessions/index.ts';
import {
  createReadableSeed,
  GenerationUnsolvableError,
  ScenarioId,
  ScenarioNotFoundError,
  ScenarioSummary,
  Seed,
  SLOW_GENERATION_MS,
  type GenerationLog,
  type ScenarioCatalog,
} from './generation.ts';

export { ScenarioId, Seed };

/** `POST /api/v1/sessions` body (backend.md §3). */
export const CreateSessionRequest = z.strictObject({
  scenarioId: ScenarioId,
  seed: Seed.optional(),
  locale: z.enum(['ru', 'en']).optional(),
});

/** `GET /api/v1/scenarios` answer. */
export const ScenarioList = z.array(ScenarioSummary);

const PAIRING_PAYLOAD = /^hs1:pair:([^:]+):([0-9]{1,5}):([0-9A-HJKMNP-TV-Z]{6})$/;

/** `POST /api/v1/sessions` answer: what the desktop needs to start and pair, never the case. */
export const CreateSessionResponse = z.strictObject({
  sessionId: z.uuid(),
  desktopToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  pairing: z
    .strictObject({
      code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{6}$/),
      expiresAt: z.int().positive(),
      qrPayload: z.string(),
    })
    .refine(
      ({ code, qrPayload }) => {
        const match = PAIRING_PAYLOAD.exec(qrPayload);
        if (!match) return false;
        const [, host, port, payloadCode] = match;
        const portNumber = Number(port);
        return (
          host !== undefined &&
          isPairingHost(host) &&
          portNumber >= 1 &&
          portNumber <= 65535 &&
          payloadCode === code
        );
      },
      { path: ['qrPayload'], message: 'Invalid pairing payload' },
    ),
});

/** Error answer of every REST endpoint: `{ error: { code, message } }`. */
export const ErrorResponse = z.strictObject({
  error: z.strictObject({ code: ErrorCode, message: z.string() }),
});

export interface SessionRouteDependencies {
  readonly scenarios: Pick<ScenarioCatalog, 'list' | 'has'>;
  readonly sessions: Pick<SessionManager, 'create'>;
  /** Connect engine resources to the new session before credentials or publication. */
  readonly prepare?: (session: Session) => void;
  readonly pairing: Pick<PairingService, 'createCode' | 'discardCode'>;
  /** Source of the generation log lines (the provider of `sessions`). */
  readonly generation?: {
    onGenerated(listener: (entry: GenerationLog) => void): () => void;
  };
  /** Seed for a request without one; the server CSPRNG by default. */
  readonly createSeed?: () => string;
}

function failure(code: ErrorCode, message: string) {
  return { error: { code, message } };
}

/** Body-parser failures occur before the route handler. */
const BODY_ERRORS = [
  [errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY, 400],
  [errorCodes.FST_ERR_CTP_INVALID_JSON_BODY, 400],
  [errorCodes.FST_ERR_CTP_INVALID_CONTENT_LENGTH, 400],
  [errorCodes.FST_ERR_CTP_BODY_TOO_LARGE, 413],
  [errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE, 415],
] as const;

function internalError(request: FastifyRequest, reply: FastifyReply) {
  request.log.error(
    { method: request.method, route: request.routeOptions.url, errorCode: 'INTERNAL' },
    'request failed',
  );
  return reply.code(500).send(failure('INTERNAL', 'Internal error'));
}

/** A broken internal contract (the seed source, the answer): the request fails as `INTERNAL`. */
class SessionContractError extends Error {
  constructor(what: string) {
    super(`Session creation broke its contract: ${what}`);
    this.name = 'SessionContractError';
  }
}

/** `GET /scenarios` and `POST /sessions` under `/api/v1`. The server is local: no authentication. */
export function registerSessionRoutes(
  app: FastifyInstance,
  {
    scenarios,
    sessions,
    pairing,
    generation,
    createSeed = createReadableSeed,
    prepare,
  }: SessionRouteDependencies,
): void {
  if (generation) {
    const unsubscribe = generation.onGenerated((entry) => {
      if (entry.durationMs > SLOW_GENERATION_MS) app.log.warn(entry, 'slow generation');
      else app.log.info(entry, 'generation finished');
    });
    app.addHook('onClose', (_instance, done) => {
      unsubscribe();
      done();
    });
  }

  app.register(
    (routes, _options, done) => {
      routes.setErrorHandler((error, _request, reply) => {
        const refusal = BODY_ERRORS.find(([BodyError]) => error instanceof BodyError);
        if (refusal) {
          return reply.code(refusal[1]).send(failure('INVALID_MESSAGE', 'Invalid request'));
        }
        return reply.code(500).send(failure('INTERNAL', 'Internal error'));
      });

      routes.get('/scenarios', (request, reply) => {
        try {
          return scenarios.list();
        } catch {
          return internalError(request, reply);
        }
      });

      routes.post('/sessions', async (request, reply) => {
        const body = CreateSessionRequest.safeParse(request.body);
        if (!body.success) {
          return reply.code(400).send(failure('INVALID_MESSAGE', 'Invalid session request'));
        }
        const { scenarioId } = body.data;
        let created: z.infer<typeof CreateSessionResponse> | undefined;
        try {
          if (!scenarios.has(scenarioId)) throw new ScenarioNotFoundError();
          const seed = body.data.seed ?? createSeed();
          if (!Seed.safeParse(seed).success) throw new SessionContractError('seed');
          // Register only after preparing the credentials and validating the DTO.
          await sessions.create(scenarioId, seed, (session) => {
            try {
              prepare?.(session);
              const answer = CreateSessionResponse.safeParse({
                sessionId: session.id,
                desktopToken: issueToken(session, 'desktop'),
                pairing: pairing.createCode(session),
              });
              if (!answer.success) throw new SessionContractError('answer');
              created = answer.data;
            } catch (error) {
              session.clearTokenHash('desktop');
              pairing.discardCode(session);
              throw error;
            }
          }, body.data.locale);
        } catch (error) {
          if (error instanceof ScenarioNotFoundError) {
            return reply.code(404).send(failure('SCENARIO_NOT_FOUND', 'Scenario not found'));
          }
          if (error instanceof GenerationUnsolvableError) {
            return reply
              .code(422)
              .send(
                failure(
                  'GENERATION_UNSOLVABLE',
                  'No solvable investigation for this scenario and seed',
                ),
              );
          }
          return internalError(request, reply);
        }

        // HTTP serialization and delivery happen after the session is registered.
        reply.header('Cache-Control', 'no-store');
        return reply.code(201).send(created);
      });
      done();
    },
    { prefix: '/api/v1' },
  );
}
