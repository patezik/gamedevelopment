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
/** `direct` in content becomes `auto`, the capture mode of `Clue` (ADR 0017). */
export type TraceCaptureMode = 'auto' | 'qr';

/** Concealment verbs: each needs an unconditional rule with a secondary trace (ADR 0017). */
export const CONCEALMENT_VERBS: readonly string[] = Object.freeze(['hide', 'destroy', 'stage']);
/** Placeholders a `supports` entry may use; they are bound when the trace is derived. */
export const SUPPORT_PLACEHOLDERS: readonly string[] = Object.freeze(['$actor', '$location', '$t']);
const DESTROY_VERB = 'destroy';

export interface Trace {
  readonly id: TraceId;
  readonly kind: TraceKind;
  readonly sourceEventId: EventId;
  readonly template: string;
  /** Claim references with `$actor`, `$location` and `$t` bound to the source event. */
  readonly supports: readonly string[];
  readonly captureMode: TraceCaptureMode;
  readonly location?: string;
  /** Carrier item: `requires.itemId`, otherwise the item target the rule matched. */
  readonly itemId?: string;
  /** The trace exists on `[availableFrom, min(decaysAt, destroyedAt))`. */
  readonly availableFrom: GameMinutes;
  readonly decaysAt?: GameMinutes;
  /** The `destroy` event that removed the carrier while the trace existed, and when it ended. */
  readonly destroyedBy?: EventId;
  readonly destroyedAt?: GameMinutes;
}

/** Item tags and existence are the only world data the rules read. */
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

function isUnconditional(rule: TraceRule): boolean {
  return rule.when?.itemId === undefined && rule.when?.targetTag === undefined;
}

const PLACEHOLDER_TOKEN = /\$[A-Za-z_][A-Za-z0-9_]*/g;

function assertSupports(rules: readonly TraceRule[]): void {
  rules.forEach((rule, row) =>
    rule.produces.forEach((spec, entry) =>
      spec.supports.forEach((support, index) => {
        const unknown = support
          .match(PLACEHOLDER_TOKEN)
          ?.find((token) => !SUPPORT_PLACEHOLDERS.includes(token));
        if (unknown !== undefined) {
          throw new EvidenceError(
            'EVIDENCE_RULE_INVALID',
            `traceRules.${row}.produces.${entry}.supports.${index}`,
            `Unknown placeholder ${unknown}; expected one of: ${SUPPORT_PLACEHOLDERS.join(', ')}`,
          );
        }
      }),
    ),
  );
}

/**
 * Conservation of evidence: concealment always leaves a secondary trace. A rule with `when` may
 * miss the concealed item, and a trace with `requires` may lack its carrier, so only an
 * unconditional rule with an entry without `requires` guarantees one.
 */
