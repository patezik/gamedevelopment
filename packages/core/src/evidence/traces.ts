import type { z } from 'zod';
import { hashId, type GameMinutes } from '../common/index.ts';
import { traceRulesSchema } from '../content/index.ts';
import type { EventId, TruthEvent } from '../truth/index.ts';
import type { ItemRegistry } from '../world/index.ts';

type DeepReadonly<T> = T extends (infer E)[]
  ? readonly DeepReadonly<E>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** A compiled rule: content data validated by `traceRulesSchema` and frozen. */
export type TraceRule = DeepReadonly<z.infer<typeof traceRulesSchema>[number]>;
export type TraceSpec = TraceRule['produces'][number];
export type TraceKind = TraceSpec['kind'];
export type TraceId = string;

export interface Trace {
  readonly id: TraceId;
  readonly kind: TraceKind;
  readonly sourceEventId: EventId;
  readonly location?: string;
  readonly itemId?: string;
  readonly availableFrom: GameMinutes;
  readonly decaysAt?: GameMinutes;
  readonly destroyedBy?: EventId;
}

/** Item tags are the only world data that rule conditions read. */
export type ItemTagSource = Pick<ItemRegistry, 'get'>;

export interface TruthEventSource {
  events(): readonly TruthEvent[];
}

// Fields are declared explicitly: Node type stripping does not support parameter properties.
export class EvidenceError extends Error {
  readonly code: 'EVIDENCE_RULE_INVALID';
  readonly path: string;

  constructor(code: 'EVIDENCE_RULE_INVALID', path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = 'EvidenceError';
    this.code = code;
    this.path = path;
  }
}

function freezeTree<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validated trace rules; rule order defines the order of produced traces. The private field makes
 * the class nominal, so a plain `{ rules }` object is rejected by the compiler and at runtime.
 */
export class TraceRuleSet {
  readonly #rules: readonly TraceRule[];

  private constructor(rules: readonly TraceRule[]) {
    this.#rules = rules;
    Object.freeze(this);
  }

  get rules(): readonly TraceRule[] {
    return this.#rules;
  }

  /**
   * Validates content data with `traceRulesSchema`, the schema the content loader uses, so both
   * accept the same verbs and `at` placeholders. Violations raise `EVIDENCE_RULE_INVALID`.
   */
  static compile(input: unknown): TraceRuleSet {
    const parsed = traceRulesSchema.safeParse(input);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      const path = issue?.path.length ? `traceRules.${issue.path.join('.')}` : 'traceRules';
      throw new EvidenceError(
        'EVIDENCE_RULE_INVALID',
        path,
        issue?.message ?? 'Invalid trace rules',
      );
    }
    return new TraceRuleSet(freezeTree(parsed.data));
  }

  static assertCompiled(value: unknown): asserts value is TraceRuleSet {
    if (typeof value !== 'object' || value === null || !(#rules in value)) {
      throw new EvidenceError(
        'EVIDENCE_RULE_INVALID',
        'traceRules',
        'Expected rules returned by compileTraceRules',
      );
    }
  }
}

export function compileTraceRules(input: unknown): TraceRuleSet {
  return TraceRuleSet.compile(input);
}

function matches(rule: TraceRule, event: TruthEvent, items: ItemTagSource): boolean {
  if (rule.verb !== event.verb) return false;
  const { itemId, targetTag } = rule.when ?? {};
  if (itemId === undefined && targetTag === undefined) return true;

  // Both conditions describe the same target item; `when` refers to items.json ids (OQ-17).
  return event.targets.some(
    (target) =>
      target.kind === 'item' &&
      (itemId === undefined || target.id === itemId) &&
      (targetTag === undefined || items.get(target.id).tags.includes(targetTag)),
  );
}

/**
 * Inputs are safe integers (TruthLog and content schemas), but their sum may not be. There is no
 * domain error code for event time, so a RangeError reports the event instead of a wrong trace.
 */
function safeMinute(minute: number, eventId: EventId, field: 'availableFrom' | 'decaysAt'): number {
  if (!Number.isSafeInteger(minute)) {
    throw new RangeError(`Trace ${field} of ${eventId} is outside the safe integer range`);
  }
  return minute;
}

function traceId(sourceEventId: EventId, rule: number, spec: number): TraceId {
  // A hash keeps truth event order and rule positions out of ids that may reach clue records.
  return hashId('tr', { sourceEventId, rule, spec }, 16);
}

/**
 * Traces of one truth event: each matching rule fires once and yields one trace per `produces` entry.
 * Interpreted fields: `kind`, `at`, `decaysAfter`. `template`, `supports`, `captureMode` and
 * `requires` are not represented in `Trace` yet (OQ-15).
 */
export function tracesForEvent(
  event: TruthEvent,
  rules: TraceRuleSet,
  items: ItemTagSource,
): Trace[] {
  // A trace is a consequence of its event, and consequences start once the event ends
  // (truth invariant 3: `cause.t + cause.duration <= effect.t`). Provisional, see OQ-16.
  TraceRuleSet.assertCompiled(rules);
  const availableFrom = safeMinute(event.t + event.duration, event.id, 'availableFrom');
  const traces: Trace[] = [];

  rules.rules.forEach((rule, row) => {
    if (!matches(rule, event, items)) return;
    rule.produces.forEach((spec, entry) => {
      const decaysAt =
        typeof spec.decaysAfter === 'number'
          ? safeMinute(availableFrom + spec.decaysAfter, event.id, 'decaysAt')
          : undefined;
      traces.push({
        id: traceId(event.id, row, entry),
        kind: spec.kind,
        sourceEventId: event.id,
        location: spec.at === '$location' ? event.location : spec.at,
        availableFrom,
        ...(decaysAt !== undefined && { decaysAt }),
      });
    });
  });
  return traces;
}

function compareEventIds(a: EventId, b: EventId): number {
  return a.length - b.length || (a < b ? -1 : Number(a > b));
}

/** Traces of a whole truth log in chronological event order. The log itself is not modified. */
export function deriveTraces(
  truth: TruthEventSource,
  rules: TraceRuleSet,
  items: ItemTagSource,
): Trace[] {
  TraceRuleSet.assertCompiled(rules);
  const events = [...truth.events()].sort((a, b) => a.t - b.t || compareEventIds(a.id, b.id));
  return events.flatMap((event) => tracesForEvent(event, rules, items));
}
