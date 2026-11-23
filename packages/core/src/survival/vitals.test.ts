import { describe, expect, it } from 'vitest';
import { stateHash } from '../common/index.ts';
import { Calendar, resolveActionCost, type ActionKind, type CostContext } from '../time/index.ts';
import {
  SurvivalError,
  VITALS_DELTAS,
  applyDelta,
  costModifiers,
  createVitalsState,
  endingFor,
  rest,
  restoreVitalsState,
  statusOf,
  tickAwake,
  trustedTalk,
  type Vitals,
  type VitalsState,
} from './vitals.ts';

const full: Vitals = { health: 10, sanity: 10, fatigue: 0 };
const state = (vitals: Partial<Vitals> = {}, carry: Partial<VitalsState> = {}): VitalsState => ({
  vitals: { ...full, ...vitals },
  awakeMinutes: 0,
  restedMinutes: 0,
  trustedTalkDay: null,
  ...carry,
});
const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};
const code = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error instanceof SurvivalError ? error.code : error;
  }
  return 'did not throw';
};

describe('createVitalsState', () => {
  it('starts from the preset values with nothing carried over', () => {
    expect(createVitalsState({ health: 10, sanity: 8, fatigue: 10 })).toEqual({
      vitals: { health: 10, sanity: 8, fatigue: 10 },
      awakeMinutes: 0,
      restedMinutes: 0,
      trustedTalkDay: null,
    });
  });

  it.each<[string, Vitals]>([
    ['health above 10', { health: 11, sanity: 8, fatigue: 0 }],
    ['negative sanity', { health: 10, sanity: -1, fatigue: 0 }],
    ['fatigue above 100', { health: 10, sanity: 8, fatigue: 101 }],
    ['fractional health', { health: 7.5, sanity: 8, fatigue: 0 }],
    ['NaN', { health: Number.NaN, sanity: 8, fatigue: 0 }],
  ])('rejects %s', (_name, start) => {
    expect(code(() => createVitalsState(start))).toBe('SURVIVAL_INVALID_STATE');
  });

  it('accepts the limits themselves', () => {
    expect(() => createVitalsState({ health: 0, sanity: 0, fatigue: 100 })).not.toThrow();
  });
});

describe('thresholds (survival-horror.md section 1)', () => {
  it.each([
    [4, false],
    [3, true],
    [1, true],
  ])('health %i: injured = %s', (health, injured) => {
    expect(statusOf({ ...full, health }).injured).toBe(injured);
  });

  it.each([
    [6, false, false],
    [5, true, false],
    [4, true, false],
    [3, true, true],
    [1, true, true],
  ])('sanity %i: phone interference = %s, hallucinations = %s', (sanity, phone, hallucinating) => {
    const status = statusOf({ ...full, sanity });
    expect(status.phoneInterference).toBe(phone);
    expect(status.hallucinating).toBe(hallucinating);
  });

  it.each([
    [70, false, false],
    [71, true, false],
    [99, true, false],
    [100, true, true],
  ])('fatigue %i: exhausted = %s, forced sleep = %s', (fatigue, exhausted, forcedSleep) => {
    const status = statusOf({ ...full, fatigue });
    expect(status.exhausted).toBe(exhausted);
    expect(status.forcedSleep).toBe(forcedSleep);
  });

  it.each<[string, Vitals, 'death' | 'madness' | undefined]>([
    ['healthy', full, undefined],
    ['health 1', { ...full, health: 1 }, undefined],
    ['sanity 1', { ...full, sanity: 1 }, undefined],
    ['health 0 is death', { ...full, health: 0 }, 'death'],
    ['sanity 0 is madness', { ...full, sanity: 0 }, 'madness'],
    ['both 0: death wins', { ...full, health: 0, sanity: 0 }, 'death'],
    ['full fatigue alone is not an ending', { ...full, fatigue: 100 }, undefined],
  ])('ending: %s', (_name, vitals, ending) => {
    expect(endingFor(vitals)).toBe(ending);
    expect(statusOf(vitals).ending).toBe(ending);
  });
});

