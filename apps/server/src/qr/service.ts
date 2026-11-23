import type { DispatchResult } from '@hs/core/game';
import type { ErrorCode, ServerMessage } from '@hs/protocol';
import type { Session } from '../sessions/index.ts';
import { renderMatrix, type QrMatrix } from './matrix.ts';
import {
  EvidenceTokenStore,
  TOKEN_ID_PATTERN,
  parseEvidenceQr,
  type EvidenceTokenStoreOptions,
} from './tokens.ts';

/** The payload of a `qr.result` message. */
export type QrResult = Extract<ServerMessage, { type: 'qr.result' }>['payload'];

type GameMinutes = number;

export class QrError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, status: number, message: string) {
    super(message);
    this.name = 'QrError';
    this.code = code;
    this.status = status;
  }
}

export interface QrServiceOptions {
  /** The session's current game minute; tokens expire in game time, not wall time. */
  readonly gameMinute: (session: Session) => GameMinutes;
  /**
   * Fixes the clue once the scan is valid. Defaults to dispatching `captureEvidence` through the
   * session, which costs the player 2 game minutes (qr-mechanics.md).
   */
  readonly capture?: (session: Session, tokenId: string) => Promise<DispatchResult>;
}

const rejected = (error: ErrorCode, clueRef?: string): QrResult => ({
  ok: false,
  error,
  ...(clueRef === undefined ? {} : { clueRef }),
});

/**
 * Why the engine refused the capture, in the player's terms. Anything unexpected is reported as
 * INTERNAL rather than leaking what the engine said.
 */
function failureOf(result: DispatchResult): ErrorCode {
  switch (result.error) {
    case 'ACTION_NOT_AVAILABLE':
    case 'ACTION_BLOCKED':
      return 'QR_PRECONDITION_FAILED';
    case 'GAME_OVER':
    case 'SESSION_CLOSED':
      return result.error;
    default:
      return 'INTERNAL';
  }
}

/**
 * Issues and checks the QR codes of one server: evidence tokens per session, the `qr.scan` rules of
 * docs/mobile/qr-mechanics.md section 2, and the matrices Godot draws.
 */
export class QrService {
  readonly #options: QrServiceOptions;
  readonly #stores = new WeakMap<Session, EvidenceTokenStore>();

  constructor(options: QrServiceOptions) {
    this.#options = options;
  }

  /**
   * A token store for a session that does not exist yet: pass it to the engine as
   * `ports.evidenceTokens`, create the session, then `attach` the two.
   */
  createStore(options?: EvidenceTokenStoreOptions): EvidenceTokenStore {
    return new EvidenceTokenStore(options);
  }

  attach(session: Session, store: EvidenceTokenStore): void {
    if (this.#stores.has(session)) throw new Error('Session already has an evidence token store');
    store.bind(session.id);
    this.#stores.set(session, store);
  }

  /**
   * Checks a scanned string and, if it is a live token of this session, captures the clue.
   *
   * Checks run in the order of qr-mechanics.md section 2 (format, session, signature, existence),
   * with one deliberate change: "already used" is decided before "expired", so scanning a QR again
   * after its clue was captured always answers QR_ALREADY_USED with the clue, never QR_EXPIRED.
   * A token is spent only when the capture succeeds, so a refused scan can be repeated.
   */
  async scan(session: Session, raw: unknown): Promise<QrResult> {
    const store = this.#stores.get(session);
    const parsed = parseEvidenceQr(raw);
    if (!store || !parsed) return rejected('QR_INVALID');
    if (parsed.sessionTag !== store.sessionTag) return rejected('QR_WRONG_SESSION');
    if (!store.verifySignature(parsed)) return rejected('QR_INVALID');
    const record = store.get(parsed.tokenId);
    if (!record) return rejected('QR_INVALID');

    // Two scans of the same QR at once must capture the clue once: the second waits for the first.
    while (record.capturing) await record.capturing.catch(() => undefined);
    if (record.usedAt !== undefined) return rejected('QR_ALREADY_USED', record.clueId);
    if (this.#options.gameMinute(session) >= record.expiresAt) return rejected('QR_EXPIRED');

    const capture =
      this.#options.capture ??
      ((s, tokenId) => s.dispatch('phone', { type: 'captureEvidence', tokenId }));
    const attempt = (async (): Promise<QrResult> => {
      let result: DispatchResult;
      try {
        result = await capture(session, record.tokenId);
      } catch {
        return rejected('INTERNAL'); // not spent: the player may scan again
      }
      if (!result.ok) return rejected(failureOf(result));
      record.usedAt = this.#options.gameMinute(session);
      return { ok: true, clueRef: record.clueId };
    })();
    record.capturing = attempt;
    try {
      return await attempt;
    } finally {
      record.capturing = undefined;
    }
  }

  /** The matrix for a token the engine issued; used by Godot's evidence overlay. */
  evidenceMatrix(session: Session, tokenId: string): QrMatrix {
    const store = this.#stores.get(session);
    const record = TOKEN_ID_PATTERN.test(tokenId) ? store?.get(tokenId) : undefined;
    if (!store || !record) throw new QrError('QR_INVALID', 404, 'Unknown evidence token');
    if (record.usedAt !== undefined) {
      throw new QrError('QR_ALREADY_USED', 409, 'This clue has already been captured');
    }
    if (this.#options.gameMinute(session) >= record.expiresAt) {
      throw new QrError('QR_EXPIRED', 410, 'This evidence token has expired');
    }
    return renderMatrix(store.payload(tokenId));
  }
}
