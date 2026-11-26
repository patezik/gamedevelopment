import {
  validateRoutine,
  whereShouldBe,
  type Character,
  type RoutineBlock,
  type ScheduleOverride,
} from '../characters/index.ts';
import type { GameMinutes, Interval } from '../common/index.ts';
import { KnowledgeStore } from '../knowledge/index.ts';
import { restoreRng, type Rng, type RngState } from '../rng/index.ts';
import { TickPhase, type Calendar, type TickContext, type TimeSystem } from '../time/index.ts';
import type { EntityRef, Fact, TruthModel } from '../truth/index.ts';
import type { Actor, ItemRegistry, LocationGraph } from '../world/index.ts';
import { FOCUS_STEP_MINUTES, type SimulationLod } from './lod.ts';
import { recordObservations, type Observer, type PerceptibleEvent } from './perception.ts';

const MINUTES_PER_DAY = 1440;
const SCHEDULE_EVENT = 'simulation.routine';
const STEP_EVENT = 'simulation.step';
const OBSERVATION_EVENT = 'simulation.observe';

type RoutineCharacter = Pick<Character, 'id' | 'routine' | 'archetypeId'> &
  Partial<Pick<Character, 'personality'>>;

type Move = {
  readonly kind: 'move';
  readonly origin: string;
  readonly destination: string;
  readonly keyItemId?: string;
};
type Stay = { readonly kind: 'stay'; readonly location: string };
export type ActivityStep = Readonly<Interval> & (Move | Stay);

export interface Activity {
  readonly block: Readonly<RoutineBlock>;
  readonly step: ActivityStep;
}

export interface Agent {
  readonly characterId: string;
  readonly activity?: Activity;
  readonly rngState: RngState;
}

/** One agent as saved by `SimulationRunner.snapshot`; the pending wake-up is derived on restore. */
export interface AgentSnapshot {
  readonly characterId: string;
  readonly location: string;
  readonly block: RoutineBlock;
  readonly nextBoundary: GameMinutes;
  readonly activity?: Activity;
  readonly rngState: RngState;
  /** `KnowledgeStore.serialize()` of the agent. */
  readonly knowledge: string;
}

export interface SimulationSnapshot {
  readonly agents: readonly AgentSnapshot[];
}

interface AgentState {
  readonly character: RoutineCharacter;
  rng: Rng;
  knowledge: KnowledgeStore;
  readonly priority: number;
  readonly overrides: readonly ScheduleOverride[];
  /** Exclusive end of this character's actions: the runner's end or an earlier exit. */
  readonly endAt: GameMinutes;
  location: string;
  activity?: Activity;
  block: RoutineBlock;
  nextBoundary: GameMinutes;
}

export interface SimulationRunnerOptions {
  readonly time: TimeSystem;
  readonly calendar: Calendar;
  readonly world: LocationGraph;
  readonly items: Pick<ItemRegistry, 'locate' | 'history'>;
  readonly truth: TruthModel;
  readonly rng: Rng;
  readonly characters: readonly RoutineCharacter[];
  readonly overrides?: readonly ScheduleOverride[];
  readonly initialLocations?: ReadonlyMap<string, string>;
  readonly knowledge?: ReadonlyMap<string, KnowledgeStore>;
  readonly stressAt?: (id: string, minute: GameMinutes) => number;
  /** Known minutes of item updates that will be written before the Simulation phase. */
  readonly itemChangeMinutes?: readonly GameMinutes[];
  /** Detail levels: `focus` agents stay in steps of at most 5 minutes (ADR 0013). */
  readonly lod?: Pick<SimulationLod, 'level'>;
  /**
   * Minutes from which a character no longer acts or observes, e.g. a death. Steps end there and
   * no transition arrives later; the caller records what happens to the character at that minute.
   */
  readonly exits?: ReadonlyMap<string, GameMinutes>;
  /**
   * State saved by `snapshot()` at `time.now()`, after the tick of that minute ran. The runner
   * continues exactly as the saved one would have; `initialLocations` and `knowledge` are ignored
   * for the saved characters.
   */
  readonly restore?: SimulationSnapshot;
  /** Exclusive end of the interval owned by this runner. Use the same calendar as TimeSystem. */
  readonly endAt: GameMinutes;
}

