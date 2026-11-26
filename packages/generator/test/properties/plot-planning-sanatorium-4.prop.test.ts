import { test } from 'vitest';
import { sanatorium } from '../support/incident.ts';
import { checkPlotSeeds } from '../support/plot-planning.ts';

test('sanatorium_winter: every plan is feasible on seeds 750–999', () => {
  checkPlotSeeds(sanatorium, 750, 1000);
}, 120_000);
