import { z } from 'zod';

/** Full list from docs/backend/protocol.md section 5. */
export const ERROR_CODES = [
  'INVALID_MESSAGE',
  'UNAUTHORIZED',
  'PROTOCOL_MISMATCH',
  'SESSION_NOT_FOUND',
  'SESSION_CLOSED',
  'SCENARIO_NOT_FOUND',
  'PAIRING_CODE_INVALID',
  'PAIRING_CODE_EXPIRED',
  'PAIRING_RATE_LIMITED',
  'DEVICE_REVOKED',
  'ACTION_INVALID',
  'ACTION_NOT_AVAILABLE',
  'ACTION_BLOCKED',
  'GAME_OVER',
  'QR_INVALID',
  'QR_WRONG_SESSION',
  'QR_EXPIRED',
  'QR_ALREADY_USED',
  'QR_PRECONDITION_FAILED',
  'SAVE_NOT_FOUND',
  'SAVE_DESYNC',
  'GENERATION_UNSOLVABLE',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;
