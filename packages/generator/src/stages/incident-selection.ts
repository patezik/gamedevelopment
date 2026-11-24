import { whereShouldBe, type Character, type ScheduleOverride } from '@hs/core/characters';
import { PERSONALITY_TRAITS } from '@hs/core/common';
import type { ScenarioContent } from '@hs/core/content';
import { createRng, type Rng } from '@hs/core/rng';
import { SimulationRunner } from '@hs/core/simulation';
import { Calendar, TimeSystem } from '@hs/core/time';
import { TruthModel } from '@hs/core/truth';
import type { Actor, ItemPlacement, LocationGraph } from '@hs/core/world';
import { GenerationRejection, type Stage } from '../pipeline/index.ts';
import type { ConflictWorld, MotiveCandidate } from './conflict-gen.ts';
import type { GeneratedWorld } from './world-gen.ts';

type CharacterId = Character['id'];
type Trait = (typeof PERSONALITY_TRAITS)[number];
type CrimeData = ScenarioContent['crimes'][number];

/** `preset.incident.gamma` when the preset omits it. */
export const DEFAULT_CULPRIT_GAMMA = 0.7;
/** `score = motive · w1 + opportunityQuality · w2 + personalityFit · w3`, so score ∈ (0, 1]. */
export const SCORE_WEIGHTS = Object.freeze({ motive: 0.5, opportunity: 0.3, personality: 0.2 });
/** Usable window starts (one per minute) at which opportunity quality reaches 1. */
export const OPPORTUNITY_SATURATION_MINUTES = 60;
/** Earliest windows per scene checked by re-simulation before the scene is given up. */
export const VERIFIED_WINDOWS_PER_SCENE = 3;
/** Plan target that requires the victim at the scene for the whole window. */
const VICTIM_TARGET = '$victim';
export const INCIDENT_NO_FEASIBLE_CULPRIT = 'INCIDENT_NO_FEASIBLE_CULPRIT';
/** An owned item's owner archetype is not in the cast, so the world cannot be instantiated. */
export const WORLD_OWNER_ABSENT = 'WORLD_OWNER_ABSENT';

const MINUTES_PER_DAY = 1440;
const SCORE_DECIMALS = 6;
const TRAITS: readonly string[] = PERSONALITY_TRAITS;
const PLAN_ACTIVITY = 'incident_plan';
/** The TruthModel of an assessment run is scratch data; it needs a syntactically valid record. */
const SCRATCH_INCIDENT = {
  type: 'assessment',
  victimIds: [],
  culpritIds: [],
  motive: 'f_0000000000000000',
  means: 'none',
  keyEventIds: [],
  window: { from: 0, to: 1 },
};

/** Feasibility criteria, in the order they are checked. */
export const FEASIBILITY_CRITERIA = ['motive', 'capable', 'means', 'opportunity'] as const;
export type FeasibilityCriterion = (typeof FEASIBILITY_CRITERIA)[number];

/** ConflictGen output plus the world it happens in (locations, items, access). */
export interface IncidentSelectionInput extends ConflictWorld {
  readonly world: GeneratedWorld;
}

/** How the culprit gets the means: in a location, or from a character met there. */
export interface Acquisition {
  readonly locationId: string;
  /** The game minute the culprit is physically there and takes it; held from `at + 1`. */
  readonly at: number;
  readonly fromCharacterId?: CharacterId;
}

/**
 * The earliest verified window at one scene, game minutes `[from, to)` before `t = 0`, with the
 * means and the schedule change that make it possible.
 */
export interface Opportunity {
  readonly locationId: string;
  readonly from: number;
  readonly to: number;
  /** Usable window starts at this scene over all means, one per minute (before re-simulation). */
  readonly starts: number;
  readonly meansItemId: string;
  /** `null` when the culprit holds the means from the start of history. */
  readonly acquisition: Acquisition | null;
  /**
   * The one changed routine block: the culprit leaves the routine at `from` and keeps the plan
   * until `to` (the window's end). `null` when the routine itself keeps the culprit at the scene.
   */
  readonly deviation: { readonly from: number; readonly to: number } | null;
  /** The earliest minute of death within `deathDelayMinutes`, before `t = 0`. */
  readonly deathAt?: number;
}

/** A character who could commit the crime against the victim. Not an accusation. */
export interface FeasibleCulprit {
  readonly characterId: CharacterId;
  /** The strongest motive against the victim at or above `preset.incident.minMotive`. */
  readonly motive: MotiveCandidate;
  /** Means of the opportunities, sorted. */
  readonly meansItemIds: readonly string[];
  /** One entry per scene with a verified window, sorted by `from`, then `locationId`. */
  readonly opportunities: readonly Opportunity[];
  readonly opportunityQuality: number;
  readonly personalityFit: number;
  readonly score: number;
}

/** Every character's feasibility against one victim for one crime template. */
export interface IncidentOption {
  readonly victimId: CharacterId;
  readonly templateId: string;
  readonly incidentType: string;
  /** Sorted by character id. */
  readonly feasible: readonly FeasibleCulprit[];
  /** Characters that failed, counted by the first criterion they failed. */
  readonly rejected: Readonly<Record<FeasibilityCriterion, number>>;
}

/** All victim × template options of a world. Deterministic and free of randomness. */
export interface IncidentAssessment {
  /** Characters allowed as victims by `preset.incident.victimConstraints`, sorted. */
  readonly victimIds: readonly CharacterId[];
  /** Templates allowed by the preset (`templates` with an allowed `incidentType`), sorted. */
  readonly templateIds: readonly string[];
  /** Sorted by victim, then template. */
  readonly options: readonly IncidentOption[];
  /** Windows that passed the routine-level check but not the re-simulation. */
  readonly windowsRejectedBySimulation: number;
}

