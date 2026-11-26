import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type ErrorCode,
  type ServerMessage,
} from '@hs/protocol';
import type { PairedDevice } from '../pairing/pairClient';
import { useConnectionStore } from '../stores/connectionStore';
import { usePhoneStore } from '../stores/phoneStore';
import { useQrStore } from '../stores/qrStore';

export const PING_INTERVAL_MS = 10_000;
/** The gateway closes a socket silent for 30 s; the client gives up on a dead link the same way. */
export const SILENCE_TIMEOUT_MS = 30_000;
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 8_000;
export const BACKOFF_JITTER = 0.2;
/** Consecutive failed attempts after which the status becomes `offline` (retries continue). */
export const OFFLINE_AFTER_ATTEMPTS = 3;

/** Delay before reconnect attempt number `attempt` (0-based): 0.5, 1, 2, 4, 8 s, +-20 % jitter. */
export function backoffDelay(attempt: number, random: () => number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
  return Math.round(base * (1 + BACKOFF_JITTER * (random() * 2 - 1)));
}

export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface WsClientOptions {
  device: PairedDevice;
  appVersion: string;
  createSocket?: (url: string) => SocketLike;
  random?: () => number;
  /** Called after DEVICE_REVOKED: the caller deletes the token and returns to /pair. */
  onRevoked: () => void;
  /** Server `event` messages (UI is out of scope for the connection layer). */
  onEvent?: (event: unknown) => void;
}

/** Codes after which reconnecting is pointless. */
const FATAL_CODES = new Set(['PROTOCOL_MISMATCH', 'SESSION_CLOSED', 'SESSION_NOT_FOUND']);

