import { spawnSync } from 'node:child_process';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { tinyManor } from '../../../../packages/core/test/fixtures/tiny-manor.ts';
import { SessionIdInUseError, SessionManager } from './index.ts';

const wait = { type: 'wait', minutes: 15 } as const;
const provider = {
  create: (_scenarioId: string, seed: string) => ({
    investigation: tinyManor(seed),
    ports: { startLocationId: 'loc_hall' },
  }),
};

describe('SessionManager', () => {
  test('runs concurrent desktop and phone actions in enqueue order', async () => {
    const calls: string[] = [];
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const manager = new SessionManager(provider, {
      createEngine: () => ({
        async dispatch(role) {
          calls.push(`start:${role}`);
          if (role === 'desktop') {
            started.resolve();
            await gate.promise;
          }
          calls.push(`end:${role}`);
          return {
            ok: true,
            minutesSpent: 15,
            events: [{ type: 'ClockAdvanced', from: 0, to: 15 }],
          };
        },
      }),
    });
    const session = await manager.create('tiny-manor', 'winter');
    await session.activate();

    const desktop = session.dispatch('desktop', wait);
    const phone = session.dispatch('phone', wait);
    await started.promise;
    expect(calls).toEqual(['start:desktop']);
    expect(session.stateVersion).toBe(0);
    gate.resolve();
    await Promise.all([desktop, phone]);

    expect(calls).toEqual(['start:desktop', 'end:desktop', 'start:phone', 'end:phone']);
    expect(session.stateVersion).toBe(2);
    expect(session.eventsAfter(0)?.map(({ seq }) => seq)).toEqual([1, 2]);
  });

  test('faults only the affected session and returns INTERNAL to already queued actions', async () => {
    let calls = 0;
    const manager = new SessionManager(provider, {
      createEngine: () => ({
        dispatch() {
          calls++;
          throw new Error('server-only diagnostic');
        },
      }),
    });
    const session = await manager.create('tiny-manor', 'winter');
    await session.activate();

    const results = await Promise.all([
      session.dispatch('desktop', wait),
      session.dispatch('phone', wait),
    ]);
    expect(results).toEqual([
      { ok: false, error: 'INTERNAL', minutesSpent: 0, events: [] },
      { ok: false, error: 'INTERNAL', minutesSpent: 0, events: [] },
    ]);
    expect(calls).toBe(1);
    expect(session.status).toBe('faulted');
    expect(session.stateVersion).toBe(0);
    expect(manager.get(session.id)).toBe(session);
    expect((await manager.create('tiny-manor', 'spring')).status).toBe('created');
  });

  test('runs the real engine, suspends at the grace boundary, and expires finished sessions', async () => {
    let now = 0;
    const manager = new SessionManager(
      {
        create(scenarioId, seed) {
          const { investigation, ports } = provider.create(scenarioId, seed);
          return {
            investigation: {
              ...investigation,
              world: { ...investigation.world, durationMinutes: 15 },
            },
            ports,
          };
        },
      },
      { now: () => now },
    );
    const session = await manager.create('tiny-manor', 'winter');
    expect(await session.activate()).toBe(true);
    now = 59_999;
    await manager.sweep();
    expect(session.status).toBe('active');
    now++;
    await manager.sweep();
    expect(session.status).toBe('suspended');
    expect(await session.dispatch('desktop', wait)).toMatchObject({ error: 'SESSION_CLOSED' });
    await session.setConnected('desktop', true);
    expect(await session.dispatch('desktop', wait)).toMatchObject({
      ok: true,
      outcome: 'time_expired',
    });
    expect(session.status).toBe('finished');
    session.setTokenHash('desktop', 'stored-hash');
    await session.setConnected('desktop', false);
    now += 30 * 60_000;
    await manager.sweep();
    expect(session.status).toBe('disposed');
    expect(session.tokenHash('desktop')).toBeUndefined();
    expect(manager.get(session.id)).toBeUndefined();
  });

  test('retains the latest 200 events and detects replay gaps', async () => {
    const manager = new SessionManager(provider, {
      createEngine: () => ({
        dispatch: () => ({
          ok: true,
          minutesSpent: 1,
          events: Array.from({ length: 201 }, () => ({
            type: 'ClockAdvanced' as const,
            from: 0,
            to: 1,
          })),
        }),
      }),
    });
    const session = await manager.create('tiny-manor', 'winter');
    await session.activate();
    await session.dispatch('desktop', wait);
    expect(session.eventsAfter(0)).toBeNull();
    expect(session.eventsAfter(1)).toHaveLength(200);
    expect(session.eventsAfter(200)?.[0]?.seq).toBe(201);
  });
});