/** The chosen incident. Server truth: keep out of player and phone views. */
export interface IncidentPlan {
  readonly type: string;
  readonly templateId: string;
  readonly victimId: CharacterId;
  readonly culpritId: CharacterId;
  readonly motive: MotiveCandidate;
  readonly meansItemIds: readonly string[];
  readonly opportunities: readonly Opportunity[];
  readonly score: number;
}

export interface IncidentTemplateStats {
  /** Eligible victims with at least one feasible culprit. */
  readonly victimsWithCulprit: number;
  /** Feasible (victim, culprit) pairs. */
  readonly pairs: number;
  /** Distinct feasible culprits, sorted. */
  readonly culprits: readonly CharacterId[];
}

/** Server diagnostics for sweeps (generation-pipeline.md §4). Keep out of player and phone views. */
export interface IncidentReport {
  readonly gamma: number;
  readonly victimsEligible: number;
  /** Feasible culprits for the chosen victim and template. */
  readonly feasibleCulpritCount: number;
  /** Feasible (victim, template, culprit) triples in the world. */
  readonly feasibleTriples: number;
  readonly byTemplate: Readonly<Record<string, IncidentTemplateStats>>;
  /** Over all (victim, template, character) triples, by the first failed criterion. */
  readonly rejected: Readonly<Record<FeasibilityCriterion, number>>;
  readonly windowsRejectedBySimulation: number;
  readonly chosen: {
    readonly victimArchetype: string;
    readonly culpritArchetype: string;
    readonly template: string;
    readonly motiveType: string;
  };
}

export interface IncidentWorld extends IncidentSelectionInput {
  readonly incident: IncidentPlan;
  readonly incidentReport: IncidentReport;
}

interface TraitBound {
  readonly trait: Trait;
  readonly gt?: number;
  readonly lt?: number;
}

interface Template {
  readonly id: string;
  readonly incidentType: string;
  readonly itemTag: string;
  readonly itemId?: string;
  readonly window: number;
  readonly scenes: readonly string[];
  readonly traits: readonly TraitBound[];
  readonly victimPresent: boolean;
  readonly deathDelay?: readonly [number, number];
}

