import { randomInt } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { isIPv6 } from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeInvestigation } from '@hs/core/game';
import { stateHash } from '@hs/core/common';
import serverPackage from '../../package.json' with { type: 'json' };
import { SessionGateway } from '../gateway/index.ts';
import { QrService, EvidenceTokenStore, type QrRouteDependencies } from '../qr/index.ts';
import {
  RecordingEngine,
  SaveService,
  SaveStore,
  type SaveRouteDependencies,
} from '../saves/index.ts';
import { engineView, engineEvents } from '../views/index.ts';
import { loadScenarioFromDir, type ScenarioContent } from '@hs/core/content';
import { generateInvestigation, type GenerationResult } from '@hs/generator';
import { ScenarioId, ScenarioSummary, Seed } from '@hs/protocol';
import { isPairingHost, type ServerConfig } from '../config/index.ts';
import { listNetworkCandidates, type NetworkInterfaces } from '../config/network.ts';
import { PairingService } from '../pairing/index.ts';
import { SessionManager, type InvestigationProvider, type Session } from '../sessions/index.ts';
import { resolveTextLocale, scenarioEnginePorts } from '../sessions/scenario-ports.ts';
import type { SessionRouteDependencies } from './sessions.ts';

/**
 * Content of the repository. Resolved on use, not on import: a packaged server (INT-005) passes
 * its own directory and may have no `import.meta.url`.
 */
export const defaultScenariosDir = (): string =>
  fileURLToPath(new URL('../../../../content/scenarios/', import.meta.url));

/** Generation slower than this is logged as a warning (backend.md §4). */
export const SLOW_GENERATION_MS = 2_000;

export { ScenarioId, ScenarioSummary, Seed };

/** The locale of the game texts (game-design.md: Russian; other locales are QA-003). */
const TITLE_LOCALE = 'ru';

export { resolveTextLocale };

/** Scenarios whose directory starts with `_` are test content: never offered to the player. */
const isTestScenario = (id: string) => id.startsWith('_');

/**
 * The scenarios the server can generate, loaded once. A broken scenario stops the start, and so
 * does one whose summary `POST /sessions` or the answer schema could not accept: `GET` never lists
 * a scenario that cannot be created.
 */
export class ScenarioCatalog {
  readonly #contents: ReadonlyMap<string, ScenarioContent>;
  readonly #summaries: readonly ScenarioSummary[];

  constructor(contents: readonly ScenarioContent[]) {
    this.#contents = new Map(contents.map((content) => [content.preset.id, content]));
    this.#summaries = [...this.#contents.values()].map(({ preset }) => {
      const summary = ScenarioSummary.safeParse({
        id: preset.id,
        title: preset.title[TITLE_LOCALE] ?? Object.values(preset.title)[0],
        durationMinutes: preset.time.durationMinutes,
      });
      if (!summary.success) {
        throw new RangeError(
          `Scenario ${preset.id.slice(0, 80)} cannot be offered: ${summary.error.message}`,
        );
      }
      return summary.data;
    });
  }

  /** Every scenario directory under `dir`; test scenarios (`_…`) only with `includeTest`. */
  static fromDirectory(
    dir: string = defaultScenariosDir(),
    { includeTest = false }: { includeTest?: boolean } = {},
  ): ScenarioCatalog {
    const ids = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (includeTest || !isTestScenario(entry.name)))
      .map((entry) => entry.name)
      .sort();
    return new ScenarioCatalog(
      ids.map((id) => {
        const content = loadScenarioFromDir(join(dir, id));
        if (content.preset.id !== id) {
          throw new RangeError(`Scenario directory ${id} holds preset ${content.preset.id}`);
        }
        return content;
      }),
    );
  }

  list(): ScenarioSummary[] {
    return this.#summaries.map((summary) => ({ ...summary }));
  }

  has(id: string): boolean {
    return this.#contents.has(id);
  }

  content(id: string): ScenarioContent | undefined {
    return this.#contents.get(id);
  }
}

/** The validation gate found no solvable case for `(scenarioId, seed)`: no session is created. */
export class GenerationUnsolvableError extends Error {
  /** Read by the request log: a refused seed is not a server failure. */
  readonly statusCode = 422;

