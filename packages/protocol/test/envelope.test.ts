import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Envelope, ErrorCode, PROTOCOL_VERSION } from '@hs/protocol';

const fixture: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/envelope.json', import.meta.url), 'utf8'),
);
const valid = { v: 1, type: 'ping', id: 'c-1', payload: {} };

describe('Envelope', () => {
  it('accepts the fixture', () => {
    expect(Envelope.safeParse(fixture).success).toBe(true);
  });

  it('accepts a minimal envelope without seq and ack', () => {
    expect(Envelope.safeParse(valid).success).toBe(true);
  });

  it('accepts a foreign protocol version (needed to answer PROTOCOL_MISMATCH)', () => {
    expect(Envelope.safeParse({ ...valid, v: PROTOCOL_VERSION + 1 }).success).toBe(true);
  });

  it.each([
    ['missing type', { v: 1, id: 'c-1', payload: {} }],
    ['empty type', { ...valid, type: '' }],
    ['missing id', { v: 1, type: 'ping', payload: {} }],
    ['empty id', { ...valid, id: '' }],
    ['missing payload', { v: 1, type: 'ping', id: 'c-1' }],
    ['payload not an object', { ...valid, payload: 'x' }],
    ['payload null', { ...valid, payload: null }],
    ['v as string', { ...valid, v: '1' }],
    ['v zero', { ...valid, v: 0 }],
    ['v fractional', { ...valid, v: 1.5 }],
    ['negative seq', { ...valid, seq: -1 }],
    ['fractional ack', { ...valid, ack: 0.5 }],
    ['unknown field', { ...valid, extra: true }],
    ['not an object', 'ping'],
    ['null', null],
  ])('rejects %s', (_name, input) => {
    expect(Envelope.safeParse(input).success).toBe(false);
  });
});

describe('ErrorCode', () => {
  it('lists exactly the 24 codes of protocol.md section 5', () => {
    expect(ErrorCode.options).toHaveLength(24);
    expect(new Set(ErrorCode.options).size).toBe(24);
  });

  it('accepts a known code and rejects an unknown one', () => {
    expect(ErrorCode.safeParse('QR_EXPIRED').success).toBe(true);
    expect(ErrorCode.safeParse('NOPE').success).toBe(false);
  });
});

describe('PROTOCOL_VERSION', () => {
  it('is 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