/** A run of minutes during which a character follows one routine block. */
interface Segment {
  readonly from: number;
  readonly to: number;
  readonly location: string;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

function round(value: number): number {
  const scale = 10 ** SCORE_DECIMALS;
  return Math.round(value * scale) / scale;
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}

function emptyRejections(): Record<FeasibilityCriterion, number> {
  return { motive: 0, capable: 0, means: 0, opportunity: 0 };
}

function traitsOf(crime: CrimeData): TraitBound[] {
  return Object.entries(crime.requires.traits)
    .sort(([a], [b]) => compare(a, b))
    .map(([trait, bound]): TraitBound => {
      if (!TRAITS.includes(trait)) {
        throw new RangeError(`Crime template ${crime.id}: unknown trait ${trait}`);
      }
      const keys = bound !== null && typeof bound === 'object' ? Object.keys(bound) : [];
      const { gt, lt } = (bound ?? {}) as { gt?: unknown; lt?: unknown };
      const valid = (value: unknown) =>
        value === undefined || (typeof value === 'number' && value >= 0 && value <= 1);
      if (
        Array.isArray(bound) ||
        keys.length === 0 ||
        keys.some((key) => key !== 'gt' && key !== 'lt') ||
        !valid(gt) ||
        !valid(lt)
      ) {
        throw new RangeError(
          `Crime template ${crime.id}: trait ${trait} needs { gt?, lt? } bounds within [0, 1]`,
        );
      }
      if (typeof gt === 'number' && typeof lt === 'number' && gt >= lt) {
        throw new RangeError(`Crime template ${crime.id}: trait ${trait} bounds never hold`);
      }
      return {
        trait: trait as Trait,
        ...(typeof gt === 'number' && { gt }),
        ...(typeof lt === 'number' && { lt }),
      };
    });
}

/** Preset-allowed templates. `locationTags` are all required: a scene carries every tag. */
function templatesOf(content: ScenarioContent): Template[] {
  const { types, templates } = content.preset.incident;
  const allowed = new Set(templates);
  const ids = new Set<string>();
  const result = content.crimes
    .filter(({ id, incidentType }) => allowed.has(id) && types.includes(incidentType))
    .toSorted((a, b) => compare(a.id, b.id))
    .map((crime): Template => {
      if (ids.has(crime.id)) throw new RangeError(`Crime template ${crime.id}: duplicate id`);
      ids.add(crime.id);
      const { means, minWindowMinutes, locationTags } = crime.requires;
      const scenes = content.locations
        .filter(({ tags }) => locationTags.every((tag) => tags.includes(tag)))
        .map(({ id }) => id)
        .sort(compare);
      return {
        id: crime.id,
        incidentType: crime.incidentType,
        itemTag: means.itemTag,
        ...(means.itemId !== undefined && { itemId: means.itemId }),
        window: minWindowMinutes,
        scenes,
        traits: traitsOf(crime),
        victimPresent: crime.plan.some(({ target }) => target === VICTIM_TARGET),
        ...(crime.deathDelayMinutes && { deathDelay: crime.deathDelayMinutes }),
      };
    });
  for (const id of allowed) {
    if (!content.crimes.some((crime) => crime.id === id)) {
      throw new RangeError(`Preset template ${id} is not in crimes.json`);
    }
  }
  return result;
}

function capable(character: Character, traits: readonly TraitBound[]): boolean {
  return traits.every(({ trait, gt, lt }) => {
    const value = character.personality[trait];
    return (
      value !== undefined && (gt === undefined || value > gt) && (lt === undefined || value < lt)
    );
  });
}

/** Mean depth inside each required bound, normalized to [0, 1]; 1 without requirements. */
function personalityFit(character: Character, traits: readonly TraitBound[]): number {
  const depths = traits.flatMap(({ trait, gt, lt }) => {
    const value = character.personality[trait];
    return [
      ...(gt === undefined ? [] : [gt >= 1 ? 1 : (value - gt) / (1 - gt)]),
      ...(lt === undefined ? [] : [lt <= 0 ? 1 : (lt - value) / lt]),
    ];
  });
  if (depths.length === 0) return 1;
  return Math.min(1, Math.max(0, depths.reduce((sum, depth) => sum + depth, 0) / depths.length));
}

interface Move {
  readonly itemId: string;
  readonly characterId: CharacterId;
  readonly t: number;
}

/**
 * Runs the routines of the whole cast through `SimulationRunner` over history, as
 * HistorySimulation does: characters walk hop by hop (`nextTimedStep`) and are in transit between
 * locations. `overrides` and `moves` describe one culprit's plan; without them it is the baseline.
 */
function simulate(
  world: GeneratedWorld,
  owners: ReadonlyMap<string, CharacterId>,
  cast: readonly Character[],
  historyStart: number,
  overrides: readonly ScheduleOverride[] = [],
  moves: readonly Move[] = [],
): TruthModel {
  const calendar = new Calendar(world.locations.startDateTime);
  const time = new TimeSystem(calendar, 0, historyStart);
  const state = world.createWorldState(owners);
  for (const { itemId, characterId, t } of moves) {
    state.items.move(itemId, { kind: 'character', id: characterId }, t, PLAN_ACTIVITY);
  }
  const truth = new TruthModel(SCRATCH_INCIDENT);
  new SimulationRunner({
    time,
    calendar,
    world: state.locations,
    items: state.items,
    truth,
    // Movement uses no randomness; perception draws from this stream and is discarded.
    rng: createRng('IncidentSelection/simulation'),
    characters: cast,
    overrides,
    // Everyone starts where the routine says, even in a location closed at that minute.
    initialLocations: new Map(
      cast.map((c) => [c.id, whereShouldBe(c, historyStart, [], calendar).location]),
    ),
    itemChangeMinutes: moves.map(({ t }) => t),
    endAt: 0,
  });
  time.advance(-historyStart);
  return truth;
}

/** A way for the culprit to be at the scene from `arrival`, holding the means. */
interface Route {
  /** End of the routine block occurrence the plan stays within. */
  readonly until: number;
  /** Where the changed block starts. */
  readonly departure: number;
  readonly arrival: number;
  readonly acquisition: Acquisition | null;
}

interface MeansAccess {
  readonly itemId: string;
  /** Root placement: a location or a character (containers resolved). */
  readonly at: ItemPlacement;
  /** Access items the culprit holds once holding this item (the item and keys inside it). */
  readonly keys: readonly string[];
}

interface Candidate {
  readonly locationId: string;
  readonly from: number;
  readonly meansItemId: string;
  readonly acquisition: Acquisition | null;
  readonly deviation: { readonly from: number; readonly to: number } | null;
  readonly deathAt?: number;
}

/**
 * Feasibility of every character for every victim and template (generation-pipeline.md §3).
 * Presence comes from a baseline run of `SimulationRunner`; the culprit's plan is routed with
 * `LocationGraph.nextTimedStep` and every reported window is confirmed by re-simulating the plan.
 * It uses no randomness that affects the result: the stage and seed sweeps share it.
 */
class Assessor {
  readonly #input: IncidentSelectionInput;
  readonly #content: ScenarioContent;
  readonly #locations: LocationGraph;
  readonly #locationIds: readonly string[];
  readonly #cast: readonly Character[];
  readonly #index: ReadonlyMap<CharacterId, number>;
  readonly #owners: ReadonlyMap<string, CharacterId>;
  readonly #historyStart: number;
  readonly #startMinute: number;
  /** Per character: runs of one routine block over `[historyStart, 0)`. */
  readonly #segments: readonly (readonly Segment[])[];
  readonly #items: readonly {
    readonly id: string;
    readonly tags: readonly string[];
    readonly at: ItemPlacement;
    readonly chain: readonly string[];
  }[];
  /** Per character, per history minute: index into `#locationIds`, or −1 in transit. */
  readonly #position: readonly Int16Array[];
  readonly #arrivals = new Map<string, number | null>();
  readonly #routes = new Map<string, readonly Route[]>();
  #rejectedBySimulation = 0;

