import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTIONS_BY_ROLE,
  ClientMessage,
  PlayerAction,
  ServerMessage,
  parseClientMessage,
  parseServerMessage,
} from '@hs/protocol';

interface Fixture {
  v: number;
  type: string;
  id: string;
  payload: object;
}

function fixtures(direction: 'client' | 'server'): Fixture[] {
  const file = new URL(`../fixtures/${direction}-messages.json`, import.meta.url);
  return JSON.parse(readFileSync(file, 'utf8')) as Fixture[];
}

const invalid = { ok: false, error: 'INVALID_MESSAGE' };

describe.each([
  {
    direction: 'client' as const,
    schema: ClientMessage,
    parse: parseClientMessage,
    reverse: parseServerMessage,
    badPayloads: [
      { role: 'tablet', token: 'token', appVersion: '1' },
      { extra: true },
      { action: { type: 'move' } },
      { raw: 1 },
      { kind: 'unknown', ref: 'notes' },
    ],
  },
  {
    direction: 'server' as const,
    schema: ServerMessage,
    parse: parseServerMessage,
    reverse: parseClientMessage,
    badPayloads: [
      { sessionId: 'session-1', role: 'phone', protocolVersion: 0 },
      { extra: true },
      { stateVersion: 2, view: [] },
      { event: { type: 'incomingCall' } },
      { requestId: 'c-3', ok: true, minutesSpent: -1 },
      { ok: false, error: 'UNKNOWN' },
      { reason: false },
      { code: 'UNKNOWN', message: 'Invalid message' },
      { desktop: 'unpaired', phone: 'online' },
    ],
  },
])('$direction messages', ({ direction, schema, parse, reverse, badPayloads }) => {
  const examples = fixtures(direction);

  it('has exactly one fixture and invalid payload per message type', () => {
    expect(examples.map(({ type }) => type)).toEqual(
      schema.options.map(({ shape }) => shape.type.value),
    );
    expect(badPayloads).toHaveLength(examples.length);
  });

  it.each(examples.map((fixture, index) => ({ fixture, badPayload: badPayloads[index] })))(
    'validates $fixture.type and rejects wrong payloads and direction',
    ({ fixture, badPayload }) => {
      expect(parse(fixture)).toEqual({ ok: true, message: fixture });
      expect(parse({ ...fixture, payload: badPayload })).toEqual(invalid);
      expect(parse({ ...fixture, payload: null })).toEqual(invalid);
      expect(reverse(fixture)).toEqual(invalid);
    },
  );

  it('checks envelope fields while preserving positive foreign versions', () => {
    const fixture = examples[0]!;
    const foreign = { ...fixture, v: 2 };
    expect(parse(foreign)).toEqual({ ok: true, message: foreign });
    expect(parse({ ...fixture, type: 'unknown' })).toEqual(invalid);
    expect(parse({ ...fixture, extra: true })).toEqual(invalid);
    const [allowed, forbidden] = direction === 'client' ? ['ack', 'seq'] : ['seq', 'ack'];
    const withCounter = { ...fixture, [allowed]: 0 };
    expect(parse(withCounter)).toEqual({ ok: true, message: withCounter });
    expect(parse({ ...fixture, [forbidden]: 0 })).toEqual(invalid);
  });
});

describe('PlayerAction', () => {
  it('assigns every directly requestable action to exactly one role', () => {
    expect(
      [...ACTIONS_BY_ROLE.desktop, ...ACTIONS_BY_ROLE.phone, 'captureEvidence'].sort(),
    ).toEqual(PlayerAction.options.map(({ shape }) => shape.type.value).sort());
  });

  it('validates action-specific parameters', () => {
    expect(PlayerAction.safeParse({ type: 'captureEvidence', tokenId: 'token-1' }).success).toBe(
      true,
    );
    expect(PlayerAction.safeParse({ type: 'wait', minutes: 0 }).success).toBe(false);
    expect(PlayerAction.safeParse({ type: 'examineLocation', locationId: 'hall' }).success).toBe(
      false,
    );
  });

  it('accepts an accusation with multiple accused characters and evidence', () => {
    const accusation = {
      type: 'accuse',
      caseFile: { accusedIds: ['character-1', 'character-2'], evidence: ['clue-1'] },
      confirm: true,
      operationId: 'op-1',
    };
    expect(PlayerAction.safeParse(accusation).success).toBe(true);
    expect(PlayerAction.safeParse({ ...accusation, confirm: undefined }).success).toBe(false);
  });

  it('keeps the operation ID optional in the schema and non-empty when present', () => {
    const accuse = { type: 'accuse', caseFile: { accusedIds: ['character-1'], evidence: [] } };
    expect(PlayerAction.safeParse({ ...accuse, confirm: true, operationId: '' }).success).toBe(
      false,
    );
    expect(PlayerAction.safeParse({ ...accuse, confirm: false }).success).toBe(true);
  });
});

describe('accusation operation fixtures', () => {
  type Message = Fixture & { payload: Record<string, unknown> };
  const read = (name: string) =>
    JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as Message[];
  const [request, retry] = read('client-accusation.json') as [Message, Message];
  const [result] = read('server-accusation.json') as [Message];

  it('are valid, and a retry carries the same operation ID and case file', () => {
    expect(parseClientMessage(request).ok).toBe(true);
    expect(parseClientMessage(retry).ok).toBe(true);
    expect(parseServerMessage(result).ok).toBe(true);
    expect(retry.id).not.toBe(request.id);
    expect(retry.payload).toEqual(request.payload);
    expect(result.payload.operationId).toBe(
      (request.payload.action as { operationId: string }).operationId,
    );
  });

  it('carry no field of the truth', () => {
    expect(JSON.stringify(result)).not.toMatch(/veracity|culprit|hallucinat|truth/i);
  });
});