export class SimulationRunner {
  readonly #agents = new Map<string, AgentState>();
  readonly #calendar: Calendar;
  readonly #world: LocationGraph;
  readonly #items: SimulationRunnerOptions['items'];
  readonly #itemChangeMinutes: readonly GameMinutes[];
  readonly #truth: TruthModel;
  readonly #endAt: GameMinutes;
  readonly #stressAt: NonNullable<SimulationRunnerOptions['stressAt']>;
  readonly #lod: SimulationRunnerOptions['lod'];

  constructor({
    time,
    calendar,
    world,
    items,
    truth,
    rng,
    characters,
    overrides = [],
    initialLocations,
    knowledge,
    stressAt = () => 0,
    itemChangeMinutes = [],
    lod,
    exits = new Map(),
    restore,
    endAt,
  }: SimulationRunnerOptions) {
    const start = time.now();
    if (!Number.isSafeInteger(endAt) || endAt < start) {
      throw new RangeError('Simulation end must be a safe integer at or after the current time');
    }
    if (itemChangeMinutes.some((minute) => !Number.isSafeInteger(minute))) {
      throw new RangeError('Item changes must be scheduled at safe integer minutes');
    }
    this.#calendar = calendar;
    this.#world = world;
    this.#items = items;
    this.#itemChangeMinutes = itemChangeMinutes.toSorted((a, b) => a - b);
    this.#truth = truth;
    this.#endAt = endAt;
    this.#stressAt = stressAt;
    this.#lod = lod;

    const known = new Set(characters.map(({ id }) => id));
    for (const [id, minute] of exits) {
      if (!known.has(id)) throw new RangeError(`Exit for unknown character: ${id}`);
      if (!Number.isSafeInteger(minute)) throw new RangeError(`Invalid exit minute for ${id}`);
    }
    const agentRng = rng.fork('sim').fork('agent');
    const sorted = characters.toSorted((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)));
    for (const [priority, input] of sorted.entries()) {
      const character = structuredClone(input);
      const { id } = character;
      if (!id) throw new RangeError('Character ID cannot be empty');
      if (this.#agents.has(id)) throw new RangeError(`Duplicate character ID: ${id}`);
      validateRoutine(character);
      const ownOverrides = structuredClone(
        overrides.filter((override) => override.characterId === id),
      );
      for (const { interval } of ownOverrides) {
        if (
          !Number.isSafeInteger(interval.from) ||
          !Number.isSafeInteger(interval.to) ||
          interval.from >= interval.to
        ) {
          throw new RangeError(`Invalid schedule override for ${id}`);
        }
      }
      const block = whereShouldBe(character, start, ownOverrides, calendar);
      const initialLocation = initialLocations?.get(id);
      const location = initialLocation ?? block.location;
      const destinations = new Set([
        location,
        ...character.routine.map((entry) => entry.location),
        ...ownOverrides.map((override) => override.block.location),
      ]);
      for (const destination of destinations) world.travelTime(destination, destination);
      if (
        initialLocation === undefined &&
        !world.isAccessible(location, this.#accessAt(character, start).actor, start).ok
      ) {
        throw new RangeError(
          `An initial location is required for ${id} when ${location} is inaccessible`,
        );
      }
      this.#agents.set(id, {
        character,
        location,
        priority,
        block,
        overrides: ownOverrides,
        rng: agentRng.fork(id),
        knowledge: knowledge?.get(id) ?? new KnowledgeStore(),
        endAt: Math.max(start, Math.min(endAt, exits.get(id) ?? endAt)),
        nextBoundary: start,
      });
    }

