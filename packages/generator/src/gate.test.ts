import { fileURLToPath } from 'node:url';
import { loadScenarioFromDir } from '@hs/core/content';
import { expect, test } from 'vitest';
import { generateInvestigation } from './index.ts';

const scenarios = new URL('../../../content/scenarios/', import.meta.url);
const load = (id: string) => loadScenarioFromDir(fileURLToPath(new URL(`${id}/`, scenarios)));
const minimal = load('_test_minimal');

// GEN-014: the generator passes its own validation gate. No `checks` option anywhere in this
// file: the default gate (structural checks, solver, testimony checks) decides.

test('_test_minimal: 25 seeds pass the default gate', () => {
  for (let i = 0; i < 25; i++) {
    const seed = `gate-${i}`;
    const result = generateInvestigation({ scenarioId: '_test_minimal', seed }, minimal);
    if (!result.ok) {
      const reasons = result.report.validations.flatMap(({ findings }) =>
        findings.filter(({ severity }) => severity === 'error').map(({ code }) => code),
      );
      throw new Error(`${seed}: rejected (${reasons.join(', ')})`);
    }
    const last = result.report.validations.at(-1);
    expect(last?.ok, seed).toBe(true);
    expect(
      last?.findings.filter(({ severity }) => severity === 'error'),
      seed,
    ).toEqual([]);
  }
});

test('_test_minimal: the motive comes from a bystander, and the culprit tells no unbreakable lie', () => {
  for (let i = 0; i < 10; i++) {
    const seed = `gate-${i}`;
    const result = generateInvestigation({ scenarioId: '_test_minimal', seed }, minimal);
    if (!result.ok) throw new Error(`${seed}: rejected`);
    const { culpritIds, victimIds } = result.investigation.truth.incident;
    const motives = result.server.testimony.filter(
      ({ proposition }) => proposition.kind === 'motive',
    );
    expect(motives.length, seed).toBeGreaterThan(0);
    for (const { speakerId, veracity, proposition } of motives) {
      expect(culpritIds, seed).not.toContain(speakerId);
      expect(victimIds, seed).not.toContain(speakerId);
      expect(veracity, seed).toBe('true');
      expect(proposition.kind === 'motive' && culpritIds.includes(proposition.who), seed).toBe(
        true,
      );
    }
    // The solver sees these answers as testimony, so the same statements reach the rules.
    expect(result.server.statements.length, seed).toBe(result.server.testimony.length);
  }
});

test('_test_minimal: without a rule of the proof the gate rejects', () => {
  const drop = (...rules: string[]) => ({
    ...minimal,
    deductionRules: minimal.deductionRules.filter(({ id }) => !rules.includes(id)),
  });
  const codes = (content: typeof minimal) =>
    generateInvestigation({ scenarioId: '_test_minimal', seed: 'gate-0' }, content, {
      maxAttempts: 2,
    }).report.validations.flatMap(({ findings }) => findings.map(({ code }) => code));
  expect(codes(drop('motive_from_testimony'))).toContain('CULPRIT_NOT_PROVABLE');
  expect(codes(drop('means_from_log'))).toContain('CULPRIT_NOT_PROVABLE');
  expect(codes(drop('no_access_from_record', 'alibi_from_witness'))).toContain('NOT_UNIQUE');
});

test('sanatorium_winter: culprits are provable and lies breakable; some seeds pass the gate', () => {
  // Known gap (GEN-014): an innocent who moves during the incident window has no single record
  // of presence, so V-UNIQUE still rejects some seeds; that is the only reason such a seed fails.
  const sanatorium = load('sanatorium_winter');
  const passed: string[] = [];
  for (const seed of ['1', '2', '3', '4', '5', '6']) {
    const result = generateInvestigation({ scenarioId: 'sanatorium_winter', seed }, sanatorium);
    if (result.ok) passed.push(seed);
    for (const { findings } of result.report.validations) {
      for (const { code } of findings.filter(({ severity }) => severity === 'error')) {
        expect(['NOT_UNIQUE'], `seed ${seed}`).toContain(code);
      }
    }
  }
  // CNT-003 data (GENERATOR_VERSION 0.4.0): seed 1 spends its attempts on NOT_UNIQUE and on
  // boiler_accident attempts that EvidenceGen or PlotPlanning reject; seed 4 passes on attempt 4.
  expect(passed).toEqual(['2', '3', '4', '6']);
}, 60_000);
