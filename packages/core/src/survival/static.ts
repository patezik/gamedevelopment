import { z } from 'zod';
import type { GameMinutes } from '../common/index.ts';
import { TickPhase, type TimeSystem } from '../time/index.ts';
import { SurvivalError } from './vitals.ts';

/** Static range and thresholds of survival-horror.md section 3. */
export const STATIC_LIMITS = { min: 0, max: 100 } as const;
export const STATIC_THRESHOLDS = [25, 50, 75, 100] as const;
export type StaticThreshold = (typeof STATIC_THRESHOLDS)[number];

/** Passive growth: +1 per this many minutes. */
export const STATIC_GROWTH_MINUTES = 60;

/** Named one-off changes of survival-horror.md section 3 (positive grows Static). */
export const STATIC_DELTAS = {
  gruesomeFind: 5,
  night: 3,
  falseAccusation: 15,
  contradictionRevealed: -3,
} as const;

export type StaticEvent =
  | {
      readonly type: 'StaticChanged';
      readonly at: GameMinutes;
      readonly before: number;
      readonly after: number;
      /** `time` or the name of a delta such as `gruesomeFind`. */
      readonly cause: string;
    }
  | {
      readonly type: 'StaticThresholdReached';
      readonly at: GameMinutes;
      readonly threshold: StaticThreshold;
      readonly level: number;
    }
  | {
      /** Static hit 100; `ending` comes from the preset rule (`madness` in the MVP). */
      readonly type: 'StaticOverwhelmed';
      readonly at: GameMinutes;
      readonly ending: string;
    };

/** Plain JSON, safe to hash and save. */
export interface StaticState {
  readonly level: number;
  /** Minutes not yet turned into a point (0 to 59). */
  readonly carryMinutes: number;
  /** Thresholds already reported; each is reported once even if Static falls and rises again. */
  readonly reached: readonly StaticThreshold[];
}

export interface StaticStep {
  readonly state: StaticState;
  readonly events: readonly StaticEvent[];
}

/** Ending a preset assigns to Static 100; the MVP default is `madness`. */
export const DEFAULT_STATIC_ENDING = 'madness';

const stateSchema = z.strictObject({
  level: z.int().min(STATIC_LIMITS.min).max(STATIC_LIMITS.max),
  carryMinutes: z
    .int()
    .min(0)
    .max(STATIC_GROWTH_MINUTES - 1),
  reached: z.array(z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(100)])),
});

/** Starting state; thresholds at or below `level` count as already reached. */
export function createStaticState(level = 0): StaticState {
  return restoreStaticState({
    level,
    carryMinutes: 0,
    reached: STATIC_THRESHOLDS.filter((t) => t <= level),
  });
}

/** Validates a saved state; throws `SURVIVAL_INVALID_STATE` if it is corrupt. */
export function restoreStaticState(saved: unknown): StaticState {
  const result = stateSchema.safeParse(saved);
  if (!result.success) {
    const details = result.error.issues
      .map(({ path, message }) => `${path.join('.')}: ${message}`)
      .join('; ');
    throw new SurvivalError('SURVIVAL_INVALID_STATE', `Invalid static state: ${details}`);
  }
  return result.data;
}

/** The Static level, the shape the `staticLevel` port of ScenarioEvents needs. */
export const staticLevel = (state: StaticState): number => state.level;

/** True once Static reached 100: the game is over by the preset rule and nothing changes. */
export const isOverwhelmed = (state: StaticState): boolean => state.level >= STATIC_LIMITS.max;

function moveTo(
  state: StaticState,
  level: number,
  carryMinutes: number,
  at: GameMinutes,
  cause: string,
  endingAt100: string,
): StaticStep {
  const events: StaticEvent[] = [];
  const reached = [...state.reached];
  if (level !== state.level) {
    events.push({ type: 'StaticChanged', at, before: state.level, after: level, cause });
  }
  for (const threshold of STATIC_THRESHOLDS) {
    if (level >= threshold && !reached.includes(threshold)) {
      reached.push(threshold);
      events.push({ type: 'StaticThresholdReached', at, threshold, level });
    }
  }
  if (level >= STATIC_LIMITS.max) {
    events.push({ type: 'StaticOverwhelmed', at, ending: endingAt100 });
  }
  return { state: { level, carryMinutes, reached }, events };
}