    const saved = new Map((restore?.agents ?? []).map((agent) => [agent.characterId, agent]));
    for (const id of saved.keys()) {
      if (!this.#agents.has(id)) throw new RangeError(`Saved state of unknown character: ${id}`);
    }
    for (const [id, agent] of this.#agents) {
      const state = saved.get(id);
      if (!state) continue;
      agent.location = state.location;
      agent.block = structuredClone(state.block);
      agent.nextBoundary = state.nextBoundary;
      agent.rng = restoreRng(state.rngState);
      agent.knowledge = KnowledgeStore.deserialize(state.knowledge);
      if (state.activity) agent.activity = structuredClone(state.activity);
    }

    time.registerHandler(SCHEDULE_EVENT, {
      phase: TickPhase.Schedules,
      handle: ({ payload }, context) => this.#updateRoutine(this.#agentFor(payload), context),
    });
    time.registerHandler(STEP_EVENT, {
      phase: TickPhase.Simulation,
      handle: ({ payload }, context) => this.#startStep(this.#agentFor(payload), context),
    });
    time.registerHandler(OBSERVATION_EVENT, {
      phase: TickPhase.WorldEvents,
      handle: ({ payload }) => this.observe(payload as PerceptibleEvent),
    });
    for (const [payload, { priority, activity, nextBoundary }] of this.#agents) {
      // A saved agent in the middle of a step wakes where the saved one was due to.
      const at = activity ? Math.min(activity.step.to, nextBoundary) : start;
      if (activity && at < start) throw new RangeError(`Saved step of ${payload} is already over`);
      time.schedule({ at, kind: SCHEDULE_EVENT, priority, payload });
    }
  }

  snapshot(): SimulationSnapshot {
    return {
      agents: [...this.#agents.values()]
        .map(({ character, location, block, nextBoundary, activity, rng, knowledge }) => ({
          characterId: character.id,
          location,
          block: structuredClone(block),
          nextBoundary,
          ...(activity && { activity: structuredClone(activity) }),
          rngState: structuredClone(rng.state),
          knowledge: knowledge.serialize(),
        }))
        .sort((a, b) =>
          a.characterId < b.characterId ? -1 : Number(a.characterId > b.characterId),
        ),
    };
  }

  getAgent(characterId: string): Agent | undefined {
    const agent = this.#agents.get(characterId);
    if (!agent) return undefined;
    const { activity, rng } = agent;
    return {
      characterId,
      rngState: rng.state,
      ...(activity && { activity: structuredClone(activity) }),
    };
  }

  knowledgeOf(characterId: string): KnowledgeStore | undefined {
    return this.#agents.get(characterId)?.knowledge;
  }

  /** Call after the Simulation phase has established presence for the event minute. */
  observe(event: PerceptibleEvent): void {
    if (event.visibility === 'private') return;
    const { t, location } = event;
    const present = new Set(this.#truth.whoWasAt(location, { from: t, to: t + 1 }));
    const observers: Observer[] = [];
    for (const id of present) {
      const agent = this.#agents.get(id);
      if (!agent || t >= agent.endAt) continue;
      const { character, knowledge, rng } = agent;
      observers.push({
        id,
        knowledge,
        rng,
        personality: character.personality ?? { conscientiousness: 0.5 },
        stress: event.visibility === 'covert' ? this.#stressAt(id, t) : 0,
      });
    }
    recordObservations(
      event,
      present,
      observers,
      this.#world.lightingAt(location, this.#calendar.toDisplay(t).period),
    );
  }

  #agentFor(payload: unknown): AgentState {
    const agent = typeof payload === 'string' ? this.#agents.get(payload) : undefined;
    if (!agent) throw new RangeError(`Unknown simulation character: ${String(payload)}`);
    return agent;
  }

  #updateRoutine(agent: AgentState, context: TickContext): void {
    const { now } = context;
    const { character, overrides, priority, activity } = agent;
    const step = activity?.step;
    if (now >= agent.endAt) {
      delete agent.activity;
      return;
    }

    agent.nextBoundary = this.#nextBoundary(agent, now);
    if (step && now < step.to) {
      // A schedule change cannot interrupt a traversal already under way.
      context.schedule({
        at: Math.min(step.to, agent.nextBoundary),
        kind: SCHEDULE_EVENT,
        priority,
        payload: character.id,
      });
      return;
    }
    agent.block = whereShouldBe(character, now, overrides, this.#calendar);
    context.schedule({ at: now, kind: STEP_EVENT, priority, payload: character.id });
  }

  #nextBoundary(agent: AgentState, now: GameMinutes): GameMinutes {
    const { hh, mm } = this.#calendar.toDisplay(now);
    const minute = hh * 60 + mm;
    let next = agent.endAt;
    for (const { to } of agent.character.routine) {
      const delta = (to - minute + MINUTES_PER_DAY) % MINUTES_PER_DAY;
      next = Math.min(next, now + (delta || MINUTES_PER_DAY));
    }
    for (const { interval } of agent.overrides) {
      if (interval.from > now) next = Math.min(next, interval.from);
      if (interval.to > now) next = Math.min(next, interval.to);
    }
    return next;
  }

