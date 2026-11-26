import { test } from 'vitest';
import { sanatorium } from '../support/incident.ts';
import { checkPlotSeeds } from '../support/plot-planning.ts';

test('sanatorium_winter: every plan is feasible on seeds 0–249', () => {
  checkPlotSeeds(sanatorium, 0, 250);
}, 120_000);