  constructor(input: IncidentSelectionInput, content: ScenarioContent) {
    this.#input = input;
    this.#content = content;
    this.#locations = input.world.locations;
    this.#locationIds = this.#locations
      .snapshot()
      .locations.map(({ id }) => id)
      .sort(compare);
    this.#cast = input.characters.toSorted((a, b) => compare(a.id, b.id));
    if (new Set(this.#cast.map(({ id }) => id)).size !== this.#cast.length) {
      throw new RangeError('Character ids must be unique');
    }
    this.#index = new Map(this.#cast.map(({ id }, index) => [id, index]));
    this.#historyStart = content.preset.time.historyStartMinutes;
    const { hh, mm } = new Calendar(this.#locations.startDateTime).toDisplay(0);
    this.#startMinute = hh * 60 + mm;
    const blocks = this.#cast.map((character) => {
      const day = new Int16Array(MINUTES_PER_DAY).fill(-1);
      character.routine.forEach(({ from, to }, block) => {
        for (let minute = from; minute !== to; minute = (minute + 1) % MINUTES_PER_DAY) {
          day[minute] = block;
          if (to === MINUTES_PER_DAY && minute === MINUTES_PER_DAY - 1) break;
        }
      });
      const gap = day.indexOf(-1);
      if (gap >= 0) throw new RangeError(`Routine of ${character.id} has a gap at minute ${gap}`);
      return day;
    });
    const blockAt = (index: number, t: number) =>
      blocks[index]![mod(this.#startMinute + t, MINUTES_PER_DAY)]!;
    this.#segments = this.#cast.map((character, index) => {
      const segments: Segment[] = [];
      let start = this.#historyStart;
      for (let t = this.#historyStart + 1; t <= 0; t++) {
        if (t < 0 && blockAt(index, t) === blockAt(index, start)) continue;
        segments.push({
          from: start,
          to: t,
          location: character.routine[blockAt(index, start)]!.location,
        });
        start = t;
      }
      return segments;
    });

    this.#owners = this.#ownersOf();
    const { initial } = input.world.createWorldState(this.#owners).items.snapshot();
    const placements = new Map(initial.map(({ item, placement }) => [item.id, placement]));
    this.#items = initial
      .map(({ item, placement }) => {
        const chain: string[] = [];
        let current = placement;
        while (current.kind === 'container' && !chain.includes(current.id)) {
          chain.push(current.id);
          current = placements.get(current.id) ?? current;
        }
        return { id: item.id, tags: item.tags, at: current, chain };
      })
      .sort((a, b) => compare(a.id, b.id));

    const length = Math.max(0, -this.#historyStart);
    this.#position = this.#cast.map(() => new Int16Array(length).fill(-1));
    if (length > 0) {
      const truth = simulate(input.world, this.#owners, this.#cast, this.#historyStart);
      const locationIndex = new Map(this.#locationIds.map((id, index) => [id, index]));
      this.#cast.forEach(({ id }, index) => {
        const row = this.#position[index]!;
        for (const { location, interval } of truth.presenceIntervals(id)) {
          const from = Math.max(interval.from, this.#historyStart);
          const to = Math.min(interval.to, 0);
          for (let t = from; t < to; t++)
            row[t - this.#historyStart] = locationIndex.get(location)!;
        }
      });
    }
  }

  /**
   * The owner of each owned item (first cast member of the owner archetype by id). An owner
   * archetype missing from this cast makes the world impossible to instantiate (the item needs
   * exactly one initial placement), so the world is rejected for regeneration.
   */
  #ownersOf(): Map<string, CharacterId> {
    const owners = new Map<string, CharacterId>();
    for (const { archetypeId, id } of this.#cast) {
      if (!owners.has(archetypeId)) owners.set(archetypeId, id);
    }
    const variant = this.#content.preset.world?.variants?.find(
      ({ id }) => id === this.#input.world.variantId,
    );
    const missing: { itemId: string; ownerArchetype: string }[] = [];
    for (const item of this.#content.items) {
      const spawn = variant?.spawns?.find(({ itemId }) => itemId === item.id);
      const owner = spawn
        ? spawn.placement.kind === 'archetype'
          ? spawn.placement.id
          : undefined
        : item.ownerArchetype;
      if (owner !== undefined && !owners.has(owner)) {
        missing.push({ itemId: item.id, ownerArchetype: owner });
      }
    }
    if (missing.length > 0) {
      throw new GenerationRejection(
        WORLD_OWNER_ABSENT,
        `Owners missing from the cast: ${missing.map(({ itemId, ownerArchetype }) => `${itemId} → ${ownerArchetype}`).join(', ')}`,
        { missing },
      );
    }
    return owners;
  }

  assess(): IncidentAssessment {
    const { excludeArchetypes } = this.#content.preset.incident.victimConstraints;
    const victims = this.#cast.filter(
      ({ archetypeId }) => !excludeArchetypes.includes(archetypeId),
    );
    const templates = templatesOf(this.#content);
    const threshold = this.#content.preset.incident.minMotive;
    const strongest = new Map<string, MotiveCandidate>();
    for (const candidate of this.#input.motives) {
      if (candidate.strength < threshold) continue;
      const key = `${candidate.who}|${candidate.against}`;
      const known = strongest.get(key);
      if (
        !known ||
        candidate.strength > known.strength ||
        (candidate.strength === known.strength &&
          compare(candidate.motiveType, known.motiveType) < 0)
      ) {
        strongest.set(key, candidate);
      }
    }

    const options: IncidentOption[] = [];
    for (const victim of victims) {
      for (const template of templates) {
        const rejected = emptyRejections();
        const feasible: FeasibleCulprit[] = [];
        for (const culprit of this.#cast) {
          if (culprit.id === victim.id) continue;
          const result = this.#evaluate(
            culprit,
            victim,
            template,
            strongest.get(`${culprit.id}|${victim.id}`),
          );
          if (typeof result === 'string') rejected[result]++;
          else feasible.push(result);
        }
        options.push({
          victimId: victim.id,
          templateId: template.id,
          incidentType: template.incidentType,
          feasible,
          rejected,
        });
      }
    }
    return {
      victimIds: victims.map(({ id }) => id),
      templateIds: templates.map(({ id }) => id),
      options,
      windowsRejectedBySimulation: this.#rejectedBySimulation,
    };
  }

  #evaluate(
    culprit: Character,
    victim: Character,
    template: Template,
    motive: MotiveCandidate | undefined,
  ): FeasibleCulprit | FeasibilityCriterion {
    if (!motive) return 'motive';
    if (!capable(culprit, template.traits)) return 'capable';
    const c = this.#index.get(culprit.id)!;
    const v = this.#index.get(victim.id)!;
    const means = this.#meansOf(template).filter((item) => this.#canAcquire(c, item));
    if (means.length === 0) return 'means';

    // Each candidate is one means with one window; candidates are re-simulated in time order.
    const opportunities: Opportunity[] = [];
    for (const scene of template.scenes) {
      const starts = new Set<number>();
      const candidates: Candidate[] = [];
      for (const item of means) {
        for (const candidate of this.#windows(c, v, template, item, scene)) {
          starts.add(candidate.from);
          candidates.push(candidate);
        }
      }
      candidates.sort((a, b) => a.from - b.from || compare(a.meansItemId, b.meansItemId));
      for (const candidate of candidates.slice(0, VERIFIED_WINDOWS_PER_SCENE)) {
        if (this.#confirm(c, v, template, candidate)) {
          opportunities.push({
            locationId: scene,
            from: candidate.from,
            to: candidate.from + template.window,
            starts: starts.size,
            meansItemId: candidate.meansItemId,
            acquisition: candidate.acquisition,
            deviation: candidate.deviation,
            ...(candidate.deathAt !== undefined && { deathAt: candidate.deathAt }),
          });
          break;
        }
        this.#rejectedBySimulation++;
      }
    }
    if (opportunities.length === 0) return 'opportunity';
    opportunities.sort((a, b) => a.from - b.from || compare(a.locationId, b.locationId));

    const usable = opportunities.reduce((sum, { starts }) => sum + starts, 0);
    const opportunityQuality = round(Math.min(1, usable / OPPORTUNITY_SATURATION_MINUTES));
    const fit = round(personalityFit(culprit, template.traits));
    const score = round(
      SCORE_WEIGHTS.motive * motive.strength +
        SCORE_WEIGHTS.opportunity * opportunityQuality +
        SCORE_WEIGHTS.personality * fit,
    );
    return {
      characterId: culprit.id,
      motive,
      meansItemIds: [...new Set(opportunities.map(({ meansItemId }) => meansItemId))].sort(compare),
      opportunities,
      opportunityQuality,
      personalityFit: fit,
      score,
    };
  }

