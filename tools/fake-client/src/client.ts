import {
  PROTOCOL_VERSION,
  ServerMessage,
  type ClientMessage,
  type PhoneView,
  type PlayerAction,
  type PlayerView,
} from '@hs/protocol';
import WebSocket from 'ws';

export type Role = 'desktop' | 'phone';
export type View = PlayerView | PhoneView;
export type ServerMessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
type PeerStatus = ServerMessageOf<'peer.status'>['payload'];
type ClientInput<T = ClientMessage> = T extends ClientMessage
  ? Omit<T, 'v' | 'id' | 'ack'> & { id?: string }
  : never;

/** Random connection drops, for chaos tests: the client reconnects and resumes by itself. */
export interface ChaosOptions {
  /** How often the client rolls the dice, in ms. */
  readonly intervalMs: number;
  /** Chance (0..1) that a roll drops the connection. */
  readonly dropProbability: number;
  /** Source of rolls; pass a seeded function to make a run repeatable. Defaults to `Math.random`. */
  readonly random?: () => number;
  /** Pause before reconnecting, in ms (default 10). */
  readonly reconnectDelayMs?: number;
}

export interface FakeClientOptions {
  /** `http://host:port` of the server. */
  readonly baseUrl: string;
  /** Session token (desktop) or device token (phone). Never printed or serialized. */
  readonly token: string;
  readonly appVersion?: string;
  /** How long a wait may last before it fails (default 5000 ms). */
  readonly timeoutMs?: number;
  readonly chaos?: ChaosOptions;
}

interface Waiter {
  readonly match: (message: ServerMessage) => boolean;
  readonly resolve: (message: ServerMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * A scriptable client that talks to a real server over WebSocket. Every incoming message is
 * validated with the `@hs/protocol` schemas; an invalid one is recorded in `violations` and fails
 * all pending waits, because a server that breaks the contract must not pass a test.
 */
export abstract class FakeClient {
  abstract readonly role: Role;
  readonly baseUrl: string;
  /** Every valid message received, in order (across reconnects). */
  readonly messages: ServerMessage[] = [];
  /** Descriptions of incoming frames that broke the protocol contract. */
  readonly violations: string[] = [];
  /** Number of automatic reconnects done under chaos. */
  reconnects = 0;
  /** Number of connection drops caused by chaos. */
  drops = 0;

  readonly #token: string;
  readonly #appVersion: string;
  readonly #timeoutMs: number;
  readonly #chaos: ChaosOptions | undefined;
  readonly #waiters = new Set<Waiter>();
  #socket: WebSocket | undefined;
  #requests = 0;
  #lastSeq = 0;
  #stateVersion = 0;
  #sessionId: string | undefined;
  #view: View | undefined;
  #peers: PeerStatus | undefined;
  #lastError: string | undefined;
  #stopped = false;
  #chaosTimer: NodeJS.Timeout | undefined;
  #reconnecting = false;

  protected constructor({ baseUrl, token, appVersion, timeoutMs, chaos }: FakeClientOptions) {
    this.baseUrl = baseUrl;
    this.#token = token;
    this.#appVersion = appVersion ?? 'fake-client';
    this.#timeoutMs = timeoutMs ?? 5000;
    this.#chaos = chaos;
  }

  /** Never exposes the token, even to `JSON.stringify` and logs. */
  toJSON(): Record<string, unknown> {
    return { role: this.role, connected: this.connected, lastSeq: this.#lastSeq };
  }

  protected get token(): string {
    return this.#token;
  }

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  get stateVersion(): number {
    return this.#stateVersion;
  }

  /** The newest view the server sent, if any. */
  get view(): View | undefined {
    return this.#view;
  }

  /** The newest `peer.status`, if any. */
  get peers(): PeerStatus | undefined {
    return this.#peers;
  }

  /** `event` payloads received so far. */
  get events(): ServerMessageOf<'event'>['payload']['event'][] {
    return this.messages.flatMap((m) => (m.type === 'event' ? [m.payload.event] : []));
  }

  /** Opens the socket, sends `hello` (with `resume` after a first connection) and waits for `welcome`. */
  connect(): Promise<ServerMessageOf<'welcome'>['payload']> {
    this.#stopped = false;
    return this.#open();
  }

  async #open(): Promise<ServerMessageOf<'welcome'>['payload']> {
    if (this.connected) throw new Error('Already connected');
    const socket = new WebSocket(`${this.baseUrl.replace(/^http/, 'ws')}/ws`);
    this.#socket = socket;
    this.#lastError = undefined;
    socket.on('message', (data, binary) => this.#receive(socket, data, binary));
    socket.on('error', () => undefined);
    socket.on('close', (code, reason) => this.#closed(socket, code, reason.toString()));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('Connection closed before it opened')));
    });
    const welcome = this.#wait<ServerMessageOf<'welcome'>>((m) => m.type === 'welcome');
    this.#sendFrame({
      v: PROTOCOL_VERSION,
      id: this.#nextId(),
      type: 'hello',
      payload: {
        role: this.role,
        token: this.#token,
        appVersion: this.#appVersion,
        ...(this.#sessionId !== undefined && {
          resume: { lastSeq: this.#lastSeq, stateVersion: this.#stateVersion },
        }),
      },
    });
    const { payload } = await welcome;
    this.#sessionId = payload.sessionId;
    this.#startChaos();
    return payload;
  }

