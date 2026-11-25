import { ErrorCode } from '@hs/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueToken, type PairingService } from '../pairing/index.ts';
import type { SessionManager } from '../sessions/index.ts';
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
});

/** `GET /api/v1/scenarios` answer. */
export const ScenarioList = z.array(ScenarioSummary);

/** `POST /api/v1/sessions` answer: what the desktop needs to start and pair, never the case. */
export const CreateSessionResponse = z.strictObject({
  sessionId: z.uuid(),
  seed: Seed,
  desktopToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  pairing: z.strictObject({
    code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{6}$/),
    expiresAt: z.int().positive(),
    qrPayload: z.string().startsWith('hs1:pair:'),
  }),
});

/** Error answer of every REST endpoint: `{ error: { code, message } }`. */
export const ErrorResponse = z.strictObject({
  error: z.strictObject({ code: ErrorCode, message: z.string() }),
});

export interface SessionRouteDependencies {
  readonly scenarios: Pick<ScenarioCatalog, 'list' | 'has'>;
  readonly sessions: Pick<SessionManager, 'create'>;
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

/**
 * Fastify's own refusals of a request body, with their statuses: empty or malformed JSON (400),
 * bad `Content-Length` (400), body over the limit (413), unsupported content type (415). Only these
 * are the client's fault; any other error, whatever `statusCode` it carries, is a server defect.
 */
const BODY_ERRORS: ReadonlyMap<string, number> = new Map([
  ['FST_ERR_CTP_EMPTY_JSON_BODY', 400],
  ['FST_ERR_CTP_INVALID_JSON_BODY', 400],
  ['FST_ERR_CTP_INVALID_CONTENT_LENGTH', 400],
  ['FST_ERR_CTP_BODY_TOO_LARGE', 413],
  ['FST_ERR_CTP_INVALID_MEDIA_TYPE', 415],
]);

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
      routes.setErrorHandler((error, request, reply) => {
        if (error instanceof ScenarioNotFoundError) {
          return reply.code(404).send(failure('SCENARIO_NOT_FOUND', error.message));
        }
        if (error instanceof GenerationUnsolvableError) {
          return reply.code(422).send(failure('GENERATION_UNSOLVABLE', error.message));
        }
        const { code, status, statusCode } = error as {
          code?: unknown;
          status?: unknown;
          statusCode?: unknown;
        };
        const bodyStatus = typeof code === 'string' ? BODY_ERRORS.get(code) : undefined;
        if (bodyStatus !== undefined && statusCode === bodyStatus) {
          return reply.code(bodyStatus).send(failure('INVALID_MESSAGE', 'Invalid request'));
        }
        // The request log skips errors that carry a client status; this one is a server defect.
        // Neither the log nor the answer gets its text: it may name the case.
        const carried = [status, statusCode].find((value) => typeof value === 'number');
        if (typeof carried === 'number' && carried < 500) {
          request.log.error(
            { method: request.method, route: request.routeOptions.url, errorCode: 'INTERNAL' },
            'request failed',
          );
        }
        return reply.code(500).send(failure('INTERNAL', 'Internal error'));
      });

      routes.get('/scenarios', () => scenarios.list());

      routes.post('/sessions', async (request, reply) => {
        const body = CreateSessionRequest.safeParse(request.body);
        if (!body.success) {
          return reply.code(400).send(failure('INVALID_MESSAGE', 'Invalid session request'));
        }
        const { scenarioId } = body.data;
        if (!scenarios.has(scenarioId)) throw new ScenarioNotFoundError();
        const seed = body.data.seed ?? createSeed();
        if (!Seed.safeParse(seed).success) throw new SessionContractError('seed');
        // Generation runs before the session exists, and the session is registered only once its
        // token, pairing code and answer are ready: any failure leaves nothing behind.
        let created: z.infer<typeof CreateSessionResponse> | undefined;
        await sessions.create(scenarioId, seed, (session) => {
          try {
            const answer = CreateSessionResponse.safeParse({
              sessionId: session.id,
              seed,
              desktopToken: issueToken(session, 'desktop'),
              pairing: pairing.createCode(session),
            });
            if (!answer.success) throw new SessionContractError('answer');
            created = answer.data;
          } catch (error) {
            pairing.discardCode(session);
            session.clearTokenHash('desktop');
            throw error;
          }
        });
        // The answer carries the desktop token and the pairing code.
        reply.header('Cache-Control', 'no-store');
        return reply.code(201).send(created);
      });
      done();
    },
    { prefix: '/api/v1' },
  );
}