  /** Items with the template's tag (and id): where they start and the keys they carry. */
  #meansOf(template: Template): MeansAccess[] {
    return this.#items
      .filter(
        ({ id, tags, at }) =>
          tags.includes(template.itemTag) &&
          (template.itemId === undefined || id === template.itemId) &&
          at.kind !== 'container',
      )
      .map(({ id, at }) => ({
        itemId: id,
        at,
        keys: this.#locations.accessItemIds.filter(
          (key) => key === id || this.#items.find((item) => item.id === key)?.chain.includes(id),
        ),
      }));
  }

  /** Access items the culprit holds from the start (carried, also inside carried containers). */
  #ownKeys(c: number): string[] {
    const id = this.#cast[c]!.id;
    return this.#items
      .filter(
        ({ id: itemId, at }) =>
          at.kind === 'character' && at.id === id && this.#locations.accessItemIds.includes(itemId),
      )
      .map(({ id: itemId }) => itemId);
  }

  #actor(c: number, extra: readonly string[] = []): Actor {
    return {
      archetypeId: this.#cast[c]!.archetypeId,
      itemIds: new Set([...this.#ownKeys(c), ...extra]),
    };
  }

  /**
   * The first history minute the culprit's own routine lets them take the item: physically in
   * its location, or in the same location as its holder. `null` if the culprit holds it from the
   * start, `undefined` if the routine never brings them to it.
   */
  #naturally(c: number, means: MeansAccess): Acquisition | null | undefined {
    const { at } = means;
    if (at.kind === 'character' && at.id === this.#cast[c]!.id) return null;
    const holderId = at.kind === 'character' ? at.id : undefined;
    const holder = holderId === undefined ? undefined : this.#position[this.#index.get(holderId)!]!;
    const place = at.kind === 'location' ? this.#locationIds.indexOf(at.id) : -1;
    const row = this.#position[c]!;
    for (let offset = 0; offset < row.length; offset++) {
      const here = row[offset]!;
      if (here < 0 || (holder ? holder[offset] !== here : here !== place)) continue;
      return {
        locationId: this.#locationIds[here]!,
        at: this.#historyStart + offset,
        ...(holderId !== undefined && { fromCharacterId: holderId }),
      };
    }
    return undefined;
  }

  /**
   * Where the one changed block may start in each routine block occurrence: at the start of
   * history, or at any minute the culprit is physically somewhere (not in transit) the minute
   * before. Only the earliest start per (position, holding the means) matters, since waiting is
   * always possible.
   */
  #sources(c: number, natural: Acquisition | null | undefined) {
    const row = this.#position[c]!;
    return this.#segments[c]!.map((segment) => {
      const seen = new Set<string>();
      const starts: { readonly from: number; readonly at: string; readonly holding: boolean }[] =
        [];
      for (let from = segment.from; from < segment.to; from++) {
        const before = from === this.#historyStart ? -1 : row[from - 1 - this.#historyStart]!;
        if (from !== this.#historyStart && before < 0) continue;
        const at = before < 0 ? segment.location : this.#locationIds[before]!;
        const holding = natural === null || (natural !== undefined && natural.at < from);
        if (seen.has(`${at}|${holding}`)) continue;
        seen.add(`${at}|${holding}`);
        starts.push({ from, at, holding });
      }
      return { until: segment.to, starts };
    });
  }

  /** Whether the culprit can take this means at all before `t = 0`. */
  #canAcquire(c: number, means: MeansAccess): boolean {
    const natural = this.#naturally(c, means);
    if (natural !== undefined) return true;
    const without = this.#actor(c);
    return this.#sources(c, natural).some(({ starts }) =>
      starts.some(({ from, at }) => this.#meetings(at, from, means, without).length > 0),
    );
  }

  /**
   * Ways to be at `scene` holding the means, at most one per routine block occurrence, all within
   * one changed block: the culprit starts where they physically are when it begins, walks with
   * `nextTimedStep`, takes the means (in its location, or from its holder when both are there)
   * and walks on to the scene. The means' keys count only after it is taken.
   */
  #routesTo(c: number, means: MeansAccess, scene: string): readonly Route[] {
    const key = `${c}|${means.itemId}|${scene}`;
    const cached = this.#routes.get(key);
    if (cached) return cached;
    const without = this.#actor(c);
    const holding = this.#actor(c, means.keys);
    const natural = this.#naturally(c, means);
    const routes: Route[] = [];
    for (const { until, starts } of this.#sources(c, natural)) {
      let best: Route | undefined;
      for (const { from, at, holding: has } of starts) {
        const found = has
          ? this.#plan(at, from, scene, holding, natural ?? null)
          : this.#fetch(at, from, scene, means, without, holding);
        if (found && found.arrival < until && (!best || found.arrival < best.arrival)) {
          best = { until, departure: from, ...found };
        }
      }
      if (best) routes.push(best);
    }
    this.#routes.set(key, routes);
    return routes;
  }

  #plan(from: string, at: number, scene: string, actor: Actor, acquisition: Acquisition | null) {
    const arrival = this.#arrive(from, scene, actor, at);
    return arrival === null ? undefined : { arrival, acquisition };
  }

  /** The earliest meeting with the means per place: its location, or each place of its holder. */
  #meetings(from: string, at: number, means: MeansAccess, without: Actor): Acquisition[] {
    if (means.at.kind === 'location') {
      const taken = this.#arrive(from, means.at.id, without, at);
      return taken === null ? [] : [{ locationId: means.at.id, at: taken }];
    }
    if (means.at.kind !== 'character') return [];
    const holderId = means.at.id;
    const holder = this.#position[this.#index.get(holderId)!]!;
    const meetings: Acquisition[] = [];
    for (const [place, location] of this.#locationIds.entries()) {
      const there = this.#arrive(from, location, without, at);
      if (there === null) continue;
      let met = there - this.#historyStart;
      while (met < holder.length && holder[met] !== place) met++;
      if (met < holder.length) {
        meetings.push({
          locationId: location,
          at: this.#historyStart + met,
          fromCharacterId: holderId,
        });
      }
    }
    return meetings;
  }

  /** Walk to the means, take it, walk to the scene; the earliest arrival over meetings. */
  #fetch(
    from: string,
    at: number,
    scene: string,
    means: MeansAccess,
    without: Actor,
    holding: Actor,
  ) {
    let best: { arrival: number; acquisition: Acquisition } | undefined;
    for (const acquisition of this.#meetings(from, at, means, without)) {
      const found = this.#plan(
        acquisition.locationId,
        acquisition.at + 1,
        scene,
        holding,
        acquisition,
      );
      if (found && (!best || found.arrival < best.arrival)) {
        best = { arrival: found.arrival, acquisition };
      }
    }
    return best;
  }

  /**
   * Earliest arrival walking hop by hop with `LocationGraph.nextTimedStep`, as `SimulationRunner`
   * does: waiting for locked hours, only through doors the actor can open. `null` when the
   * target cannot be reached before `t = 0`.
   */
  #arrive(from: string, to: string, actor: Actor, at: number): number | null {
    const key = `${from}|${to}|${[...(actor.itemIds ?? [])].sort().join(',')}|${actor.archetypeId}|${at}`;
    if (this.#arrivals.has(key)) return this.#arrivals.get(key)!;
    let location = from;
    let now = at;
    let result: number | null = now;
    for (let hops = 0; location !== to; hops++) {
      const hop =
        hops > this.#locationIds.length * 2
          ? null
          : this.#locations.nextTimedStep(location, to, actor, now);
      if (!hop || hop.arriveAt >= 0) {
        result = null;
        break;
      }
      location = hop.destination;
      now = hop.arriveAt;
      result = now;
    }
    if (result !== null && result >= 0) result = null;
    this.#arrivals.set(key, result);
    return result;
  }

  /** Window candidates at `scene` with `itemId`, by start: routine-level presence checks. */
  #windows(
    c: number,
    v: number,
    template: Template,
    means: MeansAccess,
    scene: string,
  ): Candidate[] {
    const { itemId } = means;
    const { window, victimPresent, deathDelay } = template;
    const place = this.#locationIds.indexOf(scene);
    const length = this.#position[c]!.length;
    const culprit = this.#position[c]!;
    const victim = this.#position[v]!;
    // valid[i]: nobody but the culprit (and the victim of a plan on them) is at the scene, and
    // that victim is there.
    const valid = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      let ok = !victimPresent || victim[i] === place;
      for (let other = 0; ok && other < this.#cast.length; other++) {
        if (other === c || (victimPresent && other === v)) continue;
        ok = this.#position[other]![i] !== place;
      }
      valid[i] = Number(ok);
    }
    const prefix = new Int32Array(length + 1);
    const present = new Int32Array(length + 1);
    for (let i = 0; i < length; i++) {
      prefix[i + 1] = prefix[i]! + valid[i]!;
      present[i + 1] = present[i]! + Number(culprit[i] === place);
    }
    const windowOk = (s: number) => {
      const i = s - this.#historyStart;
      return prefix[i + window]! - prefix[i]! === window;
    };
    const deathAt = (s: number): number | undefined | null => {
      if (!deathDelay) return undefined;
      const end = s + window;
      if (victimPresent) return end + deathDelay[0] <= -1 ? end + deathDelay[0] : null;
      for (let d = end + deathDelay[0]; d <= Math.min(end + deathDelay[1], -1); d++) {
        if (victim[d - this.#historyStart] === place) return d;
      }
      return null;
    };

    const result: Candidate[] = [];
    const add = (
      s: number,
      route: Omit<Candidate, 'locationId' | 'from' | 'meansItemId' | 'deathAt'>,
    ) => {
      const death = deathAt(s);
      if (death === null) return false;
      result.push({
        locationId: scene,
        from: s,
        meansItemId: itemId,
        ...route,
        ...(death !== undefined && { deathAt: death }),
      });
      return true;
    };

    // The routine already keeps the culprit at the scene, holding the means.
    const natural = this.#naturally(c, means);
    if (natural !== undefined) {
      const from = natural === null ? this.#historyStart : natural.at + 1;
      for (let s = from; s + window <= 0; s++) {
        const i = s - this.#historyStart;
        if (present[i + window]! - present[i]! !== window || !windowOk(s)) continue;
        add(s, { acquisition: natural, deviation: null });
      }
    }
    // One changed block. If the culprit is already at the scene when it starts, the window may
    // begin earlier, while the routine still keeps them there holding the means.
    for (const route of this.#routesTo(c, means, scene)) {
      let first = route.arrival;
      const held = (s: number) =>
        route.acquisition === null ||
        (route.acquisition.at < s && route.acquisition.at < route.departure);
      if (route.arrival === route.departure) {
        while (
          first > this.#historyStart &&
          culprit[first - 1 - this.#historyStart] === place &&
          held(first - 1)
        ) {
          first--;
        }
      }
      for (let s = first; s + window <= route.until; s++) {
        if (!windowOk(s)) continue;
        add(s, {
          acquisition: route.acquisition,
          deviation: { from: route.departure, to: s + window },
        });
      }
    }
    return result;
  }

  /**
   * Re-simulates the plan: the culprit's changed block becomes schedule overrides (to the place
   * of acquisition, then to the scene), the means moves to the culprit when taken. The window
   * holds when the run puts the culprit (and the victim of a plan on them) at the scene for every
   * minute, nobody else is there, the acquisition happened in person, and a delayed death finds
   * the victim at the scene before `t = 0`.
   */
  #confirm(c: number, v: number, template: Template, candidate: Candidate): boolean {
    const culprit = this.#cast[c]!;
    const victim = this.#cast[v]!;
    const { locationId: scene, from, acquisition, deviation, meansItemId } = candidate;
    const to = from + template.window;
    const block = (location: string) => ({
      from: 0,
      to: MINUTES_PER_DAY,
      location,
      activity: PLAN_ACTIVITY,
      flexibility: 0,
    });
    const overrides: ScheduleOverride[] = [];
    if (deviation) {
      let start = deviation.from;
      if (acquisition && acquisition.at >= deviation.from) {
        overrides.push({
          characterId: culprit.id,
          interval: { from: start, to: acquisition.at + 1 },
          block: block(acquisition.locationId),
        });
        start = acquisition.at + 1;
      }
      overrides.push({
        characterId: culprit.id,
        interval: { from: start, to },
        block: block(scene),
      });
    }
    const moves = acquisition
      ? [{ itemId: meansItemId, characterId: culprit.id, t: acquisition.at + 1 }]
      : [];
    const truth = simulate(
      this.#input.world,
      this.#owners,
      this.#cast,
      this.#historyStart,
      overrides,
      moves,
    );
    if (acquisition) {
      if (truth.whereWas(culprit.id, acquisition.at) !== acquisition.locationId) return false;
      const { fromCharacterId: holder } = acquisition;
      if (holder && truth.whereWas(holder, acquisition.at) !== acquisition.locationId) return false;
    }
    for (let t = from; t < to; t++) {
      if (truth.whereWas(culprit.id, t) !== scene) return false;
      if (template.victimPresent && truth.whereWas(victim.id, t) !== scene) return false;
    }
    const allowed = new Set([culprit.id, ...(template.victimPresent ? [victim.id] : [])]);
    if (truth.whoWasAt(scene, { from, to }).some((id) => !allowed.has(id))) return false;
    const { deathAt } = candidate;
    if (deathAt !== undefined && !template.victimPresent) {
      if (truth.whereWas(victim.id, deathAt) !== scene) return false;
    }
    return true;
  }
}