  constructor() {
    super('No solvable investigation for this scenario and seed');
    this.name = 'GenerationUnsolvableError';
  }
}

export class ScenarioNotFoundError extends Error {
  readonly statusCode = 404;

  constructor() {
    super('Scenario not found');
    this.name = 'ScenarioNotFoundError';
  }
}

/**
 * One generation for the log. Only public facts: `seed`, version, attempt count and the codes of
 * the rejections (what `hs-gen` prints without `--debug-truth`). The findings' messages, the chosen
 * incident and the investigation name characters, so they never get here.
 */
export interface GenerationLog {
  readonly scenarioId: string;
  readonly seed: string;
  readonly generatorVersion: string;
  readonly ok: boolean;
  readonly attempts: number;
  readonly durationMs: number;
  readonly stageMs: Readonly<Record<string, number>>;
  readonly rejections: readonly string[];
}

function generationLog(
  scenarioId: string,
  seed: string,
  result: GenerationResult,
  durationMs: number,
): GenerationLog {
  const { report } = result;
  const stageMs: Record<string, number> = {};
  for (const attempt of report.attempts) {
    for (const [stage, ms] of Object.entries(attempt.timingsMs)) {
      stageMs[stage] = (stageMs[stage] ?? 0) + ms;
    }
  }
  for (const stage of Object.keys(stageMs)) stageMs[stage] = Math.round(stageMs[stage]!);
  const rejections = new Set<string>();
  for (const attempt of report.attempts) {
    if (attempt.rejection) rejections.add(attempt.rejection.code);
  }
  for (const { findings } of report.validations) {
    for (const { severity, checkId, code } of findings) {
      if (severity === 'error') rejections.add(`${checkId}:${code}`);
    }
  }
  return {
    scenarioId,
    seed,
    generatorVersion: report.generatorVersion,
    ok: result.ok,
    attempts: report.attempts.length,
    durationMs: Math.round(durationMs),
    stageMs,
    rejections: [...rejections].sort(),
  };
}

export interface GeneratorProviderOptions {
  /** The real generator with its full validation gate; replaced only in tests. */
  readonly generate?: typeof generateInvestigation;
  /** Server clock for timings (milliseconds). */
  readonly now?: () => number;
}

/**
 * `InvestigationProvider` of SRV-001 on top of `generateInvestigation` (GEN-011): the case is handed
 * to the session only when the validation gate accepted it, otherwise `GenerationUnsolvableError`.
 */
export class GeneratorInvestigationProvider implements InvestigationProvider {
  readonly #catalog: ScenarioCatalog;
  readonly #generate: typeof generateInvestigation;
  readonly #now: () => number;
  readonly #listeners = new Set<(entry: GenerationLog) => void>();

  constructor(catalog: ScenarioCatalog, options: GeneratorProviderOptions = {}) {
    this.#catalog = catalog;
    this.#generate = options.generate ?? generateInvestigation;
    this.#now = options.now ?? (() => performance.now());
  }

