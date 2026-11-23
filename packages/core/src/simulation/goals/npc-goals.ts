import type { Personality } from '../../characters/index.ts';
import {
  tracesForEvent,
  type ItemTagSource,
  type Trace,
  type TraceRuleSet,
  type TruthEventSource,
} from '../../evidence/index.ts';
import type { Belief, KnowledgeStore } from '../../knowledge/index.ts';
import type { Rng } from '../../rng/index.ts';
import type { EntityRef, Fact, TruthEvent, TruthEventInput } from '../../truth/index.ts';
import type { Goal, GoalContext } from './planner.ts';

/** What an agent decides from: personality and the 0–1 stress/wariness scales, never the truth. */
export interface NpcState {
  readonly personality: Readonly<Personality>;
  readonly stress: number;
  readonly wariness: number;
  readonly knowledge: Pick<KnowledgeStore, 'query'>;
}

export type NpcContext = GoalContext<NpcState>;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const trait = (state: NpcState, name: keyof Personality): number =>
  clamp01(state.personality[name]);

/** Scores stay below `ExecutePlot` (1) and above `FollowRoutine` (0). */
const MAX_SCORE = 0.95;
const score = (value: number): number => Math.min(MAX_SCORE, Math.max(0.01, value));

export const CONCEAL_WARINESS_THRESHOLD = 0.5;
export const PROTECT_STATIC_THRESHOLD = 75;
export const RUMOR_CONFIDENCE_FACTOR = 0.8;

// ---------------------------------------------------------------- ConcealEvidence

export interface ConcealTarget {
  readonly entity: EntityRef;
  readonly location: string;
}

export interface ConcealPorts {
  /** Evidence against the agent or their secret that the agent knows about. */
  incriminating(context: NpcContext): readonly ConcealTarget[];
  /** Appends the concealment event to the truth log and returns it with its assigned ID. */
  record(input: TruthEventInput): TruthEvent;
  readonly rules: TraceRuleSet;
  readonly items: ItemTagSource;
  readonly truth: TruthEventSource;
  /** Receives the secondary traces of the concealment (never empty, see ADR 0017). */
  onTraces(context: NpcContext, event: TruthEvent, traces: readonly Trace[]): void;
}

export const CONCEAL_MINUTES = 5;

export function scoreConcealEvidence(state: NpcState, targets: number): number {
  if (targets === 0 || state.wariness <= CONCEAL_WARINESS_THRESHOLD) return -Infinity;
  return score(
    0.3 + 0.4 * state.wariness + 0.15 * trait(state, 'conscientiousness') + 0.15 * state.stress,
  );
}

/**
 * Hides or destroys one piece of evidence. Impulsive agents destroy; the rest hide. The act is a
 * truth event whose trace rules must yield a secondary trace (conservation of evidence).
 */
export function concealEvidence(ports: ConcealPorts): Goal<NpcState> {
  return {
    id: 'ConcealEvidence',
    score: (context) => scoreConcealEvidence(context.state, ports.incriminating(context).length),
    plan(context, rng) {
      const targets = ports.incriminating(context);
      const target = targets.length === 0 ? undefined : rng.pick(targets);
      if (!target) return null;
      const verb = rng.chance(trait(context.state, 'impulsivity')) ? 'destroy' : 'hide';
      return {
        duration: CONCEAL_MINUTES,
        start() {
          const { now, agentId } = context;
          const facts: Fact[] = [
            {
              kind: 'did',
              who: agentId,
              verb,
              target: target.entity,
              at: now,
              where: target.location,
            },
          ];
          const event = ports.record({
            t: now,
            duration: CONCEAL_MINUTES,
            verb,
            actorIds: [agentId],
            location: target.location,
            targets: [target.entity],
            causes: [],
            facts,
            traceIds: [],
            visibility: 'covert',
          });
          const traces = tracesForEvent(event, ports.rules, ports.items, ports.truth);
          if (traces.length === 0) {
            throw new Error(`Concealment ${event.id} left no secondary trace`);
          }
          ports.onTraces(context, event, traces);
        },
      };
    },
  };
}

// ---------------------------------------------------------------- SpreadRumor

