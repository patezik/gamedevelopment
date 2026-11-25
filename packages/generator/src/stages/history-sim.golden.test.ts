import { stateHash } from '@hs/core/common';
import { expect, test } from 'vitest';
import { incidentInput, minimal } from '../../test/support/incident.ts';
import {
  GENERATOR_VERSION,
  historySimulation,
  incidentSelection,
  plotPlanning,
  runPipeline,
  type IncidentSelectionInput,
  type Stage,
} from '../index.ts';

/*
 * Golden snapshots (ADR 0004): any change of these results for existing seeds must raise the
 * minor GENERATOR_VERSION and update the hashes together.
 */
test('golden HistorySimulation results for five seeds of _test_minimal', () => {
  const results = ['0', '1', '2', '3', '4'].map((seed) => {
    const input = incidentInput(minimal, seed);
    const fixed: Stage<undefined, IncidentSelectionInput> = {
      name: 'Input',
      generate: () => input,
    };
    const result = runPipeline(
      [fixed, incidentSelection, plotPlanning, historySimulation],
      undefined,
      {
        seed,
        content: minimal,
        now: () => 0,
      },
    );
    if (!result.ok) throw new Error(`Expected a history for seed ${seed}`);
    expect(result.report.generatorVersion).toBe(GENERATOR_VERSION);
    const { truth, knowledge, relationshipsAtStart, locationsAtStart, historyReport } =
      result.output;
    return [
      seed,
      truth.incident.keyEventIds.join(','),
      stateHash({
        truth: truth.serialize(),
        knowledge: [...knowledge].map(([id, store]) => [id, store.serialize()]),
        relationships: relationshipsAtStart.snapshot(),
        locationsAtStart: [...locationsAtStart],
        historyReport,
      }),
    ];
  });
  expect(GENERATOR_VERSION).toBe('0.3.0');
  expect(results).toEqual([
    ['0', 'ev_13', '9ad47b7c601972a20929ff06c4422711602b046a9e17a5a0b60e6c61b3d43882'],
    ['1', 'ev_13', '75a68538f48af9fe9b1847984fbfc562c66b0c68add56ce1ecd63ec955f795e6'],
    ['2', 'ev_13', 'e45d46b46af15bd1cf49d42fd93b215e65773d45d1eb93cd3a0979452d59609b'],
    ['3', 'ev_13', '62a60d05cf20f7ce4d10b4af52d46100e82c09f41d71cbf046cf2db179596ecf'],
    ['4', 'ev_13', 'fcb3f484b4927bfb3772919e5140ecbbb9b8c16cbba4f36a3e4ff15c7564cd21'],
  ]);
});
