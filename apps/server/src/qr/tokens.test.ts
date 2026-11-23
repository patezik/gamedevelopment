import { describe, expect, it } from 'vitest';
import { EvidenceTokenStore, parseEvidenceQr, sessionTagOf } from './tokens.ts';

const secret = Buffer.alloc(32, 7);
const counter = () => {
  let n = 0;
  return (size: number) => Buffer.alloc(size, ++n);
};
const bound = (id = 'session-a', options = {}) => {
  const store = new EvidenceTokenStore({ secret, randomBytes: counter(), ...options });
  store.bind(id);
  return store;
};

describe('issue', () => {
  it('returns a 96-bit url-safe id and keeps a record that carries no clue content', () => {
    const store = bound();
    const tokenId = store.issue('clue_ledger', 120);
    expect(tokenId).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(store.get(tokenId)).toEqual({ tokenId, clueId: 'clue_ledger', expiresAt: 120 });
  });

  it('never repeats an id, even when the random source does', () => {
    const repeated = [Buffer.alloc(12, 1), Buffer.alloc(12, 1), Buffer.alloc(12, 2)];
    const store = new EvidenceTokenStore({
      secret,
      randomBytes: () => repeated.shift() ?? Buffer.alloc(12, 9),
    });
    const first = store.issue('a', 1);
    const second = store.issue('b', 1);
    expect(second).not.toBe(first);
    expect(store.get(first)?.clueId).toBe('a');
  });

  it('uses real randomness by default', () => {
    const store = new EvidenceTokenStore();
    const ids = new Set(Array.from({ length: 500 }, () => store.issue('c', 1)));
    expect(ids.size).toBe(500);
  });

  it('rejects an expiry that is not a number', () => {
    expect(() => bound().issue('c', Number.NaN)).toThrow(RangeError);
    expect(() => bound().issue('c', Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('revoke forgets the token', () => {
    const store = bound();
    const tokenId = store.issue('c', 10);
    store.revoke(tokenId);
    expect(store.get(tokenId)).toBeUndefined();
    store.revoke(tokenId); // harmless the second time
  });
});

describe('payload', () => {
  it('has the documented shape and size', () => {
    const store = bound();
    const payload = store.payload(store.issue('c', 10));
    expect(payload).toMatch(/^hs1:ev:[0-9a-f]{8}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}$/);
    expect(payload).toHaveLength(55);
  });

  it('starts with the tag of its session and is stable for one token', () => {
    const store = bound('session-a');
    const tokenId = store.issue('c', 10);
    expect(store.payload(tokenId)).toBe(store.payload(tokenId));
    expect(store.payload(tokenId).split(':')[2]).toBe(sessionTagOf('session-a'));
  });

  it('refuses to draw a QR before the store knows its session, or for an unknown token', () => {
    const unbound = new EvidenceTokenStore({ secret });
    expect(() => unbound.payload(unbound.issue('c', 1))).toThrow(/not bound/);
    expect(() => bound().payload('AAAAAAAAAAAAAAAA')).toThrow(/Unknown/);
  });

  it('binds only once', () => {
    expect(() => bound().bind('other')).toThrow(/already bound/);
  });

  it('needs a secret of a sensible size', () => {
    expect(() => new EvidenceTokenStore({ secret: Buffer.alloc(8) })).toThrow(RangeError);
  });
});

describe('signature', () => {
  const setup = () => {
    const store = bound();
    const payload = store.payload(store.issue('c', 10));
    const parsed = parseEvidenceQr(payload);
    if (!parsed) throw new Error('the store produced an unparsable payload');
    return { store, payload, parsed };
  };

  it('accepts what the store signed', () => {
    const { store, parsed } = setup();
    expect(store.verifySignature(parsed)).toBe(true);
  });

  it('rejects every single-character change to the signature, including the spare last bits', () => {
    const { store, parsed } = setup();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (let i = 0; i < parsed.sig.length; i++) {
      for (const char of alphabet) {
        if (char === parsed.sig[i]) continue;
        const forged = `${parsed.sig.slice(0, i)}${char}${parsed.sig.slice(i + 1)}`;
        expect(store.verifySignature({ ...parsed, sig: forged }), `${i}:${char}`).toBe(false);
      }
    }
  });

  it('rejects a signature made for another token, tag or secret', () => {
    const { store, parsed } = setup();
    expect(store.verifySignature({ ...parsed, tokenId: 'BBBBBBBBBBBBBBBB' })).toBe(false);
    expect(store.verifySignature({ ...parsed, sessionTag: sessionTagOf('session-b') })).toBe(false);
    const stranger = new EvidenceTokenStore({ secret: Buffer.alloc(32, 8) });
    expect(stranger.verifySignature(parsed)).toBe(false);
  });

  it('a signature made without the secret is useless: a guess of the right length fails', () => {
    const { store, parsed } = setup();
    expect(store.verifySignature({ ...parsed, sig: 'A'.repeat(22) })).toBe(false);
  });
});

describe('parseEvidenceQr', () => {
  const valid = `hs1:ev:${'0'.repeat(8)}:${'A'.repeat(16)}:${'B'.repeat(22)}`;

  it('splits a well-formed string', () => {
    expect(parseEvidenceQr(valid)).toEqual({
      sessionTag: '00000000',
      tokenId: 'A'.repeat(16),
      sig: 'B'.repeat(22),
    });
  });

  it.each<[string, unknown]>([
    ['a pairing QR', 'hs1:pair:game-pc.local:7420:ABC123'],
    ['an Expo Go QR', 'exp://192.168.1.5:8081'],
    ['a URL', 'https://example.com'],
    ['an empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { raw: valid }],
    ['an array', [valid]],
    ['the wrong prefix', valid.replace('hs1:ev', 'hs2:ev')],
    ['an upper-case marker', valid.replace('hs1:ev', 'HS1:EV')],
    ['an upper-case tag', valid.replace('00000000', 'ABCDEF00')],
    ['a tag of 7 characters', valid.replace('00000000', '0000000')],
    ['a tag of 9 characters', valid.replace('00000000', '000000000')],
    ['a token id of 15 characters', valid.replace('A'.repeat(16), 'A'.repeat(15))],
    ['a token id of 17 characters', valid.replace('A'.repeat(16), 'A'.repeat(17))],
    ['a signature of 21 characters', valid.slice(0, -1)],
    ['a signature of 23 characters', `${valid}B`],
    ['a missing part', valid.split(':').slice(0, 4).join(':')],
    ['an extra part', `${valid}:x`],
    ['a trailing newline', `${valid}\n`],
    ['a trailing space', `${valid} `],
    ['a leading space', ` ${valid}`],
    ['a standard-base64 character', valid.replace('B'.repeat(22), `${'B'.repeat(21)}+`)],
    ['a look-alike unicode letter', valid.replace('A', 'А')],
  ])('rejects %s', (_name, raw) => {
    expect(parseEvidenceQr(raw)).toBeUndefined();
  });

  it('rejects a huge string at once (every part of the pattern has a fixed size)', () => {
    const started = process.hrtime.bigint();
    expect(parseEvidenceQr(`hs1:ev:${'a'.repeat(1_000_000)}`)).toBeUndefined();
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(50);
  });
});

describe('sessionTagOf', () => {
  it('is 8 hex characters, stable, and differs between sessions', () => {
    expect(sessionTagOf('a')).toMatch(/^[0-9a-f]{8}$/);
    expect(sessionTagOf('a')).toBe(sessionTagOf('a'));
    expect(sessionTagOf('a')).not.toBe(sessionTagOf('b'));
  });
});
