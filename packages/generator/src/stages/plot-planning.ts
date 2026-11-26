import { whereShouldBe, type Character, type ScheduleOverride } from '@hs/core/characters';
import type { Interval } from '@hs/core/common';
import type { ScenarioContent } from '@hs/core/content';
import { Calendar } from '@hs/core/time';
import type { EntityRef, Fact, IncidentRecord } from '@hs/core/truth';
import type { Actor } from '@hs/core/world';
import { GenerationRejection, type Stage } from '../pipeline/index.ts';
import type { IncidentWorld, Opportunity } from './incident-selection.ts';

type CrimeData = ScenarioContent['crimes'][number];
type CrimeStep = CrimeData['plan'][number];

export const PLOT_INFEASIBLE = 'PLOT_INFEASIBLE';
/** `state` property of the fact that explains a bent schedule. */
export const SCHEDULE_DEVIATION_PROPERTY = 'schedule_deviation';
/** Why the culprit leaves the routine. Drawn from `gen/PlotPlanning/deviation`. */
export const DEVIATION_REASONS = Object.freeze(['errand', 'insomnia', 'summoned', 'unwell']);
/** Taking the means is a one-minute act in the verified model (generation-pipeline.md §3). */
export const ACQUIRE_MINUTES = 1;

const PLAN_ACTIVITY = 'incident_plan';
const MINUTES_PER_DAY = 1440;
const DEFAULT_STEP_MINUTES = 1;
const ACQUIRE_VERB = 'take';

/** One goal of the culprit for `ExecutePlot`: `{ id, window, duration }` plus what it is. */
export interface PlotStepPlan {
  readonly id: string;
  readonly verb: string;
  readonly target: EntityRef;
  readonly locationId: string;
  /** Game minutes the step may start in (`from`) and must end by (`to`). */
  readonly window: Interval;
  readonly duration: number;
  readonly optional: boolean;
  /** Taking the means (before the window); every other step is inside it. */
  readonly acquire: boolean;
}

/** The one schedule bend of the plan and the fact that explains it. */
export interface ScheduleDeviation {
  readonly interval: Interval;
  readonly reason: string;
  /** Truth fact recording the reason (`state` of the culprit). */
  readonly fact: Fact;
}

/** What the culprit will claim about the incident window. A lie: server truth, not a fact. */
export interface PlannedAlibi {
  readonly claimedLocationId: string;
  readonly interval: Interval;
  readonly claim: Fact;
}

/** Part of the `IncidentRecord` known before the history runs (motive and events come later). */
export type PlannedIncident = Pick<
  IncidentRecord,
  'type' | 'victimIds' | 'culpritIds' | 'means' | 'window'
>;

/** Server truth. Keep out of player and phone views. */
export interface PlotPlan {
  readonly templateId: string;
  readonly opportunity: Opportunity;
  /** In execution order; consecutive steps do not overlap. */
  readonly steps: readonly PlotStepPlan[];
  /** At most one deviation, as at most two overrides (to the acquisition place, then the scene). */
  readonly deviation: ScheduleDeviation | null;
  readonly overrides: readonly ScheduleOverride[];
  readonly alibi: PlannedAlibi;
  readonly incident: PlannedIncident;
  readonly deathAt?: number;
}

