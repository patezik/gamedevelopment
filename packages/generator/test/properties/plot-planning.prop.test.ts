import { test } from 'vitest';
import { minimal } from '../support/incident.ts';
import { checkPlotSeeds } from '../support/plot-planning.ts';

test('_test_minimal: every plan is feasible on 1000 seeds', () => {
  checkPlotSeeds(minimal, 0, 1000);
}, 120_000);
