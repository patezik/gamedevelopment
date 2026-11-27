import {
  GameEngine,
  type DispatchResult,
  type EnginePorts,
  type Investigation,
} from '@hs/core/game';
import {
  createSave,
  gameReplayRuntime,
  loadSave,
  recordAction,
  SaveDesyncError,
  SaveFile,
} from '@hs/core/save';
import type { ErrorCode, PlayerAction, SaveSummary as PublicSaveSummary } from '@hs/protocol';
import { z } from 'zod';
import type { InvestigationProvider, SessionEngine, SessionRole } from '../sessions/index.ts';
import { isSaveId, type SaveStore } from './store.ts';

/** An error that already carries a protocol code and an HTTP status. */
export class SaveError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** For `SAVE_DESYNC`: the first journal entry that does not check out; 0 is the initial state. */
  readonly atAction?: number;

  constructor(code: ErrorCode, status: number, message: string, atAction?: number) {
    super(message);
    this.name = 'SaveError';
    this.code = code;
    this.status = status;
    if (atAction !== undefined) this.atAction = atAction;
  }
}

export type SaveSummary = Readonly<PublicSaveSummary>;

const identity = z.looseObject({ scenarioId: z.string().min(1), seed: z.string() });
const meta = z.object({ gameTime: z.int().nonnegative() });

export interface SaveServiceOptions {
  readonly store: SaveStore;
  /** The provider the session manager uses: a save is regenerated from `(scenarioId, seed)`. */
  readonly provider: InvestigationProvider;
  /** Wall clock in milliseconds; only for the `createdAt` metadata. */
  readonly now?: () => number;
  /**
   * Ports owned by one running game (the QR token store). Called for every new game and every
   * restore so both build the same engine: the replay must see what the live game saw.
   */
  readonly withPorts?: (investigation: Investigation, ports: EnginePorts) => EnginePorts;
  /** The engine is built (new, or restored and verified): bind per-game resources to it. */
  readonly onEngine?: (engine: RecordingEngine, ports: EnginePorts) => void;
}

/** The engine of a session whose every action is journaled to disk before it is acknowledged. */
export class RecordingEngine implements SessionEngine {
  readonly #service: SaveService;
  readonly #saveId: string;
  readonly #engine: GameEngine;
  readonly #save: SaveFile;
  #gameTime: number;

  constructor(service: SaveService, saveId: string, engine: GameEngine, save: SaveFile) {
    this.#service = service;
    this.#saveId = saveId;
    this.#engine = engine;
    this.#save = save;
    this.#gameTime = engine.snapshot().minute;
  }

  /** Makes this engine the only writer of its save. The one it replaces can no longer write. */
  claim(): void {
    this.#service.claim(this.#saveId, this);
  }

  async dispatch(role: SessionRole, action: PlayerAction): Promise<DispatchResult> {
    // `recordAction` dispatches and journals as one step; the file is written before the caller
    // sees the result, so an acknowledged action is never missing from the save.
    const result = recordAction(this.#save, this.#engine, role, action);
    this.#gameTime += result.minutesSpent;
    await this.#service.persist(this.#saveId, this, this.#save, this.#gameTime);
    return result;
  }

  snapshot(): ReturnType<GameEngine['snapshot']> {
    return this.#engine.snapshot();
  }

  playerView() {
    return this.#engine.playerView();
  }

  phoneView() {
    return this.#engine.phoneView();
  }

  stateHash(): string {
    return this.#engine.stateHash();
  }
}

export class SaveService {
  readonly #store: SaveStore;
  readonly #provider: InvestigationProvider;
  readonly #now: () => number;
  readonly #owners = new Map<string, RecordingEngine>();
  readonly #withPorts: NonNullable<SaveServiceOptions['withPorts']>;
  readonly #onEngine: NonNullable<SaveServiceOptions['onEngine']>;

  constructor({ store, provider, now = Date.now, withPorts, onEngine }: SaveServiceOptions) {
    this.#store = store;
    this.#provider = provider;
    this.#now = now;
    this.#withPorts = withPorts ?? ((_investigation, ports) => ports);
    this.#onEngine = onEngine ?? (() => undefined);
  }

  /**
   * For `SessionManager`'s `createEngine`: the new session's engine journals itself under the
   * session's ID. Nothing is written until the first action; a game with no actions is not worth
   * continuing. The engine does not own the save yet: `claim()` it when the session is published,
   * so a session that never gets published cannot displace the writer of an existing save.
   */
  createEngine = (
    investigation: Investigation,
    ports: EnginePorts,
    sessionId: string,
  ): RecordingEngine => {
    const gamePorts = this.#withPorts(investigation, ports);
    const engine = GameEngine.create(investigation, gamePorts);
    const { scenarioId, seed, generatorVersion } = investigation;
    const save = createSave(
      { scenarioId, seed, generatorVersion, createdAt: new Date(this.#now()).toISOString() },
      engine,
    );
    const recording = new RecordingEngine(this, sessionId, engine, save);
    this.#onEngine(recording, gamePorts);
    return recording;
  };

  claim(saveId: string, engine: RecordingEngine): void {
    this.#owners.set(saveId, engine);
  }

  async persist(
    saveId: string,
    writer: RecordingEngine,
    save: SaveFile,
    gameTime: number,
  ): Promise<void> {
    if (this.#owners.get(saveId) !== writer) {
      throw new Error('The save now belongs to another session');
    }
    await this.#store.write(saveId, JSON.stringify(save));
    // Derived data for the list: if the process dies between the two writes it is one action late.
    await this.#store.writeMeta(saveId, { gameTime });
  }

  async list(): Promise<SaveSummary[]> {
    const summaries: SaveSummary[] = [];
    for (const { saveId, updatedAt } of await this.#store.files()) {
      let head: z.infer<typeof identity>;
      try {
        head = identity.parse(JSON.parse((await this.#store.read(saveId)) ?? ''));
      } catch {
        continue; // not a save (a stray or damaged file): it cannot be loaded either
      }
      const stored = meta.safeParse(await this.#store.readMeta(saveId));
      summaries.push({
        saveId,
        scenarioId: head.scenarioId,
        updatedAt: updatedAt.toISOString(),
        gameTime: stored.success ? stored.data.gameTime : null,
      });
    }
    return summaries.sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.saveId.localeCompare(b.saveId),
    );
  }

  /**
   * Rebuilds the game by replaying the save and checking every hash. The result is not yet the
   * writer of the save: call `claim()` when committing the replacement session.
   */
  async restore(saveId: string): Promise<RecordingEngine> {
    const text = isSaveId(saveId) ? await this.#store.read(saveId) : undefined;
    if (text === undefined) throw new SaveError('SAVE_NOT_FOUND', 404, 'Save not found');

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new SaveError('SAVE_DESYNC', 422, 'The save file is damaged', 0);
    }
    const head = identity.safeParse(raw);
    if (!head.success) throw new SaveError('SAVE_DESYNC', 422, 'The save file is damaged', 0);

    const created = await this.#provider.create(head.data.scenarioId, head.data.seed);
    const { investigation } = created;
    const ports = this.#withPorts(investigation, created.ports);
    let engine: GameEngine;
    try {
      engine = loadSave(raw, () => gameReplayRuntime(investigation, ports));
    } catch (error) {
      if (error instanceof SaveDesyncError) {
        throw new SaveError(error.code, 422, error.message, error.atAction);
      }
      throw error;
    }
    // `loadSave` accepted it, so this parse cannot fail.
    const save = SaveFile.parse(raw);
    const recording = new RecordingEngine(this, saveId, engine, save);
    this.#onEngine(recording, ports);
    return recording;
  }
}
