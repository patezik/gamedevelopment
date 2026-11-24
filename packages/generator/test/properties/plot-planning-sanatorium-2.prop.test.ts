import { test } from 'vitest';
import { sanatorium } from '../support/incident.ts';
import { checkPlotSeeds } from '../support/plot-planning.ts';

test('sanatorium_winter: every plan is feasible on seeds 250–499', () => {
  checkPlotSeeds(sanatorium, 250, 500);
}, 120_000);