/**
 * Applies a one-off change (a find, a false accusation, a revealed contradiction), clamped to
 * 0..100. Once Static is at 100 nothing changes any more.
 */
export function applyStaticDelta(
  state: StaticState,
  delta: number,
  at: GameMinutes,
  cause: string,
  endingAt100: string = DEFAULT_STATIC_ENDING,
): StaticStep {
  if (!Number.isSafeInteger(delta)) throw new RangeError('static delta must be a whole number');
  if (isOverwhelmed(state)) return { state, events: [] };
  const level = Math.min(STATIC_LIMITS.max, Math.max(STATIC_LIMITS.min, state.level + delta));
  return moveTo(state, level, state.carryMinutes, at, cause, endingAt100);
}

/**
 * `minutes` of game time passing (call from the Timers phase with the span the clock advanced):
 * +1 per 60 minutes, with leftover minutes carried so the result does not depend on how time is
 * split. `at` is the game minute at the end of the span. This module never moves the clock.
 */
export function tickStatic(
  state: StaticState,
  minutes: number,
  at: GameMinutes,
  endingAt100: string = DEFAULT_STATIC_ENDING,
): StaticStep {
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new RangeError(`minutes must be a non-negative whole number, got ${String(minutes)}`);
  }
  if (isOverwhelmed(state) || minutes === 0) return { state, events: [] };
  const total = state.carryMinutes + minutes;
  const gain = Math.floor(total / STATIC_GROWTH_MINUTES);
  const level = Math.min(STATIC_LIMITS.max, state.level + gain);
  return moveTo(state, level, total % STATIC_GROWTH_MINUTES, at, 'time', endingAt100);
}

const TIMER = 'survival.staticTick';

/**
 * Passive growth as a timer: one event per game hour in the `Timers` phase, so Static grows while
 * the clock moves through `TimeSystem.advance` and never by a clock of its own. Holds the state
 * and the events since the last `drain`. Reaching 100 interrupts the advance.
 */
export class StaticTimer {
  #state: StaticState;
  #log: StaticEvent[] = [];
  readonly #endingAt100: string;

  /**
   * `resume` is for a restored scheduler that already holds the next tick; otherwise the first
   * tick is planned one hour after `time.now()`.
   */
  constructor(
    time: TimeSystem,
    state: StaticState = createStaticState(),
    opts: { endingAt100?: string; resume?: boolean } = {},
  ) {
    this.#state = state;
    this.#endingAt100 = opts.endingAt100 ?? DEFAULT_STATIC_ENDING;
    time.registerHandler(TIMER, {
      phase: TickPhase.Timers,
      handle: (event, context) => {
        const step = tickStatic(this.#state, STATIC_GROWTH_MINUTES, event.at, this.#endingAt100);
        this.#state = step.state;
        this.#log.push(...step.events);
        if (isOverwhelmed(step.state)) return { interrupt: 'static' };
        context.schedule({
          kind: TIMER,
          at: event.at + STATIC_GROWTH_MINUTES,
          priority: 0,
          payload: null,
        });
        return undefined;
      },
    });
    if (!opts.resume && !isOverwhelmed(state)) {
      time.schedule({
        kind: TIMER,
        at: time.now() + STATIC_GROWTH_MINUTES,
        priority: 0,
        payload: null,
      });
    }
  }

  state(): StaticState {
    return this.#state;
  }

  level(): number {
    return this.#state.level;
  }

  /** Applies a one-off change at `at`; its events join the log. */
  apply(delta: number, at: GameMinutes, cause: string): void {
    const step = applyStaticDelta(this.#state, delta, at, cause, this.#endingAt100);
    this.#state = step.state;
    this.#log.push(...step.events);
  }

  /** Returns and clears the events recorded since the last call, in order. */
  drain(): StaticEvent[] {
    const events = this.#log;
    this.#log = [];
    return events;
  }
}
