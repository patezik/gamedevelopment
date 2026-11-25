import { stateHash } from '@hs/core/common';
import { expect, test } from 'vitest';
import { incidentInput, minimal } from '../../test/support/incident.ts';
import {
  GENERATOR_VERSION,
  incidentSelection,
  runPipeline,
  type IncidentSelectionInput,
  type Stage,
} from '../index.ts';

/*
 * Golden snapshots (ADR 0004): any change of these results for existing seeds must raise the
 * minor GENERATOR_VERSION and update the hashes together.
 */
test('golden IncidentSelection results for five seeds of _test_minimal', () => {
  const results = ['0', '1', '2', '3', '4'].map((seed) => {
    const input = incidentInput(minimal, seed);
    const fixed: Stage<undefined, IncidentSelectionInput> = {
      name: 'Input',
      generate: () => input,
    };
    const result = runPipeline([fixed, incidentSelection], undefined, {
      seed,
      content: minimal,
      now: () => 0,
    });
    if (!result.ok) throw new Error(`Expected an incident for seed ${seed}`);
    expect(result.report.generatorVersion).toBe(GENERATOR_VERSION);
    const { incident, incidentReport } = result.output;
    return [
      seed,
      `${incident.culpritId}>${incident.victimId}`,
      stateHash({ incident, incidentReport }),
    ];
  });
  expect(GENERATOR_VERSION).toBe('0.3.0');
  expect(results).toEqual([
    ['0', 'ch_1>ch_2', '47111ff09b8fedaf51304956ad2fdd4896343dbcd040e7139e7f73f7ffd5e095'],
    ['1', 'ch_1>ch_3', '98917b6fb14f947338f14daa26bf7aec351255aeebfc12a629bcdb4d2a29546f'],
    ['2', 'ch_2>ch_3', 'e41a18975482e31bf49e45e8405b245e71811c3aff30d8e7c9bc42ad61976545'],
    ['3', 'ch_2>ch_3', 'c27a083e031bc42a41d9e10216d9cc1a4f5d93e2d8e2d260a4618606228e86f5'],
    ['4', 'ch_2>ch_3', '27acfbc42920428a01adf8a26892a425283445e5e2b46ccb4387cd4132ff9910'],
  ]);
});
