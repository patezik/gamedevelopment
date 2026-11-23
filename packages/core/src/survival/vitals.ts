import { z } from 'zod';
import type { GameMinutes } from '../common/index.ts';
import type { ActionKind, Calendar, CostModifier } from '../time/index.ts';

/** Ranges from docs/game-design/survival-horror.md section 1. */
export const VITALS_LIMITS = {
  health: { min: 0, max: 10 },
  sanity: { min: 0, max: 10 },
  fatigue: { min: 0, max: 100 },
} as const;

export interface Vitals {
  readonly health: number;
  readonly sanity: number;
  readonly fatigue: number;
}

export type VitalsDelta = Partial<Vitals>;

/** Thresholds of survival-horror.md section 1; each is checked against the value after a change. */
export const VITALS_THRESHOLDS = {
  /** Health at or below this: moves take +50 % time. */
  injuredHealth: 3,
  /** Sanity at or below this: the phone glitches. */
  phoneInterferenceSanity: 5,
  /** Sanity at or below this: hallucinations; conversations take +5 minutes. */
  hallucinationSanity: 3,
  /** Fatigue above this: every action takes +25 % time. */
  exhaustedFatigue: 70,
  /** Fatigue at this value forces sleep. */
  forcedSleepFatigue: 100,
  forcedSleepMinutes: 240,
} as const;

/** Fixed changes named in survival-horror.md (positive restores, negative costs). */
export const VITALS_DELTAS = {
  gruesomeFind: { sanity: -2 },
  darkLocationAtNight: { sanity: -1 },
  medkit: { health: 3 },
  sedative: { sanity: 2 },
  /** Once per game day: applied by `trustedTalk`, which enforces the daily limit. */
  trustedTalk: { sanity: 1 },
} as const satisfies Record<string, VitalsDelta>;

/**
 * Whole minutes per point. Vitals are integers, so each rule is "1 point per N minutes":
 * awake fatigue +10/hour, rest fatigue -30/hour, rest sanity +1/2 hours, rest health +1/4 hours.
 */
const AWAKE_FATIGUE_MINUTES = 6;
const REST_FATIGUE_MINUTES = 2;
const REST_SANITY_MINUTES = 120;
const REST_HEALTH_MINUTES = 240;
/** Least common multiple of the rest periods, so one counter serves all three. */
const REST_CYCLE = 240;

export type SurvivalEvent =
  | {
      readonly type: 'VitalsChanged';
      readonly at: GameMinutes;
      readonly before: Vitals;
      readonly after: Vitals;
      /** What changed them: `awake`, `rest`, or the name of a delta such as `medkit`. */
      readonly cause: string;
    }
  | {
      readonly type: 'PlayerIncapacitated';
      readonly at: GameMinutes;
      readonly cause: 'death' | 'madness';
    };

/**
 * Vitals plus the minutes carried over between calls, so partial time is not lost to rounding:
 * resting 37 + 23 minutes restores exactly what resting 60 does. Plain JSON, safe to hash and save.
 */
export interface VitalsState {
  readonly vitals: Vitals;
  /** Awake minutes not yet turned into fatigue (0 to 5). */
  readonly awakeMinutes: number;
  /** Resting minutes in the current 4-hour cycle (0 to 239). */
  readonly restedMinutes: number;
  /** Game day of the last trusted talk that restored sanity; `null` if there has been none. */
  readonly trustedTalkDay: number | null;
}

export interface VitalsStep {
  readonly state: VitalsState;
  readonly events: readonly SurvivalEvent[];
  /**
   * Set when fatigue reached 100: the caller must spend this many minutes asleep (`rest`). Time
   * only moves through `TimeSystem.advance`, so this module asks instead of advancing the clock.
   */
  readonly forcedSleepMinutes?: number;
}

export interface VitalsStatus {
  readonly injured: boolean;
  readonly phoneInterference: boolean;
  readonly hallucinating: boolean;
  readonly exhausted: boolean;
  readonly forcedSleep: boolean;
  readonly ending: 'death' | 'madness' | undefined;
}

export type SurvivalErrorCode = 'SURVIVAL_INVALID_STATE';

export class SurvivalError extends Error {
  readonly code: SurvivalErrorCode;

  constructor(code: SurvivalErrorCode, message: string) {
    super(message);
    this.name = 'SurvivalError';
    this.code = code;
  }
}

const bounded = (limit: { min: number; max: number }) => z.int().min(limit.min).max(limit.max);

const vitalsSchema = z.strictObject({
  health: bounded(VITALS_LIMITS.health),
  sanity: bounded(VITALS_LIMITS.sanity),
  fatigue: bounded(VITALS_LIMITS.fatigue),
});