export class WsClient {
  private readonly opts: WsClientOptions;
  private socket: SocketLike | null = null;
  private running = false;
  private attempt = 0;
  private welcomed = false;
  private idCounter = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WsClientOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.attempt = 0;
    useConnectionStore.getState().setStatus('connecting');
    this.open();
  }

  /** Closes the socket for good (revoked, unpair, unmount). */
  stop(): void {
    this.running = false;
    this.teardown();
  }

  /** Sends `qr.scan`. False when the link is not up (nothing is queued: the player rescans). */
  sendQrScan(raw: string): boolean {
    if (!this.running || !this.welcomed || !this.socket) {
      return false;
    }
    this.send('qr.scan', { raw });
    return true;
  }

  /** App went to the background: the OS kills sockets anyway, so close cleanly without retries. */
  pause(): void {
    if (!this.running) {
      return;
    }
    this.teardown();
    useConnectionStore.getState().setStatus('offline');
  }

  /** App became active again: reconnect right away with `resume`. */
  resume(): void {
    if (!this.running) {
      return;
    }
    this.teardown();
    this.attempt = 0;
    useConnectionStore.getState().setStatus('connecting');
    this.open();
  }

  private url(): string {
    const { host, port, wsPath } = this.opts.device;
    return `ws://${host}:${port}${wsPath}`;
  }

  private nextId(): string {
    this.idCounter += 1;
    return `m${this.idCounter}`;
  }

  private send(type: string, payload: Record<string, unknown>, withAck = false): void {
    const envelope: Record<string, unknown> = {
      v: PROTOCOL_VERSION,
      type,
      id: this.nextId(),
      payload,
    };
    if (withAck) {
      envelope.ack = useConnectionStore.getState().lastSeq;
    }
    this.socket?.send(JSON.stringify(envelope));
  }

  private open(): void {
    const create = this.opts.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    const socket = create(this.url());
    this.socket = socket;
    this.welcomed = false;
    socket.onopen = () => {
      if (this.socket !== socket) {
        return;
      }
      this.sendHello();
      this.armSilence();
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) {
        this.onData(event.data);
      }
    };
    socket.onerror = () => {
      // `onclose` follows and drives the retry; nothing to log (the URL carries no secrets, the error may).
    };
    socket.onclose = () => {
      if (this.socket === socket) {
        this.onClosed();
      }
    };
  }

  private sendHello(): void {
    const version = usePhoneStore.getState().stateVersion;
    const payload: Record<string, unknown> = {
      role: 'phone',
      token: this.opts.device.deviceToken,
      appVersion: this.opts.appVersion,
    };
    if (version !== null) {
      payload.resume = { lastSeq: useConnectionStore.getState().lastSeq, stateVersion: version };
    }
    this.send('hello', payload);
  }

  private onData(data: unknown): void {
    this.armSilence();
    let json: unknown;
    try {
      json = typeof data === 'string' ? JSON.parse(data) : undefined;
    } catch {
      json = undefined;
    }
    const parsed = parseServerMessage(json);
    if (!parsed.ok) {
      // Never log the payload: it may hold game data.
      console.warn('[ws] ignored an invalid server message');
      return;
    }
    this.handle(parsed.message);
  }

  private handle(message: ServerMessage): void {
    const conn = useConnectionStore.getState();
    if (message.seq !== undefined) {
      conn.noteSeq(message.seq);
    }
    switch (message.type) {
      case 'welcome': {
        const { stateVersion, lastSeq } = message.payload;
        const phone = usePhoneStore.getState();
        // The server went back in time (restart without our state): drop our position.
        if (phone.stateVersion !== null && stateVersion < phone.stateVersion) {
          phone.resetVersion();
          conn.setPosition(lastSeq, stateVersion);
        } else if (lastSeq < conn.lastSeq) {
          conn.setPosition(lastSeq, conn.stateVersion);
        }
        this.welcomed = true;
        this.attempt = 0;
        conn.setError(null);
        conn.setStatus('online');
        this.startPing();
        return;
      }
      case 'view.update': {
        if (
          usePhoneStore.getState().applyUpdate(message.payload.stateVersion, message.payload.view)
        ) {
          useConnectionStore.setState({ stateVersion: message.payload.stateVersion });
        }
        return;
      }
      case 'resync':
        usePhoneStore.getState().resetVersion();
        return;
      case 'event':
        this.opts.onEvent?.(message.payload.event);
        return;
      case 'error':
        this.onServerError(message.payload.code, message.payload.message);
        return;
      case 'qr.result': {
        const { ok, error, clueRef } = message.payload;
        useQrStore.getState().setResult({ ok, error, clueRef });
        return;
      }
      default:
        // pong, peer.status, action.result: nothing to do at this layer.
        return;
    }
  }

  private onServerError(code: ErrorCode, message: string): void {
    const conn = useConnectionStore.getState();
    if (code === 'DEVICE_REVOKED') {
      this.stop();
      conn.setError({ code, message });
      conn.setStatus('unpaired');
      usePhoneStore.getState().clear();
      this.opts.onRevoked();
      return;
    }
    conn.setError({ code, message });
    if (FATAL_CODES.has(code)) {
      this.stop();
      conn.setStatus('offline');
    }
  }

  private onClosed(): void {
    this.clearTimers();
    // A scan in flight loses its answer with the socket: the player rescans.
    useQrStore.getState().reset();
    this.socket = null;
    if (!this.running) {
      return;
    }
    const conn = useConnectionStore.getState();
    this.attempt += 1;
    conn.setStatus(this.attempt >= OFFLINE_AFTER_ATTEMPTS ? 'offline' : 'reconnecting');
    const delay = backoffDelay(this.attempt - 1, this.opts.random ?? Math.random);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running) {
        this.open();
      }
    }, delay);
  }

  private startPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
    }
    this.pingTimer = setInterval(() => {
      if (this.welcomed) {
        this.send('ping', {}, true);
      }
    }, PING_INTERVAL_MS);
  }

  private armSilence(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
    }
    this.silenceTimer = setTimeout(() => {
      const socket = this.socket;
      if (socket) {
        // A dead link may never deliver `onclose`: treat silence as a drop.
        socket.onclose = null;
        socket.close();
        this.onClosed();
      }
    }, SILENCE_TIMEOUT_MS);
  }

  private clearTimers(): void {
    for (const t of [this.retryTimer, this.silenceTimer]) {
      if (t) {
        clearTimeout(t);
      }
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
    }
    this.retryTimer = this.silenceTimer = this.pingTimer = null;
  }

  private teardown(): void {
    this.clearTimers();
    useQrStore.getState().reset();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.close();
    }
  }
}
