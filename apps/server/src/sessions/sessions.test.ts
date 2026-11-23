import { describe, expect, test } from 'vitest';
import { tinyManor } from '../../../../packages/core/test/fixtures/tiny-manor.ts';
import { SessionManager } from './index.ts';

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
