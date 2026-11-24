import { createRng } from '@hs/core/rng';
import { describe, expect, test } from 'vitest';
import {
  incidentInput,
  minimal,
  motive,
  sanatorium,
  select,
  withIncident,
} from '../../test/support/incident.ts';
import { confirm } from '../../test/support/oracle.ts';
import {
  assessIncidents,
  GenerationRejection,
  incidentSelection,
  runPipeline,
  selectIncident,
  type IncidentSelectionInput,
  type Stage,
} from '../index.ts';

const SEEDS = 2000;

/** The stage stream of attempt 1 of `seed`, as `runPipeline` creates it. */
const stream = (seed: string) => createRng(`${seed}#1`).fork('gen/IncidentSelection');

/** The given input as the first stage, so `runPipeline` hands IncidentSelection its own stream. */
function fixed(input: IncidentSelectionInput): Stage<undefined, IncidentSelectionInput> {
  return { name: 'Input', generate: () => input };
}

describe('_test_minimal over 2000 seeds', () => {
  test('the helper uses the stream runPipeline gives the stage in attempt 1', () => {
    for (const seed of ['0', '1', '1999']) {
      const input = incidentInput(minimal, seed);
      const result = runPipeline([fixed(input), incidentSelection], undefined, {
        seed,
        content: minimal,
        now: () => 0,
      });
      if (!result.ok) throw new Error('Expected an incident');
      expect(result.report.attempts).toHaveLength(1);
      expect(result.output.incident).toEqual(select(input, minimal, seed).incident);
      const assessment = assessIncidents(input, minimal);
      expect(selectIncident(input, assessment, minimal, stream(seed)).incident).toEqual(
        result.output.incident,
      );
    }
  });

  test('every character that can be the culprit is chosen; the victim never is', () => {
    const feasibleEver = new Set<string>();
    const chosen = new Map<string, number>();
    const feasiblePairs = new Set<string>();
    const chosenPairs = new Set<string>();
    let rejected = 0;
    for (let seed = 0; seed < SEEDS; seed++) {
      const input = incidentInput(minimal, String(seed));
      const assessment = assessIncidents(input, minimal);
      for (const { victimId, feasible } of assessment.options) {
        for (const { characterId } of feasible) {
          feasibleEver.add(characterId);
          feasiblePairs.add(`${characterId}>${victimId}`);
        }
      }
      if (assessment.options.every(({ feasible }) => feasible.length === 0)) {
        rejected++;
        continue;
      }
      // The stage is assessIncidents + selectIncident on the stage stream; one assessment serves.
      const { incident, incidentReport } = selectIncident(
        input,
        assessment,
        minimal,
        stream(String(seed)),
      );
      expect(incident.culpritId).not.toBe(incident.victimId);
      const option = assessment.options.find(
        (o) => o.victimId === incident.victimId && o.templateId === incident.templateId,
      )!;
      expect(option.feasible.map(({ characterId }) => characterId)).toContain(incident.culpritId);
      expect(incidentReport.feasibleCulpritCount).toBe(option.feasible.length);
      if (seed % 50 === 0) {
        expect(
          confirm(
            input,
            minimal,
            incident.culpritId,
            incident.victimId,
            incident.templateId,
            incident.opportunities[0]!,
          ),
        ).toEqual([]);
      }
      chosen.set(incident.culpritId, (chosen.get(incident.culpritId) ?? 0) + 1);
      chosenPairs.add(`${incident.culpritId}>${incident.victimId}`);
    }
    // Every character of the cast satisfies the constraints in some world...
    expect([...feasibleEver].sort()).toEqual(['ch_1', 'ch_2', 'ch_3']);
    // ...and each of them, and each feasible (culprit, victim) pair, is chosen at least once.
    expect([...chosen.keys()].sort()).toEqual([...feasibleEver].sort());
    expect([...chosenPairs].sort()).toEqual([...feasiblePairs].sort());
    expect(rejected).toBe(0);
    // No identity dominates: each id is the culprit in 20–47 % of worlds.
    for (const count of chosen.values()) {
      expect(count / SEEDS).toBeGreaterThan(0.2);
      expect(count / SEEDS).toBeLessThan(0.47);
    }
  }, 300_000);
});

/** Pearson's χ² of observed counts against expected probabilities. */
function chiSquare(observed: readonly number[], probabilities: readonly number[]): number {
  const total = observed.reduce((sum, n) => sum + n, 0);
  return observed.reduce((sum, n, i) => {
    const expected = total * probabilities[i]!;
    return sum + (n - expected) ** 2 / expected;
  }, 0);
}