export interface PlotWorld extends IncidentWorld {
  readonly plot: PlotPlan;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

/** Steps in an order that honors `before` / `after`; ties keep the template order. */
function orderSteps(crime: CrimeData): CrimeStep[] {
  const steps = crime.plan;
  const names = new Set<string>();
  for (const { step } of steps) {
    if (names.has(step)) throw new RangeError(`Crime ${crime.id}: duplicate step ${step}`);
    names.add(step);
  }
  const edges: (readonly [string, string])[] = [];
  for (const { step, before, after } of steps) {
    for (const other of [before, after]) {
      if (other !== undefined && !names.has(other)) {
        throw new RangeError(`Crime ${crime.id}: unknown step ${other}`);
      }
    }
    if (before !== undefined) edges.push([step, before]);
    if (after !== undefined) edges.push([after, step]);
  }
  const result: CrimeStep[] = [];
  const left = [...steps];
  while (left.length > 0) {
    const index = left.findIndex(
      ({ step }) => !edges.some(([from, to]) => to === step && left.some((s) => s.step === from)),
    );
    if (index < 0) throw new RangeError(`Crime ${crime.id}: steps order has a cycle`);
    result.push(left.splice(index, 1)[0]!);
  }
  return result;
}

function targetOf(
  placeholder: string,
  plan: { meansItemId: string; victimId: string; scene: string },
): EntityRef {
  switch (placeholder) {
    case '$means':
      return { kind: 'item', id: plan.meansItemId };
    case '$victim':
      return { kind: 'character', id: plan.victimId };
    case '$location':
      return { kind: 'location', id: plan.scene };
    default:
      throw new RangeError(`Unknown plan target ${placeholder}`);
  }
}

/**
 * Chains the steps of the template into the verified window: `acquire` (the `take` of the means)
 * at the place and minute of acquisition when the culprit does not hold it, the rest one after
 * another at the scene from `opportunity.from`. A step's window ends after its duration plus the
 * slack of the opportunity, so any order-preserving delay inside the opportunity stays feasible.
 */
function layoutSteps(
  crime: CrimeData,
  world: IncidentWorld,
  opportunity: Opportunity,
): PlotStepPlan[] {
  const { victimId } = world.incident;
  const { locationId: scene, meansItemId, acquisition } = opportunity;
  const ctx = { meansItemId, victimId, scene };
  const ordered = orderSteps(crime).map((step) => ({
    step,
    duration: step.duration ?? DEFAULT_STEP_MINUTES,
    acquire: step.verb === ACQUIRE_VERB && step.target === '$means',
  }));
  const windowLength = opportunity.to - opportunity.from;
  const onScene = ordered.filter(({ acquire }) => !acquire);
  let total = onScene.reduce((sum, { duration }) => sum + duration, 0);
  // Optional steps that do not fit are dropped, last first.
  for (let i = onScene.length - 1; i >= 0 && total > windowLength; i--) {
    if (!onScene[i]!.step.optional) continue;
    total -= onScene[i]!.duration;
    onScene.splice(i, 1);
  }
  if (total > windowLength) {
    throw new RangeError(
      `Crime ${crime.id}: steps need ${total} minutes at the scene, window is ${windowLength}`,
    );
  }
  const slack = windowLength - total;

  const steps: PlotStepPlan[] = [];
  let cursor = opportunity.from;
  for (const { step, duration, acquire } of ordered) {
    const target = targetOf(step.target, ctx);
    const optional = step.optional === true;
    if (acquire) {
      if (!acquisition) continue; // held from the start of history
      steps.push({
        id: step.step,
        verb: step.verb,
        target,
        locationId: acquisition.locationId,
        window: { from: acquisition.at, to: acquisition.at + ACQUIRE_MINUTES },
        duration: ACQUIRE_MINUTES,
        optional,
        acquire: true,
      });
      continue;
    }
    if (!onScene.some((s) => s.step === step)) continue;
    steps.push({
      id: step.step,
      verb: step.verb,
      target,
      locationId: scene,
      window: { from: cursor, to: Math.min(opportunity.to, cursor + duration + slack) },
      duration,
      optional,
      acquire: false,
    });
    cursor += duration;
  }
  return steps.toSorted((a, b) => a.window.from - b.window.from);
}

function blockAt(location: string) {
  return { from: 0, to: MINUTES_PER_DAY, location, activity: PLAN_ACTIVITY, flexibility: 0 };
}

/** The same overrides IncidentSelection confirmed by re-simulation. */
function overridesOf(culpritId: string, opportunity: Opportunity): ScheduleOverride[] {
  const { deviation, acquisition, locationId: scene } = opportunity;
  if (!deviation) return [];
  const result: ScheduleOverride[] = [];
  let start = deviation.from;
  if (acquisition && acquisition.at >= deviation.from) {
    result.push({
      characterId: culpritId,
      interval: { from: start, to: acquisition.at + 1 },
      block: blockAt(acquisition.locationId),
    });
    start = acquisition.at + 1;
  }
  result.push({
    characterId: culpritId,
    interval: { from: start, to: opportunity.to },
    block: blockAt(scene),
  });
  return result;
}

/**
 * Feasibility problems of a plan against the location graph and the opportunity; empty when it
 * can be executed. Walks from the acquisition with `nextTimedStep` as the simulation does, with
 * every access item (a lower bound on travel time: IncidentSelection re-simulated the exact
 * holdings), and checks the order, windows and schedule bend.
 */
export function verifyPlot(world: IncidentWorld, plot: PlotPlan): string[] {
  const problems: string[] = [];
  const { opportunity: o, steps, deviation, overrides } = plot;
  const culprit = world.characters.find(({ id }) => id === world.incident.culpritId)!;
  const locations = world.world.locations;
  const known = new Set(locations.snapshot().locations.map(({ id }) => id));

  for (const [i, step] of steps.entries()) {
    const { id, window, duration, locationId } = step;
    if (!known.has(locationId)) problems.push(`${id}: unknown location ${locationId}`);
    if (duration <= 0 || duration > window.to - window.from) {
      problems.push(`${id}: duration ${duration} does not fit its window`);
    }
    const previous = steps[i - 1];
    if (previous && window.from < previous.window.from + previous.duration) {
      problems.push(`${id}: starts before ${previous.id} can end`);
    }
    if (!step.acquire && (window.from < o.from || window.to > o.to)) {
      problems.push(`${id}: leaves the opportunity window`);
    }
  }
  const onScene = steps.filter(({ acquire }) => !acquire);
  const needed = onScene.reduce((sum, { duration }) => sum + duration, 0);
  if (onScene.length > 0 && needed > o.to - o.from) {
    problems.push(`steps at the scene need ${needed} minutes, the window has ${o.to - o.from}`);
  }

  if (o.acquisition) {
    const { acquisition } = o;
    const acquire = steps.find((step) => step.acquire);
    if (acquire?.window.from !== acquisition.at || acquire.locationId !== acquisition.locationId) {
      problems.push('acquisition is not a step of the plan');
    }
    const actor: Actor = {
      archetypeId: culprit.archetypeId,
      itemIds: new Set(locations.accessItemIds),
    };
    let place = acquisition.locationId;
    let now = acquisition.at + ACQUIRE_MINUTES;
    for (let hops = 0; place !== o.locationId; hops++) {
      const hop =
        hops > known.size * 2 ? null : locations.nextTimedStep(place, o.locationId, actor, now);
      if (!hop) {
        problems.push(`no route from ${acquisition.locationId} to ${o.locationId}`);
        break;
      }
      place = hop.destination;
      now = hop.arriveAt;
    }
    if (place === o.locationId && now > o.from) {
      problems.push(`arrives at ${o.locationId} at ${now}, after the window start ${o.from}`);
    }
  }

  if (deviation) {
    const { from, to } = deviation.interval;
    // IncidentSelection re-simulated this one-block deviation. The opportunity can start
    // earlier while the unmodified routine already keeps the culprit at the scene.
    if (!o.deviation || from !== o.deviation.from || to !== o.deviation.to || to !== o.to) {
      problems.push('schedule bend does not cover the window verified by IncidentSelection');
    }
    if (overrides.length === 0 || overrides.length > 2) {
      problems.push(`schedule bend needs 1 or 2 overrides, has ${overrides.length}`);
    }
    for (const { interval, characterId } of overrides) {
      if (characterId !== culprit.id || interval.from < from || interval.to > to) {
        problems.push('override leaves the schedule bend');
      }
    }
  } else if (overrides.length > 0) {
    problems.push('overrides without a schedule bend');
  }
  if (plot.incident.window.from !== o.from || plot.incident.window.to !== o.to) {
    problems.push('incident window differs from the opportunity');
  }
  return problems;
}

/**
 * PlotPlanning (GEN-007): turns the chosen incident into the culprit's plan
 * (generation-pipeline.md §3). One verified opportunity is drawn from `gen/PlotPlanning/
 * opportunity`; the template steps become `ExecutePlot` goals inside it, the one schedule bend
 * gets a recorded reason, and the alibi the culprit will give is planned. A plan that fails
 * `verifyPlot` rejects the attempt.
 */
export const plotPlanning: Stage<IncidentWorld, PlotWorld> = {
  name: 'PlotPlanning',
  generate(input, { rng, content, logger }) {
    const { incident } = input;
    const crime = content.crimes.find(({ id }) => id === incident.templateId);
    if (!crime) throw new RangeError(`Crime template ${incident.templateId} is not in crimes.json`);
    const culprit: Character = input.characters.find(({ id }) => id === incident.culpritId)!;
    const opportunity = rng.fork('opportunity').pick(incident.opportunities);
    const steps = layoutSteps(crime, input, opportunity);
    const window: Interval = { from: opportunity.from, to: opportunity.to };

    let deviation: ScheduleDeviation | null = null;
    if (opportunity.deviation) {
      const reason = rng.fork('deviation').pick(DEVIATION_REASONS);
      const interval = { from: opportunity.deviation.from, to: opportunity.deviation.to };
      deviation = {
        interval,
        reason,
        fact: {
          kind: 'state',
          entity: { kind: 'character', id: culprit.id },
          property: SCHEDULE_DEVIATION_PROPERTY,
          value: reason,
          interval,
        },
      };
    }

    const calendar = new Calendar(input.world.locations.startDateTime);
    const routineAt = whereShouldBe(culprit, opportunity.from, [], calendar).location;
    const elsewhere = [
      ...new Set([
        ...culprit.routine.map(({ location }) => location),
        ...input.world.locations
          .snapshot()
          .locations.map(({ id }) => id)
          .sort(compare),
      ]),
    ].filter((id) => id !== opportunity.locationId);
    const claimedLocationId =
      routineAt !== opportunity.locationId ? routineAt : rng.fork('alibi').pick(elsewhere);

    const plot: PlotPlan = {
      templateId: incident.templateId,
      opportunity,
      steps,
      deviation,
      overrides: overridesOf(culprit.id, opportunity),
      alibi: {
        claimedLocationId,
        interval: window,
        claim: { kind: 'at', who: culprit.id, where: claimedLocationId, interval: window },
      },
      incident: {
        type: incident.type,
        victimIds: [incident.victimId],
        culpritIds: [culprit.id],
        means: opportunity.meansItemId,
        window,
      },
      ...(opportunity.deathAt !== undefined && { deathAt: opportunity.deathAt }),
    };
    const problems = verifyPlot(input, plot);
    if (problems.length > 0) {
      throw new GenerationRejection(PLOT_INFEASIBLE, `Plot is not feasible: ${problems[0]}`, {
        problems,
      });
    }
    logger.debug('plot planned', { steps: steps.length, deviation: deviation?.reason ?? null });
    return { ...input, plot };
  },
};
