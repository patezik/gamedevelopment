import { randomUUID } from 'node:crypto';
import {
  GameEngine,
  type DispatchResult,
  type EnginePorts,
  type Investigation,
} from '@hs/core/game';
import type { ErrorCode, PlayerAction, PlayerView, PhoneView } from '@hs/protocol';

const EVENT_LIMIT = 200;
const DESKTOP_GRACE_MS = 60_000;
const FINISHED_TTL_MS = 30 * 60_000;

export const DEFAULT_LOCALE = 'ru';

export type SessionRole = 'desktop' | 'phone';
export type SessionStatus =
  'created' | 'active' | 'suspended' | 'finished' | 'faulted' | 'disposed';

export interface InvestigationProvider {
  create(
    scenarioId: string,
    seed: string,
    locale?: string,
  ):
    | { investigation: Investigation; ports: EnginePorts }
    | Promise<{ investigation: Investigation; ports: EnginePorts }>;
}

export interface SessionEngine {
  playerView?(): PlayerView;
  phoneView?(): PhoneView | undefined;
  dispatch(role: SessionRole, action: PlayerAction): DispatchResult | Promise<DispatchResult>;
}

/** A dispatch result; a successful one carries the `stateVersion` that this dispatch produced. */
export type SessionDispatchResult = DispatchResult & { readonly stateVersion?: number };

export interface SessionEvent {
  readonly seq: number;
  readonly event: DispatchResult['events'][number];
}

function failed(error: ErrorCode): DispatchResult {
  return { ok: false, error, minutesSpent: 0, events: [] };
}

export class Session {
  readonly id: string;
  readonly engine: SessionEngine;
  readonly #now: () => number;
  readonly #connected = new Set<SessionRole>();
  readonly #tokenHashes = new Map<SessionRole, string>();
  readonly #events: SessionEvent[] = [];
  #status: SessionStatus = 'created';
  #stateVersion = 0;
  #eventSeq = 0;
  #desktopAbsentSince: number | undefined;
  #finishedIdleSince: number | undefined;
  #queue: Promise<void> = Promise.resolve();

  constructor(id: string, engine: SessionEngine, now: () => number) {
    this.id = id;
    this.engine = engine;
    this.#now = now;
  }

  get status(): SessionStatus {
    return this.#status;
  }

  get stateVersion(): number {
    return this.#stateVersion;
  }

  get eventSeq(): number {
    return this.#eventSeq;
  }

