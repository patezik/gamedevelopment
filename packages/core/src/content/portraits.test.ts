import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { PORTRAIT_REF } from '../characters/index.ts';
import { archetypesSchema, crossCheck, loadScenarioFromDir, portraitRefOf } from './index.ts';

const root = fileURLToPath(new URL('../../../../content/scenarios/', import.meta.url));
const minimal = loadScenarioFromDir(`${root}_test_minimal`);
const sanatorium = loadScenarioFromDir(`${root}sanatorium_winter`);

const doctor = {
  id: 'head_doctor',
  portraits: { m1: ['Виктор Андреевич Ларионов'], f1: ['Елена Борисовна Каштанова'] },
};

test('portraitRefOf: <archetype_id>.<variant> by name, undefined without a variant', () => {
  expect(portraitRefOf(doctor, 'Виктор Андреевич Ларионов')).toBe('head_doctor.m1');
  expect(portraitRefOf(doctor, 'Елена Борисовна Каштанова')).toBe('head_doctor.f1');
  // NFC: a decomposed «й» or «ё» in either list still matches.
  expect(portraitRefOf(doctor, 'Виктор Андреевич Ларионов'.normalize('NFD'))).toBe(
    'head_doctor.m1',
  );
  expect(portraitRefOf(doctor, 'Олег Петрович Суворин')).toBeUndefined();
  expect(portraitRefOf({ id: 'cook' }, 'Олег Петрович Суворин')).toBeUndefined();
  // An archetype id the desktop art library cannot load gives no reference.
  expect(
    portraitRefOf({ id: 'head-doctor', portraits: doctor.portraits }, 'Виктор Андреевич Ларионов'),
  ).toBeUndefined();
});

test('archetype schema: portraits map variants of a letter and digits to nonempty name lists', () => {
  const archetype = minimal.archetypes[0]!;
  const name = archetype.names[0]!;
  expect(archetypesSchema.safeParse([{ ...archetype, portraits: { m1: [name] } }]).success).toBe(
    true,
  );
  for (const portraits of [
    { M1: [name] },
    { m: [name] },
    { '1m': [name] },
    { m1: [] },
    { m1: [''] },
  ]) {
    expect(archetypesSchema.safeParse([{ ...archetype, portraits }]).success).toBe(false);
  }
});

test('cross-check: portrait names come from the pool, once each, with a loadable reference', () => {
  const archetype = minimal.archetypes[0]!;
  const [first, second] = archetype.names as [string, string];
  const check = (patch: object) =>
    crossCheck({
      ...minimal,
      archetypes: [{ ...archetype, ...patch }, ...minimal.archetypes.slice(1)],
    });

  expect(check({ portraits: { m1: [first], f1: [second] } })).toEqual([]);
  expect(check({ portraits: { m1: ['Никто Никакой'] } })).toEqual([
    {
      code: 'CONTENT_DANGLING_REF',
      path: 'archetypes[0].portraits.m1[0]',
      message: 'Unknown ID "Никто Никакой"',
    },
  ]);
  expect(check({ portraits: { m1: [first], f1: [first] } })).toEqual([
    {
      code: 'CONTENT_SCHEMA_ERROR',
      path: 'archetypes[0].portraits.f1[0]',
      message: `Name "${first}" has more than one portrait variant`,
    },
  ]);
  expect(check({ id: 'with-dash', portraits: { m1: [first] } })).toContainEqual({
    code: 'CONTENT_SCHEMA_ERROR',
    path: 'archetypes[0].portraits.m1',
    message: '"with-dash.m1" is not a portrait reference',
  });
});

test('sanatorium_winter: portrait variants are valid references for names of the pool', () => {
  expect(crossCheck(sanatorium)).toEqual([]);
  const refs = sanatorium.archetypes.flatMap((archetype) =>
    archetype.names.flatMap((name) => portraitRefOf(archetype, name) ?? []),
  );
  expect(refs.length).toBeGreaterThan(0);
  for (const ref of refs) expect(ref).toMatch(PORTRAIT_REF);
});
