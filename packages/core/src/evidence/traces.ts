import type { z } from 'zod';
import { hashId, type GameMinutes } from '../common/index.ts';
import { traceRulesSchema } from '../content/index.ts';
import type { EventId, TruthEvent } from '../truth/index.ts';
import type { ItemRegistry } from '../world/index.ts';

export type TraceRule = z.infer<typeof traceRulesSchema>[number];
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

export class EvidenceError extends Error {
  constructor(
    readonly code: 'EVIDENCE_RULE_INVALID',
    readonly path: string,
    message: string,
  ) {
    super(`${code} at ${path}: ${message}`);
    this.name = 'EvidenceError';
  }
}

// `$location` is the only placeholder documented for `at` (scenario-presets.md §5).
// Other placeholders are rejected until their meaning is defined (OQ-17).
const LOCATION_VARIABLES = new Set(['$location']);

function freezeTree<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
}

/** Validated trace rules; rule order defines the order of produced traces. */
export class TraceRuleSet {
  private constructor(readonly rules: readonly TraceRule[]) {
    Object.freeze(this);
  }

  /** Validates content data; schema and placeholder errors raise `EVIDENCE_RULE_INVALID`. */
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

    parsed.data.forEach((rule, row) => {
      rule.produces.forEach(({ at }, entry) => {
        if (at.startsWith('$') && !LOCATION_VARIABLES.has(at)) {
          throw new EvidenceError(
            'EVIDENCE_RULE_INVALID',
            `traceRules.${row}.produces.${entry}.at`,
            `Unsupported location placeholder "${at}"`,
          );
        }
      });
    });

    return new TraceRuleSet(freezeTree(parsed.data));
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
  const availableFrom = event.t + event.duration;
  const traces: Trace[] = [];

  rules.rules.forEach((rule, row) => {
    if (!matches(rule, event, items)) return;
    rule.produces.forEach((spec, entry) => {
      traces.push({
        id: traceId(event.id, row, entry),
        kind: spec.kind,
        sourceEventId: event.id,
        location: spec.at === '$location' ? event.location : spec.at,
        availableFrom,
        ...(typeof spec.decaysAfter === 'number' && { decaysAt: availableFrom + spec.decaysAfter }),
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
  const events = [...truth.events()].sort((a, b) => a.t - b.t || compareEventIds(a.id, b.id));
  return events.flatMap((event) => tracesForEvent(event, rules, items));
}