/**
 * Feasibility of every eligible victim × allowed template × character pair, without choosing.
 * IncidentSelection chooses from it; seed sweeps use it to measure template feasibility.
 */
export function assessIncidents(
  input: IncidentSelectionInput,
  content: ScenarioContent,
): IncidentAssessment {
  return new Assessor(input, content).assess();
}

function gammaOf(content: ScenarioContent): number {
  return content.preset.incident.gamma ?? DEFAULT_CULPRIT_GAMMA;
}

function reportOf(
  assessment: IncidentAssessment,
  gamma: number,
): Omit<IncidentReport, 'feasibleCulpritCount' | 'chosen'> {
  const rejected = emptyRejections();
  const byTemplate: Record<string, IncidentTemplateStats> = {};
  for (const templateId of assessment.templateIds) {
    const options = assessment.options.filter((option) => option.templateId === templateId);
    byTemplate[templateId] = {
      victimsWithCulprit: options.filter(({ feasible }) => feasible.length > 0).length,
      pairs: options.reduce((sum, { feasible }) => sum + feasible.length, 0),
      culprits: [
        ...new Set(
          options.flatMap(({ feasible }) => feasible.map(({ characterId }) => characterId)),
        ),
      ].sort(compare),
    };
  }
  for (const option of assessment.options) {
    for (const criterion of FEASIBILITY_CRITERIA) rejected[criterion] += option.rejected[criterion];
  }
  return {
    gamma,
    victimsEligible: assessment.victimIds.length,
    feasibleTriples: assessment.options.reduce((sum, { feasible }) => sum + feasible.length, 0),
    byTemplate,
    rejected,
    windowsRejectedBySimulation: assessment.windowsRejectedBySimulation,
  };
}

