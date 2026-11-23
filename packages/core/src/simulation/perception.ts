import type { Personality } from '../characters/index.ts';
import type { KnowledgeStore } from '../knowledge/index.ts';
import type { Rng } from '../rng/index.ts';
import type { Fact, TruthEvent } from '../truth/index.ts';
import type { Light } from '../world/index.ts';

export type PerceptibleEvent = Pick<
  TruthEvent,
  'id' | 't' | 'location' | 'actorIds' | 'verb' | 'visibility'
>;

export interface Observer {
  readonly id: string;
  readonly knowledge: Pick<KnowledgeStore, 'add'>;
  readonly rng: Pick<Rng, 'fork'>;
  readonly personality: Pick<Personality, 'conscientiousness'>;
  readonly stress: number;
}

const visibilityFactor = { bright: 1, dim: 0.65, dark: 0.25 } satisfies Record<Light, number>;

/** Inputs use the 0–1 scale. Stress halves attention at its maximum. */
export function attention(
  { conscientiousness }: Observer['personality'],
  lighting: Light,
  stress: number,
): number {
  if (
    !Number.isFinite(conscientiousness) ||
    conscientiousness < 0 ||
    conscientiousness > 1 ||
    !Number.isFinite(stress) ||
    stress < 0 ||
    stress > 1
  ) {
    throw new RangeError('Attention inputs must be between 0 and 1');
  }
  return (0.25 + 0.75 * conscientiousness) * visibilityFactor[lighting] * (1 - stress / 2);
}

/** Records what can be seen at the event's start. Presence covers the observed minute. */
export function recordObservations(
  event: PerceptibleEvent,
  presentIds: ReadonlySet<string>,
  observers: readonly Observer[],
  lighting: Light,
): void {
  if (event.visibility === 'private') return;
  const { t, location, verb, actorIds } = event;
  const actions: Fact[] = actorIds.map((who) => ({
    kind: 'did',
    who,
    verb,
    at: t,
    where: location,
  }));
  const presence: Fact[] = [...presentIds].map((who) => ({
    kind: 'at',
    who,
    where: location,
    interval: { from: t, to: t + 1 },
  }));
  for (const observer of observers) {
    if (!presentIds.has(observer.id)) continue;
    const confidence =
      event.visibility === 'public'
        ? 1
        : attention(observer.personality, lighting, observer.stress);
    if (
      event.visibility === 'covert' &&
      !observer.rng.fork('perception').fork(event.id).chance(confidence)
    ) {
      continue;
    }
    for (const proposition of actions) {
      observer.knowledge.add({
        proposition,
        confidence,
        source: 'observed',
        acquiredAt: t,
        fuzzMinutes: 0,
      });
    }
    for (const proposition of presence) {
      if (proposition.kind === 'at' && proposition.who !== observer.id) {
        observer.knowledge.add({
          proposition,
          confidence,
          source: 'observed',
          acquiredAt: t,
          fuzzMinutes: 0,
        });
      }
    }
  }
}