describe('applyDelta', () => {
  it('applies a change and reports it', () => {
    const step = applyDelta(state({ sanity: 8 }), VITALS_DELTAS.gruesomeFind, 120, 'gruesomeFind');
    expect(step.state.vitals).toEqual({ health: 10, sanity: 6, fatigue: 0 });
    expect(step.events).toEqual([
      {
        type: 'VitalsChanged',
        at: 120,
        before: { health: 10, sanity: 8, fatigue: 0 },
        after: { health: 10, sanity: 6, fatigue: 0 },
        cause: 'gruesomeFind',
      },
    ]);
  });

  it('clamps to the limits instead of overflowing', () => {
    expect(
      applyDelta(state({ health: 9 }), VITALS_DELTAS.medkit, 0, 'medkit').state.vitals.health,
    ).toBe(10);
    expect(applyDelta(state({ fatigue: 95 }), { fatigue: 50 }, 0, 'x').state.vitals.fatigue).toBe(
      100,
    );
    expect(applyDelta(state({ health: 2 }), { health: -9 }, 0, 'x').state.vitals.health).toBe(0);
  });

  it('emits nothing when nothing changes (already at the limit)', () => {
    expect(applyDelta(state(), VITALS_DELTAS.medkit, 0, 'medkit').events).toEqual([]);
    expect(applyDelta(state(), {}, 0, 'x').events).toEqual([]);
  });

  it.each([
    ['gruesomeFind', { sanity: -2 }],
    ['darkLocationAtNight', { sanity: -1 }],
    ['medkit', { health: 3 }],
    ['sedative', { sanity: 2 }],
    ['trustedTalk', { sanity: 1 }],
  ] as const)('named delta %s matches the doc table', (name, delta) => {
    expect(VITALS_DELTAS[name]).toEqual(delta);
  });

  it('rejects fractional changes', () => {
    expect(() => applyDelta(state(), { sanity: 0.5 }, 0, 'x')).toThrow(RangeError);
  });

  it('health 0 ends the game as death, once', () => {
    const step = applyDelta(state({ health: 3 }), { health: -4 }, 50, 'attack');
    expect(step.events.map((e) => e.type)).toEqual(['VitalsChanged', 'PlayerIncapacitated']);
    expect(step.events[1]).toEqual({ type: 'PlayerIncapacitated', at: 50, cause: 'death' });
  });

  it('sanity 0 ends the game as madness', () => {
    const step = applyDelta(state({ sanity: 2 }), { sanity: -2 }, 50, 'static');
    expect(step.events[1]).toEqual({ type: 'PlayerIncapacitated', at: 50, cause: 'madness' });
  });

  it('health and sanity reaching 0 together is one ending: death', () => {
    const step = applyDelta(state({ health: 1, sanity: 1 }), { health: -1, sanity: -1 }, 0, 'x');
    expect(step.events.filter((e) => e.type === 'PlayerIncapacitated')).toEqual([
      { type: 'PlayerIncapacitated', at: 0, cause: 'death' },
    ]);
  });

  it('after the ending nothing changes: no more events, no healing, no ticking', () => {
    const dead = applyDelta(state({ health: 1 }), { health: -1 }, 0, 'x').state;
    for (const step of [
      applyDelta(dead, VITALS_DELTAS.medkit, 1, 'medkit'),
      tickAwake(dead, 600, 600),
      rest(dead, 600, 600),
    ]) {
      expect(step.state).toBe(dead);
      expect(step.events).toEqual([]);
    }
  });
});

describe('tickAwake: +10 fatigue per hour', () => {
  it.each([
    [60, 10],
    [120, 20],
    [6, 1],
    [5, 0],
    [59, 9],
    [0, 0],
    [600, 100],
  ])('%i minutes awake adds %i fatigue', (minutes, gain) => {
    expect(tickAwake(state(), minutes, minutes).state.vitals.fatigue).toBe(gain);
  });

  it('carries the remainder so no time is lost to rounding', () => {
    const first = tickAwake(state(), 5, 5);
    expect(first.state.vitals.fatigue).toBe(0);
    expect(first.state.awakeMinutes).toBe(5);
    expect(first.events).toEqual([]);
    expect(tickAwake(first.state, 1, 6).state).toMatchObject({
      vitals: { fatigue: 1 },
      awakeMinutes: 0,
    });
  });

  it('is independent of how the time is split', () => {
    const whole = tickAwake(state(), 60, 60).state;
    let split = state();
    for (const minutes of [7, 11, 13, 29]) split = tickAwake(split, minutes, 0).state;
    expect(split).toEqual(whole);
  });

  it('asks for forced sleep exactly when fatigue reaches 100', () => {
    const step = tickAwake(state({ fatigue: 95 }), 60, 60);
    expect(step.state.vitals.fatigue).toBe(100);
    expect(step.forcedSleepMinutes).toBe(240);
    expect(tickAwake(state({ fatigue: 90 }), 30, 30).forcedSleepMinutes).toBeUndefined(); // 95
    expect(tickAwake(step.state, 60, 120).forcedSleepMinutes).toBeUndefined(); // already asked
  });

  it('a forced sleep of 240 minutes clears the exhaustion', () => {
    const tired = tickAwake(state({ fatigue: 99 }), 6, 6);
    expect(tired.forcedSleepMinutes).toBe(240);
    expect(rest(tired.state, 240, 246).state.vitals.fatigue).toBe(0); // 100 - 120, clamped
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s minutes', (minutes) => {
    expect(() => tickAwake(state(), minutes, 0)).toThrow(RangeError);
  });
});

