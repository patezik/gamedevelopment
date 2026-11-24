import { describe, expect, test } from 'vitest';
import {
  incidentInput,
  minimal,
  motive,
  oracle,
  scenario,
  select,
  withIncident,
} from '../../test/support/incident.ts';
import { assessIncidents, type IncidentSelectionInput } from '../index.ts';

const SEEDS = 2000;

describe('_test_minimal over 2000 seeds', () => {
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
      const { incident, incidentReport } = select(input, minimal, String(seed));
      expect(incident.culpritId).not.toBe(incident.victimId);
      const option = assessment.options.find(
        (o) => o.victimId === incident.victimId && o.templateId === incident.templateId,
      )!;
      expect(option.feasible.map(({ characterId }) => characterId)).toContain(incident.culpritId);
      expect(incidentReport.feasibleCulpritCount).toBe(option.feasible.length);
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
  }, 120_000);
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
    const [option] = assessIncidents(input, preset).options.filter((o) => o.feasible.length);
    const culprits = option!.feasible.map(({ characterId }) => characterId);
    const weights = option!.feasible.map(({ score }) => score ** gamma);
    const total = weights.reduce((sum, w) => sum + w, 0);
    const counts = culprits.map(() => 0);
    for (let draw = 0; draw < DRAWS; draw++) {
      const { incident } = select(input, preset, `draw-${draw}`);
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
  }, 120_000);

  test('γ = 0 is uniform among feasible culprits; a larger γ sharpens the preference', () => {
    const uniform = frequencies(0);
    expect(uniform.probabilities).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(chiSquare(uniform.counts, uniform.probabilities)).toBeLessThan(CRITICAL[3]);
    const sharp = frequencies(4);
    expect(chiSquare(sharp.counts, sharp.probabilities)).toBeLessThan(CRITICAL[3]);
    expect(sharp.counts[3]! / sharp.counts[0]!).toBeGreaterThan(
      uniform.counts[3]! / uniform.counts[0]!,
    );
  }, 120_000);
});

describe('sanatorium_winter sweep', () => {
  test('the chosen plan always matches the oracle; staged_fall has no scene on main data', () => {
    const sanatorium = scenario('sanatorium_winter');
    let worlds = 0;
    for (let seed = 0; seed < 60; seed++) {
      const input = incidentInput(sanatorium, String(seed));
      const assessment = assessIncidents(input, sanatorium);
      for (const option of assessment.options) {
        for (const { characterId, opportunities } of option.feasible) {
          const windows = oracle(
            input,
            sanatorium,
            characterId,
            option.victimId,
            option.templateId,
          );
          expect(new Map(opportunities.map(({ locationId, from }) => [locationId, from]))).toEqual(
            windows,
          );
        }
      }
      if (assessment.options.some(({ feasible }) => feasible.length)) worlds++;
      // No location has both "residential" and "hazard" (CNT-003 replaces this template).
      expect(
        assessment.options.filter((o) => o.templateId === 'staged_fall' && o.feasible.length),
      ).toEqual([]);
    }
    expect(worlds).toBeGreaterThan(0);
  }, 120_000);
});
