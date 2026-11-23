import type { DispatchResult } from '@hs/core/game';
import type { ErrorCode } from '@hs/protocol';
import { describe, expect, it, vi } from 'vitest';
import { Session } from '../sessions/index.ts';
import { QrService } from './service.ts';

const ok: DispatchResult = { ok: true, minutesSpent: 2, events: [] };
const refused = (error: ErrorCode): DispatchResult => ({
  ok: false,
  error,
  minutesSpent: 0,
  events: [],
});

/** One session with an engine we control, one clue token, and a game clock we can move. */
async function setup(
  engine: (action: unknown) => DispatchResult | Promise<DispatchResult> = () => ok,
) {
  const calls: unknown[] = [];
  const dispatch = vi.fn((role: string, action: unknown) => {
    calls.push({ role, action });
    return engine(action);
  });
  const session = new Session('session-a', { dispatch }, () => 0);
  await session.activate();
  let minute = 10;
  const service = new QrService({ gameMinute: () => minute });
  const store = service.createStore({ secret: Buffer.alloc(32, 3) });
  service.attach(session, store);
  const tokenId = store.issue('clue_ledger', 100);
  return {
    service,
    session,
    store,
    tokenId,
    raw: store.payload(tokenId),
    dispatch,
    calls,
    setMinute: (m: number) => {
      minute = m;
    },
    scan: (raw: unknown, on = session) => service.scan(on, raw),
  };
}

