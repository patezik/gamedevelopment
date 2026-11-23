import websocket from '@fastify/websocket';
import {
  ACTIONS_BY_ROLE,
  ClientEvent,
  Envelope,
  PhoneView,
  PlayerView,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from '@hs/protocol';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
import { hashSessionToken } from '../pairing/index.ts';
import type { Session, SessionManager, SessionRole } from '../sessions/index.ts';

type Message<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
type Hello = Extract<ClientMessage, { type: 'hello' }>;
type Replayable = Message<'event' | 'view.update'>;
type View = PlayerView | PhoneView;
type GatewayInput = Extract<ClientMessage, { type: 'qr.scan' | 'phone.ui' }>;
type QrResult = Message<'qr.result'>['payload'];
type Outgoing<T = ServerMessage> = T extends ServerMessage
  ? Omit<T, 'id'> & { id?: string }
  : never;

interface Peer {
  socket: WebSocket;
  session: Session;
  role: SessionRole;
  hash: string;
  sentSeq: number;
  ack: number;
}

interface Stream {
  seq: number;
  peers: Map<SessionRole, Peer>;
  history: { role: SessionRole; message: Replayable }[];
  floor: Record<SessionRole, number>;
}

export interface GatewayOptions {
  sessions?: Pick<SessionManager, 'findByTokenHash'>;
  serverVersion: string;
  snapshot?: (session: Session, role: SessionRole) => View | undefined;
  qrScan?: (session: Session, raw: string) => QrResult | Promise<QrResult>;
  helloMs?: number;
  heartbeatMs?: number;
  replayLimit?: number;
}

const limit = 256 * 1024;

export class SessionGateway {
  readonly #streams = new WeakMap<Session, Stream>();
  readonly #options: GatewayOptions;

  constructor(options: GatewayOptions) {
    this.#options = options;
    for (const value of [options.helloMs, options.heartbeatMs, options.replayLimit]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new RangeError('Gateway limits must be positive integers');
      }
    }
  }

  #stream(session: Session): Stream {
    const existing = this.#streams.get(session);
    if (existing) return existing;
    const stream: Stream = {
      seq: 0,
      peers: new Map(),
      history: [],
      floor: { desktop: 0, phone: 0 },
    };
    this.#streams.set(session, stream);
    return stream;
  }

  #send(socket: WebSocket, message: Outgoing): void {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > limit) {
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify({ ...message, id: message.id ?? randomUUID() }));
  }

  #error(socket: WebSocket, code: ErrorCode, requestId?: string): void {
    this.#send(socket, {
      v: PROTOCOL_VERSION,
      type: 'error',
      payload: { code, message: code, ...(requestId && { requestId }) },
    });
  }

  #authorized(peer: Peer): boolean {
    return peer.session.tokenHash(peer.role) === peer.hash;
  }

  #deliver(peer: Peer, message: Replayable): void {
    if (!this.#authorized(peer)) return;
    peer.sentSeq = Math.max(peer.sentSeq, message.seq ?? 0);
    this.#send(peer.socket, message);
  }

  #publish(
    session: Session,
    role: SessionRole,
    input:
      Pick<Message<'event'>, 'type' | 'payload'> | Pick<Message<'view.update'>, 'type' | 'payload'>,
  ): void {
    const stream = this.#stream(session);
    const message: Replayable = {
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      seq: stream.seq + 1,
      ...input,
    };
    if (Buffer.byteLength(JSON.stringify(message)) > limit) {
      throw new RangeError('Gateway message exceeds 256 KiB');
    }
    stream.seq++;
    stream.history.push({ role, message });
    if (stream.history.length > (this.#options.replayLimit ?? 200)) {
      const evicted = stream.history.shift()!;
      stream.floor[evicted.role] = evicted.message.seq!;
    }
    const peer = stream.peers.get(role);
    if (peer) this.#deliver(peer, message);
  }

  publishEvent(session: Session, role: SessionRole, event: ClientEvent): void {
    this.#publish(session, role, { type: 'event', payload: { event: ClientEvent.parse(event) } });
  }

  publishView(session: Session, role: SessionRole, view: View): void {
    const schema = role === 'desktop' ? PlayerView : PhoneView;
    this.#publish(session, role, {
      type: 'view.update',
      payload: {
        stateVersion: session.stateVersion,
        view: schema.parse(view),
      },
    });
  }

  #peerStatus(session: Session): void {
    const { peers } = this.#stream(session);
    const online = (role: SessionRole) => {
      const peer = peers.get(role);
      return (
        peer !== undefined && this.#authorized(peer) && peer.socket.readyState === peer.socket.OPEN
      );
    };
    const payload: Message<'peer.status'>['payload'] = {
      desktop: online('desktop') ? 'online' : 'offline',
      phone: online('phone') ? 'online' : session.tokenHash('phone') ? 'offline' : 'unpaired',
    };
    for (const peer of peers.values()) {
      if (this.#authorized(peer))
        this.#send(peer.socket, { v: PROTOCOL_VERSION, type: 'peer.status', payload });
    }
  }

  revokePhone(session: Session): void {
    const peer = this.#stream(session).peers.get('phone');
    if (!peer) {
      this.#peerStatus(session);
      return;
    }
    this.#error(peer.socket, 'DEVICE_REVOKED');
    peer.socket.close(1008, 'DEVICE_REVOKED');
  }

  #welcome(peer: Peer, resume: Hello['payload']['resume']): void {
    const { session, role } = peer;
    const stream = this.#stream(session);
    peer.sentSeq = stream.seq;
    this.#send(peer.socket, {
      v: PROTOCOL_VERSION,
      type: 'welcome',
      payload: {
        sessionId: session.id,
        role,
        protocolVersion: PROTOCOL_VERSION,
        serverVersion: this.#options.serverVersion,
        stateVersion: session.stateVersion,
        lastSeq: stream.seq,
      },
    });
    if (resume) {
      const replay = stream.history.filter(
        (entry) => entry.role === role && entry.message.seq! > resume.lastSeq,
      );
      const hasLatestView = replay.some(
        ({ message }) =>
          message.type === 'view.update' && message.payload.stateVersion === session.stateVersion,
      );
      if (
        resume.lastSeq >= stream.floor[role] &&
        resume.lastSeq <= stream.seq &&
        (resume.stateVersion === session.stateVersion ||
          (resume.stateVersion < session.stateVersion && hasLatestView))
      ) {
        peer.ack = resume.lastSeq;
        for (const { message } of replay) this.#deliver(peer, message);
        return;
      }
      this.#send(peer.socket, {
        v: PROTOCOL_VERSION,
        type: 'resync',
        payload: { reason: 'resume_unavailable' },
      });
    }
    const view = this.#options.snapshot?.(session, role);
    if (view) this.publishView(session, role, view);
  }

  async #message(peer: Peer, message: Exclude<ClientMessage, Hello>): Promise<void> {
    const { session, role, socket } = peer;
    switch (message.type) {
      case 'ping':
        this.#send(socket, { v: PROTOCOL_VERSION, type: 'pong', payload: {} });
        return;
      case 'action.request': {
        const { action } = message.payload;
        const allowed: readonly string[] = ACTIONS_BY_ROLE[role];
        const result = allowed.includes(action.type)
          ? await session.dispatch(role, action)
          : { ok: false, error: 'ACTION_INVALID' as const, minutesSpent: 0 };
        if (this.#authorized(peer)) {
          this.#send(socket, {
            v: PROTOCOL_VERSION,
            type: 'action.result',
            payload: {
              requestId: message.id,
              ok: result.ok,
              minutesSpent: result.minutesSpent,
              ...(result.error && { error: result.error }),
            },
          });
        }
        if ('outcome' in result && result.outcome) {
          for (const target of ['desktop', 'phone'] as const) {
            this.publishEvent(session, target, { type: 'gameOver' });
          }
        }
        return;
      }
      case 'qr.scan':
      case 'phone.ui':
        await this.#phoneMessage(peer, message);
    }
  }

  async #phoneMessage(peer: Peer, message: GatewayInput): Promise<void> {
    if (peer.role !== 'phone') {
      this.#error(peer.socket, 'ACTION_INVALID', message.id);
    } else if (message.type === 'qr.scan') {
      const payload = await this.#options.qrScan?.(peer.session, message.payload.raw);
      if (!this.#authorized(peer)) return;
      this.#send(peer.socket, {
        v: PROTOCOL_VERSION,
        type: 'qr.result',
        payload: payload ?? { ok: false, error: 'QR_PRECONDITION_FAILED' },
      });
    }
  }

  connect(socket: WebSocket): void {
    let peer: Peer | undefined;
    let closed = false;
    let pending = 0;
    let queue = Promise.resolve();
    const close = (code: number, reason: string) => {
      closed = true;
      socket.close(code, reason);
    };
    let timer = setTimeout(() => close(1008, 'HELLO_TIMEOUT'), this.#options.helloMs ?? 5000);
    const heartbeat = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => close(1008, 'HEARTBEAT_TIMEOUT'),
        this.#options.heartbeatMs ?? 30_000,
      );
    };
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clearTimeout(timer);
      closed = true;
      if (!peer) return;
      const { session, role } = peer;
      const { peers } = this.#stream(session);
      if (peers.get(role) !== peer) return;
      peers.delete(role);
      void session.setConnected(role, false);
      this.#peerStatus(session);
    });
    socket.on('message', (data: RawData, binary: boolean) => {
      if (closed) return;
      if (++pending > 32) {
        close(1008, 'RATE_LIMITED');
        return;
      }
      queue = queue
        .then(async () => {
          if (closed) return;
          let json: unknown;
          try {
            if (!binary && Buffer.isBuffer(data)) json = JSON.parse(data.toString('utf8'));
          } catch {
            /* Invalid JSON. */
          }
          const envelope = Envelope.safeParse(json);
          if (!envelope.success) {
            this.#error(socket, 'INVALID_MESSAGE');
            return;
          }
          if (envelope.data.v !== PROTOCOL_VERSION) {
            this.#error(socket, 'PROTOCOL_MISMATCH', envelope.data.id);
            close(1008, 'PROTOCOL_MISMATCH');
            return;
          }
          const parsed = parseClientMessage(json);
          if (!parsed.ok) {
            this.#error(socket, parsed.error, envelope.data.id);
            return;
          }
          const message = parsed.message;
          if (!peer) {
            if (message.type !== 'hello') {
              this.#error(socket, 'UNAUTHORIZED', message.id);
              close(1008, 'HELLO_REQUIRED');
              return;
            }
            const hash = hashSessionToken(message.payload.token);
            const auth = this.#options.sessions?.findByTokenHash(hash);
            if (!auth || auth.role !== message.payload.role) {
              this.#error(socket, 'UNAUTHORIZED', message.id);
              close(1008, 'UNAUTHORIZED');
              return;
            }
            const status = await auth.session.refreshLifetime();
            if (closed) return;
            if (status === 'disposed' || status === 'faulted') {
              this.#error(socket, 'SESSION_CLOSED', message.id);
              close(1008, 'SESSION_CLOSED');
              return;
            }
            if (auth.session.tokenHash(auth.role) !== hash) {
              this.#error(socket, 'UNAUTHORIZED', message.id);
              close(1008, 'UNAUTHORIZED');
              return;
            }
            const { peers } = this.#stream(auth.session);
            const previous = peers.get(auth.role);
            peer = { ...auth, socket, hash, ack: 0, sentSeq: 0 };
            peers.set(auth.role, peer);
            previous?.socket.close(1000, 'REPLACED');
            heartbeat();
            void auth.session.setConnected(auth.role, true);
            this.#welcome(peer, message.payload.resume);
            this.#peerStatus(auth.session);
            return;
          }
          if (!this.#authorized(peer) || this.#stream(peer.session).peers.get(peer.role) !== peer) {
            this.#error(socket, 'DEVICE_REVOKED', message.id);
            close(1008, 'DEVICE_REVOKED');
            return;
          }
          const ack = message.ack ?? peer.ack;
          if (message.type === 'hello' || ack > peer.sentSeq) {
            this.#error(socket, 'INVALID_MESSAGE', message.id);
            return;
          }
          peer.ack = Math.max(peer.ack, ack);
          heartbeat();
          await this.#message(peer, message);
        })
        .catch(() => {
          this.#error(socket, 'INTERNAL');
          close(1011, 'INTERNAL');
        })
        .finally(() => {
          pending--;
        });
    });
  }
}

export function registerGateway(app: FastifyInstance, gateway: SessionGateway): void {
  void app.register(websocket, { options: { maxPayload: limit, perMessageDeflate: false } });
  void app.register((routes, _options, done) => {
    routes.get(
      '/ws',
      {
        websocket: true,
        preValidation(request, reply, next) {
          if (request.url.includes('?')) {
            void reply.code(400).send();
            return;
          }
          next();
        },
      },
      (socket) => gateway.connect(socket),
    );
    done();
  });
}
