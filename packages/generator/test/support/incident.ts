import { fileURLToPath } from 'node:url';
import { whereShouldBe, type Character } from '@hs/core/characters';
import { loadScenarioFromDir, type ScenarioContent } from '@hs/core/content';
import { createRng } from '@hs/core/rng';
import { Calendar } from '@hs/core/time';
import type { Actor, ItemPlacement } from '@hs/core/world';
import {
  castGen,
  conflictGen,
  GenerationRejection,
  incidentSelection,
  runPipeline,
  socialGen,
  worldGen,
  type IncidentSelectionInput,
  type IncidentWorld,
  type MotiveCandidate,
} from '../../src/index.ts';

const root = new URL('../../../../content/scenarios/', import.meta.url);
export const silent = { debug() {} };

export function scenario(id: string): ScenarioContent {
  return loadScenarioFromDir(fileURLToPath(new URL(`${id}/`, root)));
}

export const minimal = scenario('_test_minimal');
export const sanatorium = scenario('sanatorium_winter');

/** The IncidentSelection input of attempt 1 of `seed`, with the streams `runPipeline` would use. */
export function incidentInput(content: ScenarioContent, seed: string): IncidentSelectionInput {
  const world = worldGen.generate(undefined, {
    rng: createRng(`${seed}#1`).fork('gen/WorldGen'),
    content,
    logger: silent,
  });
  const result = runPipeline([castGen, socialGen, conflictGen], undefined, {
    seed,
    content,
    now: () => 0,
  });
  if (!result.ok) throw new Error(`ConflictGen failed for seed ${seed}`);
  return { ...result.output, world };
}

export function select(
  input: IncidentSelectionInput,
  content: ScenarioContent,
  seed = 'select',
): IncidentWorld {
  return incidentSelection.generate(input, {
    rng: createRng(seed).fork('gen/IncidentSelection'),
    content,
    logger: silent,
  });
}

export function trySelect(
  input: IncidentSelectionInput,
  content: ScenarioContent,
  seed = 'select',
): IncidentWorld | GenerationRejection {
  try {
    return select(input, content, seed);
  } catch (error) {
    if (error instanceof GenerationRejection) return error;
    throw error;
  }
}

/** A motive of `who` against `against` (for fixtures that control motives directly). */
export function motive(who: string, against: string, strength = 0.5): MotiveCandidate {
  return { who, against, motiveType: 'protect_record', strength, basis: [] };
}

/** Every ordered pair has a motive of the given strength. */
export function everyMotive(input: IncidentSelectionInput, strength = 0.5): MotiveCandidate[] {
  return input.characters.flatMap((c) =>
    input.characters.filter((v) => v.id !== c.id).map((v) => motive(c.id, v.id, strength)),
  );
}

/** A routine with one block for the whole day. */
export function stay(location: string, activity = 'wait'): Character['routine'] {
  return [{ from: 0, to: 1440, location, activity, flexibility: 0 }];
}

export function withRoutine(
  input: IncidentSelectionInput,
  routines: Readonly<Record<string, Character['routine']>>,
): IncidentSelectionInput {
  return {
    ...input,
    characters: input.characters.map((c) =>
      routines[c.id] ? { ...c, routine: routines[c.id]! } : c,
    ),
  };
}

type Crime = ScenarioContent['crimes'][number];

export function withCrime(content: ScenarioContent, change: (crime: Crime) => Crime) {
  return { ...content, crimes: content.crimes.map(change) };
}

export function withIncident(
  content: ScenarioContent,
  incident: Partial<ScenarioContent['preset']['incident']>,
): ScenarioContent {
  return {
    ...content,
    preset: { ...content.preset, incident: { ...content.preset.incident, ...incident } },
  };
}

/**
 * Independent oracle of generation-pipeline.md §3, minute by minute through `whereShouldBe`.
 * Returns the earliest usable window per scene for (culprit, victim, template), or the first
 * failed criterion.
 */