describe('rest: -30 fatigue/h, +1 sanity/2h, +1 health/4h', () => {
  it.each<[number, Partial<Vitals>, Vitals]>([
    [60, { fatigue: 80 }, { health: 10, sanity: 10, fatigue: 50 }],
    [120, { fatigue: 80, sanity: 5 }, { health: 10, sanity: 6, fatigue: 20 }],
    [240, { fatigue: 80, sanity: 5, health: 4 }, { health: 5, sanity: 7, fatigue: 0 }],
    [37, { fatigue: 80 }, { health: 10, sanity: 10, fatigue: 62 }], // 37 min = 18 points (proportional)
    [1, { fatigue: 80 }, { health: 10, sanity: 10, fatigue: 80 }],
    [2, { fatigue: 80 }, { health: 10, sanity: 10, fatigue: 79 }],
  ])('%i minutes from %j', (minutes, start, expected) => {
    expect(rest(state(start), minutes, minutes).state.vitals).toEqual(expected);
  });

  it('37 + 23 minutes restores exactly what 60 does', () => {
    const start = state({ fatigue: 80 });
    const split = rest(rest(start, 37, 37).state, 23, 60).state;
    expect(split.vitals).toEqual(rest(start, 60, 60).state.vitals);
    expect(split.vitals.fatigue).toBe(50);
  });

  it('sanity and health come from accumulated rest, not from a single long one', () => {
    let s = state({ sanity: 5, health: 4 });
    for (let i = 0; i < 4; i++) s = rest(s, 60, 0).state; // four separate hours
    expect(s.vitals).toMatchObject({ sanity: 7, health: 5 });
    expect(s.restedMinutes).toBe(0);
  });

  it('wraps the 4-hour cycle', () => {
    const near = state({ health: 4 }, { restedMinutes: 239 });
    const step = rest(near, 1, 0);
    expect(step.state.vitals.health).toBe(5);
    expect(step.state.restedMinutes).toBe(0);
  });

  it('never overshoots the limits', () => {
    expect(rest(state({ fatigue: 10 }), 480, 0).state.vitals).toEqual({
      health: 10,
      sanity: 10,
      fatigue: 0,
    });
  });

  it('leaves the awake carry alone and reports a rest cause', () => {
    const step = rest(state({ fatigue: 20 }, { awakeMinutes: 4 }), 60, 60);
    expect(step.state.awakeMinutes).toBe(4);
    expect(step.events[0]).toMatchObject({ type: 'VitalsChanged', cause: 'rest', at: 60 });
  });

  it('emits nothing when there is nothing to restore', () => {
    expect(rest(state(), 60, 60).events).toEqual([]);
  });
});

