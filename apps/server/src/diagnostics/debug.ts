import type { GameSnapshot } from '@hs/core/game';
import { PROTOCOL_VERSION, type ErrorCode } from '@hs/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import serverPackage from '../../package.json' with { type: 'json' };
import type { Session } from '../sessions/index.ts';
import { REPRO_FORMAT, type ReproBundle } from './repro.ts';

/** What the debug endpoints need from an engine: `GameEngine` already has both. */
export interface DebugSource {
  snapshot(): GameSnapshot;
  stateHash(): string;
}

/** `session.engine` is only typed as something that dispatches; inspect it by what it can do. */
export function asDebugSource(engine: unknown): DebugSource | undefined {
  const candidate = engine as Partial<Record<'snapshot' | 'stateHash', unknown>> | null;
  return typeof candidate?.snapshot === 'function' && typeof candidate.stateHash === 'function'
    ? (engine as DebugSource)
    : undefined;
}

const investigationSchema = z.looseObject({
  scenarioId: z.string(),
  seed: z.string(),
  generatorVersion: z.string(),
  truth: z.json(),
});

function parseInvestigation(snapshot: GameSnapshot) {
  return investigationSchema.parse(JSON.parse(snapshot.investigation));
}

export function buildReproBundle(
  session: Session,
  source: DebugSource,
  exportedAt: Date,
): ReproBundle {
  const snapshot = source.snapshot();
  const { scenarioId, seed, generatorVersion } = parseInvestigation(snapshot);
  return {
    format: REPRO_FORMAT,
    version: 1,
    exportedAt: exportedAt.toISOString(),
    server: { version: serverPackage.version, protocolVersion: PROTOCOL_VERSION },
    session: { id: session.id, status: session.status, stateVersion: session.stateVersion },
    scenarioId,
    seed,
    generatorVersion,
    stateHash: source.stateHash(),
    snapshot,
  };
}

export interface DebugRouteDependencies {
  /** `PairingService.authorizeDesktop`: the Bearer desktop token of the session in the URL. */
  readonly authorizeDesktop: (id: string, authorization: string | undefined) => Session;
  /** Defaults to inspecting `session.engine`. */
  readonly sourceOf?: (session: Session) => DebugSource | undefined;
  /** Wall clock for `exportedAt`. */
  readonly now?: () => Date;
}

class DebugError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

interface HttpError {
  readonly code: ErrorCode;
  readonly status: number;
  readonly message: string;
}

/** Errors that already carry a protocol code and HTTP status (ours and the pairing service's). */
function asHttpError(error: unknown): HttpError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, status, message } = error as Record<string, unknown>;
  return typeof code === 'string' && typeof status === 'number' && typeof message === 'string'
    ? { code: code as ErrorCode, status, message }
    : undefined;
}

/**
 * `GET /sessions/:id/debug/truth` and `GET /sessions/:id/debug/export`, for the desktop token only.
 *
 * Register these only when `HS_DEBUG_TRUTH=1`. With the flag off they do not exist, so the server
 * answers 404 exactly as for any other unknown path: a player cannot even tell the solution is
 * available somewhere.
 */
export function registerDebugRoutes(
  app: FastifyInstance,
  {
    authorizeDesktop,
    sourceOf = (session) => asDebugSource(session.engine),
    now = () => new Date(),
  }: DebugRouteDependencies,
): void {
  app.register(
    (routes, _options, done) => {
      routes.setErrorHandler((error, _request, reply) => {
        const http = asHttpError(error);
        if (!http) throw error;
        reply.code(http.status).send({ error: { code: http.code, message: http.message } });
      });
      // The solution must not be kept by a browser or a proxy.
      routes.addHook('onSend', (_request, reply, payload, next) => {
        reply.header('Cache-Control', 'no-store');
        next(null, payload);
      });

      const inspect = (id: string, authorization: string | undefined) => {
        const session = authorizeDesktop(id, authorization);
        const source = sourceOf(session);
        if (!source) {
          throw new DebugError('INTERNAL', 501, 'This session cannot be inspected');
        }
        return { session, source };
      };

      routes.get<{ Params: { id: string } }>('/sessions/:id/debug/truth', (request) => {
        const { session, source } = inspect(request.params.id, request.headers.authorization);
        request.log.warn({ sessionId: session.id }, 'debug truth requested');
        const snapshot = source.snapshot();
        const { scenarioId, seed, generatorVersion, truth } = parseInvestigation(snapshot);
        return {
          sessionId: session.id,
          scenarioId,
          seed,
          generatorVersion,
          minute: snapshot.minute,
          truth,
        };
      });

      routes.get<{ Params: { id: string } }>('/sessions/:id/debug/export', (request) => {
        const { session, source } = inspect(request.params.id, request.headers.authorization);
        request.log.warn({ sessionId: session.id }, 'debug export requested');
        return buildReproBundle(session, source, now());
      });
      done();
    },
    { prefix: '/api/v1' },
  );
}