describe('a valid scan', () => {
  it('captures the clue once through the session and answers with the clue', async () => {
    const { scan, raw, dispatch, tokenId } = await setup();
    expect(await scan(raw)).toEqual({ ok: true, clueRef: 'clue_ledger' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('phone', { type: 'captureEvidence', tokenId });
  });

  it('works through a custom capture function too', async () => {
    const calls: string[] = [];
    const session = new Session('s', { dispatch: () => refused('INTERNAL') }, () => 0);
    const service = new QrService({
      gameMinute: () => 0,
      capture: (_s, tokenId) => {
        calls.push(tokenId);
        return Promise.resolve(ok);
      },
    });
    const store = service.createStore();
    service.attach(session, store);
    const tokenId = store.issue('c', 50);
    expect(await service.scan(session, store.payload(tokenId))).toEqual({ ok: true, clueRef: 'c' });
    expect(calls).toEqual([tokenId]);
  });
});

describe('QR_INVALID', () => {
  it.each<[string, unknown]>([
    ['a pairing QR', 'hs1:pair:game-pc.local:7420:ABC123'],
    ['an Expo Go QR', 'exp://192.168.1.5:8081'],
    ['nonsense', 'hello'],
    ['an empty string', ''],
    ['no string at all', undefined],
    ['a number', 7],
  ])('for %s', async (_name, input) => {
    const { scan, dispatch } = await setup();
    expect(await scan(input)).toEqual({ ok: false, error: 'QR_INVALID' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('for a forged signature: no single changed character gets through', async () => {
    const { scan, raw, dispatch } = await setup();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const sigStart = raw.lastIndexOf(':') + 1;
    for (let i = sigStart; i < raw.length; i++) {
      for (const char of alphabet) {
        if (char === raw[i]) continue;
        const forged = `${raw.slice(0, i)}${char}${raw.slice(i + 1)}`;
        expect(await scan(forged), `${i}:${char}`).toEqual({ ok: false, error: 'QR_INVALID' });
      }
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('for a token id the attacker made up, even with a signature of the right size', async () => {
    const { scan, raw, dispatch } = await setup();
    const [prefix, , , , sig] = raw.split(':') as [string, string, string, string, string];
    const tag = raw.split(':')[2];
    expect(await scan(`${prefix}:ev:${tag}:${'Z'.repeat(16)}:${sig}`)).toEqual({
      ok: false,
      error: 'QR_INVALID',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('for a correctly signed token that the engine has revoked', async () => {
    const { scan, raw, store, tokenId, dispatch } = await setup();
    store.revoke(tokenId);
    expect(await scan(raw)).toEqual({ ok: false, error: 'QR_INVALID' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('for a session that never issued a token', async () => {
    const { scan, raw, service } = await setup();
    const lonely = new Session('lonely', { dispatch: () => ok }, () => 0);
    expect(await service.scan(lonely, raw)).toEqual({ ok: false, error: 'QR_INVALID' });
    expect(await scan(raw)).toMatchObject({ ok: true });
  });
});

describe('QR_WRONG_SESSION', () => {
  async function twoSessions() {
    const a = await setup();
    const dispatchB = vi.fn(() => ok);
    const sessionB = new Session('session-b', { dispatch: dispatchB }, () => 0);
    await sessionB.activate();
    const storeB = a.service.createStore({ secret: Buffer.alloc(32, 9) });
    a.service.attach(sessionB, storeB);
    const tokenB = storeB.issue('clue_other', 100);
    return { ...a, sessionB, dispatchB, rawB: storeB.payload(tokenB) };
  }

  it("rejects a token of another session, and the other session's engine is not touched", async () => {
    const { scan, rawB, dispatch, dispatchB } = await twoSessions();
    expect(await scan(rawB)).toEqual({ ok: false, error: 'QR_WRONG_SESSION' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(dispatchB).not.toHaveBeenCalled();
  });

  it('rejects it the other way round as well', async () => {
    const { raw, sessionB, service } = await twoSessions();
    expect(await service.scan(sessionB, raw)).toEqual({ ok: false, error: 'QR_WRONG_SESSION' });
  });

  it('a token of this session with only the tag swapped is the wrong session, not a captured clue', async () => {
    const { scan, raw, dispatch } = await twoSessions();
    const parts = raw.split(':');
    parts[2] = '0'.repeat(8);
    expect(await scan(parts.join(':'))).toEqual({ ok: false, error: 'QR_WRONG_SESSION' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('QR_EXPIRED (game time)', () => {
  it('works up to the last minute before expiry and not from the expiry minute', async () => {
    const live = await setup();
    live.setMinute(99);
    expect(await live.scan(live.raw)).toMatchObject({ ok: true });

    const dead = await setup();
    dead.setMinute(100);
    expect(await dead.scan(dead.raw)).toEqual({ ok: false, error: 'QR_EXPIRED' });
    expect(dead.dispatch).not.toHaveBeenCalled();
  });

  it('is decided by the game clock, not the wall clock', async () => {
    const { scan, raw } = await setup(); // the game stands at minute 10, the token lasts to 100
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await scan(raw)).toEqual({ ok: true, clueRef: 'clue_ledger' });
  });

  it('an expired token is not spent and not captured', async () => {
    const { scan, raw, store, tokenId, setMinute } = await setup();
    setMinute(500);
    await scan(raw);
    expect(store.get(tokenId)?.usedAt).toBeUndefined();
  });
});

describe('QR_ALREADY_USED (idempotent)', () => {
  it('answers the same way every time and captures only once', async () => {
    const { scan, raw, dispatch } = await setup();
    expect(await scan(raw)).toEqual({ ok: true, clueRef: 'clue_ledger' });
    for (let i = 0; i < 5; i++) {
      expect(await scan(raw)).toEqual({
        ok: false,
        error: 'QR_ALREADY_USED',
        clueRef: 'clue_ledger',
      });
    }
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('is still "already used", not "expired", once the clock has run past the expiry', async () => {
    const { scan, raw, setMinute } = await setup();
    await scan(raw);
    setMinute(5_000);
    expect(await scan(raw)).toEqual({
      ok: false,
      error: 'QR_ALREADY_USED',
      clueRef: 'clue_ledger',
    });
  });

  it('records when the clue was captured', async () => {
    const { scan, raw, store, tokenId, setMinute } = await setup();
    setMinute(42);
    await scan(raw);
    expect(store.get(tokenId)?.usedAt).toBe(42);
  });

  it('two scans at the same instant capture the clue once; the second is told it is used', async () => {
    let release: (value: DispatchResult) => void = () => undefined;
    const { scan, raw, dispatch } = await setup(
      () => new Promise<DispatchResult>((resolve) => (release = resolve)),
    );
    const first = scan(raw);
    const second = scan(raw);
    const third = scan(raw);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(dispatch).toHaveBeenCalledTimes(1); // the others are waiting, not capturing
    release(ok);
    expect(await Promise.all([first, second, third])).toEqual([
      { ok: true, clueRef: 'clue_ledger' },
      { ok: false, error: 'QR_ALREADY_USED', clueRef: 'clue_ledger' },
      { ok: false, error: 'QR_ALREADY_USED', clueRef: 'clue_ledger' },
    ]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('QR_PRECONDITION_FAILED', () => {
  it.each<ErrorCode>(['ACTION_NOT_AVAILABLE', 'ACTION_BLOCKED'])(
    'when the engine says %s, and the token stays usable',
    async (error) => {
      let allowed = false;
      const { scan, raw, store, tokenId } = await setup(() => (allowed ? ok : refused(error)));
      expect(await scan(raw)).toEqual({ ok: false, error: 'QR_PRECONDITION_FAILED' });
      expect(store.get(tokenId)?.usedAt).toBeUndefined();
      allowed = true; // the player went back to the right room
      expect(await scan(raw)).toEqual({ ok: true, clueRef: 'clue_ledger' });
    },
  );

  it('a scan that waited for a refused one gets its own try', async () => {
    const answers = [refused('ACTION_NOT_AVAILABLE'), ok];
    let release: (value: DispatchResult) => void = () => undefined;
    const { scan, raw, dispatch } = await setup(
      () => answers.shift() ?? new Promise<DispatchResult>((resolve) => (release = resolve)),
    );
    const first = scan(raw);
    const second = scan(raw);
    expect(await first).toEqual({ ok: false, error: 'QR_PRECONDITION_FAILED' });
    expect(await second).toEqual({ ok: true, clueRef: 'clue_ledger' });
    expect(dispatch).toHaveBeenCalledTimes(2);
    release(ok);
  });
});

describe("failures that are not the player's fault", () => {
  it.each<[ErrorCode, ErrorCode]>([
    ['GAME_OVER', 'GAME_OVER'],
    ['SESSION_CLOSED', 'SESSION_CLOSED'],
    ['INTERNAL', 'INTERNAL'],
    ['ACTION_INVALID', 'INTERNAL'], // e.g. the engine does not know the action yet: do not leak it
    ['UNAUTHORIZED', 'INTERNAL'],
  ])('engine %s is reported as %s and does not spend the token', async (engineError, reported) => {
    const { scan, raw, store, tokenId } = await setup(() => refused(engineError));
    expect(await scan(raw)).toEqual({ ok: false, error: reported });
    expect(store.get(tokenId)?.usedAt).toBeUndefined();
  });

  it('an exception in the capture becomes INTERNAL and the player may scan again', async () => {
    let calls = 0;
    const session = new Session('s', { dispatch: () => ok }, () => 0);
    const service = new QrService({
      gameMinute: () => 0,
      capture: () => (++calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(ok)),
    });
    const store = service.createStore();
    service.attach(session, store);
    const raw = store.payload(store.issue('c', 50));
    expect(await service.scan(session, raw)).toEqual({ ok: false, error: 'INTERNAL' });
    expect(await service.scan(session, raw)).toEqual({ ok: true, clueRef: 'c' });
  });

  it('a closed session refuses the capture through the real Session', async () => {
    const closed = new Session('c', { dispatch: () => ok }, () => 0); // never activated
    const service = new QrService({ gameMinute: () => 0 });
    const store = service.createStore();
    service.attach(closed, store);
    const raw = store.payload(store.issue('c', 50));
    expect(await service.scan(closed, raw)).toEqual({ ok: false, error: 'SESSION_CLOSED' });
  });
});

describe('attach', () => {
  it('gives a session one store only', async () => {
    const { service, session } = await setup();
    expect(() => service.attach(session, service.createStore())).toThrow(/already has/);
  });
});

describe('evidenceMatrix', () => {
  it('draws the payload of an issued token', async () => {
    const { service, session, tokenId } = await setup();
    const matrix = service.evidenceMatrix(session, tokenId);
    expect(matrix.modules).toHaveLength(matrix.size * matrix.size);
  });

  it.each<[string, string, number, ErrorCode]>([
    ['an unknown token', 'ZZZZZZZZZZZZZZZZ', 404, 'QR_INVALID'],
    ['a malformed token id', 'short', 404, 'QR_INVALID'],
    ['an id with path characters', '../../etc/passwd', 404, 'QR_INVALID'],
  ])('refuses %s', async (_name, tokenId, status, code) => {
    const { service, session } = await setup();
    expect(() => service.evidenceMatrix(session, tokenId)).toThrow(
      expect.objectContaining({ code, status }),
    );
  });

  it('refuses a token that is already captured (409) or expired (410)', async () => {
    const used = await setup();
    await used.scan(used.raw);
    expect(() => used.service.evidenceMatrix(used.session, used.tokenId)).toThrow(
      expect.objectContaining({ code: 'QR_ALREADY_USED', status: 409 }),
    );

    const old = await setup();
    old.setMinute(100);
    expect(() => old.service.evidenceMatrix(old.session, old.tokenId)).toThrow(
      expect.objectContaining({ code: 'QR_EXPIRED', status: 410 }),
    );
  });

  it('does not show a token of another session', async () => {
    const { service, tokenId } = await setup();
    const other = new Session('other', { dispatch: () => ok }, () => 0);
    service.attach(other, service.createStore());
    expect(() => service.evidenceMatrix(other, tokenId)).toThrow(
      expect.objectContaining({ code: 'QR_INVALID' }),
    );
  });
});