const stateSchema = z.strictObject({
  vitals: vitalsSchema,
  awakeMinutes: z
    .int()
    .min(0)
    .max(AWAKE_FATIGUE_MINUTES - 1),
  restedMinutes: z
    .int()
    .min(0)
    .max(REST_CYCLE - 1),
  trustedTalkDay: z.int().nullable(),
});

function parse<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .map(({ path, message }) => `${path.join('.')}: ${message}`)
      .join('; ');
    throw new SurvivalError('SURVIVAL_INVALID_STATE', `Invalid ${what}: ${details}`);
  }
  return result.data;
}

/** Starting state from the preset's `survival.startVitals`. Out-of-range values are an error. */
export function createVitalsState(start: Vitals): VitalsState {
  return {
    vitals: parse(vitalsSchema, start, 'starting vitals'),
    awakeMinutes: 0,
    restedMinutes: 0,
    trustedTalkDay: null,
  };
}

/** Validates a saved state; throws `SURVIVAL_INVALID_STATE` if it is corrupt. */
export function restoreVitalsState(saved: unknown): VitalsState {
  return parse(stateSchema, saved, 'vitals state');
}

/** The ending the vitals force, if any. Death wins when health and sanity both reach 0. */
export function endingFor(vitals: Vitals): 'death' | 'madness' | undefined {
  if (vitals.health <= VITALS_LIMITS.health.min) return 'death';
  if (vitals.sanity <= VITALS_LIMITS.sanity.min) return 'madness';
  return undefined;
}

export function statusOf(vitals: Vitals): VitalsStatus {
  return {
    injured: vitals.health <= VITALS_THRESHOLDS.injuredHealth,
    phoneInterference: vitals.sanity <= VITALS_THRESHOLDS.phoneInterferenceSanity,
    hallucinating: vitals.sanity <= VITALS_THRESHOLDS.hallucinationSanity,
    exhausted: vitals.fatigue > VITALS_THRESHOLDS.exhaustedFatigue,
    forcedSleep: vitals.fatigue >= VITALS_THRESHOLDS.forcedSleepFatigue,
    ending: endingFor(vitals),
  };
}

const clamp = (value: number, { min, max }: { min: number; max: number }): number =>
  Math.min(max, Math.max(min, value));

