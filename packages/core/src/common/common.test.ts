import { expect, test } from 'vitest';
import {
  canonicalJson,
  contains,
  hashId,
  intersect,
  nodeHasher,
  overlaps,
  sequentialId,
  stateHash,
} from '@hs/core/common';

test('orders object keys recursively and keeps array order', () => {
  const first = { b: 1, a: [{ z: 'last', a: true }, null] };
  const second = { a: [{ a: true, z: 'last' }, null], b: 1 };
  expect(canonicalJson(first)).toBe('{"a":[{"a":true,"z":"last"},null],"b":1}');
  expect(canonicalJson(first)).toBe(canonicalJson(second));
  expect(canonicalJson({ 2: 'two', 10: 'ten' })).toBe('{"10":"ten","2":"two"}');
});

test.each([undefined, NaN, Infinity, -Infinity, 1n])('rejects unsupported values (%s)', (value) => {
  expect(() => canonicalJson({ 'nested.key': [value] })).toThrow('$["nested.key"][0]');
});

test('rejects sparse arrays, class instances, and cycles', () => {
  const sparse: unknown[] = [];
  sparse.length = 1;
  expect(() => canonicalJson(sparse)).toThrow('$[0]');
  expect(() => canonicalJson({ value: new Map() })).toThrow('$["value"]');
  const cyclic: { self?: object } = {};
  cyclic.self = cyclic;
  expect(() => canonicalJson(cyclic)).toThrow('$["self"]: cyclic reference');
});

test('allows the same object in independent branches', () => {
  const value = { a: 1 };
  expect(canonicalJson([value, value])).toBe('[{"a":1},{"a":1}]');
});

test('computes SHA-256 and hashes canonical state', () => {
  expect(nodeHasher.sha256('abc')).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  expect(stateHash({ b: 1, a: 2 })).toBe(stateHash({ a: 2, b: 1 }));
  expect(stateHash({ a: 2 }, { sha256: (text) => text })).toBe('{"a":2}');
});

test('creates independent sequences and deterministic hash-based IDs', () => {
  const nextEvent = sequentialId('ev');
  const nextItem = sequentialId('it');
  expect([nextEvent(), nextEvent(), nextItem()]).toEqual(['ev_1', 'ev_2', 'it_1']);
  const value = { b: 1, a: 2 };
  expect(hashId('f', value, 16)).toBe(`f_${stateHash(value).slice(0, 16)}`);
  expect(hashId('f', { a: 2, b: 1 }, 16)).toBe(hashId('f', value, 16));
});

test.each([0, 65, 1.5, NaN])('rejects invalid hash ID lengths (%s)', (length) => {
  expect(() => hashId('f', null, length)).toThrow(RangeError);
});

test('uses half-open intervals and treats empty intersections as null', () => {
  const interval = { from: 3, to: 7 };
  const touching = { from: 7, to: 10 };
  const partial = { from: 5, to: 9 };
  const empty = { from: 4, to: 4 };

  expect(contains(interval, 2)).toBe(false);
  expect(contains(interval, 3)).toBe(true);
  expect(contains(interval, 7)).toBe(false);
  expect(contains(empty, 4)).toBe(false);
  expect(overlaps(interval, touching)).toBe(false);
  expect(overlaps(interval, empty)).toBe(false);
  expect(overlaps(interval, partial)).toBe(true);
  expect(intersect(interval, touching)).toBeNull();
  expect(intersect(interval, empty)).toBeNull();
  expect(intersect(interval, partial)).toEqual({ from: 5, to: 7 });
  expect(intersect(partial, interval)).toEqual({ from: 5, to: 7 });
});