  #startStep(agent: AgentState, context: TickContext): void {
    const previousStep = agent.activity?.step;
    if (previousStep?.kind === 'move') agent.location = previousStep.destination;
    const { character, priority, nextBoundary, block } = agent;
    const { now } = context;
    const step = this.#limitDetail(agent, this.#planStep(agent, now), now);
    const event = this.#recordStep(character.id, step);
    agent.activity = { block, step };
    context.schedule({ at: now, kind: OBSERVATION_EVENT, priority, payload: event });
    context.schedule({
      at: Math.min(step.to, nextBoundary),
      kind: SCHEDULE_EVENT,
      priority,
      payload: character.id,
    });
  }

  /** A `focus` agent's stay is cut into short steps; the presence it records is unchanged. */
  #limitDetail(agent: AgentState, step: ActivityStep, now: GameMinutes): ActivityStep {
    if (step.kind !== 'stay' || step.to - now <= FOCUS_STEP_MINUTES) return step;
    return this.#lod?.level(agent.character.id, agent.location, now) === 'focus'
      ? { ...step, to: now + FOCUS_STEP_MINUTES }
      : step;
  }

  #planStep(agent: AgentState, now: GameMinutes): ActivityStep {
    const { location, block, nextBoundary } = agent;
    const stay = { kind: 'stay', location, from: now, to: nextBoundary } as const;
    if (location === block.location) return stay;
    const { actor, nextChange } = this.#accessAt(agent.character, now);
    const hop = this.#world.nextTimedStep(location, block.location, actor, now);
    const stayUntil = Math.min(nextBoundary, nextChange);
    if (!hop || hop.arriveAt > agent.endAt) return { ...stay, to: stayUntil };
    if (hop.departAt > now) return { ...stay, to: Math.min(stayUntil, hop.departAt) };
    return {
      kind: 'move',
      origin: location,
      destination: hop.destination,
      from: now,
      to: hop.arriveAt,
      ...(hop.keyItemId !== undefined && { keyItemId: hop.keyItemId }),
    };
  }

  #accessAt(character: RoutineCharacter, now: GameMinutes): { actor: Actor; nextChange: number } {
    const itemIds = new Set<string>();
    let nextChange = this.#itemChangeMinutes.find((minute) => minute > now) ?? Infinity;
    for (const keyId of this.#world.accessItemIds) {
      let id = keyId;
      for (;;) {
        const change = this.#items.history(id).find(({ t }) => t > now);
        if (change) nextChange = Math.min(nextChange, change.t);
        const placement = this.#items.locate(id, now);
        if (placement.kind === 'container') {
          id = placement.id;
        } else {
          if (placement.kind === 'character' && placement.id === character.id) itemIds.add(keyId);
          break;
        }
      }
    }
    return { actor: { archetypeId: character.archetypeId, itemIds }, nextChange };
  }

  #recordStep(who: string, step: ActivityStep): PerceptibleEvent {
    const { from, to, kind } = step;
    const moving = step.kind === 'move';
    const location = moving ? step.origin : step.location;
    const target = moving ? { kind: 'location' as const, id: step.destination } : undefined;
    const fact: Fact = target
      ? { kind: 'did', who, verb: kind, target, at: from, where: location }
      : { kind: 'at', who, where: location, interval: { from, to } };
    const targets: EntityRef[] = target ? [target] : [];
    if (step.kind === 'move' && step.keyItemId !== undefined) {
      targets.push({ kind: 'item', id: step.keyItemId });
    }
    const event = {
      t: from,
      verb: kind,
      actorIds: [who],
      location,
      visibility: 'public' as const,
    };
    const id = this.#truth.append({
      ...event,
      duration: to - from,
      targets,
      causes: [],
      facts: [fact],
      traceIds: [],
    });
    return { ...event, id };
  }
}
