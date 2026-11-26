import { z } from 'zod';
import { Envelope } from '../envelope.ts';
import { ErrorCode } from '../errors.ts';
import { PhoneView, PlayerView } from '../views/index.ts';
import { PlayerAction } from './actions.ts';

export { ACTIONS_BY_ROLE, PlayerAction } from './actions.ts';

const role = z.enum(['desktop', 'phone']);
const id = z.string().min(1);
const counter = z.int().nonnegative();
const version = z.int().positive();
const empty = z.strictObject({});

const clientEnvelope = Envelope.omit({ seq: true });
const serverEnvelope = Envelope.omit({ ack: true });

export const ClientMessage = z.discriminatedUnion('type', [
  clientEnvelope.extend({
    type: z.literal('hello'),
    payload: z.strictObject({
      role,
      token: id,
      appVersion: id,
      resume: z.strictObject({ lastSeq: counter, stateVersion: counter }).optional(),
    }),
  }),
  clientEnvelope.extend({ type: z.literal('ping'), payload: empty }),
  clientEnvelope.extend({
    type: z.literal('action.request'),
    payload: z.strictObject({ action: PlayerAction }),
  }),
  clientEnvelope.extend({
    type: z.literal('qr.scan'),
    payload: z.strictObject({ raw: id }),
  }),
  clientEnvelope.extend({
    type: z.literal('phone.ui'),
    payload: z.strictObject({ kind: z.enum(['appOpened', 'notificationRead']), ref: id }),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ClientEvent = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('notification'), notificationId: id }),
  z.strictObject({ type: z.literal('incomingCall'), callId: id }),
  z.strictObject({
    type: z.literal('scanResult'),
    ok: z.boolean(),
    clueRef: id.optional(),
    error: ErrorCode.optional(),
  }),
  z.strictObject({ type: z.literal('gameOver') }),
]);
export type ClientEvent = z.infer<typeof ClientEvent>;

export const ServerMessage = z.discriminatedUnion('type', [
  serverEnvelope.extend({
    type: z.literal('welcome'),
    payload: z.strictObject({
      sessionId: id,
      role,
      protocolVersion: version,
      serverVersion: id,
      stateVersion: counter,
      lastSeq: counter,
    }),
  }),
  serverEnvelope.extend({ type: z.literal('pong'), payload: empty }),
  serverEnvelope.extend({
    type: z.literal('view.update'),
    // The desktop connection receives a PlayerView and the phone a PhoneView.
    payload: z.strictObject({ stateVersion: counter, view: z.union([PlayerView, PhoneView]) }),
  }),
  serverEnvelope.extend({
    type: z.literal('event'),
    payload: z.strictObject({ event: ClientEvent }),
  }),
  serverEnvelope.extend({
    type: z.literal('action.result'),
    payload: z.strictObject({
      requestId: id,
      ok: z.boolean(),
      error: ErrorCode.optional(),
      minutesSpent: counter,
      interrupted: z.boolean().optional(),
      /** Echo of `accuse.operationId`; with it the result may be a stored replay (ADR 0022). */
      operationId: id.optional(),
      /** `stateVersion` produced by the executed operation; only with `operationId`, only if `ok`. */
      stateVersion: version.optional(),
    }),
  }),
  serverEnvelope.extend({
    type: z.literal('qr.result'),
    payload: z.strictObject({
      ok: z.boolean(),
      error: ErrorCode.optional(),
      clueRef: id.optional(),
    }),
  }),
  serverEnvelope.extend({
    type: z.literal('resync'),
    payload: z.strictObject({ reason: id }),
  }),
  serverEnvelope.extend({
    type: z.literal('error'),
    payload: z.strictObject({ code: ErrorCode, message: id, requestId: id.optional() }),
  }),
  serverEnvelope.extend({
    type: z.literal('peer.status'),
    payload: z.strictObject({
      desktop: z.enum(['online', 'offline']),
      phone: z.enum(['online', 'offline', 'unpaired']),
    }),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

type ParseResult<T> = { ok: true; message: T } | { ok: false; error: 'INVALID_MESSAGE' };

export function parseClientMessage(input: unknown): ParseResult<ClientMessage> {
  const result = ClientMessage.safeParse(input);
  return result.success
    ? { ok: true, message: result.data }
    : { ok: false, error: 'INVALID_MESSAGE' };
}

export function parseServerMessage(input: unknown): ParseResult<ServerMessage> {
  const result = ServerMessage.safeParse(input);
  return result.success
    ? { ok: true, message: result.data }
    : { ok: false, error: 'INVALID_MESSAGE' };
}
