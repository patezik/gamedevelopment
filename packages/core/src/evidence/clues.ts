import { hashId, type GameMinutes } from '../common/index.ts';
import type { EventId } from '../truth/index.ts';
import type { Trace, TraceCaptureMode, TraceId } from './traces.ts';

export type DiscoveryAction =
  | { readonly type: 'examineHotspot'; readonly hotspotId: string }
  | { readonly type: 'read'; readonly documentId: string };

export type DiscoveryRequirement = {
  readonly kind: 'item' | 'password' | 'contact' | 'clue';
  readonly id: string;
};

export interface ClueRule {
  readonly locationId?: string;
  readonly action: DiscoveryAction;
  readonly requires?: readonly DiscoveryRequirement[];
  readonly presentation?: string;
}

export type ClueRules = ReadonlyMap<string, ClueRule>;

export interface DiscoveryCondition {
  readonly locationId: string;
  readonly action: DiscoveryAction;
  readonly requires: readonly DiscoveryRequirement[];
  readonly availableFrom: GameMinutes;
  readonly availableUntil?: GameMinutes;
}

export interface Clue {
  readonly id: string;
  readonly traceId: TraceId;
  readonly sourceEventId: EventId;
  readonly supports: readonly string[];
  readonly discovery: DiscoveryCondition;
  readonly captureMode: TraceCaptureMode;
  readonly presentation: string;
}

export interface DiscoveryContext {
  readonly locationId: string;
  readonly action: DiscoveryAction;
  readonly minute: GameMinutes;
  readonly has: (requirement: DiscoveryRequirement) => boolean;
}

function actionTarget(action: DiscoveryAction): string {
  return action.type === 'examineHotspot' ? action.hotspotId : action.documentId;
}

export function discoverable(clue: Clue, context: DiscoveryContext): boolean {
  const condition = clue.discovery;
  return (
    condition.locationId === context.locationId &&
    condition.action.type === context.action.type &&
    actionTarget(condition.action) === actionTarget(context.action) &&
    condition.availableFrom <= context.minute &&
    (condition.availableUntil === undefined || context.minute < condition.availableUntil) &&
    condition.requires.every(context.has)
  );
}

/** Clue prerequisites form a directed graph within the generated case. */
export function validateCluePrerequisites(clues: readonly Clue[]): void {
  const byId = new Map(clues.map((clue) => [clue.id, clue]));
  const visiting = new Set<string>();
  const complete = new Set<string>();

  function visit(id: string): void {
    if (complete.has(id)) return;
    if (visiting.has(id)) throw new Error(`Circular clue prerequisite: ${id}`);
    const clue = byId.get(id);
    if (!clue) throw new Error(`Unknown clue prerequisite: ${id}`);

    visiting.add(id);
    for (const requirement of clue.discovery.requires) {
      if (requirement.kind === 'clue') visit(requirement.id);
    }
    visiting.delete(id);
    complete.add(id);
  }

  for (const clue of clues) visit(clue.id);
}

export function deriveClues(traces: readonly Trace[], rules: ClueRules): Clue[] {
  const clues: Clue[] = [];
  for (const trace of traces) {
    const rule = rules.get(trace.template);
    if (!rule) continue;
    const locationId = rule.locationId ?? trace.location;
    if (!locationId) throw new Error(`Clue rule requires a location: ${trace.template}`);
    const availableUntil = Math.min(trace.decaysAt ?? Infinity, trace.destroyedAt ?? Infinity);

    clues.push({
      id: hashId('cl', trace.id, 12),
      traceId: trace.id,
      sourceEventId: trace.sourceEventId,
      supports: [...trace.supports],
      discovery: {
        locationId,
        action: structuredClone(rule.action),
        requires: structuredClone(rule.requires ?? []),
        availableFrom: trace.availableFrom,
        ...(Number.isFinite(availableUntil) ? { availableUntil } : {}),
      },
      captureMode: trace.captureMode,
      presentation: rule.presentation ?? trace.template,
    });
  }
  validateCluePrerequisites(clues);
  return clues;
}