/** χ² critical values at α = 0.001. */
const CRITICAL = { 3: 16.266 } as const;

describe('culprit distribution follows score^gamma', () => {
  // Five visitors; only ch_1 has enemies, with distinct motive strengths, so the victim and the
  // template are fixed and only the weighted culprit draw varies with the stage seed.
  const content = {
    ...minimal,
    preset: {
      ...minimal.preset,
      cast: { min: 5, max: 5, quotas: [{ archetype: 'visitor', min: 5, max: 5 }] },
    },
    archetypes: minimal.archetypes.map((a) => ({
      ...a,
      names: ['Анна', 'Илья', 'Олег', 'Вера', 'Лев'],
    })),
  };
  const world = incidentInput(content, 'distribution');
  const strengths = { ch_2: 0.4, ch_3: 0.6, ch_4: 0.8, ch_5: 1 } as const;
  const input: IncidentSelectionInput = {
    ...world,
    motives: Object.entries(strengths).map(([who, strength]) => motive(who, 'ch_1', strength)),
  };
  const DRAWS = 8000;

  function frequencies(gamma: number) {
    const preset = withIncident(content, { gamma });
    const assessment = assessIncidents(input, preset);
    const [option] = assessment.options.filter((o) => o.feasible.length);
    const culprits = option!.feasible.map(({ characterId }) => characterId);
    const weights = option!.feasible.map(({ score }) => score ** gamma);
    const total = weights.reduce((sum, w) => sum + w, 0);
    const counts = culprits.map(() => 0);
    // Only the stream changes between draws, so one assessment serves every draw.
    for (let draw = 0; draw < DRAWS; draw++) {
      const { incident } = selectIncident(input, assessment, preset, stream(`draw-${draw}`));
      expect(incident.victimId).toBe('ch_1');
      counts[culprits.indexOf(incident.culpritId)]!++;
    }
    return { culprits, counts, probabilities: weights.map((w) => w / total), option: option! };
  }

  test('γ = 0.7: χ² against score^0.7 stays below the 0.1 % critical value', () => {
    const { culprits, counts, probabilities, option } = frequencies(0.7);
    expect(culprits).toEqual(['ch_2', 'ch_3', 'ch_4', 'ch_5']);
    // Scores differ only by motive strength.
    const scores = option.feasible.map(({ score }) => score);
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
    expect(new Set(scores).size).toBe(4);
    expect(chiSquare(counts, probabilities)).toBeLessThan(CRITICAL[3]);
    // Smoothing: the strongest is preferred, but less than in proportion to the score.
    const ratio = counts[3]! / counts[0]!;
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThan(scores[3]! / scores[0]!);
  }, 300_000);

  test('γ = 0 is uniform among feasible culprits; a larger γ sharpens the preference', () => {
    const uniform = frequencies(0);
    expect(uniform.probabilities).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(chiSquare(uniform.counts, uniform.probabilities)).toBeLessThan(CRITICAL[3]);
    const sharp = frequencies(4);
    expect(chiSquare(sharp.counts, sharp.probabilities)).toBeLessThan(CRITICAL[3]);
    expect(sharp.counts[3]! / sharp.counts[0]!).toBeGreaterThan(
      uniform.counts[3]! / uniform.counts[0]!,
    );
  }, 300_000);
});

describe('sanatorium_winter sweep', () => {
  // Invariants only: they must hold for any correct update of the scenario data (CNT-003).
  test('every reported opportunity is confirmed by an independent simulation', () => {
    let feasibleWorlds = 0;
    for (let seed = 0; seed < 30; seed++) {
      const input = incidentInput(sanatorium, String(seed));
      const assessment = assessIncidents(input, sanatorium);
      for (const option of assessment.options) {
        for (const { characterId, opportunities } of option.feasible) {
          for (const opportunity of opportunities) {
            expect(
              confirm(
                input,
                sanatorium,
                characterId,
                option.victimId,
                option.templateId,
                opportunity,
              ),
            ).toEqual([]);
          }
        }
      }
      const any = assessment.options.some(({ feasible }) => feasible.length);
      if (any) feasibleWorlds++;
      else expect(() => select(input, sanatorium, String(seed))).toThrow(GenerationRejection);
    }
    expect(feasibleWorlds).toBeGreaterThan(0);
  }, 300_000);
});
