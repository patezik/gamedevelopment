import { fileURLToPath } from 'node:url';
import { loadScenarioFromDir } from '@hs/core/content';
import {
  serializeInvestigation,
  deserializeInvestigation,
  type Investigation,
} from '@hs/core/game';
import { compileDeductionRules } from '@hs/core/investigation';
import type { Question } from '@hs/core/knowledge';
import {
  collectTestimony,
  phoneRequiredCheck,
  testimonyCheck,
  timelineCheck,
  truthInvariantsCheck,
  investigationHash,
  type Check,
  type ValidationContext,
} from '@hs/validator';
import { expect, test } from 'vitest';
import { runCli } from './cli.ts';
import {
  GENERATION_CHECKS,
  GENERATOR_VERSION,
  generateInvestigation,
  type GenerationResult,
  type ServerGenerationPayload,
} from './index.ts';

const scenarios = new URL('../../../content/scenarios/', import.meta.url);
const minimal = loadScenarioFromDir(fileURLToPath(new URL('_test_minimal/', scenarios)));
const req = (seed: string) => ({ scenarioId: '_test_minimal', seed });

/**
 * The gate without the solver and lie checks. The shipped deduction rules never establish a
 * motive (see OQ-20), so the full gate rejects every seed; these checks still gate the rest.
 */
const STRUCTURAL: readonly Check[] = [
  truthInvariantsCheck,
  timelineCheck,
  testimonyCheck,
  phoneRequiredCheck,
];

function accepted(result: GenerationResult) {
  if (!result.ok) throw new Error('Expected an accepted investigation');
  return result;
}

test('golden: five seeds of _test_minimal give the same investigations (structural gate)', () => {
  expect(GENERATOR_VERSION).toBe('0.3.0');
  const rows = ['0', '1', '2', '3', '4'].map((seed) => {
    const result = accepted(generateInvestigation(req(seed), minimal, { checks: STRUCTURAL }));
    const { incident } = result.investigation.truth;
    return [
      seed,
      result.report.attempts.length,
      incident.type,
      incident.culpritIds[0],
      result.investigationHash,
    ];
  });
  expect(rows).toMatchInlineSnapshot(`
    [
      [
        "0",
        1,
        "theft",
        "ch_1",
        "55c976721d581ad13774a29fc246baacf699576168aa15402e3dc75e4a9578d6",
      ],
      [
        "1",
        1,
        "theft",
        "ch_1",
        "69e24f16ecca038457f8eb8e66bcd201e035797d615dd51d40f8ec611ce0c459",
      ],
      [
        "2",
        1,
        "theft",
        "ch_2",
        "cbbffdfcf6d3eef4a19d2d04ed4e0b94df04c72861f44d60ab0b13f872b3dfc1",
      ],
      [
        "3",
        1,
        "theft",
        "ch_2",
        "cb9903167d283c35bd0cc7527e418daa7940030a7e8fa25fe43abcd23af4ec39",
      ],
      [
        "4",
        1,
        "theft",
        "ch_2",
        "3ca42835ce4b6b11327a8b7520a736d378bac764e52f62cb786d1490a520b581",
      ],
    ]
  `);
});

test('is deterministic and packages a restorable investigation', () => {
  const first = accepted(generateInvestigation(req('7'), minimal, { checks: STRUCTURAL }));
  const second = accepted(generateInvestigation(req('7'), minimal, { checks: STRUCTURAL }));
  expect(second.investigationHash).toBe(first.investigationHash);
  expect(serializeInvestigation(second.investigation)).toBe(
    serializeInvestigation(first.investigation),
  );
  expect(first.investigationHash).toBe(investigationHash(first.investigation));
  expect(first.investigation).toMatchObject({
    scenarioId: '_test_minimal',
    seed: '7',
    generatorVersion: GENERATOR_VERSION,
  });
  const restored = deserializeInvestigation(serializeInvestigation(first.investigation));
  expect(investigationHash(restored)).toBe(first.investigationHash);
  expect(generateInvestigation(req('8'), minimal, { checks: STRUCTURAL })).not.toMatchObject({
    investigationHash: first.investigationHash,
  });
  // The report names the incident and the attempts that were validated.
  expect(first.report.chosen?.template).toBeTypeOf('string');
  expect(first.report.validations.at(-1)).toMatchObject({ ok: true });
  expect(first.report.validations).toHaveLength(first.report.attempts.length);
});

