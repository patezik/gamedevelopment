import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { EvidenceTokenPort } from '@hs/core/evidence';

type GameMinutes = number;

/** `hs1:ev:<sessionTag>:<tokenId>:<sig>` (ADR 0008 section 6). */
const EVIDENCE_QR = /^hs1:ev:([0-9a-f]{8}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22})$/;

const TOKEN_ID_BYTES = 12; // 96 bits
const SIG_BYTES = 16; // HMAC-SHA256 truncated to 128 bits

export const TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;

/** A server-side record of one issued token. The QR carries none of this. */
export interface EvidenceTokenRecord {
  readonly tokenId: string;
  readonly clueId: string;
  /** Game minute from which the token no longer works. */
  readonly expiresAt: GameMinutes;
  /** Game minute of the successful capture, once there is one. */
  usedAt?: GameMinutes;
  /** The capture in progress; concurrent scans of the same QR wait for it. */
  capturing?: Promise<unknown> | undefined;
}

export interface ParsedEvidenceQr {
  readonly sessionTag: string;
  readonly tokenId: string;
  readonly sig: string;
}

/** Splits a scanned string into its parts; `undefined` for anything that is not an evidence QR. */
export function parseEvidenceQr(raw: unknown): ParsedEvidenceQr | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = EVIDENCE_QR.exec(raw);
  if (!match) return undefined;
  const [, sessionTag, tokenId, sig] = match;
  return sessionTag && tokenId && sig ? { sessionTag, tokenId, sig } : undefined;
}

/** The first 8 hex characters of SHA-256(sessionId): enough to tell sessions apart, not a secret. */
export function sessionTagOf(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
}

export interface EvidenceTokenStoreOptions {
  /** HMAC key; random per store unless given (tests). */
  readonly secret?: Buffer;
  /** Source of randomness for token ids (replaced in tests). */
  readonly randomBytes?: (size: number) => Buffer;
  /**
   * Makes token ids reproducible: an id is a hash of this seed, the clue and the expiry, so a
   * replay of the same journal issues the same ids and the engine state hashes agree (ADR 0025).
   * The seed names the case (it is derived from the truth), so it stays on the server. The id is
   * only a handle: what makes a QR genuine is the HMAC under the per-process secret.
   */
  readonly idSeed?: string;
}

/**
 * Evidence tokens of one game session. Implements the core's `EvidenceTokenPort`, so the engine
 * issues tokens here, and signs each QR with HMAC-SHA256 under a secret that never leaves the
 * process. Build it before the session exists, hand it to the engine as `ports.evidenceTokens`,
 * then `bind` it to the session id.
 */
export class EvidenceTokenStore implements EvidenceTokenPort {
  readonly #secret: Buffer;
  readonly #random: (size: number) => Buffer;
  readonly #idSeed: string | undefined;
  readonly #records = new Map<string, EvidenceTokenRecord>();
  #sessionTag: string | undefined;

  constructor(options: EvidenceTokenStoreOptions = {}) {
    this.#secret = options.secret ?? randomBytes(32);
    this.#random = options.randomBytes ?? randomBytes;
    this.#idSeed = options.idSeed;
    if (this.#secret.length < 16) throw new RangeError('HMAC secret must be at least 16 bytes');
  }

  /** Ties the store to its session. Done once; QRs cannot be built or checked before. */
  bind(sessionId: string): void {
    if (this.#sessionTag !== undefined) throw new Error('Evidence token store is already bound');
    this.#sessionTag = sessionTagOf(sessionId);
  }

  get sessionTag(): string | undefined {
    return this.#sessionTag;
  }

  issue(clueId: string, expiresAt: GameMinutes): string {
    if (!Number.isFinite(expiresAt)) throw new RangeError('expiresAt must be a finite game minute');
    let tokenId: string;
    let attempt = 0;
    do {
      tokenId = this.#newId(clueId, expiresAt, attempt++);
    } while (this.#records.has(tokenId));
    this.#records.set(tokenId, { tokenId, clueId, expiresAt });
    return tokenId;
  }

  #newId(clueId: string, expiresAt: GameMinutes, attempt: number): string {
    if (this.#idSeed === undefined) return this.#random(TOKEN_ID_BYTES).toString('base64url');
    return createHash('sha256')
      .update(JSON.stringify([this.#idSeed, clueId, expiresAt, attempt]))
      .digest()
      .subarray(0, TOKEN_ID_BYTES)
      .toString('base64url');
  }

  /**
   * Puts back the token a restored game still has pending, under this store's own secret (a QR
   * drawn before the restart carries the old signature and no longer verifies). Every other
   * record is dropped: replay issued tokens for clues that were captured or replaced since.
   * Call it once the engine is rebuilt, with the engine's pending capture, if any.
   */
  adoptPending(
    pending:
      { readonly tokenId: string; readonly clueId: string; readonly expiresAt: number } | undefined,
  ): void {
    if (pending !== undefined && !TOKEN_ID_PATTERN.test(pending.tokenId)) {
      throw new RangeError('Invalid pending token id');
    }
    this.#records.clear();
    if (pending) {
      this.#records.set(pending.tokenId, {
        tokenId: pending.tokenId,
        clueId: pending.clueId,
        expiresAt: pending.expiresAt,
      });
    }
  }

  revoke(tokenId: string): void {
    this.#records.delete(tokenId);
  }

  get(tokenId: string): EvidenceTokenRecord | undefined {
    return this.#records.get(tokenId);
  }

  #sign(sessionTag: string, tokenId: string): Buffer {
    return createHmac('sha256', this.#secret)
      .update(`${sessionTag}:${tokenId}`)
      .digest()
      .subarray(0, SIG_BYTES);
  }

  /** The string to draw as a QR for an issued token. */
  payload(tokenId: string): string {
    const tag = this.#sessionTag;
    if (tag === undefined) throw new Error('Evidence token store is not bound to a session');
    if (!this.#records.has(tokenId)) throw new Error('Unknown evidence token');
    return `hs1:ev:${tag}:${tokenId}:${this.#sign(tag, tokenId).toString('base64url')}`;
  }

  /** Whether `parsed.sig` is the signature of this token under this store's secret. */
  verifySignature({ sessionTag, tokenId, sig }: ParsedEvidenceQr): boolean {
    const given = Buffer.from(sig, 'base64url');
    // 22 base64url characters carry 132 bits for a 128-bit value, so the spare bits of the last
    // character would let several strings pass as one signature: accept only the canonical one.
    if (given.toString('base64url') !== sig) return false;
    const expected = this.#sign(sessionTag, tokenId);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
