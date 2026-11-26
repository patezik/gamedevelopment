import { QrMatrixResponse, type ErrorCode } from '@hs/protocol';
import type { FastifyInstance } from 'fastify';
import type { Session } from '../sessions/index.ts';
import { renderMatrix } from './matrix.ts';
import { QrError, type QrService } from './service.ts';

export interface QrRouteDependencies {
  readonly qr: QrService;
  /** `PairingService.authorizeDesktop`: the Bearer desktop token of the session in the URL. */
  readonly authorizeDesktop: (id: string, authorization: string | undefined) => Session;
  /** The session's latest pairing code, without issuing a new one. */
  readonly activePairingCode: (
    session: Session,
  ) => { readonly qrPayload: string; readonly expiresAt: number } | undefined;
  /** Wall clock in milliseconds, the same one the pairing codes use. */
  readonly now?: () => number;
}

interface HttpError {
  readonly code: ErrorCode;
  readonly status: number;
  readonly message: string;
}

/** Errors that already carry a protocol code and HTTP status (ours and the pairing service's). */
function asHttpError(error: unknown): HttpError | undefined {
  if (error instanceof QrError) return error;
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, status, message } = error as Record<string, unknown>;
  return typeof code === 'string' && typeof status === 'number' && typeof message === 'string'
    ? { code: code as ErrorCode, status, message }
    : undefined;
}

/** `GET /sessions/:id/pairing-qr` and `GET /sessions/:id/evidence-qr/:tokenId` (desktop only). */
export function registerQrRoutes(
  app: FastifyInstance,
  { qr, authorizeDesktop, activePairingCode, now = Date.now }: QrRouteDependencies,
): void {
  app.register(
    (routes, _options, done) => {
      routes.setErrorHandler((error, _request, reply) => {
        const http = asHttpError(error);
        if (!http) throw error;
        reply.code(http.status).send({ error: { code: http.code, message: http.message } });
      });
      // A QR is a credential while it is on screen: never let a proxy or the browser keep it.
      routes.addHook('onSend', (_request, reply, payload, next) => {
        reply.header('Cache-Control', 'no-store');
        next(null, payload);
      });

      routes.get<{ Params: { id: string } }>('/sessions/:id/pairing-qr', (request) => {
        const session = authorizeDesktop(request.params.id, request.headers.authorization);
        const code = activePairingCode(session);
        if (!code)
          throw new QrError('PAIRING_CODE_INVALID', 404, 'There is no pairing code to show');
        if (code.expiresAt <= now()) {
          throw new QrError('PAIRING_CODE_EXPIRED', 410, 'The pairing code has expired');
        }
        return QrMatrixResponse.parse(renderMatrix(code.qrPayload));
      });

      routes.get<{ Params: { id: string; tokenId: string } }>(
        '/sessions/:id/evidence-qr/:tokenId',
        (request) =>
          QrMatrixResponse.parse(
            qr.evidenceMatrix(
              authorizeDesktop(request.params.id, request.headers.authorization),
              request.params.tokenId,
            ),
          ),
      );
      done();
    },
    { prefix: '/api/v1' },
  );
}