test('rejects a request for another scenario than the content', () => {
  expect(() => generateInvestigation({ scenarioId: 'other', seed: '1' }, minimal)).toThrow(
    /not other/,
  );
});

test('GENERATION_UNSOLVABLE: every attempt is rejected with the reasons of the failed checks', () => {
  const result = generateInvestigation(req('1'), minimal);
  if (result.ok) throw new Error('The shipped rules cannot prove a motive; expected a rejection');
  expect(result.error).toBe('GENERATION_UNSOLVABLE');
  expect(result.report.attempts).toHaveLength(8);
  expect(result.report.attempts.every(({ accepted }) => !accepted)).toBe(true);
  expect(result.report.validations).toHaveLength(8);
  // A failed generation keeps its contract: no server payload of any attempt.
  expect(Object.keys(result).sort()).toEqual(['error', 'ok', 'report']);
  for (const { ok, findings } of result.report.validations) {
    expect(ok).toBe(false);
    const codes = findings.map(({ code }) => code);
    expect(codes).toContain('CULPRIT_NOT_PROVABLE');
    expect(codes).toContain('NOT_UNIQUE');
    expect(findings.every(({ message }) => message.length > 0)).toBe(true);
  }
  expect(generateInvestigation(req('1'), minimal, { maxAttempts: 3 }).report.attempts).toHaveLength(
    3,
  );
});

test('the gate runs every check of the default list', () => {
  expect(GENERATION_CHECKS.map(({ id }) => id)).toEqual([
    'V-TRUTH-INV',
    'V-TIMELINE',
    'V-PHONE-REQUIRED',
    'V-HALLUCINATION',
    'V-REACHABLE',
    'V-CULPRIT-PROVABLE',
    'V-UNIQUE',
    'V-LIES-BREAKABLE',
    'V-TESTIMONY',
  ]);
});

test('a failed check repairs the case with the next attempt seed', () => {
  const noFirstCulprit: Check = {
    id: 'V-NOT-CH-1',
    description: 'Test gate: ch_1 is never the culprit',
    run: ({ truth }) =>
      truth.incident.culpritIds.includes('ch_1')
        ? [{ severity: 'error', code: 'CH_1_GUILTY', message: 'ch_1 is guilty', eventIds: [] }]
        : [],
  };
  let repaired = 0;
  for (let n = 0; n < 40 && repaired < 3; n++) {
    const result = accepted(
      generateInvestigation(req(`gate-${n}`), minimal, { checks: [noFirstCulprit] }),
    );
    expect(result.investigation.truth.incident.culpritIds).not.toContain('ch_1');
    const { attempts, validations } = result.report;
    expect(validations.map(({ attempt }) => attempt)).toEqual(attempts.map(({ number }) => number));
    if (attempts.length === 1) continue;
    repaired++;
    expect(validations[0]).toMatchObject({
      ok: false,
      findings: [expect.objectContaining({ code: 'CH_1_GUILTY' })],
    });
    expect(attempts.at(-1)?.seed).toBe(`gate-${n}#${attempts.length}`);
  }
  expect(repaired).toBeGreaterThan(0);
});

test('a gate that never passes ends in GENERATION_UNSOLVABLE', () => {
  const never: Check = {
    id: 'V-NEVER',
    description: 'Test gate: always fails',
    run: () => [{ severity: 'error', code: 'NEVER', message: 'no', eventIds: [] }],
  };
  const result = generateInvestigation(req('2'), minimal, { checks: [never] });
  expect(result).toMatchObject({ ok: false, error: 'GENERATION_UNSOLVABLE' });
});

test('a warning does not stop a case', () => {
  const warn: Check = {
    id: 'V-WARN',
    description: 'Test gate: only warns',
    run: () => [{ severity: 'warning', code: 'W', message: 'hm', eventIds: [] }],
  };
  const result = accepted(generateInvestigation(req('3'), minimal, { checks: [warn] }));
  expect(result.report.validations[0]?.findings).toHaveLength(1);
});