function assertConservation(rules: readonly TraceRule[]): void {
  for (const verb of CONCEALMENT_VERBS) {
    const conserved = rules.some(
      (rule) =>
        rule.verb === verb &&
        isUnconditional(rule) &&
        rule.produces.some(({ requires }) => requires === undefined),
    );
    if (!conserved) {
      throw new EvidenceError(
        'EVIDENCE_RULE_INVALID',
        'traceRules',
        `Concealment verb "${verb}" needs a rule without "when" producing a trace without "requires"`,
      );
    }
  }
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
   * Validates content data with `traceRulesSchema`, the schema the content loader uses, then the
   * `supports` placeholders and the conservation law. Violations raise `EVIDENCE_RULE_INVALID`.
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
    assertSupports(parsed.data);
    assertConservation(parsed.data);
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

const NO_MATCH = Symbol('no match');

/**
 * The item target a rule fires on: the first one satisfying every `when` condition (OQ-17), or
 * the first item target of an unconditional rule (`undefined` if the event has none).
 */
function matchedItem(
  rule: TraceRule,
  event: TruthEvent,
  items: ItemTagSource,
): string | undefined | typeof NO_MATCH {
  if (rule.verb !== event.verb) return NO_MATCH;
  const { itemId, targetTag } = rule.when ?? {};
  const target = event.targets.find(
    (candidate) =>
      candidate.kind === 'item' &&
      (itemId === undefined || candidate.id === itemId) &&
      (targetTag === undefined || items.get(candidate.id).tags.includes(targetTag)),
  );
  if (target !== undefined) return target.id;
  return isUnconditional(rule) ? undefined : NO_MATCH;
}

/**
 * Inputs are safe integers (TruthLog and content schemas), but their sum may not be. There is no
 * domain error code for event time, so a RangeError reports the event instead of a wrong trace.
 */
function safeMinute(
  minute: number,
  eventId: EventId,
  field: 'availableFrom' | 'decaysAt' | 'destroyedAt',
): number {
  if (!Number.isSafeInteger(minute)) {
    throw new RangeError(`Trace ${field} of ${eventId} is outside the safe integer range`);
  }
  return minute;
}

function traceId(sourceEventId: EventId, rule: number, spec: number): TraceId {
  // A hash keeps truth event order and rule positions out of ids that may reach clue records.
  return hashId('tr', { sourceEventId, rule, spec }, 16);
}

function compareEvents(a: TruthEvent, b: TruthEvent): number {
  return a.t - b.t || a.id.length - b.id.length || (a.id < b.id ? -1 : Number(a.id > b.id));
}

interface Destruction {
  readonly eventId: EventId;
  readonly at: GameMinutes;
}

/**
 * The first destruction of every item: a `destroy` event destroys its first item target once the
 * event ends. Later `destroy` events of the same item are ignored, so a carrier is destroyed once.
 */
function destructionsOf(events: readonly TruthEvent[]): ReadonlyMap<string, Destruction> {
  const destructions = new Map<string, Destruction>();
  for (const event of [...events].sort(compareEvents)) {
    if (event.verb !== DESTROY_VERB) continue;
    const target = event.targets.find(({ kind }) => kind === 'item');
    if (target === undefined) continue;
    const at = safeMinute(event.t + event.duration, event.id, 'destroyedAt');
    const known = destructions.get(target.id);
    if (known === undefined || at < known.at)
      destructions.set(target.id, { eventId: event.id, at });
  }
  return destructions;
}

function itemExists(items: ItemTagSource, itemId: string): boolean {
  try {
    items.get(itemId);
    return true;
  } catch (error) {
    // Duck typing keeps `world` a type-only import of this module.
    if ((error as { code?: unknown } | null)?.code === 'WORLD_UNKNOWN_ITEM') return false;
    throw error;
  }
}

const BOUND_PLACEHOLDER = /\$(actor|location|t)(?![A-Za-z0-9_])/g;

/**
 * Binds `$location` and `$t` (the event start) and expands an entry with `$actor` once per
 * distinct actor; without actors such an entry is dropped instead of keeping a placeholder.
 */
function bindSupports(supports: readonly string[], event: TruthEvent): string[] {
  const actors = [...new Set(event.actorIds)];
  const bound = supports.flatMap((support) =>
    (support.includes('$actor') ? actors : ['']).map((actor) =>
      support.replace(BOUND_PLACEHOLDER, (_, name: string) =>
        name === 'actor' ? actor : name === 'location' ? event.location : String(event.t),
      ),
    ),
  );
  return [...new Set(bound)];
}

function eventTraces(
  event: TruthEvent,
  rules: TraceRuleSet,
  items: ItemTagSource,
  destructions: ReadonlyMap<string, Destruction>,
): Trace[] {
  // A trace is a consequence of its event, and consequences start once the event ends
  // (truth invariant 3: `cause.t + cause.duration <= effect.t`).
  const availableFrom = safeMinute(event.t + event.duration, event.id, 'availableFrom');
  const traces: Trace[] = [];

  rules.rules.forEach((rule, row) => {
    const target = matchedItem(rule, event, items);
    if (target === NO_MATCH) return;
    rule.produces.forEach((spec, entry) => {
      const carrier = spec.requires?.itemId;
      const itemId = carrier ?? target;
      const destruction = itemId === undefined ? undefined : destructions.get(itemId);
      if (carrier !== undefined) {
        // The carrier must exist in this world and survive until the trace appears.
        if (!itemExists(items, carrier)) return;
        if (destruction !== undefined && destruction.at <= availableFrom) return;
      }
      const decaysAt =
        typeof spec.decaysAfter === 'number'
          ? safeMinute(availableFrom + spec.decaysAfter, event.id, 'decaysAt')
          : undefined;
      // Only a destruction inside the trace lifetime is recorded. Traces of a `destroy` event
      // start when it ends, so the event never destroys its own secondary traces.
      const destroyed =
        destruction !== undefined &&
        availableFrom < destruction.at &&
        (decaysAt === undefined || destruction.at < decaysAt)
          ? destruction
          : undefined;
      traces.push({
        id: traceId(event.id, row, entry),
        kind: spec.kind,
        sourceEventId: event.id,
        template: spec.template,
        supports: bindSupports(spec.supports, event),
        captureMode: spec.captureMode === 'qr' ? 'qr' : 'auto',
        location: spec.at === '$location' ? event.location : spec.at,
        ...(itemId !== undefined && { itemId }),
        availableFrom,
        ...(decaysAt !== undefined && { decaysAt }),
        ...(destroyed && { destroyedBy: destroyed.eventId, destroyedAt: destroyed.at }),
      });
    });
  });
  return traces;
}

/**
 * Traces of one truth event: each matching rule fires once and yields at most one trace per
 * `produces` entry. Destruction (`requires`, `destroyedBy`) is evaluated against the `destroy`
 * events of `truth` when it is given; without it no carrier counts as destroyed.
 */
export function tracesForEvent(
  event: TruthEvent,
  rules: TraceRuleSet,
  items: ItemTagSource,
  truth?: TruthEventSource,
): Trace[] {
  TraceRuleSet.assertCompiled(rules);
  return eventTraces(event, rules, items, truth ? destructionsOf(truth.events()) : new Map());
}

/** Traces of a whole truth log in chronological event order. The log itself is not modified. */
export function deriveTraces(
  truth: TruthEventSource,
  rules: TraceRuleSet,
  items: ItemTagSource,
): Trace[] {
  TraceRuleSet.assertCompiled(rules);
  const events = [...truth.events()].sort(compareEvents);
  const destructions = destructionsOf(events);
  return events.flatMap((event) => eventTraces(event, rules, items, destructions));
}

/** Whether the trace exists at minute `t`; every bound is half-open like `Interval`. */
export function isTraceAvailable(trace: Trace, t: GameMinutes): boolean {
  const end = Math.min(trace.decaysAt ?? Infinity, trace.destroyedAt ?? Infinity);
  return trace.availableFrom <= t && t < end;
}
