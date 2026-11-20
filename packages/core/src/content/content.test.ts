import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import {
  archetypesSchema,
  crimesSchema,
  deductionRulesSchema,
  itemsSchema,
  locationsSchema,
  motivesSchema,
  phoneTemplatesSchema,
  presetSchema,
  relationshipsSchema,
  textTemplatesSchema,
  traceRulesSchema,
} from './schemas.ts';
import { ContentError, createContentRepo, crossCheck, loadScenarioFromDir } from './index.ts';

const root = fileURLToPath(new URL('../../../../content/scenarios/', import.meta.url));
const fixture = join(root, '_test_minimal');
const valid = loadScenarioFromDir(fixture);

test.each([
  ['preset', presetSchema, valid.preset, { ...valid.preset, phone: { minQrShare: 1.2 } }],
  [
    'locations',
    locationsSchema,
    valid.locations,
    [{ ...valid.locations[0], lighting: { night: 'dark' } }],
  ],
  ['items', itemsSchema, valid.items, [{ ...valid.items[0], locationId: 123 }]],
  [
    'archetypes',
    archetypesSchema,
    valid.archetypes,
    [{ ...valid.archetypes[0], personality: { honesty: [1, 0] } }],
  ],
  [
    'relationships',
    relationshipsSchema,
    valid.relationships,
    [{ ...valid.relationships[0], fromArchetypes: 'visitor' }],
  ],
  [
    'motives',
    motivesSchema,
    valid.motives,
    [{ ...valid.motives[0], strength: { base: -1, plus: [] } }],
  ],
  ['crimes', crimesSchema, valid.crimes, [{ ...valid.crimes[0], plan: [] }]],
  ['traceRules', traceRulesSchema, valid.traceRules, [{ ...valid.traceRules[0], produces: [] }]],
  [
    'deductionRules',
    deductionRulesSchema,
    valid.deductionRules,
    [{ ...valid.deductionRules[0], requires: [] }],
  ],
  ['text', textTemplatesSchema, valid.text.ru?.common, { missing_record: [] }],
  [
    'phone',
    phoneTemplatesSchema,
    valid.phone.inbox,
    [{ ...valid.phone.inbox?.[0], kind: 'native' }],
  ],
] as const)('%s accepts its fixture and rejects a typical mistake', (_name, schema, good, bad) => {
  expect(schema.safeParse(good).success).toBe(true);
  expect(schema.safeParse(bad).success).toBe(false);
});

test('rejects a zone suffix and an invalid calendar date', () => {
  for (const startDateTime of ['2026-01-14T08:00:00Z', '2026-02-30T08:00:00']) {
    expect(
      presetSchema.safeParse({ ...valid.preset, time: { ...valid.preset.time, startDateTime } })
        .success,
    ).toBe(false);
  }
});

test('finds broken location, item and archetype references and missing trace rules', () => {
  const content = structuredClone(valid);
  content.locations[0]!.connections[0]!.to = 'loc_missing';
  content.locations[1]!.hotspots[0]!.itemIds = ['it_missing'];
  content.preset.cast.quotas[0]!.archetype = 'missing';
  content.crimes[0]!.plan[0]!.verb = 'unknown';
  expect(crossCheck(content)).toEqual([
    {
      code: 'CONTENT_DANGLING_REF',
      path: 'preset.cast.quotas[0].archetype',
      message: 'Unknown ID "missing"',
    },
    {
      code: 'CONTENT_DANGLING_REF',
      path: 'locations[0].connections[0].to',
      message: 'Unknown ID "loc_missing"',
    },
    {
      code: 'CONTENT_DANGLING_REF',
      path: 'locations[1].hotspots[0].itemIds[0]',
      message: 'Unknown ID "it_missing"',
    },
    {
      code: 'CONTENT_MISSING_TRACE_RULE',
      path: 'crimes[0].plan[0].verb',
      message: 'No trace rule for verb "unknown"',
    },
  ]);
});

test('reports duplicate IDs', () => {
  const content = { ...valid, items: [...valid.items, ...valid.items] };
  expect(crossCheck(content)).toContainEqual({
    code: 'CONTENT_SCHEMA_ERROR',
    path: 'items[1].id',
    message: 'Duplicate ID "it_log"',
  });
});

test('loads the summarized scenario and rejects paths as IDs', () => {
  const repo = createContentRepo(root);
  expect(repo.listScenarios()).toContainEqual({
    id: '_test_minimal',
    title: { ru: 'Тестовый сценарий' },
    durationMinutes: 120,
  });
  expect(repo.load('_test_minimal')).toEqual(valid);
  expect(() => repo.load('../_test_minimal')).toThrow('Invalid scenario ID');
});

test('loader reports the exact path for schema errors and dangling references', () => {
  const folder = mkdtempSync(join(tmpdir(), 'hs-content-test-'));
  try {
    cpSync(fixture, folder, { recursive: true });
    const location = valid.locations[0]!;
    const file = join(folder, 'locations.json');
    writeFileSync(file, JSON.stringify([{ ...location, connections: [{ to: 123, minutes: 2 }] }]));
    expect(() => loadScenarioFromDir(folder)).toThrow(
      /CONTENT_SCHEMA_ERROR locations\[0\]\.connections\[0\]\.to/,
    );
    writeFileSync(
      file,
      JSON.stringify([
        { ...location, connections: [{ to: 'loc_missing', minutes: 2 }] },
        valid.locations[1],
      ]),
    );
    expect(() => loadScenarioFromDir(folder)).toThrow(
      /CONTENT_DANGLING_REF locations\[0\]\.connections\[0\]\.to/,
    );
    writeFileSync(file, '{ broken JSON');
    expect(() => loadScenarioFromDir(folder)).toThrow(ContentError);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