test('hs-gen without --debug-truth prints no truth, with it prints the investigation', () => {
  const run = (...args: string[]) =>
    runCli(['--scenario', '_test_minimal', '--seed', '4', ...args], { checks: STRUCTURAL });
  const direct = accepted(generateInvestigation(req('4'), minimal, { checks: STRUCTURAL }));
  const culprit = direct.investigation.truth.incident.culpritIds[0]!;

  const plain = run();
  expect(plain.code).toBe(0);
  expect(JSON.parse(plain.stdout)).toEqual({
    ok: true,
    scenarioId: '_test_minimal',
    seed: '4',
    generatorVersion: GENERATOR_VERSION,
    attempts: direct.report.attempts.length,
    investigationHash: direct.investigationHash,
  });
  for (const secret of ['culprit', 'truth', 'veracity', 'hallucination', 'motive']) {
    expect(plain.stdout).not.toContain(secret);
  }
  // The server payload of GEN-013 stays out of the public output.
  for (const key of ['server', 'clues', 'requiredClueIds', 'liePolicies', 'testimony', 'rules']) {
    expect(plain.stdout).not.toContain(key);
  }
  for (const { id } of direct.server.clues) expect(plain.stdout).not.toContain(id);

  const debug = run('--debug-truth');
  const parsed = JSON.parse(debug.stdout) as Record<string, unknown>;
  expect(debug.code).toBe(0);
  expect(parsed).toMatchObject({ investigationHash: direct.investigationHash });
  expect(JSON.stringify(parsed.investigation)).toContain('culpritIds');
  expect(JSON.stringify(parsed.investigation)).toContain(culprit);
  expect(parsed.report).toMatchObject({ seed: '4' });
  expect(Object.keys(parsed).sort()).toEqual(
    [...Object.keys(JSON.parse(plain.stdout) as object), 'investigation', 'report'].sort(),
  );
});

test('hs-gen on an unsolvable case exits 1 with codes only, and 2 on bad arguments', () => {
  const failed = runCli(['--scenario', '_test_minimal', '--seed', '1']);
  expect(failed.code).toBe(1);
  const body = JSON.parse(failed.stdout) as {
    error: string;
    failures: { attempt: number; reasons: string[] }[];
  };
  expect(body.error).toBe('GENERATION_UNSOLVABLE');
  expect(body.failures).toHaveLength(8);
  expect(body.failures[0]?.reasons).toContain('V-CULPRIT-PROVABLE:CULPRIT_NOT_PROVABLE');
  expect(failed.stdout).not.toMatch(/ch_\d/);

  expect(runCli(['--scenario', '_test_minimal']).code).toBe(2);
  expect(runCli(['--scenario', '_test_minimal', '--seed']).code).toBe(2);
  expect(runCli(['--scenario', '_test_minimal', '--seed', '1', '--nope']).code).toBe(2);
  expect(runCli(['--scenario', 'missing_scenario', '--seed', '1']).code).toBe(2);
});

interface Gated {
  readonly investigation: Investigation;
  readonly context: ValidationContext;
}

/** Test gate: records what each attempt was checked with; rejects the first attempt if asked. */
function recording(seen: Gated[], rejectFirst: boolean): Check {
  return {
    id: 'V-RECORD',
    description: 'Test gate: records the investigation and context of every attempt',
    run: (investigation, context) => {
      seen.push({ investigation, context });
      return rejectFirst && seen.length === 1
        ? [{ severity: 'error', code: 'FIRST_REJECTED', message: 'first', eventIds: [] }]
        : [];
    },
  };
}

/** The question bank of the gate (`questionsFor` in generate.ts). */
function questionsFor(investigation: Investigation): Question[] {
  return [
    { type: 'whereWereYou', interval: investigation.truth.incident.window },
    { type: 'aboutYourself' },
    ...investigation.characters.map(({ id }) => ({
      type: 'whatDoYouKnowAbout' as const,
      characterId: id,
    })),
  ];
}

/** Testimony drawn again from the payload's own memories and lie policies. */
function testimonyOf(server: ServerGenerationPayload, investigation: Investigation) {
  const witnesses = investigation.characters.map((character) => ({
    character,
    knowledge: server.knowledge.get(character.id)!,
    policy: server.liePolicies.get(character.id)!,
  }));
  return collectTestimony(witnesses, questionsFor(investigation), 0);
}

