import { RelationshipGraph, whereShouldBe, type Character } from '@hs/core/characters';
import type { Interval } from '@hs/core/common';
import type { KnowledgeStore } from '@hs/core/knowledge';
import type { Rng } from '@hs/core/rng';
import {
  detectEncounters,
  runEncounters,
  SimulationRunner,
  type PerceptibleEvent,
  type Stay,
} from '@hs/core/simulation';
import { executePlot, followRoutine, GoalLoop, GoalPlanner } from '@hs/core/simulation/goals';
import { Calendar, TickPhase, TimeSystem } from '@hs/core/time';
import {
  factId,
  TruthModel,
  type EntityRef,
  type EventId,
  type Fact,
  type IncidentRecord,
  type PropositionPattern,
  type TruthEvent,
} from '@hs/core/truth';
import type { WorldState } from '@hs/core/world';
import { GenerationRejection, type Stage } from '../pipeline/index.ts';
import { motiveFact } from './conflict-gen.ts';
import type { PlotStepPlan, PlotWorld } from './plot-planning.ts';

type CharacterId = Character['id'];

/** The culprit's plan could not be executed at any start inside its windows. */
export const HISTORY_PLOT_FRUSTRATED = 'HISTORY_PLOT_FRUSTRATED';
/** Incident types whose victim dies (truth-model.md §4, «Смерть»). */
export const LETHAL_INCIDENT_TYPES: readonly string[] = Object.freeze(['murder']);
/** Verb of the event that records a death; its actor is the victim. */
export const DEATH_VERB = 'die';

const DEATH_EVENT = 'history.death';
const OBSERVE_EVENT = 'history.observe';

/** One executed step of the plan. */
export interface ExecutedStep {
  readonly id: string;
  readonly eventId: EventId;
  readonly t: number;
}

/** One way of executing the plan: its scene steps delayed by `shift` minutes. */
export interface HistoryAttempt {
  readonly shift: number;
  /** Why the plan failed with this delay; empty for the accepted attempt. */
  readonly problems: readonly string[];
}

/** Server diagnostics. Keep out of player and phone views. */
export interface HistoryReport {
  /** Tried delays in order; the last is accepted. */
  readonly attempts: readonly HistoryAttempt[];
  /** The largest delay the step windows allow. */
  readonly maxShift: number;
  readonly steps: readonly ExecutedStep[];
  /** Minute of the victim's death, `null` when nobody dies. */
  readonly deathAt: number | null;
  /** Events written by the simulation (routines, plan, death, conversations). */
  readonly simulatedEvents: number;
  readonly encounters: number;
}

/** Server truth: keep out of player and phone views. */
export interface HistoryWorld extends PlotWorld {
  /** Backstory and simulated history up to `t = 0`, with the incident record. */
  readonly truth: TruthModel;
  /** Locations and items as the history left them (the means moved to the culprit). */
  readonly worldState: WorldState;
  /** What each character knows at `t = 0`: observations and conversations of the history. */
  readonly knowledge: ReadonlyMap<CharacterId, KnowledgeStore>;
  /** Relationships after the drift of the history's conversations. */
  readonly relationshipsAtStart: RelationshipGraph;
  /** Where each character (or the victim's body) is at `t = 0`. */
  readonly locationsAtStart: ReadonlyMap<CharacterId, string>;
  readonly historyReport: HistoryReport;
}

