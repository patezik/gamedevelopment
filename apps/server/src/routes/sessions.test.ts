import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScenarioFromDir } from '@hs/core/content';
import type { Investigation } from '@hs/core/game';
import { GENERATION_CHECKS, generateInvestigation, type GenerationResult } from '@hs/generator';
import { errorCodes } from 'fastify';
import { describe, expect, test, vi } from 'vitest';
import { tinyManor } from '../../../../packages/core/test/fixtures/tiny-manor.ts';
import { buildApp } from '../app.ts';
import { readConfig } from '../config/index.ts';
import { captureLogs } from '../diagnostics/harness.ts';
import { PairingService, verifyToken } from '../pairing/index.ts';
import { Session, SessionManager, type InvestigationProvider } from '../sessions/index.ts';
import {
  createReadableSeed,
  createSessionServices,
  defaultScenariosDir,
  GeneratorInvestigationProvider,
  pairingHost,
  ScenarioCatalog,
  type GeneratorProviderOptions,
} from './generation.ts';
import {
  CreateSessionRequest,
  CreateSessionResponse,
  ErrorResponse,
  ScenarioId,
  ScenarioList,
  Seed,
  type SessionRouteDependencies,
} from './sessions.ts';

const READABLE_SEED = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const scenarios = ScenarioCatalog.fromDirectory();
const withTests = ScenarioCatalog.fromDirectory(undefined, { includeTest: true });

/** A valid case for an isolated REST test: the provider stands in for the generator. */
const fixtureProvider = () => ({
  create: vi.fn((_scenarioId: string, seed: string) => ({
    investigation: tinyManor(seed),
    ports: { startLocationId: 'loc_hall' },
  })),
});

interface BootOptions {
  provider?: InvestigationProvider;
  catalog?: ScenarioCatalog;
  generation?: SessionRouteDependencies['generation'];
  createSeed?: () => string;
  logStream?: { write(line: string): void };
  host?: () => string;
  createId?: () => string;
}

/** The app wired the way server.ts wires it, with the given provider. */
function boot(options: BootOptions = {}) {
  const fixture = fixtureProvider();
  const provider = options.provider ?? fixture;
  const catalog = options.catalog ?? scenarios;
  const createId = vi.fn(options.createId ?? randomUUID);
  const sessions = new SessionManager(provider, { createId });
  const pairing = new PairingService(sessions, {
    host: options.host ?? (() => 'game-pc.local'),
    port: 7420,
  });
  const createCode = vi.spyOn(pairing, 'createCode');
  const app = buildApp(readConfig({ HS_LOG_LEVEL: options.logStream ? 'trace' : 'silent' }), {
    pairing,
    sessions: {
      scenarios: catalog,
      sessions,
      pairing,
      ...(options.generation && { generation: options.generation }),
      ...(options.createSeed && { createSeed: options.createSeed }),
    },
    ...(options.logStream && { logStream: options.logStream }),
  });
  const create = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/v1/sessions', payload: payload as object });
  /** Calls of the fixture provider (unused when the test passes its own provider). */
  const generated = fixture.create;
  return { app, sessions, pairing, generated, createId, createCode, create };
}

/** The generator's real provider; `options` replace the generator only where a test says so. */
function generatorBoot(
  options: GeneratorProviderOptions & { logStream?: { write(line: string): void } } = {},
) {
  const { logStream, ...providerOptions } = options;
  const provider = new GeneratorInvestigationProvider(withTests, providerOptions);
  return {
    ...boot({
      provider,
      catalog: withTests,
      generation: provider,
      ...(logStream && { logStream }),
    }),
    generator: provider,
  };
}