function canonical(server: ServerGenerationPayload): string {
  return JSON.stringify({
    ...server,
    knowledge: [...server.knowledge].map(([id, store]) => [id, store.serialize()]),
    liePolicies: [...server.liePolicies],
  });
}

/** Every field of the payload is the object the gate checked in `gated` (the accepted attempt). */
function expectPayloadOf(result: GenerationResult & { ok: true }, gated: Gated) {
  const { server, investigation } = result;
  const { context } = gated;
  expect(investigation).toBe(gated.investigation);
  expect(result.investigationHash).toBe(investigationHash(gated.investigation));
  expect(server.startLocationId).toBe(context.startLocationId);
  expect(server.clues).toBe(context.clues);
  expect(server.requiredClueIds).toBe(context.requiredClueIds);
  expect(server.testimony).toBe(context.testimony);
  expect(server.statements).toBe(context.statements);
  expect(server.deductionRules).toBe(context.deductionRules);
  // Memories and policies give exactly the testimony the gate checked.
  expect(testimonyOf(server, investigation)).toEqual(context.testimony);
}

test('GEN-013: an accepted case carries the server payload the gate checked', () => {
  const seen: Gated[] = [];
  const result = accepted(
    generateInvestigation(req('7'), minimal, { checks: [...STRUCTURAL, recording(seen, false)] }),
  );
  expect(seen).toHaveLength(1);
  expect(result.server.attempt).toBe(1);
  expectPayloadOf(result, seen[0]!);

  const { server, investigation } = result;
  const clueIds = new Set(server.clues.map(({ id }) => id));
  expect(server.requiredClueIds.length).toBeGreaterThan(0);
  expect(server.requiredClueIds.every((id) => clueIds.has(id))).toBe(true);
  const cast = investigation.characters.map(({ id }) => id).sort();
  expect([...server.knowledge.keys()].sort()).toEqual(cast);
  expect([...server.liePolicies.keys()].sort()).toEqual(cast);
  expect(server.testimony.length).toBeGreaterThan(0);
  expect(server.statements.map(({ id }) => id)).toEqual(server.testimony.map(({ id }) => id));
  expect(server.statements.some((statement) => 'veracity' in statement)).toBe(false);
  expect(server.deductionRules).toEqual(compileDeductionRules(minimal.deductionRules));
});

test('GEN-013: after a rejected first attempt the payload is the accepted attempt', () => {
  const run = () => {
    const seen: Gated[] = [];
    let clockReads = 0;
    const result = accepted(
      generateInvestigation(req('0'), minimal, {
        checks: [...STRUCTURAL, recording(seen, true)],
        now: () => clockReads++,
      }),
    );
    return { seen, result, clockReads };
  };
  const { seen, result, clockReads } = run();
  expect(result.report.attempts.map(({ number }) => number)).toEqual([1, 2]);
  // Two clock reads per stage: attempts 1 and 2 plus the V-DETERMINISM replay of attempt 2, and
  // no further generation to build the payload.
  const stages = Object.keys(result.report.attempts[0]!.timingsMs).length;
  expect(stages).toBe(10);
  expect(clockReads).toBe(2 * stages * 3);
  expect(result.report.validations[0]).toMatchObject({
    attempt: 1,
    ok: false,
    findings: [expect.objectContaining({ code: 'FIRST_REJECTED' })],
  });
  expect(seen).toHaveLength(2);
  expect(result.server.attempt).toBe(2);
  expectPayloadOf(result, seen[1]!);

  // The rejected attempt generated another case; none of its data is in the payload.
  const rejected = seen[0]!;
  expect(result.investigationHash).not.toBe(investigationHash(rejected.investigation));
  expect(result.server.clues).not.toEqual(rejected.context.clues);
  expect(result.server.testimony).not.toEqual(rejected.context.testimony);
  expect(testimonyOf(result.server, result.investigation)).not.toEqual(rejected.context.testimony);

  // Deterministic: a second run gives the same payload and hash.
  const again = run().result;
  expect(again.investigationHash).toBe(result.investigationHash);
  expect(canonical(again.server)).toBe(canonical(result.server));
});
