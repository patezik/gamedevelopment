import { ErrorCode } from '@hs/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueToken, type PairingService } from '../pairing/index.ts';
import type { SessionManager } from '../sessions/index.ts';
import {
  createReadableSeed,
  GenerationUnsolvableError,
  ScenarioNotFoundError,
  SLOW_GENERATION_MS,
  type GenerationLog,
  type ScenarioCatalog,
} from './generation.ts';

/**
 * A seed the client may choose: printable, bounded, safe in logs and file names. `#` is left out
 * on purpose: the generator names its attempts `<seed>#<n>`.
 */
export const Seed = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** `POST /api/v1/sessions` body (backend.md §3). */
export const CreateSessionRequest = z.strictObject({
  scenarioId: z.string().min(1).max(64),
  seed: Seed.optional(),
});

/** `GET /api/v1/scenarios` answer. */
export const ScenarioList = z.array(
  z.strictObject({
    id: z.string().min(1),
    title: z.string().min(1),
    durationMinutes: z.int().positive(),
  }),
);

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
  readonly pairing: Pick<PairingService, 'createCode'>;
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
      routes.setErrorHandler((error, _request, reply) => {
        if (error instanceof ScenarioNotFoundError) {
          return reply.code(404).send(failure('SCENARIO_NOT_FOUND', error.message));
        }
        if (error instanceof GenerationUnsolvableError) {
          return reply.code(422).send(failure('GENERATION_UNSOLVABLE', error.message));
        }
        const { statusCode } = error as { statusCode?: unknown };
        if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
          // Body that is not JSON, wrong content type, empty body: Fastify refused it.
          return reply.code(statusCode).send(failure('INVALID_MESSAGE', 'Invalid request'));
        }
        // The text of an unexpected error may name the case; the request log records the failure.
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
        // Generation runs before the session exists: a refused case leaves nothing behind.
        const session = await sessions.create(scenarioId, seed);
        const desktopToken = issueToken(session, 'desktop');
        // The answer carries the desktop token and the pairing code.
        reply.header('Cache-Control', 'no-store');
        return reply.code(201).send({
          sessionId: session.id,
          seed,
          desktopToken,
          pairing: pairing.createCode(session),
        });
      });
      done();
    },
    { prefix: '/api/v1' },
  );
}
