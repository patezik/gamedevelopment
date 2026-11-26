import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { PROTOCOL_VERSION, type ErrorCode } from '@hs/protocol';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Session, SessionManager, SessionRole } from '../sessions/index.ts';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const codeSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{6}$/);
const requestSchema = z.object({
  code: codeSchema,
  deviceName: z.string().trim().min(1).max(128),
  appVersion: z.string().min(1).max(64),
  protocolVersion: z.int().positive(),
});
const ttlMs = 300_000;
const attemptWindowMs = 60_000;

interface CodeEntry {
  session: Session;
  expiresAt: number;
  failures: number;
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueToken(session: Session, role: SessionRole): string {
  const token = randomBytes(32).toString('base64url');
  session.setTokenHash(role, hashSessionToken(token));
  return token;
}

export function verifyToken(session: Session, role: SessionRole, token: string): boolean {
  const expected = session.tokenHash(role);
  return expected !== undefined &&
    timingSafeEqual(Buffer.from(hashSessionToken(token), 'hex'), Buffer.from(expected, 'hex'));
}

class PairingError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

interface PairingOptions {
  host: () => string;
  port: number;
  now?: () => number;
  onDeviceRevoked?: (session: Session, reason: 'DEVICE_REVOKED') => void;
}

export class PairingService {
  readonly #sessions: Pick<SessionManager, 'get'>;
  readonly #options: PairingOptions;
  readonly #now: () => number;
  readonly #codes = new Map<string, CodeEntry>();
  readonly #sessionCodes = new Map<string, string>();
  readonly #attempts = new Map<string, number[]>();
  readonly #revocationListeners = new Set<(session: Session) => void>();
  #nextCleanup = 0;

  constructor(sessions: Pick<SessionManager, 'get'>, options: PairingOptions) {
    this.#sessions = sessions;
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  #removeCode(code: string, entry: CodeEntry): void {
    this.#codes.delete(code);
    this.#sessionCodes.delete(entry.session.id);
  }

  #cleanup(now: number): void {
    if (now < this.#nextCleanup) return;
    this.#nextCleanup = now + attemptWindowMs;
    for (const [ip, attempts] of this.#attempts) {
      if ((attempts.at(-1) ?? 0) <= now - attemptWindowMs) this.#attempts.delete(ip);
    }
    // Keep expired codes briefly so a slow scan can receive an explicit expiry response.
    for (const [code, entry] of this.#codes) {
      if (entry.expiresAt + ttlMs <= now || entry.session.status === 'disposed') {
        this.#removeCode(code, entry);
      }
    }
  }

  createCode(session: Session) {
    const { pairing, commit } = this.prepareCode(session);
    commit();
    return pairing;
  }

  /** Stages a code without touching either index. Validate and commit it in the same turn. */
  prepareCode(session: Session) {
    const now = this.#now();
    const host = this.#options.host();
    let code: string;
    do {
      code = Array.from({ length: 6 }, () => alphabet.charAt(randomInt(alphabet.length))).join('');
    } while (this.#codes.has(code));
    const qrPayload = ['hs1', 'pair', host, this.#options.port, code].join(':');
    const expiresAt = now + ttlMs;
    return {
      pairing: { code, expiresAt, qrPayload },
      commit: () => {
        this.#cleanup(now);
        const previous = this.#sessionCodes.get(session.id);
        if (previous !== undefined) this.#codes.delete(previous);
        this.#codes.set(code, { session, expiresAt, failures: 0 });
        this.#sessionCodes.set(session.id, code);
      },
    };
  }

  /** Forgets the session's pairing code, if it has one (a session whose creation failed). */
  discardCode(session: Session): void {
    const code = this.#sessionCodes.get(session.id);
    if (code === undefined) return;
    const entry = this.#codes.get(code);
    if (entry?.session === session) this.#removeCode(code, entry);
  }

  /** The session's latest pairing code (it may have expired), without issuing a new one. */
  activeCode(session: Session): { code: string; expiresAt: number; qrPayload: string } | undefined {
    const code = this.#sessionCodes.get(session.id);
    const entry = code === undefined ? undefined : this.#codes.get(code);
    if (code === undefined || entry?.session !== session) return undefined;
    return {
      code,
      expiresAt: entry.expiresAt,
      qrPayload: ['hs1', 'pair', this.#options.host(), this.#options.port, code].join(':'),
    };
  }

  authorizeDesktop(id: string, authorization: string | undefined): Session {
    const session = this.#sessions.get(id);
    if (!session || session.status === 'disposed') {
      throw new PairingError('SESSION_NOT_FOUND', 404, 'Session not found');
    }
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization ?? '')?.[1];
    if (!token || !verifyToken(session, 'desktop', token)) {
      throw new PairingError('UNAUTHORIZED', 401, 'A valid desktop token is required');
    }
    return session;
  }

  revokeDevice(session: Session): void {
    if (!session.clearTokenHash('phone')) return;
    this.#options.onDeviceRevoked?.(session, 'DEVICE_REVOKED');
    for (const listener of this.#revocationListeners) listener(session);
  }

  onDeviceRevoked(listener: (session: Session) => void): () => void {
    this.#revocationListeners.add(listener);
    return () => { this.#revocationListeners.delete(listener); };
  }

  async pair(body: unknown, ip: string) {
    const now = this.#now();
    this.#cleanup(now);
    const attempts = (this.#attempts.get(ip) ?? []).filter((at) => at > now - attemptWindowMs);
    if (attempts.length >= 5) {
      throw new PairingError('PAIRING_RATE_LIMITED', 429, 'Too many pairing attempts');
    }
    attempts.push(now);
    this.#attempts.set(ip, attempts);

    const code = z.object({ code: codeSchema }).safeParse(body);
    const entry = code.success ? this.#codes.get(code.data.code) : undefined;
    if (!code.success || !entry || entry.session.status === 'disposed' ||
        entry.session.status === 'faulted') {
      throw new PairingError('PAIRING_CODE_INVALID', 400, 'Invalid pairing code');
    }
    if (entry.expiresAt <= now) {
      throw new PairingError('PAIRING_CODE_EXPIRED', 410, 'Pairing code expired');
    }
    const request = requestSchema.safeParse(body);
    if (!request.success || request.data.protocolVersion !== PROTOCOL_VERSION) {
      if (++entry.failures >= 20) this.#removeCode(code.data.code, entry);
      if (!request.success) throw new PairingError('INVALID_MESSAGE', 400, 'Invalid pairing request');
      throw new PairingError('PROTOCOL_MISMATCH', 400, 'Unsupported protocol version');
    }

    this.#removeCode(code.data.code, entry);
    const { session } = entry;
    this.revokeDevice(session);
    const deviceToken = issueToken(session, 'phone');
    await session.activate();
    return { sessionId: session.id, deviceToken, wsPath: '/ws' };
  }
}

export function registerPairingRoutes(app: FastifyInstance, service: PairingService): void {
  app.register((routes, _options, done) => {
    routes.setErrorHandler((error, _request, reply) => {
      if (!(error instanceof PairingError)) throw error;
      reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    });

    routes.post('/pair', (request) => service.pair(request.body, request.ip));
    routes.post<{ Params: { id: string } }>('/sessions/:id/pairing-code', (request) =>
      service.createCode(service.authorizeDesktop(request.params.id, request.headers.authorization)),
    );
    routes.delete<{ Params: { id: string } }>('/sessions/:id/device', (request, reply) => {
      service.revokeDevice(service.authorizeDesktop(request.params.id, request.headers.authorization));
      return reply.code(204).send();
    });
    done();
  }, { prefix: '/api/v1' });
}