interface Run {
  readonly truth: TruthModel;
  readonly state: WorldState;
  readonly runner: SimulationRunner;
  readonly steps: readonly ExecutedStep[];
  readonly death?: { readonly at: number; readonly eventId: EventId; readonly location: string };
  readonly problems: string[];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

/** Owners of archetype-owned items: the first character of the archetype by id (IncidentSelection). */
function ownersOf(characters: readonly Character[]): Map<string, CharacterId> {
  const owners = new Map<string, CharacterId>();
  for (const { archetypeId, id } of characters.toSorted((a, b) => compare(a.id, b.id))) {
    if (!owners.has(archetypeId)) owners.set(archetypeId, id);
  }
  return owners;
}

/** Whether the `at` facts of `who` at `location` cover every minute of `[from, to)`. */
function presentThroughout(
  truth: TruthModel,
  who: CharacterId,
  location: string,
  { from, to }: Interval,
): boolean {
  let covered = from;
  for (const { location: where, interval } of truth.presenceIntervals(who)) {
    if (where !== location || interval.from > covered || interval.to <= covered) continue;
    covered = interval.to;
    if (covered >= to) return true;
  }
  return covered >= to;
}

/** Where `who` is when its last recorded segment ends (a stay's place or a move's destination). */
function lastPlace(events: readonly TruthEvent[], who: CharacterId): string | undefined {
  let end = -Infinity;
  let place: string | undefined;
  for (const event of events) {
    if (event.verb === 'move' && event.actorIds.includes(who)) {
      const destination = event.targets.find(({ kind }) => kind === 'location');
      if (destination && event.t + event.duration >= end) {
        end = event.t + event.duration;
        place = destination.id;
      }
    }
    for (const fact of event.facts) {
      if (fact.kind === 'at' && fact.who === who && fact.interval.to >= end) {
        end = fact.interval.to;
        place = fact.where;
      }
    }
  }
  return place;
}

/** The plan as `ExecutePlot` steps, scene steps delayed by `shift` inside their windows. */
function delayed(steps: readonly PlotStepPlan[], shift: number) {
  return steps.map((step) =>
    step.acquire ? step : { ...step, window: { ...step.window, from: step.window.from + shift } },
  );
}

/** The largest delay that keeps every scene step inside its window. */
function maxShiftOf(steps: readonly PlotStepPlan[]): number {
  const slack = steps
    .filter(({ acquire }) => !acquire)
    .map(({ window, duration }) => window.to - window.from - duration);
  return slack.length === 0 ? 0 : Math.max(0, Math.min(...slack));
}

function aimsAt(step: PlotStepPlan, victim: CharacterId): boolean {
  return step.target.kind === 'character' && step.target.id === victim;
}

/** The step whose event causes the death: the first aimed at the victim, else the first at the scene. */
function lethalStep(world: PlotWorld, steps: readonly PlotStepPlan[]): PlotStepPlan | undefined {
  return (
    steps.find((step) => aimsAt(step, world.incident.victimId)) ??
    steps.find(({ acquire }) => !acquire)
  );
}

/**
 * The minute the victim dies, or `undefined` when the incident is not lethal: the planned delayed
 * death, otherwise the end of the lethal step (steps start at their window, as `ExecutePlot` runs
 * them back to back).
 */
function deathMinute(world: PlotWorld, steps: readonly PlotStepPlan[]): number | undefined {
  if (!LETHAL_INCIDENT_TYPES.includes(world.incident.type)) return undefined;
  if (world.plot.deathAt !== undefined) return world.plot.deathAt;
  const lethal = lethalStep(world, steps);
  return lethal && lethal.window.from + lethal.duration;
}

/** The root of an item's placement: a location or a character (containers resolved). */
function rootOf(state: WorldState, itemId: string, t: number): { kind: string; id: string } {
  let placement = state.items.locate(itemId, t);
  for (let depth = 0; placement.kind === 'container'; depth++) {
    if (depth > 64) throw new RangeError(`Container cycle around ${itemId}`);
    placement = state.items.locate(placement.id, t);
  }
  return placement;
}

/**
 * Runs the history once: every character's routine from `historyStart` to `t = 0` through
 * `SimulationRunner`, the culprit's plan through the `ExecutePlot` goal (score 1, above the
 * routine), the victim's death, and observations of every event. Then checks that each executed
 * step happened where and how the plan needs it.
 */
function simulate(world: PlotWorld, historyStart: number, rng: Rng, shift: number): Run {
  const { incident, plot } = world;
  const culprit = incident.culpritId;
  const victim = incident.victimId;
  const steps = delayed(plot.steps, shift);
  const calendar = new Calendar(world.world.locations.startDateTime);
  const time = new TimeSystem(calendar, 0, historyStart);
  const state = world.world.createWorldState(ownersOf(world.characters));
  const truth = new TruthModel(
    // Placeholder: the record is completed once the history is known.
    {
      ...plot.incident,
      motive: factId(motiveFact(incident.motive)),
      keyEventIds: [],
    },
    world.history,
  );
  const motiveEvent = truth
    .events()
    .find(({ facts }) =>
      facts.some((fact) => fact.kind === 'motive' && matchesMotive(fact, world)),
    );
  const means = plot.opportunity.meansItemId;
  const acquisition = plot.opportunity.acquisition;
  const deathAt = deathMinute(world, steps);
  const problems: string[] = [];
  if (deathAt !== undefined && deathAt >= 0) {
    problems.push(`death at minute ${deathAt} is not before t = 0`);
  }

  const runner = new SimulationRunner({
    time,
    calendar,
    world: state.locations,
    items: state.items,
    truth,
    rng: rng.fork('simulation'),
    characters: world.characters,
    overrides: plot.overrides,
    // Everyone starts where the routine says, as in IncidentSelection.
    initialLocations: new Map(
      world.characters.map((c) => [c.id, whereShouldBe(c, historyStart, [], calendar).location]),
    ),
    itemChangeMinutes: acquisition ? [acquisition.at + 1] : [],
    ...(deathAt !== undefined && deathAt < 0 && { exits: new Map([[victim, deathAt]]) }),
    endAt: 0,
  });

  time.registerHandler(OBSERVE_EVENT, {
    phase: TickPhase.WorldEvents,
    handle: ({ payload }) => runner.observe(payload as PerceptibleEvent),
  });
  const observe = (event: PerceptibleEvent) =>
    time.schedule({ at: event.t, kind: OBSERVE_EVENT, priority: 0, payload: event });

  const executed: ExecutedStep[] = [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  const planner = new GoalPlanner<null>().register(followRoutine(() => {})).register(
    executePlot(new Map([[culprit, steps]]), ({ now }, { id }) => {
      const step = byId.get(id)!;
      const previous = executed.at(-1)?.eventId ?? motiveEvent?.id;
      const facts: Fact[] = [
        {
          kind: 'did',
          who: culprit,
          verb: step.verb,
          target: step.target,
          at: now,
          where: step.locationId,
        },
      ];
      const targets: EntityRef[] = [step.target];
      if (step.acquire) {
        if (now + 1 < 0) {
          facts.push({
            kind: 'possessed',
            who: culprit,
            item: means,
            interval: { from: now + 1, to: 0 },
          });
        }
        if (acquisition?.fromCharacterId !== undefined) {
          targets.push({ kind: 'character', id: acquisition.fromCharacterId });
        }
      }
      const event = {
        t: now,
        verb: step.verb,
        actorIds: [culprit],
        location: step.locationId,
        visibility: 'covert' as const,
      };
      const eventId = truth.append({
        ...event,
        duration: step.duration,
        targets,
        causes: previous === undefined ? [] : [previous],
        facts,
        traceIds: [],
      });
      // Held from the minute after the take, as IncidentSelection verified.
      if (step.acquire)
        state.items.move(means, { kind: 'character', id: culprit }, now + 1, eventId);
      executed.push({ id, eventId, t: now });
      observe({ ...event, id: eventId });
    }),
  );
  new GoalLoop({
    time,
    planner,
    rng: rng.fork('simulation'),
    agents: [{ id: culprit, readState: () => null, nextRoutineBoundary: () => undefined }],
    endAt: 0,
  });

  let death: Run['death'];
  if (deathAt !== undefined && deathAt < 0) {
    time.registerHandler(DEATH_EVENT, {
      phase: TickPhase.WorldEvents,
      handle: () => {
        const location = lastPlace(truth.events(), victim) ?? plot.opportunity.locationId;
        const lethal = lethalStep(world, steps);
        const cause = executed.find(({ id }) => id === lethal?.id)?.eventId;
        const event = {
          t: deathAt,
          verb: DEATH_VERB,
          actorIds: [victim],
          location,
          visibility: 'public' as const,
        };
        const interval = { from: deathAt, to: 0 };
        const eventId = truth.append({
          ...event,
          duration: 0,
          targets: [],
          causes: cause === undefined ? [] : [cause],
          facts: [
            {
              kind: 'state',
              entity: { kind: 'character', id: victim },
              property: 'alive',
              value: false,
              interval,
            },
            // The body stays where the victim died.
            { kind: 'at', who: victim, where: location, interval },
          ],
          traceIds: [],
        });
        death = { at: deathAt, eventId, location };
        runner.observe({ ...event, id: eventId });
      },
    });
    time.schedule({ at: deathAt, kind: DEATH_EVENT, priority: 0, payload: null });
  }

  time.advance(-historyStart);
  problems.push(...verify(world, steps, { truth, state, executed, death }));
  return { truth, state, runner, steps: executed, ...(death && { death }), problems };
}

function matchesMotive(fact: Fact, world: PlotWorld): boolean {
  return factId(fact) === factId(motiveFact(world.incident.motive));
}

/** What went wrong with the executed plan; empty when every step happened as planned. */
function verify(
  world: PlotWorld,
  steps: readonly PlotStepPlan[],
  run: {
    truth: TruthModel;
    state: WorldState;
    executed: readonly ExecutedStep[];
    death: Run['death'];
  },
): string[] {
  const { truth, state, executed, death } = run;
  const { culpritId: culprit, victimId: victim } = world.incident;
  const { opportunity } = world.plot;
  const victimAllowed = steps.some((step) => aimsAt(step, victim));
  const problems: string[] = [];
  for (const step of steps) {
    const done = executed.find(({ id }) => id === step.id);
    if (!done) {
      problems.push(`${step.id}: not executed in its window`);
      continue;
    }
    const span = { from: done.t, to: done.t + Math.max(step.duration, 1) };
    if (!presentThroughout(truth, culprit, step.locationId, span)) {
      problems.push(`${step.id}: the culprit is not at ${step.locationId} at minute ${done.t}`);
    }
    if (step.acquire) {
      const holder = opportunity.acquisition?.fromCharacterId;
      const root = rootOf(state, opportunity.meansItemId, done.t);
      const ok = holder
        ? root.kind === 'character' &&
          root.id === holder &&
          presentThroughout(truth, holder, step.locationId, span)
        : root.kind === 'location' && root.id === step.locationId;
      if (!ok)
        problems.push(`${step.id}: the means is not at ${step.locationId} at minute ${done.t}`);
      continue;
    }
    const witnesses = truth
      .whoWasAt(step.locationId, span)
      .filter((id) => id !== culprit && !(victimAllowed && id === victim));
    if (witnesses.length > 0) problems.push(`${step.id}: witnessed by ${witnesses.join(', ')}`);
    // After death the body stays in place, so later steps on it still find it there.
    if (aimsAt(step, victim) && !presentThroughout(truth, victim, step.locationId, span)) {
      problems.push(`${step.id}: the victim is not at ${step.locationId}`);
    }
  }
  // Without a step aimed at the victim, a delayed death must happen at the scene.
  if (death && !victimAllowed && world.plot.deathAt !== undefined) {
    if (death.location !== opportunity.locationId) {
      problems.push(`the victim dies at ${death.location}, not at ${opportunity.locationId}`);
    }
  }
  return problems;
}

/** Presence of the living for the encounters; the body is no longer company. */
function staysOf(
  truth: TruthModel,
  historyStart: number,
  death: Run['death'],
  victim: string,
): Stay[] {
  const stays: Stay[] = [];
  for (const fact of truth.facts({ kind: 'at' })) {
    if (fact.kind !== 'at' || fact.interval.from < historyStart) continue;
    const end =
      fact.who === victim && death ? Math.min(fact.interval.to, death.at) : fact.interval.to;
    if (end <= fact.interval.from) continue;
    stays.push({
      characterId: fact.who,
      location: fact.where,
      interval: { from: fact.interval.from, to: end },
    });
  }
  return stays;
}

/**
 * HistorySimulation (GEN-008): the history from `preset.time.historyStartMinutes` to `t = 0`
 * (generation-pipeline.md §3). The truth is what the simulation did: the culprit executes the
 * plan as the `ExecutePlot` goal, and `IncidentRecord.keyEventIds` are the executed steps. A plan
 * the simulation frustrates is delayed inside its windows; when no delay works the attempt is
 * rejected (`HISTORY_PLOT_FRUSTRATED`).
 */
export const historySimulation: Stage<PlotWorld, HistoryWorld> = {
  name: 'HistorySimulation',
  generate(input, { rng, content, logger }) {
    const historyStart = content.preset.time.historyStartMinutes;
    const { incident, plot } = input;
    if (plot.steps.length === 0) throw new RangeError('The plot has no steps to execute');
    const maxShift = maxShiftOf(plot.steps);
    const attempts: HistoryAttempt[] = [];
    let run: Run | undefined;
    for (let shift = 0; shift <= maxShift; shift++) {
      const candidate = simulate(input, historyStart, rng, shift);
      attempts.push({ shift, problems: candidate.problems });
      if (candidate.problems.length === 0) {
        run = candidate;
        break;
      }
    }
    if (!run) {
      throw new GenerationRejection(
        HISTORY_PLOT_FRUSTRATED,
        `The plan could not be executed: ${attempts[0]!.problems[0]}`,
        { attempts },
      );
    }

    const { truth: scratch, runner, steps, death } = run;
    const victim = incident.victimId;
    const culprit = incident.culpritId;
    const relationships = new RelationshipGraph(input.relationships.snapshot());
    const conceal: PropositionPattern[] = [
      { kind: 'did', who: culprit },
      { kind: 'motive', who: culprit },
      { kind: 'at', who: culprit, where: plot.opportunity.locationId },
    ];
    const encounters = runEncounters(
      detectEncounters(staysOf(scratch, historyStart, death, victim)),
      (id) => {
        const knowledge = runner.knowledgeOf(id);
        return knowledge && { id, knowledge, conceal: id === culprit ? conceal : [] };
      },
      relationships,
      scratch,
    );

    // The scene's steps lead: the first key event places the incident (validator, solver).
    const planOrder = new Map(
      plot.steps.map(({ id, acquire }, index) => [id, [acquire, index] as const]),
    );
    const keyEventIds = steps
      .toSorted((a, b) => {
        const [acquireA, indexA] = planOrder.get(a.id)!;
        const [acquireB, indexB] = planOrder.get(b.id)!;
        return Number(acquireA) - Number(acquireB) || indexA - indexB;
      })
      .map(({ eventId }) => eventId);
    const record: IncidentRecord = { ...scratch.incident, keyEventIds };
    const { events } = JSON.parse(scratch.serialize()) as { events: TruthEvent[] };
    const truth = new TruthModel(record, events);

    const all = truth.events();
    const knowledge = new Map(
      input.characters
        .map(({ id }) => id)
        .sort(compare)
        .map((id) => [id, runner.knowledgeOf(id)!] as const),
    );
    const locationsAtStart = new Map(
      [...knowledge.keys()].map((id) => [id, lastPlace(all, id)!] as const),
    );
    const historyReport: HistoryReport = {
      attempts,
      maxShift,
      steps,
      deathAt: death?.at ?? null,
      simulatedEvents: all.length - input.history.length,
      encounters: encounters.length,
    };
    logger.debug('history simulated', {
      shift: attempts.at(-1)!.shift,
      events: historyReport.simulatedEvents,
      encounters: encounters.length,
    });
    return {
      ...input,
      truth,
      worldState: run.state,
      knowledge,
      relationshipsAtStart: relationships,
      locationsAtStart,
      historyReport,
    };
  },
};
