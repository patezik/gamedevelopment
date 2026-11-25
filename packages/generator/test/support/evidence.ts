import type { ScenarioContent } from '@hs/core/content';
import { createRng } from '@hs/core/rng';
import {
  evidenceGen,
  GenerationRejection,
  type EvidenceWorld,
  type TestimonyWorld,
  testimonyGen,
} from '../../src/index.ts';
import { planned, simulateHistory } from './history.ts';
import { silent } from './incident.ts';

export interface Sample {
  readonly seed: string;
  readonly world: EvidenceWorld;
}

const cache = new Map<string, Sample[]>();

/**
 * The first `count` seeds of `prefix` whose attempt 1 reaches EvidenceGen, with its output.
 * Cached per content and prefix inside one test file, so the stages under test share the early
 * stages' work (the slowest part of a sample).
 */
export function evidenceSamples(
  content: ScenarioContent,
  contentId: string,
  prefix: string,
  count: number,
): readonly Sample[] {
  const key = `${contentId}/${prefix}`;
  const samples = cache.get(key) ?? [];
  cache.set(key, samples);
  for (let n = 0; samples.length < count && n < count * 20; n++) {
    const seed = `${prefix}-${n}`;
    if (samples.some((sample) => sample.seed === seed)) continue;
    const world = planned(content, seed);
    if (!world) continue;
    const history = simulateHistory(world, content, seed);
    if (history instanceof GenerationRejection) continue;
    samples.push({
      seed,
      world: evidenceGen.generate(history, {
        rng: createRng(`${seed}#1`).fork('gen/EvidenceGen'),
        content,
        logger: silent,
      }),
    });
  }
  return samples.slice(0, count);
}

export function testimony(world: EvidenceWorld, content: ScenarioContent, seed: string) {
  return testimonyGen.generate(world, {
    rng: createRng(`${seed}#1`).fork('gen/TestimonyGen'),
    content,
    logger: silent,
  });
}

export type { TestimonyWorld };