describe('trustedTalk: +1 sanity, once per game day', () => {
  // The game starts at 08:00 on day 1, so midnight (t = 960) starts day 2.
  const calendar = new Calendar('2026-01-14T08:00:00');
  const low = (extra: Partial<VitalsState> = {}) => state({ sanity: 5 }, extra);

  it('restores 1 sanity and reports it', () => {
    const step = trustedTalk(low(), 120, calendar);
    expect(step.state.vitals.sanity).toBe(6);
    expect(step.state.trustedTalkDay).toBe(1);
    expect(step.events).toEqual([
      {
        type: 'VitalsChanged',
        at: 120,
        before: { health: 10, sanity: 5, fatigue: 0 },
        after: { health: 10, sanity: 6, fatigue: 0 },
        cause: 'trustedTalk',
      },
    ]);
  });

  it('refuses a second talk on the same day: same state, no events', () => {
    const first = trustedTalk(low(), 120, calendar).state;
    const second = trustedTalk(first, 600, calendar);
    expect(second.state).toBe(first);
    expect(second.events).toEqual([]);
    expect(second.state.vitals.sanity).toBe(6);
  });

  it('allows one more on the next day', () => {
    const day1 = trustedTalk(low(), 120, calendar).state;
    const day2 = trustedTalk(day1, 1000, calendar).state;
    expect(day2.vitals.sanity).toBe(7);
    expect(day2.trustedTalkDay).toBe(2);
  });

  it('uses the calendar day, so the limit resets exactly at midnight', () => {
    const before = trustedTalk(low(), 959, calendar).state; // 23:59 on day 1
    expect(trustedTalk(before, 959, calendar).state).toBe(before);
    expect(trustedTalk(before, 960, calendar).state.vitals.sanity).toBe(7); // 00:00, day 2
  });

  it('works on prehistory days too (day 0 and below)', () => {
    const step = trustedTalk(low(), -500, calendar);
    expect(step.state.trustedTalkDay).toBe(0);
    expect(trustedTalk(step.state, -490, calendar).state).toBe(step.state);
  });

  it('does not spend the day when sanity is already full', () => {
    const full10 = state();
    const step = trustedTalk(full10, 120, calendar);
    expect(step.events).toEqual([]);
    expect(step.state.trustedTalkDay).toBeNull();
    // later the same day sanity drops, and the talk helps after all
    const hurt = applyDelta(step.state, VITALS_DELTAS.gruesomeFind, 300, 'gruesomeFind').state;
    expect(trustedTalk(hurt, 320, calendar).state.vitals.sanity).toBe(9);
  });

  it('does nothing once the hero is incapacitated', () => {
    const gone = applyDelta(state({ sanity: 1 }), { sanity: -1 }, 0, 'x').state;
    const step = trustedTalk(gone, 10, calendar);
    expect(step.state).toBe(gone);
    expect(step.events).toEqual([]);
  });

  it('survives time passing, rest, other changes and saving', () => {
    let s = trustedTalk(low(), 120, calendar).state;
    s = tickAwake(s, 90, 210).state;
    s = rest(s, 60, 270).state;
    s = applyDelta(s, { fatigue: 5 }, 275, 'x').state;
    expect(s.trustedTalkDay).toBe(1);
    const restored = restoreVitalsState(JSON.parse(JSON.stringify(s)));
    expect(restored).toEqual(s);
    expect(trustedTalk(restored, 300, calendar).state).toBe(restored); // still refused after a reload
  });

  it('has no way to be told a day: it cannot be bypassed from outside', () => {
    expect(trustedTalk.length).toBe(3); // (state, at, calendar): the day is derived inside
  });
});

describe('purity', () => {
  it('never mutates its input (frozen states pass through every function)', () => {
    const s = deepFreeze(state({ fatigue: 50, sanity: 6 }, { awakeMinutes: 3 }));
    expect(() => {
      tickAwake(s, 90, 90);
      rest(s, 90, 90);
      applyDelta(s, { sanity: -1 }, 0, 'x');
      costModifiers(s.vitals);
    }).not.toThrow();
  });

  it('gives the same answer for the same input', () => {
    const run = () => {
      let s = state();
      const events = [];
      for (const [m, kind] of [
        [75, 'awake'],
        [40, 'rest'],
        [200, 'awake'],
        [130, 'rest'],
      ] as const) {
        const step = kind === 'awake' ? tickAwake(s, m, 0) : rest(s, m, 0);
        s = step.state;
        events.push(...step.events);
      }
      return stateHash({ s, events });
    };
    expect(run()).toBe(run());
  });
});