  /** Sends a protocol message with the next request id and the current `ack`. Returns its id. */
  send(message: ClientInput): string {
    const id = message.id ?? this.#nextId();
    this.#sendFrame({
      v: PROTOCOL_VERSION,
      ...message,
      id,
      ...(this.#lastSeq > 0 && { ack: this.#lastSeq }),
    });
    return id;
  }

  /** Sends text as is, for tests of how the server treats broken frames. */
  sendRaw(text: string): void {
    this.#sendFrame(text);
  }

  /** Sends `action.request` and waits for the `action.result` with the same request id. */
  async sendAction(action: PlayerAction): Promise<ServerMessageOf<'action.result'>['payload']> {
    const id = this.#nextId();
    const result = this.#wait<ServerMessageOf<'action.result'>>(
      (m) => m.type === 'action.result' && m.payload.requestId === id,
    );
    this.send({ type: 'action.request', id, payload: { action } });
    return (await result).payload;
  }

  /** Sends `ping` and waits for `pong`. */
  async ping(): Promise<void> {
    const pong = this.#wait((m) => m.type === 'pong');
    this.send({ type: 'ping', payload: {} });
    await pong;
  }

  /** Waits for the next message of a type that satisfies `predicate` (messages already seen do not count). */
  waitFor<T extends ServerMessage['type']>(
    type: T,
    predicate: (message: ServerMessageOf<T>) => boolean = () => true,
    timeoutMs?: number,
  ): Promise<ServerMessageOf<T>> {
    return this.#wait<ServerMessageOf<T>>(
      (m) => m.type === type && predicate(m as ServerMessageOf<T>),
      timeoutMs,
    );
  }

  /** The newest view when it satisfies `predicate` already, otherwise the first later one that does. */
  async waitForView(predicate: (view: View) => boolean = () => true, timeoutMs?: number) {
    if (this.#view && predicate(this.#view)) return this.#view;
    const update = await this.#wait<ServerMessageOf<'view.update'>>(
      (m) => m.type === 'view.update' && predicate(m.payload.view),
      timeoutMs,
    );
    return update.payload.view;
  }

  /** Waits until `peer.status` satisfies `predicate` (checks the newest one first). */
  async waitForPeers(predicate: (status: PeerStatus) => boolean, timeoutMs?: number) {
    if (this.#peers && predicate(this.#peers)) return this.#peers;
    return (
      await this.#wait<ServerMessageOf<'peer.status'>>(
        (m) => m.type === 'peer.status' && predicate(m.payload),
        timeoutMs,
      )
    ).payload;
  }

  /** Waits until the server closes the connection; resolves with its close code and reason. */
  waitForClose(timeoutMs = this.#timeoutMs): Promise<{ code: number; reason: string }> {
    const socket = this.#socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      return Promise.resolve({ code: 0, reason: '' });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for close')), timeoutMs);
      socket.once('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
    });
  }

  /** Cuts the connection without a close frame, as a network failure would. */
  drop(): void {
    this.#socket?.terminate();
  }

  /** Reconnects with `resume` after a drop. */
  reconnect(): Promise<ServerMessageOf<'welcome'>['payload']> {
    return this.connect();
  }

  /** Closes the connection for good and stops chaos and reconnects. */
  async close(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#chaosTimer);
    this.#chaosTimer = undefined;
    const socket = this.#socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    const closed = this.waitForClose();
    socket.close();
    await closed;
  }

  #nextId(): string {
    return `${this.role}-${++this.#requests}`;
  }

  #sendFrame(frame: unknown): void {
    if (!this.connected) throw new Error('Not connected');
    this.#socket?.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  #wait<T extends ServerMessage>(match: (message: ServerMessage) => boolean, timeoutMs?: number) {
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve: resolve as (message: ServerMessage) => void,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error('Timed out waiting for a server message'));
        }, timeoutMs ?? this.#timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  #failWaiters(error: Error): void {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
  }

  #receive(socket: WebSocket, data: WebSocket.RawData, binary: boolean): void {
    if (socket !== this.#socket) return;
    let json: unknown;
    try {
      if (binary || !Buffer.isBuffer(data)) throw new Error('not text');
      json = JSON.parse(data.toString('utf8'));
    } catch {
      this.violations.push('A frame was not JSON text');
      this.#failWaiters(new Error('The server sent a frame that is not JSON text'));
      return;
    }
    const parsed = ServerMessage.safeParse(json);
    if (!parsed.success) {
      const type = (json as { type?: unknown } | null)?.type;
      const description = `Invalid ${typeof type === 'string' ? type : 'unknown'} message: ${parsed.error.message}`;
      this.violations.push(description);
      this.#failWaiters(new Error(description));
      return;
    }
    const message = parsed.data;
    this.messages.push(message);
    if (message.seq !== undefined) this.#lastSeq = Math.max(this.#lastSeq, message.seq);
    switch (message.type) {
      case 'welcome':
        this.#stateVersion = message.payload.stateVersion;
        break;
      case 'view.update':
        this.#view = message.payload.view;
        this.#stateVersion = message.payload.stateVersion;
        break;
      case 'peer.status':
        this.#peers = message.payload;
        break;
      case 'error':
        this.#lastError = message.payload.code;
        break;
      default:
    }
    for (const waiter of [...this.#waiters]) {
      if (!waiter.match(message)) continue;
      this.#waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  #closed(socket: WebSocket, code: number, reason: string): void {
    if (socket !== this.#socket) return;
    const why = this.#lastError ? `${this.#lastError}, ` : '';
    this.#failWaiters(new Error(`Connection closed (${why}code ${code} ${reason})`.trim()));
  }

  #startChaos(): void {
    const chaos = this.#chaos;
    if (!chaos || this.#chaosTimer) return;
    const random = chaos.random ?? Math.random;
    this.#chaosTimer = setInterval(() => {
      if (this.#stopped || this.#reconnecting || !this.connected) return;
      if (random() >= chaos.dropProbability) return;
      this.drops++;
      this.drop();
      void this.#reconnectLoop(chaos.reconnectDelayMs ?? 10);
    }, chaos.intervalMs);
    this.#chaosTimer.unref();
  }

  async #reconnectLoop(delayMs: number): Promise<void> {
    this.#reconnecting = true;
    try {
      while (!this.#stopped) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (this.#stopped) return;
        try {
          await this.#open();
          this.reconnects++;
          return;
        } catch {
          // The server may be busy tearing the old connection down: try again.
        }
      }
    } finally {
      this.#reconnecting = false;
    }
  }
}
