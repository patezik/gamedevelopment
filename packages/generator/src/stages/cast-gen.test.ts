import { fileURLToPath } from 'node:url';
import { characterSchema, validateRoutine } from '@hs/core/characters';
import { loadScenarioFromDir, type ScenarioContent } from '@hs/core/content';
import { expect, test } from 'vitest';
import { castGen, runPipeline } from '../index.ts';

const content = loadScenarioFromDir(
  fileURLToPath(new URL('../../../../content/scenarios/sanatorium_winter/', import.meta.url)),
);

function generate(seed: string, scenario = content) {
  const result = runPipeline([castGen], undefined, { seed, content: scenario, now: () => 0 });
  if (!result.ok) throw new Error('Expected CastGen to succeed');
  return result.output;
}

test('1,000 seeds obey quotas, unique names, trait ranges and complete routines', () => {
  const compositions = new Set<string>();
  for (let seed = 0; seed < 1000; seed++) {
    const cast = generate(String(seed));
    expect(cast).toHaveLength(7);
    const counts = new Map<string, number>();
    const given = new Set<string>();
    const surnames = new Set<string>();
    for (const character of cast) {
      characterSchema.parse(character);
      validateRoutine(character);
      const words = character.name.toLowerCase().split(/\s+/);
      given.add(words[0]!);
      surnames.add(words.at(-1)!);
      counts.set(character.archetypeId, (counts.get(character.archetypeId) ?? 0) + 1);
      const archetype = content.archetypes.find(({ id }) => id === character.archetypeId)!;
      expect(archetype.names).toContain(character.name);
      for (const [trait, [min, max]] of Object.entries(archetype.personality)) {
        const value = character.personality[trait as keyof typeof character.personality];
        expect(value >= min && value <= max).toBe(true);
      }
    }
    for (const quota of content.preset.cast.quotas) {
      const count = counts.get(quota.archetype) ?? 0;
      expect(count >= quota.min && count <= quota.max).toBe(true);
    }
    expect(given.size).toBe(cast.length);
    expect(surnames.size).toBe(cast.length);
    compositions.add([...counts.keys()].sort().join(','));
  }
  expect(compositions.size).toBe(10);
  expect(generate('repeat')).toEqual(generate('repeat'));
}, 20_000);

test('finds a feasible assignment when mandatory name pools overlap and respects exclusions', () => {
  const first = {
    ...content.archetypes[0]!,
    id: 'first',
    names: ['Анна Иванова', 'Вера Петрова'],
    biography: [
      { text: 'Lives locally', tags: ['local'], excludes: ['visitor'] },
      { text: 'Visiting', tags: ['visitor'] },
      { text: 'Reads', tags: ['reading'] },
    ],
  };
  const second = { ...first, id: 'second', names: ['Анна Сидорова'] };
  const scenario: ScenarioContent = {
    ...content,
    archetypes: [first, second],
    preset: {
      ...content.preset,
      cast: {
        min: 2,
        max: 2,
        quotas: [first, second].map(({ id }) => ({ archetype: id, min: 1, max: 1 })),
      },
    },
  };
  const cast = generate('overlap', scenario);
  expect(cast.find(({ archetypeId }) => archetypeId === 'first')?.name).toBe('Вера Петрова');
  for (const { biography } of cast) {
    expect(biography).toHaveLength(2);
    expect(biography.flatMap(({ tags }) => tags)).not.toEqual(
      expect.arrayContaining(['local', 'visitor']),
    );
  }
  first.names = ['Анна Иванова'];
  expect(() => generate('impossible', scenario)).toThrow(/quotas/);
});
