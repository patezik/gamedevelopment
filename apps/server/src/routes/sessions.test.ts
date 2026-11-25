import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Investigation } from '@hs/core/game';
import { GENERATION_CHECKS, generateInvestigation, type GenerationResult } from '@hs/generator';
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
  GeneratorInvestigationProvider,
  ScenarioCatalog,
  type GeneratorProviderOptions,
} from './generation.ts';
import {
  CreateSessionResponse,
  ErrorResponse,
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
}

/** The app wired the way server.ts wires it, with the given provider. */
function boot(options: BootOptions = {}) {
  const fixture = fixtureProvider();
  const provider = options.provider ?? fixture;
  const catalog = options.catalog ?? scenarios;
  const createId = vi.fn(randomUUID);
  const sessions = new SessionManager(provider, { createId });
  const pairing = new PairingService(sessions, { host: () => 'game-pc.local', port: 7420 });
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
      expect(body.seed).toBe('winter-42');
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
      expect(first.seed).toMatch(READABLE_SEED);
      expect(second.seed).toMatch(READABLE_SEED);
      expect(first.seed).not.toBe(second.seed);
      expect(generated.mock.calls).toEqual([
        ['sanatorium_winter', first.seed],
        ['sanatorium_winter', second.seed],
      ]);
      expect(first.sessionId).not.toBe(second.sessionId);
      expect(first.desktopToken).not.toBe(second.desktopToken);
    } finally {
      await app.close();
    }
  });

  test('the seed source can be injected; a given seed is never replaced', async () => {
    const createSeed = vi.fn(() => 'FIXED-SEED-0001');
    const { app, create } = boot({ createSeed });
    try {
      expect((await create({ scenarioId: 'sanatorium_winter' })).json()).toMatchObject({
        seed: 'FIXED-SEED-0001',
      });
      expect((await create({ scenarioId: 'sanatorium_winter', seed: '7' })).json()).toMatchObject({
        seed: '7',
      });
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
        'seed',
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
    // Test-only injection: the shipped deduction rules prove no motive (OQ-20), so the full gate
    // refuses every seed. The structural checks still gate the case, as in the GEN-011 tests.
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

  // The production path, full validation gate. With OQ-20 open every seed is refused; once the
  // content proves motives, the same test expects a session instead.
  test.each([
    ['_test_minimal', '42'],
    ['sanatorium_winter', '42'],
  ])(
    'full gate on %s seed %s: a session only for an accepted case',
    async (scenarioId, seed) => {
      const { app, sessions, createId, createCode, create } = generatorBoot();
      try {
        const response = await create({ scenarioId, seed });
        if (response.statusCode === 201) {
          const body = CreateSessionResponse.parse(response.json());
          expect(sessions.get(body.sessionId)?.status).toBe('created');
        } else {
          expect(response.statusCode).toBe(422);
          expect(ErrorResponse.parse(response.json()).error.code).toBe('GENERATION_UNSOLVABLE');
          expect(createId).not.toHaveBeenCalled();
          expect(createCode).not.toHaveBeenCalled();
        }
      } finally {
        await app.close();
      }
    },
    60_000,
  );

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
