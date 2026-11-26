import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  CreateSessionRequest,
  ERROR_CODES,
  ErrorResponse,
  FORBIDDEN_VIEW_KEYS,
  HealthResponse,
  NetworkResponse,
  PairRequest,
  PairResponse,
  PairingCodeResponse,
  QrMatrixResponse,
  SaveList,
  ScenarioList,
  SessionCredentials,
} from '@hs/protocol';

const dir = new URL('../fixtures/rest/', import.meta.url);
const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as unknown;

/** Every REST fixture and the schema it must pass (backend.md section 3). */
const SCHEMA_BY_FIXTURE: Record<string, z.ZodType> = {
  'health.json': HealthResponse,
  'network.json': NetworkResponse,
  'scenarios.json': ScenarioList,
  'create-session.request.json': CreateSessionRequest,
  'create-session.response.json': SessionCredentials,
  'pairing-code.response.json': PairingCodeResponse,
  'pairing-qr.response.json': QrMatrixResponse,
  'evidence-qr.response.json': QrMatrixResponse,
  'pair.request.json': PairRequest,
  'pair.response.json': PairResponse,
  'saves.json': SaveList,
  'load-save.response.json': SessionCredentials,
  'error.json': ErrorResponse,
  'error.save-desync.json': ErrorResponse,
};

describe('REST fixtures', () => {
  it('map every file of fixtures/rest to a schema', () => {
    expect(readdirSync(dir).sort()).toEqual(Object.keys(SCHEMA_BY_FIXTURE).sort());
  });

  it.each(Object.entries(SCHEMA_BY_FIXTURE))('%s passes its schema', (name, schema) => {
    expect(schema.safeParse(read(name)).success).toBe(true);
  });

  it('carry no field of the truth', () => {
    for (const name of Object.keys(SCHEMA_BY_FIXTURE)) {
      const text = JSON.stringify(read(name));
      for (const key of FORBIDDEN_VIEW_KEYS)
        expect(text, `${name}: ${key}`).not.toContain(`"${key}"`);
    }
  });
});

describe('REST schemas', () => {
  it('rejects seed in a save list entry', () => {
    const entry = {
      saveId: 'save-1',
      scenarioId: 'sanatorium_winter',
      updatedAt: '2026-11-26T12:00:00.000Z',
      gameTime: 15,
    };
    expect(SaveList.safeParse([{ ...entry, seed: 'private-seed' }]).success).toBe(false);
    expect(SaveList.safeParse([entry]).success).toBe(true);
  });

  it('reject unknown keys of strict answers and requests', () => {
    for (const [name, schema] of [
      ['health.json', HealthResponse],
      ['create-session.response.json', SessionCredentials],
      ['create-session.request.json', CreateSessionRequest],
      ['pair.response.json', PairResponse],
      ['error.json', ErrorResponse],
    ] as const) {
      expect(schema.safeParse({ ...(read(name) as object), extra: 1 }).success, name).toBe(false);
    }
  });

  it('reject malformed values', () => {
    const credentials = read('create-session.response.json') as { pairing: object };
    expect(SessionCredentials.safeParse({ ...credentials, sessionId: 'x' }).success).toBe(false);
    expect(
      SessionCredentials.safeParse({
        ...credentials,
        pairing: { ...credentials.pairing, code: 'abc' },
      }).success,
    ).toBe(false);
    expect(CreateSessionRequest.safeParse({ scenarioId: 's', seed: 'a#1' }).success).toBe(false);
    expect(QrMatrixResponse.safeParse({ size: 3, modules: '10101' }).success).toBe(false);
    expect(
      PairRequest.safeParse({ ...(read('pair.request.json') as object), deviceName: ' ' }).success,
    ).toBe(false);
    expect(
      SaveList.safeParse([{ ...(read('saves.json') as object[])[0], gameTime: -1 }]).success,
    ).toBe(false);
  });

  it('give errors one shape: atAction is optional and only a non-negative integer', () => {
    expect(ErrorResponse.safeParse(read('error.json')).success).toBe(true);
    const desync = read('error.save-desync.json') as { error: object };
    expect(ErrorResponse.safeParse(desync).success).toBe(true);
    expect(ErrorResponse.safeParse({ error: { ...desync.error, atAction: -1 } }).success).toBe(
      false,
    );
    expect(ErrorResponse.safeParse({ error: { code: 'NOPE', message: 'x' } }).success).toBe(false);
    for (const code of ERROR_CODES) {
      expect(ErrorResponse.safeParse({ error: { code, message: code } }).success).toBe(true);
    }
  });
});
