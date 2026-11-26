import { z } from 'zod';
import {
  ClientEvent,
  ClientMessage,
  CreateSessionRequest,
  Envelope,
  ErrorCode,
  ErrorResponse,
  HealthResponse,
  NetworkResponse,
  PairRequest,
  PairResponse,
  PairingInfo,
  QrMatrixResponse,
  SaveList,
  ScenarioList,
  SessionCredentials,
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
  'rest-error-response.json': ErrorResponse,
  'rest-health-response.json': HealthResponse,
  'rest-network-response.json': NetworkResponse,
  'rest-scenario-list.json': ScenarioList,
  'rest-create-session-request.json': CreateSessionRequest,
  'rest-session-credentials.json': SessionCredentials,
  'rest-pairing-info.json': PairingInfo,
  'rest-qr-matrix-response.json': QrMatrixResponse,
  'rest-pair-request.json': PairRequest,
  'rest-pair-response.json': PairResponse,
  'rest-save-list.json': SaveList,
} as const;

/** Deterministic JSON Schema text per file name. */
export function renderSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [file, schema] of Object.entries(SCHEMAS)) {
    out[file] = `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`;
  }
  return out;
}