export interface RumorPorts {
  /** Characters the agent can talk to now. */
  listeners(context: NpcContext): readonly string[];
  /** Delivers the (distorted) belief; the receiver stores it as `told`. */
  tell(context: NpcContext, listenerId: string, belief: Belief): void;
}

export const RUMOR_MINUTES = 10;
const RUMOR_SHIFT_STEP = 5;

function juicyBeliefs(state: NpcState): Belief[] {
  return [
    ...state.knowledge.query({ kind: 'motive' }),
    ...state.knowledge.query({ kind: 'relation' }),
    ...state.knowledge.query({ kind: 'did' }),
  ]
    .filter(({ proposition }) => proposition.kind !== 'did' || proposition.verb !== 'talk')
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        JSON.stringify(a.proposition).localeCompare(JSON.stringify(b.proposition)),
    );
}

export function scoreSpreadRumor(state: NpcState, rumors: number, listeners: number): number {
  const extraversion = trait(state, 'extraversion');
  if (rumors === 0 || listeners === 0 || extraversion < 0.5) return -Infinity;
  return score(0.2 + 0.5 * extraversion + 0.1 * (1 - trait(state, 'honesty')) + 0.1 * state.stress);
}

/**
 * Retelling distorts a belief deterministically from `rng`: confidence drops by the told factor,
 * a `did` time and `at`/`possessed`/`state` intervals shift by 5–15 minutes, and a `motive`
 * loses its basis. A shifted proposition never equals the original.
 */
export function distortRumor(belief: Belief, rng: Rng): Belief {
  const stream = rng.fork('distort');
  const shift = (stream.chance(0.5) ? 1 : -1) * stream.int(1, 3) * RUMOR_SHIFT_STEP;
  const p = belief.proposition;
  let proposition: Fact = p;
  if (p.kind === 'did') proposition = { ...p, at: p.at + shift };
  else if (p.kind === 'at' || p.kind === 'possessed' || p.kind === 'state') {
    proposition = { ...p, interval: { from: p.interval.from + shift, to: p.interval.to + shift } };
  } else if (p.kind === 'motive') proposition = { ...p, basis: [] };
  return {
    ...belief,
    proposition,
    confidence: belief.confidence * RUMOR_CONFIDENCE_FACTOR,
    source: 'told',
    fuzzMinutes: belief.fuzzMinutes + Math.abs(shift),
  };
}

export function spreadRumor(ports: RumorPorts): Goal<NpcState> {
  return {
    id: 'SpreadRumor',
    score: (context) =>
      scoreSpreadRumor(
        context.state,
        juicyBeliefs(context.state).length,
        ports.listeners(context).length,
      ),
    plan(context, rng) {
      const rumor = juicyBeliefs(context.state)[0];
      const listeners = ports.listeners(context);
      if (!rumor || listeners.length === 0) return null;
      const listener = rng.pick([...listeners].sort());
      return {
        duration: RUMOR_MINUTES,
        start() {
          const told = distortRumor(
            { ...rumor, acquiredAt: context.now, fromCharacter: context.agentId },
            rng.fork(`rumor/${listener}/${context.now}`),
          );
          ports.tell(context, listener, told);
        },
      };
    },
  };
}

// ---------------------------------------------------------------- ProtectSelf

export interface Threat {
  /** Static level, 0–100, at the agent's position. */
  readonly static: number;
  readonly secondaryIncident: boolean;
}

export interface ProtectPorts {
  threat(context: NpcContext): Threat;
  /** Locks the agent in and changes their plans; the port records the availability change. */
  lockIn(context: NpcContext): void;
}

export const PROTECT_MINUTES = 30;

export function scoreProtectSelf(state: NpcState, threat: Threat): number {
  if (threat.static < PROTECT_STATIC_THRESHOLD && !threat.secondaryIncident) return -Infinity;
  const level = Math.max(
    clamp01((threat.static - PROTECT_STATIC_THRESHOLD) / (100 - PROTECT_STATIC_THRESHOLD)),
    threat.secondaryIncident ? 0.5 : 0,
  );
  return score(
    0.4 + 0.3 * level + 0.15 * trait(state, 'neuroticism') + 0.15 * (1 - trait(state, 'courage')),
  );
}

export function protectSelf(ports: ProtectPorts): Goal<NpcState> {
  return {
    id: 'ProtectSelf',
    score: (context) => scoreProtectSelf(context.state, ports.threat(context)),
    plan: (context) => ({ duration: PROTECT_MINUTES, start: () => ports.lockIn(context) }),
  };
}

