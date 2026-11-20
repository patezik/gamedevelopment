import { expect, test } from 'vitest';
import { canonicalJson, hashId } from '../common/index.ts';
import { factId, factIdSchema, factSchema, matchProposition, type Fact } from './index.ts';

const presence = {
  kind: 'at',
  who: 'ch_anna',
  where: 'loc_hall',
  interval: { from: -10, to: 0 },
} as const;
const action = {
  kind: 'did',
  who: 'ch_anna',
  where: 'loc_hall',
  at: -8,
  verb: 'inspect_drawer',
} as const;

test.each<Fact>([
  presence,
  action,
  { kind: 'possessed', who: 'ch_anna', item: 'it_key', interval: presence.interval },
  { kind: 'relation', a: 'ch_anna', b: 'ch_igor', relType: 'debt', since: -20 },
  {
    kind: 'motive',
    who: 'ch_anna',
    against: 'ch_igor',
    motiveType: 'debt',
    basis: [factId(presence)],
  },
  {
    kind: 'state',
    entity: { kind: 'item', id: 'it_key' },
    property: 'hidden',
    value: true,
    interval: presence.interval,
  },
])('validates the $kind fact', (fact) => {
  expect(factSchema.parse(fact)).toEqual(fact);
});

test('rejects invalid fact shapes and intervals', () => {
  expect(factSchema.safeParse({ ...presence, extra: true }).success).toBe(false);
  expect(factSchema.safeParse({ ...presence, interval: { from: -1, to: -1 } }).success).toBe(false);
  expect(factSchema.safeParse({ ...action, at: 0.5 }).success).toBe(false);
  expect(factSchema.safeParse({ ...action, target: { kind: 'unknown', id: 'x' } }).success).toBe(
    false,
  );
});

test('uses canonical IDs independent of field order and absent optional fields', () => {
  expect(factIdSchema.parse(factId(presence))).toBe(hashId('f', canonicalJson(presence), 16));
  expect(factId({ ...presence, interval: { to: 0, from: -10 } })).toBe(factId(presence));
  expect(factId({ ...action, target: undefined })).toBe(factId(action));
  expect(factId({ ...presence, where: 'loc_office' })).not.toBe(factId(presence));
});

test('matches partial patterns and binds fields', () => {
  expect(
    matchProposition(presence, {
      kind: 'at',
      who: { var: 'person' },
      interval: { to: 0, from: -10 },
    }),
  ).toEqual(new Map([['person', 'ch_anna']]));
  expect(matchProposition(presence, { kind: 'at' })).toEqual(new Map());
  expect(matchProposition(presence, { kind: 'at', where: 'loc_office' })).toBeNull();
  expect(matchProposition(presence, { kind: 'did' })).toBeNull();
  expect(matchProposition(action, { kind: 'did', target: { var: 'target' } })).toBeNull();
});

test('requires repeated variables to match the same value', () => {
  const relation = { kind: 'relation', a: 'ch_anna', b: 'ch_igor', relType: 'trust' } as const;
  const pattern = { kind: 'relation', a: { var: 'person' }, b: { var: 'person' } } as const;
  expect(matchProposition(relation, pattern)).toBeNull();
  expect(matchProposition({ ...relation, b: relation.a }, pattern)).toEqual(
    new Map([['person', relation.a]]),
  );
});
