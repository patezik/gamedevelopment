import {
  validateRoutine,
  whereShouldBe,
  type Character,
  type RoutineBlock,
  type ScheduleOverride,
} from '../characters/index.ts';
import type { GameMinutes, Interval } from '../common/index.ts';
import type { Rng, RngState } from '../rng/index.ts';
import { TickPhase, type Calendar, type TickContext, type TimeSystem } from '../time/index.ts';
import type { Fact, TruthModel } from '../truth/index.ts';
import type { Actor, LocationGraph } from '../world/index.ts';

const MINUTES_PER_DAY = 1440;
const SCHEDULE_EVENT = 'simulation.routine';
const STEP_EVENT = 'simulation.step';

type RoutineCharacter = Pick<Character, 'id' | 'routine' | 'access' | 'archetypeId'>;

type Move = { readonly kind: 'move'; readonly origin: string; readonly destination: string };
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

interface AgentState {
  readonly character: RoutineCharacter;
  readonly actor: Actor;
  readonly rng: Rng;
  readonly priority: number;
  readonly overrides: readonly ScheduleOverride[];
  location: string;
  activity?: Activity;
  block: RoutineBlock;
  nextBoundary: GameMinutes;
}

export interface SimulationRunnerOptions {
  readonly time: TimeSystem;
  readonly calendar: Calendar;
  readonly world: LocationGraph;
  readonly truth: TruthModel;
  readonly rng: Rng;
  readonly characters: readonly RoutineCharacter[];
  readonly overrides?: readonly ScheduleOverride[];
  readonly initialLocations?: ReadonlyMap<string, string>;
  /** Exclusive end of the interval owned by this runner. Use the same calendar as TimeSystem. */
  readonly endAt: GameMinutes;
}

export class SimulationRunner {
  readonly #agents = new Map<string, AgentState>();
  readonly #calendar: Calendar;
  readonly #world: LocationGraph;
  readonly #truth: TruthModel;
  readonly #endAt: GameMinutes;

  constructor({
    time,
    calendar,
    world,
    truth,
    rng,
    characters,
    overrides = [],
    initialLocations,
    endAt,
  }: SimulationRunnerOptions) {
    const start = time.now();
    if (!Number.isSafeInteger(endAt) || endAt < start) {
      throw new RangeError('Simulation end must be a safe integer at or after the current time');
    }
    this.#calendar = calendar;
    this.#world = world;
    this.#truth = truth;
    this.#endAt = endAt;

    const agentRng = rng.fork('sim').fork('agent');
    const sorted = characters.toSorted((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)));
    for (const [priority, input] of sorted.entries()) {
      const character = structuredClone(input);
      const { id, archetypeId, access } = character;
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
      const actor: Actor = {
        archetypeId,
        itemIds: new Set(access.flatMap((grant) => ('itemId' in grant ? [grant.itemId] : []))),
      };
      const block = whereShouldBe(character, start, ownOverrides, calendar);
      const initialLocation = initialLocations?.get(id);
      const location = initialLocation ?? block.location;
      const destinations = new Set([
        location,
        ...character.routine.map((entry) => entry.location),
        ...ownOverrides.map((override) => override.block.location),
      ]);
      for (const destination of destinations) world.travelTime(destination, destination, actor);
      if (initialLocation === undefined && !world.isAccessible(location, actor, start).ok) {
        throw new RangeError(
          `An initial location is required for ${id} when ${location} is inaccessible`,
        );
      }
      this.#agents.set(id, {
        character,
        actor,
        location,
        priority,
        block,
        overrides: ownOverrides,
        rng: agentRng.fork(id),
        nextBoundary: start,
      });
    }

    time.registerHandler(SCHEDULE_EVENT, {
      phase: TickPhase.Schedules,
      handle: ({ payload }, context) => this.#updateRoutine(this.#agentFor(payload), context),
    });
    time.registerHandler(STEP_EVENT, {
      phase: TickPhase.Simulation,
      handle: ({ payload }, context) => this.#startStep(this.#agentFor(payload), context),
    });
    for (const [payload, { priority }] of this.#agents) {
      time.schedule({ at: start, kind: SCHEDULE_EVENT, priority, payload });
    }
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

  #agentFor(payload: unknown): AgentState {
    const agent = typeof payload === 'string' ? this.#agents.get(payload) : undefined;
    if (!agent) throw new RangeError(`Unknown simulation character: ${String(payload)}`);
    return agent;
  }

  #updateRoutine(agent: AgentState, context: TickContext): void {
    const { now } = context;
    const { character, overrides, priority, activity } = agent;
    const step = activity?.step;
    if (now === this.#endAt) {
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
    let next = this.#endAt;
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
    const step = this.#planStep(agent, now);
    this.#recordStep(character.id, step);
    agent.activity = { block, step };
    context.schedule({
      at: Math.min(step.to, nextBoundary),
      kind: SCHEDULE_EVENT,
      priority,
      payload: character.id,
    });
  }

  #planStep(agent: AgentState, now: GameMinutes): ActivityStep {
    const { location, actor, block, nextBoundary } = agent;
    const stay = { kind: 'stay', location, from: now, to: nextBoundary } as const;
    const hop = this.#world.nextTimedStep(location, block.location, actor, now);
    if (!hop || hop.arriveAt > this.#endAt) return stay;
    if (hop.departAt > now) return { ...stay, to: Math.min(nextBoundary, hop.departAt) };
    return {
      kind: 'move',
      origin: location,
      destination: hop.destination,
      from: now,
      to: hop.arriveAt,
    };
  }

  #recordStep(who: string, step: ActivityStep): void {
    const { from, to, kind } = step;
    const moving = step.kind === 'move';
    const location = moving ? step.origin : step.location;
    const target = moving ? { kind: 'location' as const, id: step.destination } : undefined;
    const fact: Fact = target
      ? { kind: 'did', who, verb: kind, target, at: from, where: location }
      : { kind: 'at', who, where: location, interval: { from, to } };
    this.#truth.append({
      t: from,
      duration: to - from,
      verb: kind,
      actorIds: [who],
      location,
      targets: target ? [target] : [],
      causes: [],
      facts: [fact],
      traceIds: [],
      visibility: 'public',
    });
  }
}