// ---------------------------------------------------------------- MeetCharacter

export type MeetReason = 'shared_secret' | 'anxiety' | 'romance' | 'collusion';

export interface MeetCandidate {
  readonly characterId: string;
  readonly reason: MeetReason;
  readonly location: string;
}

export interface MeetPorts {
  candidates(context: NpcContext): readonly MeetCandidate[];
  /** Moves the agent to the meeting; the encounter itself is handled by SIM-003. */
  meet(context: NpcContext, candidate: MeetCandidate): void;
}

export const MEET_MINUTES = 20;
const MEET_WEIGHT: Record<MeetReason, number> = {
  collusion: 0.45,
  shared_secret: 0.4,
  romance: 0.35,
  anxiety: 0.3,
};

export function scoreMeet(state: NpcState, candidate: MeetCandidate): number {
  const social = (trait(state, 'extraversion') + trait(state, 'agreeableness')) / 2;
  const anxious = candidate.reason === 'anxiety' ? state.stress * 0.3 : 0;
  return score(MEET_WEIGHT[candidate.reason] + 0.3 * social + anxious);
}

function bestCandidates(state: NpcState, candidates: readonly MeetCandidate[]): MeetCandidate[] {
  const ranked = candidates
    .map((candidate) => ({ candidate, value: scoreMeet(state, candidate) }))
    .sort(
      (a, b) => b.value - a.value || (a.candidate.characterId < b.candidate.characterId ? -1 : 1),
    );
  return ranked.filter(({ value }) => value === ranked[0]?.value).map(({ candidate }) => candidate);
}

export function meetCharacter(ports: MeetPorts): Goal<NpcState> {
  return {
    id: 'MeetCharacter',
    score(context) {
      const [best] = bestCandidates(context.state, ports.candidates(context));
      return best ? scoreMeet(context.state, best) : -Infinity;
    },
    plan(context, rng) {
      const best = bestCandidates(context.state, ports.candidates(context));
      if (best.length === 0) return null;
      const candidate = rng.pick(best);
      return { duration: MEET_MINUTES, start: () => ports.meet(context, candidate) };
    },
  };
}

// ---------------------------------------------------------------- SeekInformation

export type SeekTrigger = 'disappearance' | 'death' | 'rumor';

export interface SeekTopic {
  readonly subjectId: string;
  readonly trigger: SeekTrigger;
}

export interface SeekPorts {
  /** Missing or dead acquaintances and rumors the agent has heard. */
  topics(context: NpcContext): readonly SeekTopic[];
  /** People the agent may ask now. */
  askable(context: NpcContext): readonly string[];
  ask(context: NpcContext, whomId: string, topic: SeekTopic): void;
}

export const SEEK_MINUTES = 15;
const SEEK_WEIGHT: Record<SeekTrigger, number> = { death: 0.5, disappearance: 0.45, rumor: 0.3 };

export function scoreSeek(state: NpcState, topic: SeekTopic): number {
  return score(
    SEEK_WEIGHT[topic.trigger] +
      0.2 * trait(state, 'openness') +
      0.15 * state.stress +
      0.1 * (1 - trait(state, 'courage')),
  );
}

function topTopic(state: NpcState, topics: readonly SeekTopic[]): SeekTopic | undefined {
  return topics
    .map((topic) => ({ topic, value: scoreSeek(state, topic) }))
    .sort((a, b) => b.value - a.value || (a.topic.subjectId < b.topic.subjectId ? -1 : 1))[0]
    ?.topic;
}

export function seekInformation(ports: SeekPorts): Goal<NpcState> {
  return {
    id: 'SeekInformation',
    score(context) {
      const topic = topTopic(context.state, ports.topics(context));
      return topic && ports.askable(context).length > 0
        ? scoreSeek(context.state, topic)
        : -Infinity;
    },
    plan(context, rng) {
      const topic = topTopic(context.state, ports.topics(context));
      const askable = [...ports.askable(context)].sort();
      if (!topic || askable.length === 0) return null;
      const whom = rng.pick(askable);
      return { duration: SEEK_MINUTES, start: () => ports.ask(context, whom, topic) };
    },
  };
}
