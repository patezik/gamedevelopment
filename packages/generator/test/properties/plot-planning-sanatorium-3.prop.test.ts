import { test } from 'vitest';
import { sanatorium } from '../support/incident.ts';
import { checkPlotSeeds } from '../support/plot-planning.ts';

test('sanatorium_winter: every plan is feasible on seeds 500–749', () => {
  checkPlotSeeds(sanatorium, 500, 750);
}, 120_000);