test('session manager loads under the server native Node runtime', () => {
  const moduleUrl = new URL('./index.ts', import.meta.url).href;
  const probe = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', 'await import(process.argv[1]);', moduleUrl],
    { encoding: 'utf8' },
  );

  expect(probe.error).toBeUndefined();
  expect(probe.status, probe.stderr).toBe(0);
});

test('prepare has a synchronous return contract', () => {
  type Prepare = NonNullable<Parameters<SessionManager['create']>[2]>;
  expectTypeOf<Prepare>().returns.toEqualTypeOf<undefined>();
});

test('a Promise-returning prepare is rejected without registering or leaking its rejection', () => {
  const probe = spawnSync(
    process.execPath,
    [
      '--unhandled-rejections=strict',
      '--import', 'tsx',
      '--input-type=module', '-e',
      `
        import assert from 'node:assert/strict';
        const { SessionManager } = await import(process.argv[1]);
        const { tinyManor } = await import(process.argv[2]);
        const manager = new SessionManager({
          create: () => ({ investigation: tinyManor(), ports: { startLocationId: 'loc_hall' } }),
        }, { createId: () => 'probe' });
        const gate = Promise.withResolvers();
        const creation = manager.create('tiny', 'seed', async () => {
          await gate.promise;
          throw new Error('late rejection');
        });
        try {
          await assert.rejects(creation, /prepare must finish synchronously/);
          assert.equal(manager.get('probe'), undefined);
        } finally {
          gate.resolve();
        }
        await new Promise(setImmediate);
      `,
      new URL('./index.ts', import.meta.url).href,
      new URL('../../../../packages/core/test/fixtures/tiny-manor.ts', import.meta.url).href,
    ],
    { encoding: 'utf8' },
  );

  expect(probe.error).toBeUndefined();
  expect(probe.status, probe.stderr).toBe(0);
});

test('concurrent create with a duplicate ID leaves the first session intact', async () => {
  const manager = new SessionManager(provider, { createId: () => 'same-id' });
  const results = await Promise.allSettled([
    manager.create('tiny', 'first', (candidate) => {
      candidate.setTokenHash('desktop', 'first-hash');
    }),
    manager.create('tiny', 'second', () => {
      throw new Error('duplicate reached prepare');
    }),
  ]);
  expect(results[0]).toMatchObject({ status: 'fulfilled', value: manager.get('same-id') });
  expect(results[1]).toMatchObject({ status: 'rejected', reason: new Error('Duplicate session ID') });
  expect(manager.get('same-id')?.tokenHash('desktop')).toBe('first-hash');
});

test('prepare cannot reenter adopt with the ID of the session being prepared', async () => {
  const manager = new SessionManager(provider, { createId: () => 'same-id' });
  const attempts: Promise<unknown>[] = [];
  const created = await manager.create('tiny', 'seed', (candidate) => {
    attempts.push(manager.adopt(candidate.id, candidate.engine).catch((error: unknown) => error));
    expect(manager.get(candidate.id) === undefined).toBe(true);
  });

  expect(await Promise.all(attempts)).toEqual([expect.any(SessionIdInUseError)]);
  expect(manager.get(created.id)).toBe(created);
});

test('create registers the session only after prepare succeeded', async () => {
  const ids = ['s-failed', 's-ok'];
  const manager = new SessionManager(provider, { createId: () => ids.shift()! });
  await expect(
    manager.create('tiny', 'seed', () => {
      throw new Error('prepare failed');
    }),
  ).rejects.toThrow('prepare failed');
  expect(manager.get('s-failed')).toBeUndefined();

  const prepared: string[] = [];
  const session = await manager.create('tiny', 'seed', (candidate) => {
    prepared.push(candidate.id);
    expect(manager.get(candidate.id)).toBeUndefined();
  });
  expect(prepared).toEqual(['s-ok']);
  expect(manager.get('s-ok')).toBe(session);
});

test('the session locale is passed to the provider and defaults to ru', async () => {
  const seen: string[] = [];
  const manager = new SessionManager({
    create(scenarioId, seed, locale) {
      seen.push(locale ?? '');
      return provider.create(scenarioId, seed);
    },
  });
  await manager.create('tiny-manor', 'winter');
  await manager.create('tiny-manor', 'winter', undefined, 'en');
  expect(seen).toEqual(['ru', 'en']);
});