describe('save and restore', () => {
  it('round-trips through JSON', () => {
    const s = tickAwake(state({ fatigue: 33 }, { restedMinutes: 100 }), 14, 14).state;
    expect(restoreVitalsState(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it.each<[string, unknown]>([
    ['not an object', 42],
    ['extra field', { ...state(), extra: 1 }],
    ['vitals out of range', { ...state(), vitals: { health: 11, sanity: 1, fatigue: 1 } }],
    ['awake carry too large', { ...state(), awakeMinutes: 6 }],
    ['rested carry too large', { ...state(), restedMinutes: 240 }],
    ['fractional carry', { ...state(), restedMinutes: 1.5 }],
    ['missing vitals', { awakeMinutes: 0, restedMinutes: 0, trustedTalkDay: null }],
    ['missing trusted-talk day', { vitals: full, awakeMinutes: 0, restedMinutes: 0 }],
    ['fractional trusted-talk day', { ...state(), trustedTalkDay: 1.5 }],
  ])('rejects corrupt state: %s', (_name, saved) => {
    expect(code(() => restoreVitalsState(saved))).toBe('SURVIVAL_INVALID_STATE');
  });
});

describe('costModifiers with resolveActionCost (TIME-004)', () => {
  const ctx = (extra: CostContext = {}): CostContext => ({
    travel: { provider: { travelTime: () => 8 }, from: 'a', to: 'b' },
    conversationMinutes: 12,
    ...extra,
  });
  const cost = (action: ActionKind, vitals: Vitals, dark = false): number => {
    const extra: CostContext =
      action === 'rest' ? { minutes: 120 } : action === 'wait' ? { minutes: 45 } : {};
    return resolveActionCost(action, {
      ...ctx(extra),
      modifiers: costModifiers(vitals, { darkWithoutLight: dark }),
    }).expected;
  };

  const healthy = full;
  const tired = { ...full, fatigue: 80 };
  const injured = { ...full, health: 2 };
  const insane = { ...full, sanity: 2 };
  const everything = { health: 2, sanity: 2, fatigue: 80 };

  // [action, healthy, tired (+25 %), injured (moves +50 %), insane (talk +5), all + darkness]
  it.each<[ActionKind, number, number, number, number, number]>([
    ['move', 8, 10, 12, 8, 23], // 8 x 1.25 x 1.5 x 1.5 = 22.5
    ['examineLocation', 15, 19, 15, 15, 19],
    ['examineHotspot', 5, 6, 5, 5, 6],
    ['captureEvidence', 2, 3, 2, 2, 3],
    ['talk', 10, 13, 10, 15, 18], // 10 x 1.25 + 5 = 17.5
    ['interrogate', 20, 25, 20, 25, 30],
    ['call', 17, 21, 17, 22, 26], // (5 + 12) x 1.25 + 5 = 26.25
    ['message', 2, 3, 2, 2, 3],
    ['read', 10, 13, 10, 10, 13],
    ['pickLock', 20, 25, 20, 20, 25],
    ['useItem', 5, 6, 5, 5, 6],
    ['rest', 120, 150, 120, 120, 150],
    ['wait', 45, 56, 45, 45, 56],
  ])('%s', (action, h, t, i, s, all) => {
    expect(cost(action, healthy)).toBe(h);
    expect(cost(action, tired)).toBe(t);
    expect(cost(action, injured)).toBe(i);
    expect(cost(action, insane)).toBe(s);
    expect(cost(action, everything, true)).toBe(all);
  });

  it.each<[string, Vitals, boolean, string[]]>([
    ['healthy: no modifiers', full, false, []],
    ['fatigue 70 is not yet tired', { ...full, fatigue: 70 }, false, []],
    ['fatigue 71', { ...full, fatigue: 71 }, false, ['fatigue']],
    ['health 4 is not yet injured', { ...full, health: 4 }, false, []],
    ['health 3', { ...full, health: 3 }, false, ['injury']],
    ['sanity 4 only glitches the phone', { ...full, sanity: 4 }, false, []],
    ['sanity 3', { ...full, sanity: 3 }, false, ['sanity']],
    ['darkness is up to the caller', full, true, ['darkness']],
    [
      'everything at once, in fixed order',
      { health: 1, sanity: 1, fatigue: 100 },
      true,
      ['fatigue', 'injury', 'darkness', 'sanity'],
    ],
  ])('%s', (_name, vitals, dark, ids) => {
    expect(costModifiers(vitals, { darkWithoutLight: dark }).map((m) => m.id)).toEqual(ids);
  });

  it('runs multipliers before the flat sanity surcharge', () => {
    const orders = costModifiers(
      { health: 1, sanity: 1, fatigue: 100 },
      { darkWithoutLight: true },
    ).map((m) => m.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(orders.at(-1)).toBeGreaterThan(orders[0] ?? 0);
  });

  it('the cost range keeps its shape: lockpicking 20-30 becomes 25-38 when tired', () => {
    const range = resolveActionCost('pickLock', { modifiers: costModifiers(tired) });
    expect(range).toEqual({ min: 25, max: 38, expected: 25 });
  });
});
