import { z } from 'zod';

/** Actions that cost game time: docs/game-design/game-design.md section 2. */
export const ACTION_KINDS = [
  'move',
  'examineLocation',
  'examineHotspot',
  'captureEvidence',
  'talk',
  'interrogate',
  'call',
  'message',
  'read',
  'pickLock',
  'useItem',
  'rest',
  'wait',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export type ActionCostErrorCode = 'ACTION_INVALID' | 'COST_TABLE_INVALID';

export class ActionCostError extends Error {
  readonly code: ActionCostErrorCode;

  constructor(code: ActionCostErrorCode, message: string) {
    super(message);
    this.name = 'ActionCostError';
    this.code = code;
  }
}

const minutes = z.int().nonnegative();

/**
 * One action's cost, in the shapes used by time-system.md section 3:
 * - `{ base: 15 }` fixed; `{ base: "graph" }` route time from the location graph;
 * - `{ base: 5, plus: "conversation" }` plus the length of the conversation;
 * - `{ base: 20, onFail: 10 }` +`onFail` minutes if the check fails (a range, not a surprise);
 * - `{ choices: [60, 120, 240] }` the player picks one; `{ range: [15, 120], step: 15 }` likewise.
 */
const costRuleSchema = z.union([
  z.strictObject({ base: z.literal('graph') }),
  z.strictObject({
    base: minutes,
    plus: z.literal('conversation').optional(),
    onFail: minutes.optional(),
  }),
  z
    .strictObject({ choices: z.array(minutes).min(1) })
    .refine(
      ({ choices }) => choices.every((value, i) => i === 0 || value > (choices[i - 1] ?? 0)),
      {
        message: 'choices must be strictly ascending',
      },
    ),
  z
    .strictObject({ range: z.tuple([minutes, minutes]), step: z.int().positive() })
    .refine(({ range: [from, to], step }) => from <= to && (to - from) % step === 0, {
      message: 'range must satisfy from <= to and be reachable from `from` in whole steps',
    }),
]);
export type CostRule = z.infer<typeof costRuleSchema>;

export type ActionCostTable = Readonly<Record<ActionKind, CostRule>>;

const overridesSchema = z.strictObject(
  Object.fromEntries(ACTION_KINDS.map((kind) => [kind, costRuleSchema.optional()])) as Record<
    ActionKind,
    z.ZodOptional<typeof costRuleSchema>
  >,
);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Core defaults; a preset overrides individual actions via {@link createActionCostTable}. */
export const DEFAULT_ACTION_COSTS: ActionCostTable = deepFreeze({
  move: { base: 'graph' },
  examineLocation: { base: 15 },
  examineHotspot: { base: 5 },
  captureEvidence: { base: 2 },
  talk: { base: 10 },
  interrogate: { base: 20 },
  call: { base: 5, plus: 'conversation' },
  message: { base: 2 },
  read: { base: 10 },
  pickLock: { base: 20, onFail: 10 },
  useItem: { base: 5 },
  rest: { choices: [60, 120, 240] },
  wait: { range: [15, 120], step: 15 },
} satisfies Record<ActionKind, CostRule>);

/**
 * Core defaults with a preset's per-action overrides applied. Unknown actions and malformed
 * rules throw `COST_TABLE_INVALID`. The result is frozen and independent of its input.
 */
export function createActionCostTable(overrides: unknown = {}): ActionCostTable {
  const parsed = overridesSchema.safeParse(overrides);
  if (!parsed.success) {
    throw new ActionCostError(
      'COST_TABLE_INVALID',
      parsed.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join('; '),
    );
  }
  const defined = Object.entries(parsed.data).filter(([, rule]) => rule !== undefined);
  return deepFreeze(structuredClone({ ...DEFAULT_ACTION_COSTS, ...Object.fromEntries(defined) }));
}

/**
 * Route time between two locations. Structurally satisfied by `LocationGraph`; declared here
 * because `time` sits below `world` and must not import it. To route for a specific actor, wrap:
 * `{ travelTime: (from, to) => graph.travelTime(from, to, actor) }`.
 */
export interface TravelTimeProvider {
  travelTime(from: string, to: string): number | null;
}

/** Adjusts a cost, e.g. fatigue, darkness, injury, low sanity (SURV-001 supplies the real ones). */
export interface CostModifier {
  readonly id: string;
  /**
   * Lower runs first. Multipliers and additions do not commute, so the order is part of the
   * contract; ties are broken by `id`, so the result never depends on array order.
   */
  readonly order: number;
  /** Receives and returns fractional minutes; rounding happens once, after the last modifier. */
  apply(minutes: number, action: ActionKind, ctx: CostContext): number;
}

export interface CostContext {
  /** Required for `move`. */
  readonly travel?: {
    readonly provider: TravelTimeProvider;
    readonly from: string;
    readonly to: string;
  };
  /** The player's chosen duration; only for actions with `choices` or `range` (rest, wait). */
  readonly minutes?: number;
  /** Length of the conversation, for rules with `plus: "conversation"` (call). Default 0. */
  readonly conversationMinutes?: number;
  readonly modifiers?: readonly CostModifier[];
}

/** Whole minutes. `min`/`max` bound what can be charged; `expected` is the no-surprise cost. */
export interface ActionCost {
  readonly min: number;
  readonly max: number;
  readonly expected: number;
}

const invalid = (message: string): ActionCostError =>
  new ActionCostError('ACTION_INVALID', message);

function wholeMinutes(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${name} must be a non-negative whole number of minutes, got ${String(value)}`);
  }
  return value;
}

/** Cost before modifiers. */
function baseCost(action: ActionKind, rule: CostRule, ctx: CostContext): ActionCost {
  const fixed = (value: number): ActionCost => ({ min: value, max: value, expected: value });

  if ('choices' in rule) {
    if (ctx.minutes === undefined) {
      const first = rule.choices[0] ?? 0;
      return { min: first, expected: first, max: rule.choices.at(-1) ?? first };
    }
    if (!rule.choices.includes(ctx.minutes)) {
      throw invalid(
        `${action} lasts ${rule.choices.join(', ')} minutes, not ${String(ctx.minutes)}`,
      );
    }
    return fixed(ctx.minutes);
  }

  if ('range' in rule) {
    const [from, to] = rule.range;
    if (ctx.minutes === undefined) return { min: from, expected: from, max: to };
    const chosen = wholeMinutes(ctx.minutes, 'minutes');
    if (chosen < from || chosen > to || (chosen - from) % rule.step !== 0) {
      throw invalid(
        `${action} lasts ${from} to ${to} minutes in steps of ${rule.step}, not ${chosen}`,
      );
    }
    return fixed(chosen);
  }

  if (ctx.minutes !== undefined) throw invalid(`${action} does not take a chosen duration`);

  if (rule.base === 'graph') {
    if (!ctx.travel) throw invalid(`${action} needs ctx.travel to look up the route time`);
    const { provider, from, to } = ctx.travel;
    const route = provider.travelTime(from, to);
    if (route === null) throw invalid(`No route from ${from} to ${to}`);
    return fixed(wholeMinutes(route, 'route time'));
  }

  const conversation =
    rule.plus === 'conversation'
      ? wholeMinutes(ctx.conversationMinutes ?? 0, 'conversationMinutes')
      : 0;
  const expected = rule.base + conversation;
  return { min: expected, expected, max: expected + (rule.onFail ?? 0) };
}

const byOrderThenId = (a: CostModifier, b: CostModifier): number =>
  a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Rounds to whole minutes; the 1e-6 pass keeps 11.499999999999998 (10 x 1.15) from rounding to 11. */
function roundMinutes(value: number): number {
  return Math.max(0, Math.round(Math.round(value * 1e6) / 1e6));
}

/**
 * Cost of an action in whole game minutes, as shown to the player before they confirm.
 * Unknown actions, missing context and durations the rule does not allow throw `ACTION_INVALID`.
 * Modifiers run in `(order, id)` order on the exact base cost and the result is rounded once;
 * it is never negative.
 */
export function resolveActionCost(
  action: ActionKind,
  ctx: CostContext = {},
  table: ActionCostTable = DEFAULT_ACTION_COSTS,
): ActionCost {
  if (typeof action !== 'string' || !Object.hasOwn(table, action)) {
    throw invalid(`Unknown action "${String(action)}"`);
  }
  const base = baseCost(action, table[action], ctx);
  const modifiers = [...(ctx.modifiers ?? [])].sort(byOrderThenId);

  const adjust = (value: number): number =>
    roundMinutes(
      modifiers.reduce((minutes, modifier) => {
        const next = modifier.apply(minutes, action, ctx);
        if (!Number.isFinite(next)) {
          throw new RangeError(`Cost modifier "${modifier.id}" returned ${String(next)}`);
        }
        return next;
      }, value),
    );

  // A well-behaved modifier is monotonic, but never return an inconsistent range if one is not.
  const [low, mid, high] = [adjust(base.min), adjust(base.expected), adjust(base.max)];
  const min = Math.min(low, mid, high);
  const max = Math.max(low, mid, high);
  return { min, max, expected: Math.min(Math.max(mid, min), max) };
}
