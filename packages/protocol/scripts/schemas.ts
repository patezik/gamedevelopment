import { z } from 'zod';
import {
  ClientEvent,
  ClientMessage,
  Envelope,
  ErrorCode,
  PhoneView,
  PlayerAction,
  PlayerView,
  ServerMessage,
} from '../src/index.ts';

/** File name -> schema. Add new exported schemas here. */
const SCHEMAS = {
  'envelope.json': Envelope,
  'error-code.json': ErrorCode,
  'client-event.json': ClientEvent,
  'client-message.json': ClientMessage,
  'player-action.json': PlayerAction,
  'player-view.json': PlayerView,
  'phone-view.json': PhoneView,
  'server-message.json': ServerMessage,
} as const;

/** Deterministic JSON Schema text per file name. */
export function renderSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [file, schema] of Object.entries(SCHEMAS)) {
    out[file] = `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`;
  }
  return out;
}