  setTokenHash(role: SessionRole, hash: string): void {
    if (this.#status === 'disposed') throw new Error('Session is disposed');
    this.#tokenHashes.set(role, hash);
  }

  tokenHash(role: SessionRole): string | undefined {
    return this.#tokenHashes.get(role);
  }

  clearTokenHash(role: SessionRole): boolean {
    return this.#tokenHashes.delete(role);
  }

  /** Null indicates a gap and the gateway must send a full snapshot. */
  eventsAfter(seq: number): SessionEvent[] | null {
    const oldest = this.#events[0]?.seq ?? this.#eventSeq + 1;
    if (!Number.isSafeInteger(seq) || seq < oldest - 1 || seq > this.#eventSeq) return null;
    return structuredClone(this.#events.filter((entry) => entry.seq > seq));
  }

  activate(): Promise<boolean> {
    return this.#enqueue(() => {
      if (this.#status !== 'created') return false;
      this.#status = 'active';
      if (!this.#connected.has('desktop')) this.#desktopAbsentSince = this.#now();
      return true;
    });
  }

  setConnected(role: SessionRole, connected: boolean): Promise<void> {
    return this.#enqueue(() => {
      this.#refreshLifetime();
      if (this.#status === 'disposed' || this.#connected.has(role) === connected) return;
      if (connected) this.#connected.add(role);
      else this.#connected.delete(role);

      if (role === 'desktop') {
        this.#desktopAbsentSince = connected ? undefined : this.#now();
        if (connected && this.#status === 'suspended') this.#status = 'active';
      }
      if (this.#status === 'finished') {
        this.#finishedIdleSince = this.#connected.size === 0 ? this.#now() : undefined;
      }
    });
  }

  dispatch(
    role: SessionRole,
    action: PlayerAction,
    precondition?: () => ErrorCode | undefined,
  ): Promise<SessionDispatchResult> {
    return this.#enqueue(async () => {
      this.#refreshLifetime();
      if (this.#status === 'faulted') return failed('INTERNAL');
      if (this.#status !== 'active') return failed('SESSION_CLOSED');

      try {
        const rejection = precondition?.();
        if (rejection) return failed(rejection);
        const result = await this.engine.dispatch(role, action);
        if (!result.ok) return result;
        const events = structuredClone(result.events);
        for (const event of events) this.#events.push({ seq: ++this.#eventSeq, event });
        if (this.#events.length > EVENT_LIMIT) {
          this.#events.splice(0, this.#events.length - EVENT_LIMIT);
        }
        this.#stateVersion++;
        if (result.outcome) {
          this.#status = 'finished';
          if (this.#connected.size === 0) this.#finishedIdleSince = this.#now();
        }
        return { ...result, stateVersion: this.#stateVersion };
      } catch {
        this.#status = 'faulted';
        return failed('INTERNAL');
      }
    });
  }

  refreshLifetime(): Promise<SessionStatus> {
    return this.#enqueue(() => {
      this.#refreshLifetime();
      return this.#status;
    });
  }

  /** Wait for queued writes and hold the queue until the replacement is ready to publish. */
  replaceWith<Engine extends SessionEngine>(
    restore: () => Promise<Engine>,
    publish: (engine: Engine) => Session,
  ): Promise<Session> {
    return this.#enqueue(async () => {
      // Only an active session can become eligible here. Leave finished-session expiry to sweep.
      if (this.#status === 'active') this.#refreshLifetime();
      if (!REPLACEABLE.has(this.#status)) throw new SessionIdInUseError();
      const replacement = publish(await restore());
      this.#dispose();
      return replacement;
    });
  }

  #dispose(): void {
    this.#status = 'disposed';
    this.#tokenHashes.clear();
    this.#events.length = 0;
  }

  #refreshLifetime(): void {
    const now = this.#now();
    if (
      this.#status === 'active' &&
      this.#desktopAbsentSince !== undefined &&
      now - this.#desktopAbsentSince >= DESKTOP_GRACE_MS
    ) {
      this.#status = 'suspended';
    }
    if (
      this.#status === 'finished' &&
      this.#finishedIdleSince !== undefined &&
      now - this.#finishedIdleSince >= FINISHED_TTL_MS
    ) {
      this.#dispose();
    }
  }

  #enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

interface SessionManagerOptions {
  readonly now?: () => number;
  readonly createId?: () => string;
  /** `sessionId` is the ID the new session will get (saves are named after it). */
  readonly createEngine?: (
    investigation: Investigation,
    ports: EnginePorts,
    sessionId: string,
  ) => SessionEngine;
  /**
   * Called synchronously right after a created session is registered, never for a session whose
   * `prepare` failed. It must not throw. The save layer makes the new engine the writer here.
   */
  readonly published?: (session: Session) => void;
}

/** A session that cannot be replaced (still running) already holds the ID. */
export class SessionIdInUseError extends Error {
  constructor() {
    super('A session with this ID is running');
    this.name = 'SessionIdInUseError';
  }
}

/** Sessions whose clients are gone or whose game is over: a loaded save may take their ID. */
const REPLACEABLE: ReadonlySet<SessionStatus> = new Set([
  'suspended',
  'finished',
  'faulted',
  'disposed',
]);

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #pendingIds = new Set<string>();
  readonly #provider: InvestigationProvider;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #createEngine: NonNullable<SessionManagerOptions['createEngine']>;
  readonly #published: ((session: Session) => void) | undefined;

  constructor(provider: InvestigationProvider, options: SessionManagerOptions = {}) {
    this.#provider = provider;
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
    this.#published = options.published;
    this.#createEngine =
      options.createEngine ?? ((investigation, ports) => GameEngine.create(investigation, ports));
  }

  /**
   * `prepare` runs synchronously on the new session before it is registered (tokens, pairing
   * code, the answer). If it fails, the manager never holds the session. The callback owns the
   * cleanup of any state it changed outside the manager. `locale` is the text language chosen by
   * the client (QA-003); the provider picks the templates.
   */
  async create(
    scenarioId: string,
    seed: string,
    prepare?: (session: Session) => undefined,
    locale = DEFAULT_LOCALE,
  ): Promise<Session> {
    const { investigation, ports } = await this.#provider.create(scenarioId, seed, locale);
    const id = this.#createId();
    if (this.#sessions.has(id) || this.#pendingIds.has(id)) throw new Error('Duplicate session ID');
    this.#pendingIds.add(id);
    try {
      const session = new Session(id, this.#createEngine(investigation, ports, id), this.#now);
      const prepared: unknown = prepare?.(session);
      if (prepared !== undefined) {
        // Observe a rejecting Promise from an untyped caller without publishing the session.
        void Promise.resolve(prepared).catch(() => undefined);
        throw new TypeError('Session prepare must finish synchronously and return undefined');
      }
      this.#sessions.set(id, session);
      this.#published?.(session);
      return session;
    } finally {
      this.#pendingIds.delete(id);
    }
  }

  /**
   * Hosts an engine under `id`. A factory restores it after the ID is reserved and queued actions
   * have finished. Synchronous `prepare` returns the commit for staged data; that commit must not
   * throw or call external hooks. The previous session is retired in the same synchronous step.
   */
  async adopt<Engine extends SessionEngine>(
    id: string,
    engine: Engine | (() => Engine | Promise<Engine>),
    prepare?: (session: Session, engine: Engine) => () => undefined,
  ): Promise<Session> {
    if (this.#pendingIds.has(id)) throw new SessionIdInUseError();
    this.#pendingIds.add(id);
    try {
      const restore = () => Promise.resolve(typeof engine === 'function' ? engine() : engine);
      const publish = (restored: Engine) => {
        const session = new Session(id, restored, this.#now);
        prepare?.(session, restored)();
        this.#sessions.set(id, session);
        return session;
      };
      const existing = this.#sessions.get(id);
      if (existing) return await existing.replaceWith(restore, publish);
      return publish(await restore());
    } finally {
      this.#pendingIds.delete(id);
    }
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  findByTokenHash(hash: string): { session: Session; role: SessionRole } | undefined {
    for (const session of this.#sessions.values()) {
      for (const role of ['desktop', 'phone'] as const) {
        if (session.tokenHash(role) === hash) return { session, role };
      }
    }
    return undefined;
  }

  async sweep(): Promise<void> {
    await Promise.all(
      [...this.#sessions].map(async ([id, session]) => {
        if (
          (await session.refreshLifetime()) === 'disposed' &&
          this.#sessions.get(id) === session
        ) {
          this.#sessions.delete(id);
        }
      }),
    );
  }
}