function wholeMinutes(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative whole number, got ${String(value)}`);
  }
}

/** Builds the step for new vitals: emits events only when something actually changed. */
function stepTo(state: VitalsState, next: VitalsState, at: GameMinutes, cause: string): VitalsStep {
  const { vitals: before } = state;
  const { vitals: after } = next;
  const events: SurvivalEvent[] = [];
  if (
    before.health !== after.health ||
    before.sanity !== after.sanity ||
    before.fatigue !== after.fatigue
  ) {
    events.push({ type: 'VitalsChanged', at, before, after, cause });
  }
  // Callers return early once the hero is incapacitated, so an ending here is always new.
  const ending = endingFor(after);
  if (ending) events.push({ type: 'PlayerIncapacitated', at, cause: ending });

  const reachedForcedSleep =
    after.fatigue >= VITALS_THRESHOLDS.forcedSleepFatigue &&
    before.fatigue < VITALS_THRESHOLDS.forcedSleepFatigue &&
    !ending;
  return {
    state: next,
    events,
    ...(reachedForcedSleep ? { forcedSleepMinutes: VITALS_THRESHOLDS.forcedSleepMinutes } : {}),
  };
}

const unchanged = (state: VitalsState): VitalsStep => ({ state, events: [] });

/**
 * Applies a one-off change (a find, a medkit, an attack), clamped to the limits. `cause` names it
 * in the event. Once the hero is incapacitated nothing changes any more.
 */
export function applyDelta(
  state: VitalsState,
  delta: VitalsDelta,
  at: GameMinutes,
  cause: string,
): VitalsStep {
  for (const [name, amount] of Object.entries(delta)) {
    if (!Number.isSafeInteger(amount)) throw new RangeError(`${name} delta must be a whole number`);
  }
  if (endingFor(state.vitals)) return unchanged(state);
  const { vitals } = state;
  const next: VitalsState = {
    ...state,
    vitals: {
      health: clamp(vitals.health + (delta.health ?? 0), VITALS_LIMITS.health),
      sanity: clamp(vitals.sanity + (delta.sanity ?? 0), VITALS_LIMITS.sanity),
      fatigue: clamp(vitals.fatigue + (delta.fatigue ?? 0), VITALS_LIMITS.fatigue),
    },
  };
  return stepTo(state, next, at, cause);
}

/**
 * `minutes` of time passing while the hero is awake (every action except rest): +10 fatigue per
 * hour. `at` is the game minute at the end of the span. May ask for forced sleep.
 */
export function tickAwake(state: VitalsState, minutes: number, at: GameMinutes): VitalsStep {
  wholeMinutes(minutes, 'minutes');
  if (endingFor(state.vitals) || minutes === 0) return unchanged(state);
  const total = state.awakeMinutes + (minutes % AWAKE_FATIGUE_MINUTES);
  const gain = Math.floor(minutes / AWAKE_FATIGUE_MINUTES) + Math.floor(total / AWAKE_FATIGUE_MINUTES);
  const next: VitalsState = {
    ...state,
    vitals: { ...state.vitals, fatigue: clamp(state.vitals.fatigue + gain, VITALS_LIMITS.fatigue) },
    awakeMinutes: total % AWAKE_FATIGUE_MINUTES,
  };
  return stepTo(state, next, at, 'awake');
}

/**
 * `minutes` of rest: fatigue -30 per hour, sanity +1 per 2 hours, health +1 per 4 hours. Partial
 * rest is proportional and carried over, so it does not matter how a rest is split. `at` is the
 * game minute at the end of the span.
 */
export function rest(state: VitalsState, minutes: number, at: GameMinutes): VitalsStep {
  wholeMinutes(minutes, 'minutes');
  if (endingFor(state.vitals) || minutes === 0) return unchanged(state);
  const before = state.restedMinutes;
  const after = before + (minutes % REST_CYCLE);
  const gained = (period: number): number =>
    Math.floor(minutes / REST_CYCLE) * (REST_CYCLE / period) +
    Math.floor(after / period) - Math.floor(before / period);
  const { vitals } = state;
  const next: VitalsState = {
    ...state,
    vitals: {
      health: clamp(vitals.health + gained(REST_HEALTH_MINUTES), VITALS_LIMITS.health),
      sanity: clamp(vitals.sanity + gained(REST_SANITY_MINUTES), VITALS_LIMITS.sanity),
      fatigue: clamp(vitals.fatigue - gained(REST_FATIGUE_MINUTES), VITALS_LIMITS.fatigue),
    },
    restedMinutes: after % REST_CYCLE,
  };
  return stepTo(state, next, at, 'rest');
}

/**
 * A conversation with a trusted character: sanity +1, but only once per game day. The day comes
 * from `calendar` and `at` here, not from the caller, so the limit cannot be bypassed by passing
 * a wrong day. The day's use is spent only when sanity actually rises: at full sanity the talk
 * changes nothing and the bonus stays available. Returns the same state when refused.
 */
export function trustedTalk(state: VitalsState, at: GameMinutes, calendar: Calendar): VitalsStep {
  const day = calendar.toDisplay(at).day;
  if (state.trustedTalkDay === day) return unchanged(state);
  const step = applyDelta(state, VITALS_DELTAS.trustedTalk, at, 'trustedTalk');
  if (step.state.vitals.sanity === state.vitals.sanity) return step;
  return { ...step, state: { ...step.state, trustedTalkDay: day } };
}

const CONVERSATIONS: readonly ActionKind[] = ['talk', 'interrogate', 'call'];

/**
 * Cost modifiers for `resolveActionCost` (TIME-004), only those that apply right now.
 * Multipliers run first (fatigue, injury, darkness) and the flat sanity surcharge last, so the
 * extra minutes are not inflated by the multipliers; the order is fixed by `order`.
 *
 * `darkWithoutLight` is for the caller to compute (dark location, no working flashlight): this
 * module knows neither lighting nor inventory.
 */
export function costModifiers(
  vitals: Vitals,
  options: { readonly darkWithoutLight?: boolean } = {},
): CostModifier[] {
  const status = statusOf(vitals);
  const modifiers: CostModifier[] = [];
  if (status.exhausted) {
    modifiers.push({ id: 'fatigue', order: 10, apply: (minutes) => minutes * 1.25 });
  }
  if (status.injured) {
    modifiers.push({
      id: 'injury',
      order: 20,
      apply: (minutes, action) => (action === 'move' ? minutes * 1.5 : minutes),
    });
  }
  if (options.darkWithoutLight) {
    modifiers.push({
      id: 'darkness',
      order: 30,
      apply: (minutes, action) => (action === 'move' ? minutes * 1.5 : minutes),
    });
  }
  if (status.hallucinating) {
    modifiers.push({
      id: 'sanity',
      order: 40,
      apply: (minutes, action) => (CONVERSATIONS.includes(action) ? minutes + 5 : minutes),
    });
  }
  return modifiers;
}
