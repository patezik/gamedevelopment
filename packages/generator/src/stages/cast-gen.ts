import { validateRoutine, type Character, type Personality } from '@hs/core/characters';
import { PERSONALITY_TRAITS } from '@hs/core/common';
import type { ScenarioContent } from '@hs/core/content';
import type { Rng } from '@hs/core/rng';
import type { Stage } from '../pipeline/index.ts';

type Archetype = ScenarioContent['archetypes'][number];
type Name = { text: string; given: string; surname: string | undefined };
type Slot = { archetype: Archetype; name: Name };
type Pool = { archetype: Archetype; names: Name[]; min: number; max: number };

function parseName(text: string): Name {
  const words = text.normalize('NFC').toLowerCase().split(/\s+/);
  return { text, given: words[0]!, surname: words.length > 1 ? words.at(-1) : undefined };
}

function chooseCast(content: ScenarioContent, rng: Rng): Slot[] {
  const { min, max, quotas } = content.preset.cast;
  const limits = new Map(quotas.map((quota) => [quota.archetype, quota] as const));
  const pools: Pool[] = rng.shuffle(content.archetypes).map((archetype) => {
    const names = rng.fork(archetype.id).shuffle(archetype.names).map(parseName);
    const quota = limits.get(archetype.id);
    return {
      archetype,
      names,
      min: quota?.min ?? 0,
      max: Math.min(quota?.max ?? max, names.length),
    };
  });
  if (
    limits.size !== quotas.length ||
    quotas.some(({ archetype }) => !pools.some(({ archetype: entry }) => entry.id === archetype))
  ) {
    throw new RangeError('Cast quotas must refer to distinct archetypes');
  }
  const required = pools.reduce((total, pool) => total + pool.min, 0);
  const capacity = pools.reduce((total, pool) => total + pool.max, 0);
  const low = Math.max(min, required);
  const high = Math.min(max, capacity);
  const selected: Slot[] = [];
  const given = new Set<string>();
  const surnames = new Set<string>();

  // Search each pool in its shuffled order. This can recover from a name shared by two pools.
  function fill(target: number, poolIndex = 0, count = 0, start = 0): boolean {
    const pool = pools[poolIndex];
    if (!pool) return selected.length === target;
    const available = Math.min(pool.max - count, pool.names.length - start);
    const remainingPools = pools.slice(poolIndex + 1);
    const remainingMin = remainingPools.reduce((total, next) => total + next.min, 0);
    const remainingMax = remainingPools.reduce((total, next) => total + next.max, 0);
    if (
      count + available < pool.min ||
      selected.length + Math.max(0, pool.min - count) + remainingMin > target ||
      selected.length + available + remainingMax < target
    )
      return false;
    if (selected.length + remainingMin < target && count < pool.max) {
      for (let index = start; index < pool.names.length; index++) {
        const name = pool.names[index]!;
        if (given.has(name.given) || (name.surname && surnames.has(name.surname))) continue;
        selected.push({ archetype: pool.archetype, name });
        given.add(name.given);
        if (name.surname) surnames.add(name.surname);
        if (fill(target, poolIndex, count + 1, index + 1)) return true;
        if (name.surname) surnames.delete(name.surname);
        given.delete(name.given);
        selected.pop();
      }
    }
    return count >= pool.min && fill(target, poolIndex + 1);
  }

  if (low <= high) {
    const preferred = rng.int(low, high);
    for (let size = preferred; size >= low; size--) {
      if (fill(size)) return selected;
    }
  }
  throw new RangeError('Cast quotas cannot be met with distinct given names and surnames');
}

function sampleTrait(rng: Rng, [min, max]: readonly [number, number]): number {
  if (min === max) return min;
  const mean = (min + max) / 2;
  const deviation = (max - min) / 6;
  for (;;) {
    const normal = Math.sqrt(-2 * Math.log(1 - rng.float())) * Math.cos(2 * Math.PI * rng.float());
    const value = mean + deviation * normal;
    if (value >= min && value <= max) return value;
  }
}

function biographyOf(archetype: Archetype, rng: Rng): Character['biography'] {
  const selected: Archetype['biography'] = [];
  for (const entry of rng.shuffle(archetype.biography)) {
    const compatible = selected.every(
      (other) =>
        !entry.excludes?.some((tag) => other.tags.includes(tag)) &&
        !other.excludes?.some((tag) => entry.tags.includes(tag)),
    );
    if (compatible) selected.push(entry);
    if (selected.length === 3) break;
  }
  return selected.map(({ text, tags }) => ({ text, tags: [...tags] }));
}

function routineOf(
  id: string,
  archetype: Archetype,
  flexibility: number,
  rng: Rng,
): Character['routine'] {
  const routine = archetype.routine.map(({ from, to, locationId, activity }) => ({
    from,
    to,
    location: locationId,
    activity,
    flexibility,
  }));
  validateRoutine({ id, routine });
  const boundaries = [...new Set([0, 1440, ...routine.flatMap(({ from, to }) => [from, to])])].sort(
    (a, b) => a - b,
  );
  const shifted = new Map<number, number>();
  for (let index = 1; index < boundaries.length - 1; index++) {
    const minute = boundaries[index]!;
    const gap = Math.min(minute - boundaries[index - 1]!, boundaries[index + 1]! - minute);
    const limit = Math.min(Math.floor(15 * flexibility), Math.floor((gap - 1) / 2));
    shifted.set(minute, minute + rng.int(-limit, limit));
  }
  return routine.map((block) => ({
    ...block,
    from: shifted.get(block.from) ?? block.from,
    to: shifted.get(block.to) ?? block.to,
  }));
}

/** WorldGen supplies the world upstream. CastGen uses the preset's archetype content. */
export const castGen: Stage<unknown, Character[]> = {
  name: 'CastGen',
  generate(_world, { rng, content }) {
    return chooseCast(content, rng.fork('cast')).map(({ archetype, name }, index) => {
      const id = `ch_${index + 1}`;
      const character = rng.fork(id);
      const personality = Object.fromEntries(
        PERSONALITY_TRAITS.map((trait) => [
          trait,
          sampleTrait(character.fork(trait), archetype.personality[trait] ?? [0, 1]),
        ]),
      ) as Personality;
      const routine = routineOf(
        id,
        archetype,
        1 - personality.conscientiousness,
        character.fork('routine'),
      );
      return {
        id,
        name: name.text,
        archetypeId: archetype.id,
        age: 45,
        socialStatus: archetype.id,
        personality,
        routine,
        biography: biographyOf(archetype, character.fork('biography')),
        access: archetype.access.flatMap(({ itemId, locationId }): Character['access'] =>
          locationId ? [{ locationId, ...(itemId && { itemId }) }] : itemId ? [{ itemId }] : [],
        ),
        goals: [],
        fears: [],
        habits: [],
        desires: [],
        secrets: [],
      };
    });
  },
};