export function oracle(
  input: IncidentSelectionInput,
  content: ScenarioContent,
  culpritId: string,
  victimId: string,
  templateId: string,
): 'motive' | 'capable' | 'means' | 'opportunity' | Map<string, number> {
  const calendar = new Calendar(content.preset.time.startDateTime);
  const crime = content.crimes.find(({ id }) => id === templateId)!;
  const culprit = input.characters.find(({ id }) => id === culpritId)!;
  const victim = input.characters.find(({ id }) => id === victimId)!;
  const at = (c: Character, t: number) => whereShouldBe(c, t, [], calendar);
  const historyStart = content.preset.time.historyStartMinutes;
  const { locations } = input.world;

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

  const owners = new Map<string, string>();
  for (const c of input.characters.toSorted((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!owners.has(c.archetypeId)) owners.set(c.archetypeId, c.id);
  }
  const { initial } = input.world.createWorldState(owners).items.snapshot();
  const placement = new Map(initial.map(({ item, placement }) => [item.id, placement]));
  const rootOf = (p: ItemPlacement): ItemPlacement =>
    p.kind === 'container' ? rootOf(placement.get(p.id)!) : p;
  const keys = new Set(
    initial
      .filter(({ placement: p }) => p.kind === 'character' && p.id === culpritId)
      .map(({ item }) => item.id)
      .filter((id) => locations.accessItemIds.includes(id)),
  );
  const { itemTag, itemId } = crime.requires.means;
  let acquireBy = Infinity;
  const means: string[] = [];
  for (const { item } of initial) {
    if (!item.tags.includes(itemTag) || (itemId !== undefined && item.id !== itemId)) continue;
    const where = rootOf(placement.get(item.id)!);
    if (where.kind === 'character') {
      means.push(item.id);
      acquireBy = Math.min(acquireBy, historyStart);
    } else if (where.kind === 'location') {
      const actor: Actor = { archetypeId: culprit.archetypeId, itemIds: keys };
      for (let t = historyStart; t < 0; t++) {
        if (!locations.isAccessible(where.id, actor, t).ok) continue;
        if (locations.travelTime(at(culprit, t).location, where.id, actor) === null) continue;
        means.push(item.id);
        acquireBy = Math.min(acquireBy, t);
        break;
      }
    }
  }
  if (means.length === 0) return 'means';

  const held = new Set([...keys, ...means.filter((id) => locations.accessItemIds.includes(id))]);
  const actor: Actor = { archetypeId: culprit.archetypeId, itemIds: held };
  const window = crime.requires.minWindowMinutes;
  const victimPresent = crime.plan.some(({ target }) => target === '$victim');
  const scenes = content.locations
    .filter(({ tags }) => crime.requires.locationTags.every((tag) => tags.includes(tag)))
    .map(({ id }) => id);
  const result = new Map<string, number>();
  for (const scene of scenes) {
    for (let s = Math.max(historyStart, acquireBy); s + window <= 0; s++) {
      if (usable(s)) {
        result.set(scene, s);
        break;
      }
    }

    function usable(s: number): boolean {
      for (let t = s; t < s + window; t++) {
        if (!locations.isAccessible(scene, actor, t).ok) return false;
        if (victimPresent && at(victim, t).location !== scene) return false;
        for (const other of input.characters) {
          if (other.id === culpritId || (victimPresent && other.id === victimId)) continue;
          const block = at(other, t);
          if (block.location === scene && block.activity !== 'sleep') return false;
        }
      }
      // Maximal runs of one routine block away from the scene inside the window.
      const away: { block: Character['routine'][number]; first: number; last: number }[] = [];
      for (let t = s; t < s + window; t++) {
        const block = at(culprit, t);
        if (block.location === scene) continue;
        const run = away.at(-1);
        if (run && run.block === block && run.last === t - 1) run.last = t;
        else away.push({ block, first: t, last: t });
      }
      if (away.length > 1) return false;
      const run = away[0];
      if (run) {
        if (run.first === s) {
          let start = s;
          while (start > historyStart && at(culprit, start - 1) === run.block) start--;
          const there = locations.travelTime(run.block.location, scene, actor);
          if (there === null || s - start < there) return false;
        }
        if (run.last === s + window - 1) {
          let end = s + window;
          while (end < 1440 && at(culprit, end) === run.block) end++;
          const back = locations.travelTime(scene, run.block.location, actor);
          if (back === null || end - (s + window) < back) return false;
        }
      }
      if (!victimPresent && crime.deathDelayMinutes) {
        const [min, max] = crime.deathDelayMinutes;
        let later = false;
        for (let d = min; d <= max && !later; d++) {
          later = at(victim, s + window + d).location === scene;
        }
        if (!later) return false;
      }
      return true;
    }
  }
  return result.size === 0 ? 'opportunity' : result;
}
