import { randomUUID } from 'node:crypto';
import {
  GameEngine,
  type DispatchResult,
  type EnginePorts,
  type Investigation,
} from '@hs/core/game';
import type { PlayerAction } from '@hs/protocol';

const EVENT_LIMIT = 200;
const DESKTOP_GRACE_MS = 60_000;
const FINISHED_TTL_MS = 30 * 60_000;

export type SessionRole = 'desktop' | 'phone';
export type SessionStatus =
  'created' | 'active' | 'suspended' | 'finished' | 'faulted' | 'disposed';

export interface InvestigationProvider {
  create(
    scenarioId: string,
    seed: string,
  ):
    | { investigation: Investigation; ports: EnginePorts }
    | Promise<{ investigation: Investigation; ports: EnginePorts }>;
}

export interface SessionEngine {
  dispatch(role: SessionRole, action: PlayerAction): DispatchResult | Promise<DispatchResult>;
}

export interface SessionEvent {
  readonly seq: number;
  readonly event: DispatchResult['events'][number];
}

function failed(error: 'INTERNAL' | 'SESSION_CLOSED'): DispatchResult {
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

  dispatch(role: SessionRole, action: PlayerAction): Promise<DispatchResult> {
    return this.#enqueue(async () => {
      this.#refreshLifetime();
      if (this.#status === 'faulted') return failed('INTERNAL');
      if (this.#status !== 'active') return failed('SESSION_CLOSED');

      try {
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
        return result;
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
      this.#status = 'disposed';
      this.#tokenHashes.clear();
      this.#events.length = 0;
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
  readonly createEngine?: (investigation: Investigation, ports: EnginePorts) => SessionEngine;
}

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #provider: InvestigationProvider;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #createEngine: NonNullable<SessionManagerOptions['createEngine']>;

  constructor(provider: InvestigationProvider, options: SessionManagerOptions = {}) {
    this.#provider = provider;
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
    this.#createEngine =
      options.createEngine ?? ((investigation, ports) => GameEngine.create(investigation, ports));
  }

  async create(scenarioId: string, seed: string): Promise<Session> {
    const { investigation, ports } = await this.#provider.create(scenarioId, seed);
    const id = this.#createId();
    if (this.#sessions.has(id)) throw new Error('Duplicate session ID');
    const session = new Session(id, this.#createEngine(investigation, ports), this.#now);
    this.#sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
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