/** Victim weight: salience (distinct relationship partners) times motives against the victim. */
function victimWeights(
  input: IncidentSelectionInput,
  victimIds: readonly CharacterId[],
  threshold: number,
) {
  return victimIds.map((id) => {
    const partners = new Set(
      input.relationships.neighbors(id).map(({ a, b }) => (a === id ? b : a)),
    ).size;
    const motives = input.motives.filter(
      ({ against, strength }) => against === id && strength >= threshold,
    ).length;
    return { value: id, weight: (1 + partners) * (1 + motives) };
  });
}

function choose(
  input: IncidentSelectionInput,
  assessment: IncidentAssessment,
  content: ScenarioContent,
  rng: Rng,
): { option: IncidentOption; culprit: FeasibleCulprit } | undefined {
  const gamma = gammaOf(content);
  const byVictim = new Map<CharacterId, IncidentOption[]>();
  for (const option of assessment.options) {
    byVictim.set(option.victimId, [...(byVictim.get(option.victimId) ?? []), option]);
  }
  const victims = rng.fork('victim');
  const pool = victimWeights(input, assessment.victimIds, content.preset.incident.minMotive);
  while (pool.length > 0) {
    const victimId = victims.weighted(pool);
    pool.splice(
      pool.findIndex(({ value }) => value === victimId),
      1,
    );
    for (const option of rng.fork(`template/${victimId}`).shuffle(byVictim.get(victimId) ?? [])) {
      if (option.feasible.length === 0) continue;
      const culprit = rng
        .fork(`culprit/${victimId}/${option.templateId}`)
        .weighted(option.feasible.map((value) => ({ value, weight: value.score ** gamma })));
      return { option, culprit };
    }
  }
  return undefined;
}

