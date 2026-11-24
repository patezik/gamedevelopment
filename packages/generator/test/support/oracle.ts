import type { Character, ScheduleOverride } from '@hs/core/characters';
import type { ScenarioContent } from '@hs/core/content';
import { createRng } from '@hs/core/rng';
import { SimulationRunner } from '@hs/core/simulation';
import { Calendar, TimeSystem } from '@hs/core/time';
import { TruthModel } from '@hs/core/truth';
import type { Actor, ItemPlacement } from '@hs/core/world';
import type { IncidentSelectionInput, Opportunity } from '../../src/index.ts';

/*
 * An oracle for IncidentSelection that shares no feasibility code with the stage. Physical
 * presence comes from its own runs of SimulationRunner (the engine HistorySimulation uses);
 * routing is a minute-by-minute search over the location graph with `isAccessible` and locks,
 * not `nextTimedStep` or `travelTime`; routine blocks are read from the routine data directly.
 */

type Crime = ScenarioContent['crimes'][number];

const INCIDENT = {
  type: 'oracle',
  victimIds: [],
  culpritIds: [],
  motive: 'f_0000000000000000',
  means: 'none',
  keyEventIds: [],
  window: { from: 0, to: 1 },
};

function owners(input: IncidentSelectionInput): Map<string, string> {
  const result = new Map<string, string>();
  for (const c of input.characters.toSorted((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!result.has(c.archetypeId)) result.set(c.archetypeId, c.id);
  }
  return result;
}

function minuteOfDay(content: ScenarioContent, t: number): number {
  const [hh, mm] = content.preset.time.startDateTime.slice(11, 16).split(':').map(Number);
  return (((hh! * 60 + mm! + t) % 1440) + 1440) % 1440;
}

/** The routine entry index for a minute, from the routine data (wrapping blocks included). */
function blockIndex(c: Character, content: ScenarioContent, t: number): number {
  const minute = minuteOfDay(content, t);
  return c.routine.findIndex(({ from, to }) =>
    from < to ? minute >= from && minute < to : minute >= from || minute < to,
  );
}

/** Runs SimulationRunner over history with the given culprit overrides and item moves. */
export function simulateHistory(
  input: IncidentSelectionInput,
  content: ScenarioContent,
  overrides: readonly ScheduleOverride[] = [],
  moves: readonly { itemId: string; characterId: string; t: number }[] = [],
): TruthModel {
  const start = content.preset.time.historyStartMinutes;
  const calendar = new Calendar(content.preset.time.startDateTime);
  const time = new TimeSystem(calendar, 0, start);
  const state = input.world.createWorldState(owners(input));
  for (const { itemId, characterId, t } of moves) {
    state.items.move(itemId, { kind: 'character', id: characterId }, t, 'oracle');
  }
  const truth = new TruthModel(INCIDENT);
  new SimulationRunner({
    time,
    calendar,
    world: state.locations,
    items: state.items,
    truth,
    rng: createRng('oracle'),
    characters: input.characters,
    overrides,
    initialLocations: new Map(
      input.characters.map((c) => [c.id, c.routine[blockIndex(c, content, start)]!.location]),
    ),
    itemChangeMinutes: moves.map(({ t }) => t),
    endAt: 0,
  });
  time.advance(-start);
  return truth;
}

function itemPlacements(input: IncidentSelectionInput) {
  const { initial } = input.world.createWorldState(owners(input)).items.snapshot();
  const direct = new Map(initial.map(({ item, placement }) => [item.id, placement]));
  const root = (p: ItemPlacement): ItemPlacement =>
    p.kind === 'container' ? root(direct.get(p.id)!) : p;
  return initial.map(({ item, placement }) => ({ item, at: root(placement), direct: placement }));
}

/**
 * Confirms a reported opportunity physically: the culprit's overrides stay inside one routine
 * block occurrence; in a simulation of the plan the culprit takes the means in person, is at the
 * scene for the whole window, nobody else (but the victim of a plan on them) is there, and a
 * delayed death happens before `t = 0` with the victim where the plan needs them. Returns the
 * failed checks.
 */
export function confirm(
  input: IncidentSelectionInput,
  content: ScenarioContent,
  culpritId: string,
  victimId: string,
  templateId: string,
  opportunity: Opportunity,
): string[] {
  const failures: string[] = [];
  const crime = content.crimes.find(({ id }) => id === templateId)!;
  const culprit = input.characters.find(({ id }) => id === culpritId)!;
  const start = content.preset.time.historyStartMinutes;
  const { locationId: scene, from, to, meansItemId, acquisition, deviation } = opportunity;
  const victimPresent = crime.plan.some(({ target }) => target === '$victim');

  if (to - from !== crime.requires.minWindowMinutes) failures.push('window length');
  if (from < start || to > 0) failures.push('window outside history');
  const sceneTags = content.locations.find(({ id }) => id === scene)!.tags;
  if (!crime.requires.locationTags.every((tag) => sceneTags.includes(tag)))
    failures.push('scene tags');
  const means = itemPlacements(input).find(({ item }) => item.id === meansItemId);
  const { itemTag, itemId } = crime.requires.means;
  if (!means || !means.item.tags.includes(itemTag) || (itemId && itemId !== meansItemId)) {
    failures.push('means does not match the template');
  }
  if (acquisition === null && !(means?.at.kind === 'character' && means.at.id === culpritId)) {
    failures.push('means not held from the start');
  }
  if (acquisition && acquisition.at >= from) failures.push('means taken after the window starts');
  if (acquisition && means?.at.kind === 'location' && means.at.id !== acquisition.locationId) {
    failures.push('means taken elsewhere');
  }

  const overrides: ScheduleOverride[] = [];
  const block = (location: string) => ({
    from: 0,
    to: 1440,
    location,
    activity: 'oracle',
    flexibility: 0,
  });
  if (deviation) {
    if (deviation.to !== to) failures.push('deviation must end with the window');
    for (let t = deviation.from; t < deviation.to; t++) {
      if (blockIndex(culprit, content, t) !== blockIndex(culprit, content, deviation.from)) {
        failures.push('deviation spans two routine blocks');
        break;
      }
    }
    let next = deviation.from;
    if (acquisition && acquisition.at >= deviation.from) {
      overrides.push({
        characterId: culpritId,
        interval: { from: next, to: acquisition.at + 1 },
        block: block(acquisition.locationId),
      });
      next = acquisition.at + 1;
    }
    overrides.push({ characterId: culpritId, interval: { from: next, to }, block: block(scene) });
  }
  const moves = acquisition
    ? [{ itemId: meansItemId, characterId: culpritId, t: acquisition.at + 1 }]
    : [];
  const truth = simulateHistory(input, content, overrides, moves);
  if (acquisition) {
    if (truth.whereWas(culpritId, acquisition.at) !== acquisition.locationId) {
      failures.push('culprit absent at acquisition');
    }
    const holder = acquisition.fromCharacterId;
    if (holder && truth.whereWas(holder, acquisition.at) !== acquisition.locationId) {
      failures.push('holder absent at acquisition');
    }
    if (holder && !(means?.at.kind === 'character' && means.at.id === holder)) {
      failures.push('wrong holder');
    }
  }
  for (let t = from; t < to; t++) {
    if (truth.whereWas(culpritId, t) !== scene) failures.push(`culprit not at scene at ${t}`);
    if (victimPresent && truth.whereWas(victimId, t) !== scene) {
      failures.push(`victim not at scene at ${t}`);
    }
  }
  const allowed = new Set([culpritId, ...(victimPresent ? [victimId] : [])]);
  for (const id of truth.whoWasAt(scene, { from, to })) {
    if (!allowed.has(id)) failures.push(`witness ${id}`);
  }
  if (crime.deathDelayMinutes) {
    const [min, max] = crime.deathDelayMinutes;
    const deathAt = opportunity.deathAt;
    if (deathAt === undefined || deathAt < to + min || deathAt > to + max || deathAt >= 0) {
      failures.push('death time');
    } else if (!victimPresent && truth.whereWas(victimId, deathAt) !== scene) {
      failures.push('victim not at scene at death');
    }
  }
  return [...new Set(failures)];
}

/**
 * Earliest arrival by a minute-by-minute search: waiting is allowed anywhere, an edge can be
 * taken if it is not locked or the actor holds its key, and the destination must be accessible
 * at the arrival minute. Arrival must be before `t = 0`.
 */
function earliest(
  input: IncidentSelectionInput,
  from: string,
  to: string,
  actor: Actor,
  at: number,
): number | null {
  const { locations } = input.world.locations.snapshot();
  const best = new Map<string, number>([[from, at]]);
  const queue = [from];
  while (queue.length > 0) {
    queue.sort((a, b) => best.get(a)! - best.get(b)!);
    const here = queue.shift()!;
    const now = best.get(here)!;
    for (const { to: next, minutes, locked } of locations.find(({ id }) => id === here)!
      .connections) {
      if (locked && (locked.itemId === undefined || !actor.itemIds?.has(locked.itemId))) continue;
      let arrive = now + minutes;
      while (arrive < 0 && !input.world.locations.isAccessible(next, actor, arrive).ok) arrive++;
      if (arrive >= 0 || arrive >= (best.get(next) ?? Infinity)) continue;
      best.set(next, arrive);
      if (!queue.includes(next)) queue.push(next);
    }
  }
  const result = best.get(to);
  return result === undefined || result >= 0 ? null : result;
}

/**
 * Independent search for the earliest window per scene (over all means) for one culprit,
 * victim and template, or the first failed criterion. Positions come from a baseline
 * SimulationRunner run; the culprit may change one routine block occurrence, starting where they
 * physically are (not in transit) the minute before.
 */
export function search(
  input: IncidentSelectionInput,
  content: ScenarioContent,
  culpritId: string,
  victimId: string,
  templateId: string,
): 'motive' | 'capable' | 'means' | 'opportunity' | Map<string, number> {
  const crime: Crime = content.crimes.find(({ id }) => id === templateId)!;
  const culprit = input.characters.find(({ id }) => id === culpritId)!;
  const start = content.preset.time.historyStartMinutes;
  const best = Math.max(
    -1,
    ...input.motives
      .filter(({ who, against }) => who === culpritId && against === victimId)
      .map(({ strength }) => strength),
  );
  if (best < content.preset.incident.minMotive) return 'motive';
  for (const [trait, bound] of Object.entries(crime.requires.traits)) {
    const { gt, lt } = bound as { gt?: number; lt?: number };
    const value = culprit.personality[trait as keyof Character['personality']];
    if ((gt !== undefined && !(value > gt)) || (lt !== undefined && !(value < lt))) {
      return 'capable';
    }
  }

  const truth = simulateHistory(input, content);
  const where = (id: string, t: number) => truth.whereWas(id, t);
  const placements = itemPlacements(input);
  const accessIds = input.world.locations.accessItemIds;
  const own = placements
    .filter(
      ({ at, item }) =>
        at.kind === 'character' && at.id === culpritId && accessIds.includes(item.id),
    )
    .map(({ item }) => item.id);
  const actor = (extra: string[]): Actor => ({
    archetypeId: culprit.archetypeId,
    itemIds: new Set([...own, ...extra]),
  });
  const { itemTag, itemId } = crime.requires.means;
  const means = placements.filter(
    ({ item, at }) =>
      item.tags.includes(itemTag) &&
      (itemId === undefined || item.id === itemId) &&
      at.kind !== 'container',
  );
  const window = crime.requires.minWindowMinutes;
  const victimPresent = crime.plan.some(({ target }) => target === '$victim');
  const scenes = content.locations
    .filter(({ tags }) => crime.requires.locationTags.every((tag) => tags.includes(tag)))
    .map(({ id }) => id);
  const allIds = input.world.locations.snapshot().locations.map(({ id }) => id);

  const windowOk = (scene: string, s: number) => {
    for (let t = s; t < s + window; t++) {
      if (victimPresent && where(victimId, t) !== scene) return false;
      for (const other of input.characters) {
        if (other.id === culpritId || (victimPresent && other.id === victimId)) continue;
        if (where(other.id, t) === scene) return false;
      }
    }
    if (crime.deathDelayMinutes) {
      const [min, max] = crime.deathDelayMinutes;
      const end = s + window;
      if (victimPresent) return end + min <= -1;
      for (let d = end + min; d <= Math.min(end + max, -1); d++) {
        if (where(victimId, d) === scene) return true;
      }
      return false;
    }
    return true;
  };

  let anyMeans = false;
  const result = new Map<string, number>();
  for (const { item, at } of means) {
    const keys = accessIds.filter(
      (key) =>
        key === item.id ||
        (() => {
          let p = placements.find((entry) => entry.item.id === key)?.direct;
          while (p?.kind === 'container') {
            if (p.id === item.id) return true;
            p = placements.find((entry) => entry.item.id === p!.id)?.direct;
          }
          return false;
        })(),
    );
    // Earliest minute the culprit's routine alone lets them take it (held from the minute after).
    let natural: number | undefined =
      at.kind === 'character' && at.id === culpritId ? start - 1 : undefined;
    for (let t = start; natural === undefined && t < 0; t++) {
      const here = where(culpritId, t);
      if (here === 'in_transit') continue;
      if (
        at.kind === 'location'
          ? here === at.id
          : at.kind === 'character' && where(at.id, t) === here
      ) {
        natural = t;
      }
    }
    const sourceAt = (o0: number): string | undefined => {
      const before = o0 === start ? undefined : where(culpritId, o0 - 1);
      if (before === 'in_transit') return undefined;
      return before ?? culprit.routine[blockIndex(culprit, content, start)]!.location;
    };
    const meets = (p0: string, o0: number, place: string): number | undefined => {
      const there = earliest(input, p0, place, actor([]), o0);
      if (there === null) return undefined;
      let t = there;
      if (at.kind === 'character') while (t < 0 && where(at.id, t) !== place) t++;
      return t < 0 ? t : undefined;
    };
    const places = at.kind === 'location' ? [at.id] : at.kind === 'character' ? allIds : [];
    if (natural !== undefined) anyMeans = true;
    for (let o0 = start; !anyMeans && o0 < 0; o0++) {
      const p0 = sourceAt(o0);
      if (p0 !== undefined && places.some((place) => meets(p0, o0, place) !== undefined)) {
        anyMeans = true;
      }
    }
    // Arrival at the scene holding the item, starting a changed block at `o0` from `p0`.
    const arrival = (p0: string, o0: number, scene: string): number | null => {
      if (natural !== undefined && natural < o0) return earliest(input, p0, scene, actor(keys), o0);
      let bestArrival: number | null = null;
      for (const place of places) {
        const t = meets(p0, o0, place);
        if (t === undefined) continue;
        const reach = earliest(input, place, scene, actor(keys), t + 1);
        if (reach !== null && (bestArrival === null || reach < bestArrival)) bestArrival = reach;
      }
      return bestArrival;
    };
    for (const scene of scenes) {
      const record = (s: number) => {
        if (!result.has(scene) || s < result.get(scene)!) result.set(scene, s);
      };
      // Natural windows: the routine keeps the culprit at the scene.
      if (natural !== undefined) {
        for (let s = natural + 1; s + window <= 0; s++) {
          let there = true;
          for (let t = s; there && t < s + window; t++) there = where(culpritId, t) === scene;
          if (there && windowOk(scene, s)) {
            record(s);
            break;
          }
        }
      }
      // One changed block occurrence.
      for (let o0 = start; o0 < 0; o0++) {
        const p0 = sourceAt(o0);
        if (p0 === undefined) continue;
        const block = blockIndex(culprit, content, o0);
        let until = o0;
        while (until < 0 && blockIndex(culprit, content, until) === block) until++;
        const a = arrival(p0, o0, scene);
        if (a === null) continue;
        // Already at the scene, holding the means, when the changed block starts: the window may
        // begin while the routine still keeps the culprit there.
        let first = a;
        if (a === o0 && p0 === scene && natural !== undefined && natural < o0) {
          while (first - 1 > natural && where(culpritId, first - 1) === scene) first--;
        }
        for (let s = first; s + window <= until; s++) {
          if (windowOk(scene, s)) {
            record(s);
            break;
          }
        }
      }
    }
  }
  if (!anyMeans) return 'means';
  return result.size === 0 ? 'opportunity' : result;
}
