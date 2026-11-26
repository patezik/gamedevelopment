import { fileURLToPath } from 'node:url';
import { loadScenarioFromDir } from '@hs/core/content';
import { expect, test } from 'vitest';
import { generateInvestigation } from './index.ts';

const scenarios = new URL('../../../content/scenarios/', import.meta.url);
const sanatorium = loadScenarioFromDir(fileURLToPath(new URL('sanatorium_winter/', scenarios)));

// CNT-013: a physical trace is found by examining the hotspot whose ID is the trace template
// (`ruleFor` in EvidenceGen), so the location of the trace must have such a hotspot.

test('every physical trace template has a hotspot in at least one location', () => {
  const templates = sanatorium.traceRules
    .flatMap(({ produces }) => produces)
    .filter(({ kind }) => kind === 'physical')
    .map(({ template }) => template);
  expect(templates.length).toBeGreaterThan(0);
  for (const template of new Set(templates)) {
    const places = sanatorium.locations.filter(({ hotspots }) =>
      hotspots.some(({ id }) => id === template),
    );
    expect(places.length, template).toBeGreaterThan(0);
  }
});

test('a fixed trace location of a physical rule has the hotspot', () => {
  for (const { produces } of sanatorium.traceRules) {
    for (const { kind, at, template } of produces) {
      if (kind !== 'physical' || at.startsWith('$')) continue;
      const location = sanatorium.locations.find(({ id }) => id === at);
      expect(
        location?.hotspots.some(({ id }) => id === template),
        `${template}@${at}`,
      ).toBe(true);
    }
  }
});

test('sanatorium_winter: every hotspot clue of seeds 1, 2, 3, 6 can be examined where it lies', () => {
  let required = 0;
  for (const seed of ['1', '2', '3', '6']) {
    const result = generateInvestigation({ scenarioId: 'sanatorium_winter', seed }, sanatorium);
    expect(result.ok, seed).toBe(true);
    if (!result.ok) continue;
    const requiredIds = new Set(result.server.requiredClueIds);
    for (const clue of result.server.clues) {
      const { action, locationId } = clue.discovery;
      if (action.type !== 'examineHotspot') continue;
      const location = sanatorium.locations.find(({ id }) => id === locationId);
      const hotspot = location?.hotspots.find(({ id }) => id === action.hotspotId);
      expect(hotspot, `${seed}: ${action.hotspotId}@${locationId}`).toBeDefined();
      if (requiredIds.has(clue.id)) required++;
    }
  }
  // The means of the poisoning is a required physical clue in these seeds.
  expect(required).toBeGreaterThan(0);
}, 30_000);