/** Everything in a case that names a person or the solution. */
function secretsOf(investigation: Investigation): string[] {
  const { incident } = investigation.truth;
  return [
    ...investigation.characters.flatMap(({ id, name }) => [id, name]),
    ...incident.culpritIds,
    ...incident.victimIds,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

const TRUTH_KEYS = /culprit|veracity|truth|hallucinat|victim|incident/i;

function unsolvable(seed: string): GenerationResult {
  const result: GenerationResult = {
    ok: false,
    error: 'GENERATION_UNSOLVABLE',
    report: {
      seed,
      generatorVersion: '0.3.0',
      attempts: [
        { number: 1, seed: `${seed}#1`, timingsMs: { WorldGen: 1.2 }, accepted: false },
        {
          number: 2,
          seed: `${seed}#2`,
          timingsMs: { WorldGen: 0.8, IncidentSelection: 2 },
          accepted: false,
          rejection: {
            stage: 'IncidentSelection',
            code: 'INCIDENT_NO_FEASIBLE_CULPRIT',
            message: 'char_nurse cannot reach char_cook',
          },
        },
      ],
      validations: [
        {
          attempt: 1,
          ok: false,
          findings: [
            {
              checkId: 'V-CULPRIT-PROVABLE',
              severity: 'error',
              code: 'CULPRIT_NOT_PROVABLE',
              message: 'char_nurse is the culprit but motive is not provable',
            },
          ],
        },
      ],
    },
  };
  return result;
}

describe('GET /api/v1/scenarios', () => {
  test('lists the player scenarios in the protocol shape, without test content', async () => {
    const { app } = boot();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/scenarios' });
      expect(response.statusCode).toBe(200);
      const body = ScenarioList.parse(response.json());
      expect(body).toEqual([
        { id: 'sanatorium_winter', title: 'Санаторий «Сосновый бор»', durationMinutes: 4320 },
      ]);
    } finally {
      await app.close();
    }
  });

  test('test scenarios (`_…`) are listed only when the catalog includes them', () => {
    expect(withTests.list().map(({ id }) => id)).toEqual(['_test_minimal', 'sanatorium_winter']);
    expect(scenarios.has('_test_minimal')).toBe(false);
  });
});

describe('POST /api/v1/sessions', () => {
  test('creates a session with the given seed: protocol shape, token hash, pairing code', async () => {
    const { app, sessions, generated, create } = boot();
    try {
      const response = await create({ scenarioId: 'sanatorium_winter', seed: 'winter-42' });

      expect(response.statusCode).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = CreateSessionResponse.parse(response.json());
      expect(generated).toHaveBeenCalledExactlyOnceWith('sanatorium_winter', 'winter-42');
      expect(body.pairing.qrPayload).toBe(`hs1:pair:game-pc.local:7420:${body.pairing.code}`);

      const session = sessions.get(body.sessionId)!;
      expect(session.status).toBe('created');
      // Only the hash is kept: the token itself is nowhere in the session.
      expect(session.tokenHash('desktop')).toMatch(/^[a-f0-9]{64}$/);
      expect(session.tokenHash('desktop')).not.toContain(body.desktopToken);
      expect(verifyToken(session, 'desktop', body.desktopToken)).toBe(true);
      expect(session.tokenHash('phone')).toBeUndefined();

      // The token is the desktop's credential for the session's other endpoints.
      const refreshed = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${body.sessionId}/pairing-code`,
        headers: { authorization: `Bearer ${body.desktopToken}` },
      });
      expect(refreshed.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  test('the pairing code of the answer pairs the phone with the new session', async () => {
    const { app, create } = boot();
    try {
      const body = CreateSessionResponse.parse(
        (await create({ scenarioId: 'sanatorium_winter', seed: 's1' })).json(),
      );
      const paired = await app.inject({
        method: 'POST',
        url: '/api/v1/pair',
        payload: {
          code: body.pairing.code,
          deviceName: 'Test phone',
          appVersion: '0.0.0',
          protocolVersion: 1,
        },
      });
      expect(paired.statusCode).toBe(200);
      expect(paired.json()).toMatchObject({ sessionId: body.sessionId });
    } finally {
      await app.close();
    }
  });

  test('without a seed the server makes a readable one and generates with it', async () => {
    const { app, generated, create } = boot();
    try {
      const first = CreateSessionResponse.parse(
        (await create({ scenarioId: 'sanatorium_winter' })).json(),
      );
      const second = CreateSessionResponse.parse(
        (await create({ scenarioId: 'sanatorium_winter' })).json(),
      );
      expect(generated).toHaveBeenCalledTimes(2);
      expect(generated).toHaveBeenNthCalledWith(1, 'sanatorium_winter', expect.stringMatching(READABLE_SEED));
      expect(generated).toHaveBeenNthCalledWith(2, 'sanatorium_winter', expect.stringMatching(READABLE_SEED));
      expect(generated.mock.calls[0]![1]).not.toBe(generated.mock.calls[1]![1]);
      expect(first.sessionId).not.toBe(second.sessionId);
      expect(first.desktopToken).not.toBe(second.desktopToken);
    } finally {
      await app.close();
    }
  });

  test('uses the server-generated seed without disclosing it in the response', async () => {
    const seed = 'FIXED-SEED-0001';
    const { app, generated, create } = boot({ createSeed: () => seed });
    try {
      const response = await create({ scenarioId: 'sanatorium_winter' });

      expect(response.statusCode).toBe(201);
      expect(generated).toHaveBeenCalledExactlyOnceWith('sanatorium_winter', seed);
      expect(response.body.includes(seed)).toBe(false);
      const body: unknown = response.json();
      expect(body).not.toHaveProperty('seed');
      const parsed = CreateSessionResponse.parse(body);
      expect(CreateSessionResponse.safeParse({ ...parsed, seed }).success).toBe(false);
    } finally {
      await app.close();
    }
  });

  test('the seed source can be injected; a given seed is never replaced', async () => {
    const createSeed = vi.fn(() => 'FIXED-SEED-0001');
    const { app, generated, create } = boot({ createSeed });
    try {
      expect((await create({ scenarioId: 'sanatorium_winter' })).statusCode).toBe(201);
      expect((await create({ scenarioId: 'sanatorium_winter', seed: '7' })).statusCode).toBe(201);
      expect(generated.mock.calls).toEqual([
        ['sanatorium_winter', 'FIXED-SEED-0001'],
        ['sanatorium_winter', '7'],
      ]);
      expect(createSeed).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  test('SCENARIO_NOT_FOUND: no generation, no session', async () => {
    const { app, generated, createId, createCode, create } = boot();
    try {
      for (const scenarioId of ['atlantis', '_test_minimal']) {
        const response = await create({ scenarioId, seed: '1' });
        expect(response.statusCode).toBe(404);
        expect(ErrorResponse.parse(response.json()).error.code).toBe('SCENARIO_NOT_FOUND');
      }
      expect(generated).not.toHaveBeenCalled();
      expect(createId).not.toHaveBeenCalled();
      expect(createCode).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('GENERATION_UNSOLVABLE: 422, no session, no token, no pairing code', async () => {
    const generate = vi.fn((req: { seed: string }) => unsolvable(req.seed));
    const logs = captureLogs();
    const { app, createId, createCode, create } = generatorBoot({
      generate,
      logStream: logs.stream,
    });
    try {
      const response = await create({ scenarioId: 'sanatorium_winter', seed: 'dead-end' });

      expect(response.statusCode).toBe(422);
      const body = ErrorResponse.parse(response.json());
      expect(body.error.code).toBe('GENERATION_UNSOLVABLE');
      expect(generate).toHaveBeenCalledOnce();
      expect(createId).not.toHaveBeenCalled();
      expect(createCode).not.toHaveBeenCalled();
      // The findings name the culprit: neither the answer nor the log repeats them.
      expect(response.body).not.toMatch(/char_|culprit|motive/i);
      expect(logs.text()).not.toMatch(/char_|is the culprit|cannot reach/);

      const generation = logs.entries().find(({ msg }) => msg === 'generation finished');
      expect(generation).toMatchObject({
        scenarioId: 'sanatorium_winter',
        seed: 'dead-end',
        generatorVersion: '0.3.0',
        ok: false,
        attempts: 2,
        stageMs: { WorldGen: 2, IncidentSelection: 2 },
        rejections: ['INCIDENT_NO_FEASIBLE_CULPRIT', 'V-CULPRIT-PROVABLE:CULPRIT_NOT_PROVABLE'],
      });
      expect(logs.entries()).not.toContainEqual(expect.objectContaining({ level: 50 }));
    } finally {
      await app.close();
    }
  });

  test.each([
    ['no body', undefined],
    ['no scenario', { seed: '1' }],
    ['scenario is not a string', { scenarioId: 7 }],
    ['unknown field', { scenarioId: 'sanatorium_winter', culpritId: 'x' }],
    ['seed with #', { scenarioId: 'sanatorium_winter', seed: 'a#2' }],
    ['seed with a space', { scenarioId: 'sanatorium_winter', seed: 'a b' }],
    ['empty seed', { scenarioId: 'sanatorium_winter', seed: '' }],
    ['seed too long', { scenarioId: 'sanatorium_winter', seed: 'x'.repeat(65) }],
  ])('INVALID_MESSAGE: %s', async (_name, payload) => {
    const { app, generated, createId } = boot();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode).toBe(400);
      expect(ErrorResponse.parse(response.json()).error.code).toBe('INVALID_MESSAGE');
      expect(generated).not.toHaveBeenCalled();
      expect(createId).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('a body that is not JSON is refused in the protocol error format', async () => {
    const { app } = boot();
    try {
      for (const [type, payload] of [
        ['application/json', '{"scenarioId":'],
        ['text/plain', 'sanatorium_winter'],
      ] as const) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/sessions',
          headers: { 'content-type': type },
          payload,
        });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(response.statusCode).toBeLessThan(500);
        expect(ErrorResponse.parse(response.json()).error.code).toBe('INVALID_MESSAGE');
      }
    } finally {
      await app.close();
    }
  });

  test('an unexpected generator failure is INTERNAL without its text, logged without it', async () => {
    const logs = captureLogs();
    const provider = {
      create: vi.fn(() => {
        throw new Error('char_nurse is the culprit');
      }),
    };
    const { app, createId, create } = boot({ provider, logStream: logs.stream });
    try {
      const response = await create({ scenarioId: 'sanatorium_winter', seed: '1' });
      expect(response.statusCode).toBe(500);
      expect(ErrorResponse.parse(response.json()).error).toEqual({
        code: 'INTERNAL',
        message: 'Internal error',
      });
      expect(createId).not.toHaveBeenCalled();
      expect(logs.text()).not.toContain('char_nurse');
      expect(logs.entries()).toContainEqual(
        expect.objectContaining({ msg: 'request failed', errorCode: 'INTERNAL' }),
      );
    } finally {
      await app.close();
    }
  });
});

describe('logs and leaks', () => {
  test('the desktop token, the pairing code and the case never reach the log or the answer', async () => {
    const logs = captureLogs();
    const { app, generated, create } = boot({ logStream: logs.stream });
    try {
      const response = await create({ scenarioId: 'sanatorium_winter', seed: 'leak-check' });
      const body = CreateSessionResponse.parse(response.json());
      const text = logs.text();

      expect(logs.entries().length).toBeGreaterThan(0);
      expect(text).not.toContain(body.desktopToken);
      expect(text).not.toContain(body.pairing.code);
      expect(text).not.toContain(body.pairing.qrPayload);
      expect(logs.entries()).toContainEqual(
        expect.objectContaining({
          msg: 'request completed',
          method: 'POST',
          route: '/api/v1/sessions',
          statusCode: 201,
        }),
      );

      const { investigation } = generated.mock.results[0]!.value as {
        investigation: Investigation;
      };
      for (const secret of secretsOf(investigation)) {
        expect(response.body).not.toContain(secret);
        expect(text).not.toContain(secret);
      }
      expect(Object.keys(JSON.parse(response.body) as Record<string, unknown>)).toEqual([
        'sessionId',
        'desktopToken',
        'pairing',
      ]);
      expect(response.body).not.toMatch(TRUTH_KEYS);
    } finally {
      await app.close();
    }
  });
});

describe('real generator', () => {
  test('a case the generator builds (gate without the solver) becomes a playable session', async () => {
    // Test-only injection: exercise engine creation with the structural checks, independently
    // of the solver. The production factory is tested against the full gate below.
    const solverFree = new Set(['V-TRUTH-INV', 'V-TIMELINE', 'V-TESTIMONY', 'V-PHONE-REQUIRED']);
    const structural = GENERATION_CHECKS.filter(({ id }) => solverFree.has(id));
    expect(structural).toHaveLength(solverFree.size);
    const generate: typeof generateInvestigation = (req, content, options) =>
      generateInvestigation(req, content, { ...options, checks: structural });
    const logs = captureLogs();
    const { app, sessions, create, generator } = generatorBoot({
      generate,
      logStream: logs.stream,
    });
    const created = vi.spyOn(generator, 'create');
    try {
      const response = await create({ scenarioId: '_test_minimal', seed: '7' });
      expect(response.statusCode).toBe(201);
      const body = CreateSessionResponse.parse(response.json());
      const { investigation } = created.mock.results[0]!.value as { investigation: Investigation };
      expect(investigation).toMatchObject({ scenarioId: '_test_minimal', seed: '7' });

      const session = sessions.get(body.sessionId)!;
      await session.activate();
      const result = await session.dispatch('desktop', { type: 'wait', minutes: 15 });
      expect(result).toMatchObject({ ok: true, minutesSpent: 15 });

      for (const secret of secretsOf(investigation)) {
        expect(response.body).not.toContain(secret);
        expect(logs.text()).not.toContain(secret);
      }
      expect(logs.entries()).toContainEqual(
        expect.objectContaining({ msg: 'generation finished', ok: true, seed: '7' }),
      );
    } finally {
      await app.close();
    }
  });

  test('a generation over 2 s is logged as a warning', async () => {
    let clock = 0;
    const logs = captureLogs();
    const { app, create } = generatorBoot({
      now: () => (clock += 2_500),
      generate: (req) => unsolvable(req.seed),
      logStream: logs.stream,
    });
    try {
      await create({ scenarioId: 'sanatorium_winter', seed: 'slow' });
      expect(logs.entries()).toContainEqual(
        expect.objectContaining({ msg: 'slow generation', level: 40, durationMs: 2_500 }),
      );
    } finally {
      await app.close();
    }
  });
});

test('the session routes and the generator load under the server native Node runtime', () => {
  // `npm start` runs `node src/server.ts`, which only strips types (see SRV-001).
  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'await import(process.argv[1]);',
      new URL('./generation.ts', import.meta.url).href,
    ],
    { encoding: 'utf8' },
  );
  expect(probe.error).toBeUndefined();
  expect(probe.status, probe.stderr).toBe(0);
});

test('createSessionServices wires the production app: catalog, real generator, pairing host', async () => {
  const config = readConfig({ HS_LOG_LEVEL: 'silent', HS_PUBLIC_HOST: 'game-pc.lan' });
  const services = createSessionServices(config, { networkInterfaces: () => ({}) });
  const app = buildApp(config, services);
  try {
    const list = await app.inject({ method: 'GET', url: '/api/v1/scenarios' });
    expect(ScenarioList.parse(list.json()).map(({ id }) => id)).toEqual(['sanatorium_winter']);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { scenarioId: '_test_minimal' },
    });
    expect(ErrorResponse.parse(missing.json()).error.code).toBe('SCENARIO_NOT_FOUND');
    const session = new Session(
      randomUUID(),
      { dispatch: () => ({ ok: false, error: 'INTERNAL', minutesSpent: 0, events: [] }) },
      Date.now,
    );
    expect(services.pairing.createCode(session).qrPayload).toMatch(/^hs1:pair:game-pc\.lan:7420:/);
    expect(services.sessions.generation).toBeInstanceOf(GeneratorInvestigationProvider);
  } finally {
    await app.close();
  }
});

/** Pairing data a failed creation could have left: the session's code, the code itself, the hash. */
async function leftovers(
  app: ReturnType<typeof boot>['app'],
  pairing: PairingService,
  session: Session,
  code: string | undefined,
) {
  const pair =
    code === undefined
      ? undefined
      : await app.inject({
          method: 'POST',
          url: '/api/v1/pair',
          payload: { code, deviceName: 'Phone', appVersion: '0.0.0', protocolVersion: 1 },
        });
  return {
    sessionCode: pairing.activeCode(session),
    pairByCode: pair?.json<{ error?: { code: string } }>().error?.code,
    desktopHash: session.tokenHash('desktop'),
  };
}

describe('late failures leave nothing behind (P1)', () => {
  test('host() throws while the pairing code is built: 500, no session, no code, no hash', async () => {
    const logs = captureLogs();
    const { app, sessions, pairing, createId, create } = boot({
      host: () => {
        throw new Error('no network interface');
      },
      logStream: logs.stream,
    });
    const discarded = vi.spyOn(pairing, 'discardCode');
    try {
      const response = await create({ scenarioId: 'sanatorium_winter', seed: 'p1-host' });
      expect(response.statusCode).toBe(500);
      expect(ErrorResponse.parse(response.json()).error.code).toBe('INTERNAL');
      const id = createId.mock.results[0]!.value as string;
      expect(sessions.get(id)).toBeUndefined();
      const session = discarded.mock.calls[0]![0];
      expect(session.id).toBe(id);
      expect(await leftovers(app, pairing, session, undefined)).toEqual({
        sessionCode: undefined,
        pairByCode: undefined,
        desktopHash: undefined,
      });
      expect(logs.text()).not.toContain('no network interface');
    } finally {
      await app.close();
    }
  });

  test('the pairing service fails: 500 and no session', async () => {
    const { app, sessions, createId, createCode, create } = boot();
    createCode.mockImplementationOnce(() => {
      throw new Error('pairing store is broken');
    });
    try {
      const response = await create({ scenarioId: 'sanatorium_winter', seed: 'p1-code' });
      expect(response.statusCode).toBe(500);
      expect(sessions.get(createId.mock.results[0]!.value as string)).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  test('the answer breaks its schema after the code was issued: code, hash and session rolled back', async () => {
    // A session id that is not a UUID makes `CreateSessionResponse` refuse the answer.
    const { app, sessions, pairing, createCode, create } = boot({ createId: () => 'not-a-uuid' });
    const discarded = vi.spyOn(pairing, 'discardCode');
    try {
      const response = await create({ scenarioId: 'sanatorium_winter', seed: 'p1-dto' });
      expect(response.statusCode).toBe(500);
      expect(ErrorResponse.parse(response.json()).error.code).toBe('INTERNAL');
      expect(sessions.get('not-a-uuid')).toBeUndefined();
      const issued = createCode.mock.results[0]!.value as { code: string };
      const session = discarded.mock.calls[0]![0];
      expect(await leftovers(app, pairing, session, issued.code)).toEqual({
        sessionCode: undefined,
        pairByCode: 'PAIRING_CODE_INVALID',
        desktopHash: undefined,
      });
    } finally {
      await app.close();
    }
  });

  test.each([
    ['incomplete payload', () => 'hs1:pair:'],
    ['invalid host', (code: string) => `hs1:pair:user@pc.local:7420:${code}`],
    ['wildcard host', (code: string) => `hs1:pair:0.0.0.0:7420:${code}`],
    ['IPv6 literal', (code: string) => `hs1:pair:[::1]:7420:${code}`],
    ['invalid port', (code: string) => `hs1:pair:pc.local:65536:${code}`],
    ['zero port', (code: string) => `hs1:pair:pc.local:0:${code}`],
    ['extra field', (code: string) => `hs1:pair:pc.local:7420:${code}:extra`],
    ['different code', (code: string) => `hs1:pair:pc.local:7420:${code.startsWith('0') ? '1' : '0'}${code.slice(1)}`],
  ] as const)('rolls back both indexes and the hash for %s', async (_name, payload) => {
    const { app, sessions, pairing, createCode, create } = boot();
    const actualCreate = PairingService.prototype.createCode.bind(pairing);
    createCode.mockImplementationOnce((session) => {
      const result = actualCreate(session);
      return { ...result, qrPayload: payload(result.code) };
    });
    try {
      const response = await create({ scenarioId: 'sanatorium_winter', seed: 'qr-dto' });
      expect(response.statusCode).toBe(500);
      expect(ErrorResponse.parse(response.json()).error.code).toBe('INTERNAL');
      const session = createCode.mock.calls[0]![0];
      const issued = createCode.mock.results[0]!.value as { code: string };
      expect(sessions.get(session.id)).toBeUndefined();
      expect(await leftovers(app, pairing, session, issued.code)).toEqual({
        sessionCode: undefined,
        pairByCode: 'PAIRING_CODE_INVALID',
        desktopHash: undefined,
      });
    } finally {
      await app.close();
    }
  });

  test('a seed source that breaks the seed contract: 500 before generation', async () => {
    const { app, generated, createId, create } = boot({ createSeed: () => 'bad seed#1' });
    try {
      const response = await create({ scenarioId: 'sanatorium_winter' });
      expect(response.statusCode).toBe(500);
      expect(ErrorResponse.parse(response.json()).error.code).toBe('INTERNAL');
      expect(generated).not.toHaveBeenCalled();
      expect(createId).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('concurrent requests: the one failing late leaves nothing, the others keep their sessions', async () => {
    let calls = 0;
    const { app, sessions, createId, create } = boot({
      host: () => {
        if (++calls === 3) throw new Error('interface went away');
        return 'game-pc.local';
      },
    });
    try {
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, n) =>
          create({ scenarioId: 'sanatorium_winter', seed: `c${String(n)}` }),
        ),
      );
      const statuses = responses.map(({ statusCode }) => statusCode).sort();
      expect(statuses).toEqual([201, 201, 201, 201, 201, 500]);
      const created = responses
        .filter(({ statusCode }) => statusCode === 201)
        .map((response) => CreateSessionResponse.parse(response.json()));
      for (const body of created) {
        const session = sessions.get(body.sessionId)!;
        expect(verifyToken(session, 'desktop', body.desktopToken)).toBe(true);
      }
      const ids = createId.mock.results.map(({ value }) => value as string);
      const lost = ids.filter((id) => !created.some(({ sessionId }) => sessionId === id));
      expect(lost).toHaveLength(1);
      expect(sessions.get(lost[0]!)).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe('scenario ids and seeds (P2)', () => {
  test('GET and POST share one scenario id schema', () => {
    expect(CreateSessionRequest.shape.scenarioId).toBe(ScenarioId);
    expect(ScenarioList.element.shape.id).toBe(ScenarioId);
  });

  test('a scenario that POST would refuse stops the catalog instead of being listed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hs-catalog-'));
    try {
      const long = 'a'.repeat(65);
      cpSync(join(defaultScenariosDir(), 'sanatorium_winter'), join(dir, long), {
        recursive: true,
      });
      const preset = join(dir, long, 'preset.json');
      writeFileSync(
        preset,
        readFileSync(preset, 'utf8').replace('"sanatorium_winter"', `"${long}"`),
      );
      expect(() => ScenarioCatalog.fromDirectory(dir)).toThrow(/cannot be offered/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pairing address (P3)', () => {
  const nic = (address: string, mac: string) => ({
    address,
    netmask: '255.255.255.0',
    family: 'IPv4' as const,
    mac,
    internal: false,
    cidr: `${address}/24`,
  });
  // eth0 ranks first among equal ranges, so a bind on wlan0 is the case that used to go wrong.
  const interfaces = {
    eth0: [nic('192.168.1.10', 'a4:83:e7:00:00:01')],
    wlan0: [nic('192.168.2.10', 'a4:83:e7:00:00:02')],
  };
  const payloadHost = (
    env: Record<string, string>,
    networkInterfaces: () => typeof interfaces = () => interfaces,
  ) => {
    const config = readConfig({ HS_LOG_LEVEL: 'silent', ...env });
    const services = createSessionServices(config, { networkInterfaces });
    const session = new Session(
      randomUUID(),
      { dispatch: () => ({ ok: false, error: 'INTERNAL', minutesSpent: 0, events: [] }) },
      Date.now,
    );
    return services.pairing.createCode(session).qrPayload.split(':').slice(2, 4).join(':');
  };

  test('an explicit IPv4 bind is the address of the QR, with the configured port', () => {
    expect(payloadHost({ HS_HOST: '192.168.2.10', HS_PORT: '7421' })).toBe('192.168.2.10:7421');
  });

  test.each([
    [{ HS_HOST: '192.168.2.10' }, '192.168.2.10:7420'],
    [{ HS_HOST: 'pc.local' }, 'pc.local:7420'],
    [{ HS_HOST: '::1', HS_PUBLIC_HOST: 'game-pc.lan' }, 'game-pc.lan:7420'],
  ] as const)('skips network discovery with an explicit pairing address %o', (env, address) => {
    const discover = vi.fn(() => {
      throw new Error('unexpected discovery');
    });
    expect(payloadHost(env, discover)).toBe(address);
    expect(discover).not.toHaveBeenCalled();
  });

  test('a wildcard bind takes the recommended candidate of GET /network', async () => {
    const app = buildApp(readConfig({ HS_LOG_LEVEL: 'silent' }), {
      networkInterfaces: () => interfaces,
    });
    try {
      const network = await app.inject({ method: 'GET', url: '/api/v1/network' });
      const recommended = network
        .json<{ candidates: { address: string; recommended: boolean }[] }>()
        .candidates.find((candidate) => candidate.recommended)!.address;
      expect(payloadHost({})).toBe(`${recommended}:7420`);
      expect(payloadHost({ HS_HOST: '::' })).toBe(`${recommended}:7420`);
      expect(payloadHost({ HS_HOST: '0000:0:0:0:0:0:0:0000' })).toBe(`${recommended}:7420`);
    } finally {
      await app.close();
    }
  });

  test('the IPv4 wildcard without LAN candidates keeps its loopback fallback', () => {
    expect(pairingHost({ host: '0.0.0.0', publicHost: undefined }, () => ({}))).toBe('127.0.0.1');
  });

  test('an IPv6-only bind gives a safe refusal over a real listener', async ({ skip }) => {
    const config = readConfig({ HS_HOST: '::1', HS_LOG_LEVEL: 'silent' });
    const discover = vi.fn(() => interfaces);
    const { pairing } = createSessionServices(config, { networkInterfaces: discover });
    // Drive the production pairing service with a case that can reach session preparation.
    const createId = vi.fn(randomUUID);
    const sessions = new SessionManager(fixtureProvider(), { createId });
    const app = buildApp(config, { pairing, sessions: { scenarios, sessions, pairing } });
    const createCode = vi.spyOn(pairing, 'createCode');
    try {
      let origin: string;
      try {
        origin = await app.listen({ host: config.host, port: 0 });
      } catch (error) {
        if (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          return skip();
        }
        throw error;
      }
      const response = await fetch(origin + '/api/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioId: 'sanatorium_winter', seed: 'ipv6' }),
        signal: AbortSignal.timeout(5_000),
      });
      expect(response.status).toBe(500);
      expect(ErrorResponse.parse(await response.json()).error.code).toBe('INTERNAL');
      expect(discover).not.toHaveBeenCalled();
      const session = createCode.mock.calls[0]![0];
      expect(sessions.get(createId.mock.results[0]!.value as string)).toBeUndefined();
      expect(session.tokenHash('desktop')).toBeUndefined();
      expect(pairing.activeCode(session)).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe('production factory uses the full GEN-011 gate (P4)', () => {
  /** A copy of `_test_minimal` without deduction rules: the full gate can never prove a culprit. */
  function unprovableScenarios() {
    const dir = mkdtempSync(join(tmpdir(), 'hs-gate-'));
    const target = join(dir, 'gate_probe');
    cpSync(join(defaultScenariosDir(), '_test_minimal'), target, { recursive: true });
    const preset = join(target, 'preset.json');
    writeFileSync(preset, readFileSync(preset, 'utf8').replace('"_test_minimal"', '"gate_probe"'));
    writeFileSync(join(target, 'deduction-rules.json'), '[]\n');
    return { dir, content: loadScenarioFromDir(target) };
  }

  const post = (app: ReturnType<typeof buildApp>, scenarioId: string, seed: string) =>
    app.inject({ method: 'POST', url: '/api/v1/sessions', payload: { scenarioId, seed } });

  test('a case only a bypassed gate accepts is refused through createSessionServices', async () => {
    const { dir, content } = unprovableScenarios();
    const config = readConfig({ HS_LOG_LEVEL: 'silent' });
    const services = createSessionServices(config, {
      scenariosDir: dir,
      networkInterfaces: () => ({}),
    });
    const app = buildApp(config, services);
    try {
      for (const seed of ['1', '2']) {
        const req = { scenarioId: 'gate_probe', seed };
        // Independent references: the full gate refuses, a gate without checks would accept.
        expect(generateInvestigation(req, content).ok).toBe(false);
        expect(generateInvestigation(req, content, { checks: [] }).ok).toBe(true);
        const response = await post(app, 'gate_probe', seed);
        expect(response.statusCode).toBe(422);
        expect(ErrorResponse.parse(response.json()).error.code).toBe('GENERATION_UNSOLVABLE');
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Not pinned to today's outcome: the answer must follow the full gate, whichever way it goes.
  test('the shipped scenario answers exactly as the full gate decides', async () => {
    const config = readConfig({ HS_LOG_LEVEL: 'silent' });
    const app = buildApp(config, createSessionServices(config, { networkInterfaces: () => ({}) }));
    const content = loadScenarioFromDir(join(defaultScenariosDir(), 'sanatorium_winter'));
    try {
      const reference = generateInvestigation(
        { scenarioId: 'sanatorium_winter', seed: '42' },
        content,
      );
      const response = await post(app, 'sanatorium_winter', '42');
      if (reference.ok) {
        expect(response.statusCode).toBe(201);
        CreateSessionResponse.parse(response.json());
      } else {
        expect(response.statusCode).toBe(422);
        expect(ErrorResponse.parse(response.json()).error.code).toBe('GENERATION_UNSOLVABLE');
      }
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe('error classes (P5)', () => {
  const raw = (app: ReturnType<typeof boot>['app'], type: string, payload: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { 'content-type': type },
      payload,
    });

  test('Fastify body refusals: 400 malformed JSON, 413 too large, 415 media type', async () => {
    const { app, createId } = boot();
    try {
      const cases = [
        [await raw(app, 'application/json', '{"scenarioId":'), 400],
        [await raw(app, 'application/json', JSON.stringify({ pad: 'x'.repeat(1_100_000) })), 413],
        [await raw(app, 'application/xml', '<session/>'), 415],
      ] as const;
      for (const [response, status] of cases) {
        expect(response.statusCode).toBe(status);
        expect(ErrorResponse.parse(response.json()).error.code).toBe('INVALID_MESSAGE');
      }
      expect(createId).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test.each([
    ['null', null],
    ['missing rejection reason', undefined],
    ['a non-Error string', 'case-detail-marker'],
    ['parser-shaped Error', Object.assign(new Error('case-detail-marker'), {
      code: 'FST_ERR_CTP_INVALID_JSON_BODY', statusCode: 400,
    })],
    ['parser error thrown by the provider', new errorCodes.FST_ERR_CTP_INVALID_JSON_BODY()],
  ] as const)('keeps an internal failure safe for %s', async (_name, reason) => {
    const logs = captureLogs();
    const provider = {
      create: () =>
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercise untyped failures.
        Promise.reject(reason),
    };
    const { app, create, createId } = boot({ provider, logStream: logs.stream });
    try {
      const response = await create({ scenarioId: 'sanatorium_winter', seed: 'error' });
      expect(response.statusCode).toBe(500);
      expect(ErrorResponse.parse(response.json()).error).toEqual({
        code: 'INTERNAL', message: 'Internal error',
      });
      expect(logs.entries().filter(({ msg }) => msg === 'request failed')).toEqual([
        expect.objectContaining({ errorCode: 'INTERNAL' }),
      ]);
      expect(response.body).not.toContain('case-detail-marker');
      expect(logs.text()).not.toContain('case-detail-marker');
      expect(createId).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('an internal error carrying a client statusCode is still 500 INTERNAL, and logged', async () => {
    const logs = captureLogs();
    const provider = {
      create: vi.fn(() => {
        throw Object.assign(new Error('char_nurse teapot'), { statusCode: 418, status: 418 });
      }),
    };
    const { app, create } = boot({ provider, logStream: logs.stream });
    try {
      const response = await create({ scenarioId: 'sanatorium_winter', seed: '1' });
      expect(response.statusCode).toBe(500);
      expect(ErrorResponse.parse(response.json()).error).toEqual({
        code: 'INTERNAL',
        message: 'Internal error',
      });
      expect(logs.entries()).toContainEqual(
        expect.objectContaining({ msg: 'request failed', errorCode: 'INTERNAL' }),
      );
      expect(logs.text()).not.toContain('char_nurse');
    } finally {
      await app.close();
    }
  });
});

describe('createReadableSeed', () => {
  test('reads as XXXX-XXXX-XXXX in Crockford Base32 and is accepted as a client seed', () => {
    const seeds = Array.from({ length: 500 }, createReadableSeed);
    for (const seed of seeds) {
      expect(seed).toMatch(READABLE_SEED);
      expect(Seed.safeParse(seed).success).toBe(true);
    }
    expect(new Set(seeds).size).toBe(seeds.length);
  });
});
