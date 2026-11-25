import {
  compileTraceRules,
  deriveClues,
  deriveTraces,
  distributeCaptureModes,
  type Clue,
  type ClueRule,
  type Trace,
} from '@hs/core/evidence';
import { GenerationRejection, type Stage } from '../pipeline/index.ts';
import type { HistoryWorld } from './history-sim.ts';

/** A key event of the incident left no discoverable clue. */
export const EVIDENCE_KEY_EVENT_UNCOVERED = 'EVIDENCE_KEY_EVENT_UNCOVERED';

export interface EvidenceWorld extends HistoryWorld {
  /** Every trace the truth log leaves (testimonial ones feed TestimonyGen). */
  readonly traces: readonly Trace[];
  /** Discoverable clues of the physical, document and digital traces, with `captureMode` set. */
  readonly clues: readonly Clue[];
  /** Clues of the incident's key events: the set the investigation must be solvable from. */
  readonly requiredClueIds: readonly string[];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

/**
 * Clue rule of a trace template: a document is read, anything else is a hotspot of the trace
 * location. Both use the template as the target ID. Testimonial traces get no rule.
 */
export function ruleFor(trace: Trace): ClueRule | undefined {
  if (trace.kind === 'testimonial') return undefined;
  return {
    action:
      trace.kind === 'document'
        ? { type: 'read', documentId: trace.template }
        : { type: 'examineHotspot', hotspotId: trace.template },
  };
}

/**
 * EvidenceGen: applies the scenario trace rules to the backstory log (EVD-001), turns the
 * traces into clues (EVD-002) and raises the share of required clues captured by QR to the
 * preset's `phone.minQrShare` (EVD-003). Needs no randomness beyond the capture distribution.
 */
export const evidenceGen: Stage<HistoryWorld, EvidenceWorld> = {
  name: 'EvidenceGen',
  generate(input, { rng, content }) {
    const rules = compileTraceRules(content.traceRules);
    const traces = deriveTraces(input.truth, rules, input.worldState.items);
    const clueRules = new Map<string, ClueRule>();
    for (const trace of traces) {
      const rule = ruleFor(trace);
      if (rule && !clueRules.has(trace.template)) clueRules.set(trace.template, rule);
    }
    const derived = deriveClues(traces, clueRules);

    const keyEvents = new Set(input.truth.incident.keyEventIds);
    const required = derived.filter(({ sourceEventId }) => keyEvents.has(sourceEventId));
    const covered = new Set(required.map(({ sourceEventId }) => sourceEventId));
    const uncovered = [...keyEvents].filter((id) => !covered.has(id)).sort(compare);
    if (uncovered.length > 0) {
      throw new GenerationRejection(
        EVIDENCE_KEY_EVENT_UNCOVERED,
        `Key events without a clue: ${uncovered.join(', ')}`,
        { uncovered },
      );
    }

    const requiredClueIds = required.map(({ id }) => id).sort(compare);
    const clues = distributeCaptureModes(
      derived,
      new Set(requiredClueIds),
      content.preset.phone.minQrShare,
      rng,
    );
    return { ...input, traces, clues, requiredClueIds };
  },
};
