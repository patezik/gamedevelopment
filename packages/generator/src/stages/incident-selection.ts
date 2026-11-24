import type { Character } from '@hs/core/characters';
import { PERSONALITY_TRAITS } from '@hs/core/common';
import type { ScenarioContent } from '@hs/core/content';
import type { Rng } from '@hs/core/rng';
import { Calendar } from '@hs/core/time';
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
/** Routine activities during which a present character does not witness the crime. */
export const UNAWARE_ACTIVITIES: readonly string[] = Object.freeze(['sleep']);
/** Plan target that requires the victim at the scene for the whole window. */
const VICTIM_TARGET = '$victim';
export const INCIDENT_NO_FEASIBLE_CULPRIT = 'INCIDENT_NO_FEASIBLE_CULPRIT';

const MINUTES_PER_DAY = 1440;
const SCORE_DECIMALS = 6;
const TRAITS: readonly string[] = PERSONALITY_TRAITS;

/** Feasibility criteria, in the order they are checked. */
export const FEASIBILITY_CRITERIA = ['motive', 'capable', 'means', 'opportunity'] as const;
export type FeasibilityCriterion = (typeof FEASIBILITY_CRITERIA)[number];

/** ConflictGen output plus the world it happens in (locations, items, access). */
export interface IncidentSelectionInput extends ConflictWorld {
  readonly world: GeneratedWorld;
}

/** The earliest usable window at one scene: game minutes `[from, to)` before `t = 0`. */
export interface Opportunity {
  readonly locationId: string;
  readonly from: number;
  readonly to: number;
  /** Usable window starts at this scene, one per minute. */
  readonly starts: number;
}

/** A character who could commit the crime against the victim. Not an accusation. */
export interface FeasibleCulprit {
  readonly characterId: CharacterId;
  /** The strongest motive against the victim at or above `preset.incident.minMotive`. */
  readonly motive: MotiveCandidate;
  /** Means items the character holds or can take, sorted. */
  readonly meansItemIds: readonly string[];
  /** One entry per scene with a window, sorted by `from`, then `locationId`. */
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

/**
 * Feasibility of every character for every victim and template (generation-pipeline.md §3).
 * It uses no randomness: the stage and seed sweeps share it.
 */
class Assessor {
  readonly #input: IncidentSelectionInput;
  readonly #content: ScenarioContent;
  readonly #locations: LocationGraph;
  readonly #cast: readonly Character[];
  readonly #index: ReadonlyMap<CharacterId, number>;
  readonly #historyStart: number;
  readonly #startMinute: number;
  /** Per character: routine block index for each minute of the day. */
  readonly #blocks: readonly Int16Array[];
  /** Per character: runs of one block over `[historyStart, MINUTES_PER_DAY)`. */
  readonly #segments: readonly (readonly Segment[])[];
  readonly #items: readonly {
    readonly id: string;
    readonly tags: readonly string[];
    readonly at: ItemPlacement;
  }[];
  readonly #access = new Map<string, Uint8Array>();
  readonly #travel = new Map<string, number | null>();