  /** Every finished generation, accepted or not (the app logs it). */
  onGenerated(listener: (entry: GenerationLog) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  create(scenarioId: string, seed: string, locale?: string) {
    const content = this.#catalog.content(scenarioId);
    if (!content) throw new ScenarioNotFoundError();
    const started = this.#now();
    const result = this.#generate({ scenarioId, seed }, content, { now: this.#now });
    const entry = generationLog(scenarioId, seed, result, this.#now() - started);
    for (const listener of this.#listeners) listener(entry);
    if (!result.ok) throw new GenerationUnsolvableError();
    return {
      investigation: result.investigation,
      ports: scenarioEnginePorts(content, result.investigation, result.server, locale),
    };
  }
}

/** Crockford Base32 without ambiguous letters, as pairing codes (ADR 0008). */
const SEED_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A seed a player can read aloud and type: `XXXX-XXXX-XXXX`, 60 bits from the server CSPRNG. */
export function createReadableSeed(): string {
  const groups = Array.from({ length: 3 }, () =>
    Array.from({ length: 4 }, () => SEED_ALPHABET.charAt(randomInt(SEED_ALPHABET.length))).join(''),
  );
  return groups.join('-');
}

/** Pairing advertises an explicit address or discovers one for an IPv4/dual-stack wildcard. */
export function pairingHost(
  { host, publicHost }: Pick<ServerConfig, 'host' | 'publicHost'>,
  networkInterfaces: () => NetworkInterfaces,
): string {
  if (publicHost !== undefined) return publicHost;
  const ipv6Wildcard = isIPv6(host) && URL.parse(`http://[${host}]`)?.hostname === '[::]';
  if (host === '0.0.0.0' || ipv6Wildcard) {
    return listNetworkCandidates(networkInterfaces())[0]?.address ?? '127.0.0.1';
  }
  if (isPairingHost(host)) return host;
  throw new Error('The bind address needs an explicit reachable HS_PUBLIC_HOST for pairing');
}

export interface SessionServicesOptions {
  /** Scenario content; the repository's by default. */
  readonly scenariosDir?: string;
  /** Defaults to `os.networkInterfaces`; replaced in tests. */
  readonly networkInterfaces?: () => NetworkInterfaces;
}

/**
 * The production wiring (SRV-013): real generation, one session manager for REST, pairing,
 * role projections and QR, and a separate token store attached before a session is published. The result is
 * passed to `buildApp` as is.
 */
export function createSessionServices(
  config: Pick<ServerConfig, 'host' | 'port' | 'publicHost' | 'dataDir'>,
  { scenariosDir, networkInterfaces = os.networkInterfaces }: SessionServicesOptions = {},
): {
  pairing: PairingService;
  sessions: SessionRouteDependencies & { sessions: SessionManager };
  gateway: SessionGateway;
  qr: QrRouteDependencies;
  saves: SaveRouteDependencies;
} {
  const scenarios = ScenarioCatalog.fromDirectory(scenariosDir);
  const provider = new GeneratorInvestigationProvider(scenarios);
  const qr = new QrService({
    gameMinute(session) {
      const view = session.engine.playerView?.();
      if (!view) throw new Error('The session engine has no game clock');
      return view.clock.t;
    },
  });
  // Every game, new or restored, journals to `HS_DATA_DIR/saves` and gets its own token store.
  const evidenceStores = new WeakMap<RecordingEngine, EvidenceTokenStore>();
  const store = new SaveStore(join(config.dataDir, 'saves'));
  const saves = new SaveService({
    store,
    provider,
    withPorts: (investigation, ports) => ({
      ...ports,
      // Reproducible ids keep the QR state hash the same in a replay (ADR 0025).
      evidenceTokens: qr.createStore({
        idSeed: stateHash(serializeInvestigation(investigation)),
      }),
    }),
    onEngine(engine, ports) {
      const tokens = ports.evidenceTokens;
      if (!(tokens instanceof EvidenceTokenStore)) throw new Error('The game has no token store');
      // A restored game keeps its pending QR; the secret of this process signs it anew.
      tokens.adoptPending(engine.snapshot().pendingCapture);
      evidenceStores.set(engine, tokens);
    },
  });
  const sessions = new SessionManager(provider, {
    createEngine: saves.createEngine,
    published(session) {
      if (session.engine instanceof RecordingEngine) session.engine.claim();
    },
  });
  const attachQr = (session: Session, engine: RecordingEngine) => {
    const tokens = evidenceStores.get(engine);
    if (!tokens) throw new Error('The session engine has no evidence token store');
    qr.attach(session, tokens);
  };
  const pairing = new PairingService(sessions, {
    host: () => pairingHost(config, networkInterfaces),
    port: config.port,
  });
  const gateway = new SessionGateway({
    sessions,
    serverVersion: serverPackage.version,
    snapshot: engineView,
    events: engineEvents,
  });
  return {
    pairing,
    gateway,
    qr: {
      qr,
      authorizeDesktop: pairing.authorizeDesktop.bind(pairing),
      activePairingCode: pairing.activeCode.bind(pairing),
    },
    sessions: {
      scenarios,
      sessions,
      pairing,
      generation: provider,
      prepare(session) {
        if (!(session.engine instanceof RecordingEngine)) throw new Error('Not a recording engine');
        attachQr(session, session.engine);
      },
    },
    saves: {
      saves,
      sessions,
      pairing,
      prepare: attachQr,
      cleanup: () => store.removeStaleTemp(),
    },
  };
}
