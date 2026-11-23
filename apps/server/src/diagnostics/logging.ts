import type { FastifyInstance } from 'fastify';

/**
 * Names that must never reach a log line, wherever they appear in a logged object. Pino replaces
 * their values with `[redacted]`. This is a second line of defence: the request log below never
 * writes headers, bodies, URLs or parameters in the first place.
 */
export const REDACTED_FIELDS = [
  'authorization',
  'cookie',
  'token',
  'tokenId',
  'deviceToken',
  'desktopToken',
  'pairingCode',
  'sig',
  'signature',
  'secret',
  'sessionSecret',
  'password',
  'raw',
  'qrPayload',
] as const;

/** Top level, one and two levels down, and request headers. */
const redactPaths = REDACTED_FIELDS.flatMap((field) => [field, `*.${field}`, `*.*.${field}`]);

/** Session ids are UUIDs, never credentials; anything else in `:id` is not worth logging. */
const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface LoggerOptions {
  level: string;
  redact: { paths: string[]; censor: string };
  stream?: { write(line: string): void };
}

/** Logger options for Fastify: the configured level, redaction, and an optional stream for tests. */
export function loggerOptions(
  level: string,
  stream?: { write(line: string): void },
): LoggerOptions {
  return {
    level,
    redact: { paths: [...redactPaths], censor: '[redacted]' },
    ...(stream ? { stream } : {}),
  };
}

/**
 * One log line per response (method, route template, status, duration) and one per failed request
 * (the error). Nothing from the URL, headers or body is logged; only the id of the session the
 * route belongs to, so a bug report can be matched to a session.
 */
export function registerRequestLogging(app: FastifyInstance): void {
  const sessionIdOf = (params: unknown): { sessionId?: string } => {
    const id = (params as { id?: unknown } | null)?.id;
    return typeof id === 'string' && SESSION_ID.test(id) ? { sessionId: id } : {};
  };

  app.addHook('onResponse', (request, reply, done) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url,
        ...sessionIdOf(request.params),
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime,
      },
      'request completed',
    );
    done();
  });

  // Fastify's own error logging is switched off with the rest of its request logging (it would
  // print the full URL), so without this a crashing handler would leave no trace at all.
  app.addHook('onError', (request, _reply, error, done) => {
    // A refused request (401, 404, validation) is the client's doing and already shows as a status
    // in the line above. Exception text and stacks may contain credentials or request data.
    const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
    const code = [status, statusCode].find((value) => typeof value === 'number');
    if (typeof code === 'number' && code < 500) {
      done();
      return;
    }
    request.log.error(
      {
        method: request.method,
        route: request.routeOptions.url,
        ...sessionIdOf(request.params),
        errorCode: 'INTERNAL',
      },
      'request failed',
    );
    done();
  });
}