  constructor(input: IncidentSelectionInput, content: ScenarioContent) {
    this.#input = input;
    this.#content = content;
    this.#locations = input.world.locations;
    this.#cast = input.characters.toSorted((a, b) => compare(a.id, b.id));
    if (new Set(this.#cast.map(({ id }) => id)).size !== this.#cast.length) {
      throw new RangeError('Character ids must be unique');
    }
    this.#index = new Map(this.#cast.map(({ id }, index) => [id, index]));
    this.#historyStart = content.preset.time.historyStartMinutes;
    const { hh, mm } = new Calendar(this.#locations.startDateTime).toDisplay(0);
    this.#startMinute = hh * 60 + mm;
    this.#blocks = this.#cast.map((character) => {
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
    this.#segments = this.#cast.map((_, index) => {
      const segments: Segment[] = [];
      let start = this.#historyStart;
      for (let t = this.#historyStart + 1; t <= MINUTES_PER_DAY; t++) {
        if (t < MINUTES_PER_DAY && this.#block(index, t) === this.#block(index, start)) continue;
        segments.push({ from: start, to: t, location: this.#where(index, start) });
        start = t;
      }
      return segments;
    });

    const owners = new Map<string, CharacterId>();
    for (const { archetypeId, id } of this.#cast)
      if (!owners.has(archetypeId)) owners.set(archetypeId, id);
    const { initial } = input.world.createWorldState(owners).items.snapshot();
    const placements = new Map(initial.map(({ item, placement }) => [item.id, placement]));
    const root = (placement: ItemPlacement): ItemPlacement => {
      const seen = new Set<string>();
      let current = placement;
      while (current.kind === 'container' && !seen.has(current.id)) {
        seen.add(current.id);
        current = placements.get(current.id) ?? current;
      }
      return current;
    };
    this.#items = initial
      .map(({ item, placement }) => ({ id: item.id, tags: item.tags, at: root(placement) }))
      .sort((a, b) => compare(a.id, b.id));
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
    const owned = new Set(
      this.#items
        .filter(({ at }) => at.kind === 'character' && at.id === culprit.id)
        .map(({ id }) => id),
    );
    const keys = new Set([...owned].filter((id) => this.#locations.accessItemIds.includes(id)));
    const means = this.#means(c, culprit, template, keys);
    if (means.size === 0) return 'means';
    const acquireBy = Math.min(...means.values());
    const meansItemIds = [...means.keys()].sort(compare);
    const held = new Set([
      ...keys,
      ...meansItemIds.filter((id) => this.#locations.accessItemIds.includes(id)),
    ]);
    const actor: Actor = { archetypeId: culprit.archetypeId, itemIds: held };

    const opportunities: Opportunity[] = [];
    for (const scene of template.scenes) {
      const found = this.#opportunity(c, v, template, scene, actor, acquireBy);
      if (found) opportunities.push(found);
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
      meansItemIds,
      opportunities,
      opportunityQuality,
      personalityFit: fit,
      score,
    };
  }

  /**
   * Means items with the earliest minute the culprit can hold each. Held or carried by another
   * character: from the start of history (taking it from the bearer is PlotPlanning's work). Lying
   * in a location (directly or in a container): the first history minute the culprit may enter it
   * and has a route there from where the routine puts them.
   */
  #means(c: number, culprit: Character, template: Template, keys: ReadonlySet<string>) {
    const actor: Actor = { archetypeId: culprit.archetypeId, itemIds: keys };
    const result = new Map<string, number>();
    for (const item of this.#items) {
      if (!item.tags.includes(template.itemTag)) continue;
      if (template.itemId !== undefined && item.id !== template.itemId) continue;
      if (item.at.kind === 'character') {
        result.set(item.id, this.#historyStart);
        continue;
      }
      if (item.at.kind !== 'location') continue;
      const access = this.#accessDay(item.at.id, actor);
      for (let t = this.#historyStart; t < 0; t++) {
        if (!access[this.#minuteOfDay(t)]) continue;
        if (this.#travelTime(this.#where(c, t), item.at.id, actor) === null) continue;
        result.set(item.id, t);
        break;
      }
    }
    return result;
  }

  /**
   * The earliest usable window at `scene`: `[s, s + window)` inside history (`s + window ≤ 0`),
   * not before the means can be held. The culprit may enter the scene every minute, and nobody
   * else present there is awake — except the victim when the plan targets them, and then the
   * victim is there the whole window. At most one routine block of the culprit away from the
   * scene overlaps the window ("bent"); a bent block at the window's edge leaves room to travel.
   * A template without a victim step but with `deathDelayMinutes` needs the victim at the scene
   * at some minute of the delay after the window.
   */
  #opportunity(
    c: number,
    v: number,
    template: Template,
    scene: string,
    actor: Actor,
    acquireBy: number,
  ): Opportunity | undefined {
    const { window } = template;
    const first = Math.max(this.#historyStart, acquireBy);
    const last = -window;
    if (first > last) return undefined;
    const access = this.#accessDay(scene, actor);
    const length = -this.#historyStart;
    const usable = new Uint8Array(length);
    for (let t = this.#historyStart; t < 0; t++) {
      const minute = this.#minuteOfDay(t);
      if (!access[minute]) continue;
      if (template.victimPresent && this.#where(v, t) !== scene) continue;
      let witnessed = false;
      for (let other = 0; other < this.#cast.length && !witnessed; other++) {
        if (other === c || (template.victimPresent && other === v)) continue;
        const block = this.#routine(other, t);
        witnessed = block.location === scene && !UNAWARE_ACTIVITIES.includes(block.activity);
      }
      if (!witnessed) usable[t - this.#historyStart] = 1;
    }
    const prefix = new Int32Array(length + 1);
    for (let index = 0; index < length; index++)
      prefix[index + 1] = prefix[index]! + usable[index]!;

    let earliest: number | undefined;
    let starts = 0;
    const segments = this.#segments[c]!;
    for (let s = first; s <= last; s++) {
      const offset = s - this.#historyStart;
      if (prefix[offset + window]! - prefix[offset]! < window) continue;
      if (!this.#bendable(segments, s, s + window, scene, actor)) continue;
      if (
        !template.victimPresent &&
        template.deathDelay &&
        !this.#victimLater(v, scene, s + window, template.deathDelay)
      ) {
        continue;
      }
      earliest ??= s;
      starts++;
    }
    return earliest === undefined
      ? undefined
      : { locationId: scene, from: earliest, to: earliest + window, starts };
  }

  /** At most one culprit block away from `scene` overlaps `[from, to)`, with travel time. */
  #bendable(segments: readonly Segment[], from: number, to: number, scene: string, actor: Actor) {
    const overlapping = segments.filter((segment) => segment.from < to && segment.to > from);
    const away = overlapping.filter(({ location }) => location !== scene);
    if (away.length === 0) return true;
    if (away.length > 1) return false;
    const bent = away[0]!;
    if (bent.from <= from) {
      const there = this.#travelTime(bent.location, scene, actor);
      if (there === null || from - bent.from < there) return false;
    }
    if (bent.to >= to) {
      const back = this.#travelTime(scene, bent.location, actor);
      if (back === null || bent.to - to < back) return false;
    }
    return true;
  }

  #victimLater(v: number, scene: string, end: number, [min, max]: readonly [number, number]) {
    for (let delay = min; delay <= max; delay++) {
      if (this.#where(v, end + delay) === scene) return true;
    }
    return false;
  }

  #minuteOfDay(t: number): number {
    return mod(this.#startMinute + t, MINUTES_PER_DAY);
  }

  #block(index: number, t: number): number {
    return this.#blocks[index]![this.#minuteOfDay(t)]!;
  }

  #routine(index: number, t: number): Character['routine'][number] {
    return this.#cast[index]!.routine[this.#block(index, t)]!;
  }

  #where(index: number, t: number): string {
    return this.#routine(index, t).location;
  }

  /** Entry permission for each minute of the day (hours, archetypes, items). */
  #accessDay(location: string, actor: Actor): Uint8Array {
    const key = `${location}|${actor.archetypeId}|${[...(actor.itemIds ?? [])].sort().join(',')}`;
    let day = this.#access.get(key);
    if (!day) {
      day = new Uint8Array(MINUTES_PER_DAY);
      for (let minute = 0; minute < MINUTES_PER_DAY; minute++) {
        const t = minute - this.#startMinute;
        day[minute] = Number(this.#locations.isAccessible(location, actor, t).ok);
      }
      this.#access.set(key, day);
    }
    return day;
  }

  /** Travel time through unlocked or openable doors; `null` without a route. */
  #travelTime(from: string, to: string, actor: Actor): number | null {
    const key = `${from}|${to}|${[...(actor.itemIds ?? [])].sort().join(',')}`;
    if (!this.#travel.has(key)) this.#travel.set(key, this.#locations.travelTime(from, to, actor));
    return this.#travel.get(key)!;
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
 * IncidentSelection (GEN-006): chooses the victim, crime template and culprit
 * (generation-pipeline.md §3). Every character except the victim is checked for motive, means,
 * opportunity and capability; no list of candidates is fixed in advance. Victims are tried in an
 * order weighted by salience and motives against them, templates in a shuffled order, and the
 * culprit is drawn from the feasible characters with weight `score^gamma`. A world without any
 * feasible culprit is rejected with `GenerationRejection`, so the pipeline regenerates it.
 */
export const incidentSelection: Stage<IncidentSelectionInput, IncidentWorld> = {
  name: 'IncidentSelection',
  generate(input, { rng, content, logger }) {
    const assessment = assessIncidents(input, content);
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
    logger.debug('incident selected', {
      template: incident.templateId,
      feasibleCulpritCount: incidentReport.feasibleCulpritCount,
    });
    return { ...input, incident, incidentReport };
  },
};