/**
 * The selection step of IncidentSelection on a ready assessment: victims in an order weighted by
 * salience and motives against them, templates in a shuffled order, the culprit drawn from the
 * feasible characters with weight `score^gamma`. Throws `GenerationRejection` when no victim has
 * a feasible culprit. `rng` is the stage stream (`gen/IncidentSelection`).
 */
export function selectIncident(
  input: IncidentSelectionInput,
  assessment: IncidentAssessment,
  content: ScenarioContent,
  rng: Rng,
): IncidentWorld {
  const report = reportOf(assessment, gammaOf(content));
  const choice = choose(input, assessment, content, rng);
  if (!choice) {
    throw new GenerationRejection(
      INCIDENT_NO_FEASIBLE_CULPRIT,
      'No character can commit any allowed crime against any eligible victim',
      { incidentReport: report },
    );
  }
  const { option, culprit } = choice;
  const archetype = (id: CharacterId) => input.characters.find((c) => c.id === id)!.archetypeId;
  const incident: IncidentPlan = {
    type: option.incidentType,
    templateId: option.templateId,
    victimId: option.victimId,
    culpritId: culprit.characterId,
    motive: culprit.motive,
    meansItemIds: culprit.meansItemIds,
    opportunities: culprit.opportunities,
    score: culprit.score,
  };
  const incidentReport: IncidentReport = {
    ...report,
    feasibleCulpritCount: option.feasible.length,
    chosen: {
      victimArchetype: archetype(option.victimId),
      culpritArchetype: archetype(culprit.characterId),
      template: option.templateId,
      motiveType: culprit.motive.motiveType,
    },
  };
  return { ...input, incident, incidentReport };
}

/**
 * IncidentSelection (GEN-006): chooses the victim, crime template and culprit
 * (generation-pipeline.md §3). Every character except the victim is checked for motive, means,
 * opportunity and capability (`assessIncidents`); no list of candidates is fixed in advance. The
 * choice is `selectIncident`. A world without any feasible culprit, or whose cast lacks the
 * owner of an owned item, is rejected with `GenerationRejection`, so the pipeline regenerates it.
 */
export const incidentSelection: Stage<IncidentSelectionInput, IncidentWorld> = {
  name: 'IncidentSelection',
  generate(input, { rng, content, logger }) {
    const result = selectIncident(input, assessIncidents(input, content), content, rng);
    logger.debug('incident selected', {
      template: result.incident.templateId,
      feasibleCulpritCount: result.incidentReport.feasibleCulpritCount,
    });
    return result;
  },
};
