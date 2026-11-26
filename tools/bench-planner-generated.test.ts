import { expect, test } from 'vitest';
import { timeFeasibleCheck } from '@hs/validator';
import { examineGeneratedCase, generatedPlannerCase, seeds } from './bench-planner-generated.ts';

// examineGeneratedCase replays the found path through GameEngine (phone role for QR captures),
// asserts motive, means and opportunity for every culprit and the end within the 70% budget.
test.each(seeds)(
  'sanatorium_winter seed %s: the planner finds a path that proves the case within 70% of the time',
  (seed) => {
    const result = examineGeneratedCase(seed);
    if ('failure' in result) throw new Error(`Seed ${seed}: ${result.failure}`);
    expect(result).toMatchObject({ seed, budget: 3024, requiredWithoutHotspot: 0 });
    expect(result.captures).toBeGreaterThan(0);
    expect(result.minutes).toBeLessThanOrEqual(3024);
  },
  60_000,
);

test('without the incident briefing the check reports the missing context instead of searching', () => {
  const { investigation, options } = generatedPlannerCase('3');
  const withoutIncident: { -readonly [K in keyof typeof options]?: (typeof options)[K] } = {
    ...options,
  };
  delete withoutIncident.knownIncident;
  expect(timeFeasibleCheck.run(investigation, withoutIncident)[0]?.code).toBe(
    'TIME_INCIDENT_CONTEXT_MISSING',
  );
}, 60_000);

test('without simulated characters the conversation proofs are out of reach', () => {
  const { investigation, options } = generatedPlannerCase('3');
  const ports = options.createSimulationPorts!;
  const quiet = () => {
    const quietPorts: { npcSimulation?: true } = ports();
    delete quietPorts.npcSimulation;
    return quietPorts;
  };
  const failure = timeFeasibleCheck.run(investigation, {
    ...options,
    createSimulationPorts: quiet,
  });
  expect(failure[0]?.code).not.toBeUndefined();
}, 60_000);
