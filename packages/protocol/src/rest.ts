import { z } from 'zod';
import { ErrorCode } from './errors.ts';

/**
 * REST schemas of the game routes under `/api/v1` (backend.md section 3). Server routes and clients
 * check requests and answers with these; bodies carry no truth of the case.
 */

/** Scenario identifier: the same rule for the list and for `POST /sessions`. */
export const ScenarioId = z.string().min(1).max(64);

/**
 * A seed the client may choose: printable, bounded, safe in logs and file names. `#` is left out
 * on purpose: the generator names its attempts `<seed>#<n>`.
 */
export const Seed = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const pairingCode = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{6}$/);

/** Error answer of every REST endpoint; `atAction` accompanies `SAVE_DESYNC` only. */
export const ErrorResponse = z.strictObject({
  error: z.strictObject({
    code: ErrorCode,
    message: z.string(),
    atAction: z.int().nonnegative().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

/** `GET /health`. */
export const HealthResponse = z.strictObject({
  status: z.literal('ok'),
  version: z.string().min(1),
  protocolVersion: z.int().positive(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** `GET /network`: LAN addresses for the pairing QR, best first. */
export const NetworkResponse = z.strictObject({
  candidates: z.array(
    z.strictObject({
      address: z.string().min(1),
      interface: z.string().min(1),
      recommended: z.boolean(),
      virtual: z.boolean(),
    }),
  ),
});
export type NetworkResponse = z.infer<typeof NetworkResponse>;

/** One scenario of `GET /scenarios`. */
export const ScenarioSummary = z.strictObject({
  id: ScenarioId,
  title: z.string().min(1),
  durationMinutes: z.int().positive(),
});
export type ScenarioSummary = z.infer<typeof ScenarioSummary>;

/** `GET /scenarios` answer. */
export const ScenarioList = z.array(ScenarioSummary);
export type ScenarioList = z.infer<typeof ScenarioList>;

/** `POST /sessions` body. */
export const CreateSessionRequest = z.strictObject({
  scenarioId: ScenarioId,
  seed: Seed.optional(),
  locale: z.enum(['ru', 'en']).optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

/** A pairing code with its QR text; `expiresAt` is Unix time in milliseconds. */
export const PairingInfo = z.strictObject({
  code: pairingCode,
  expiresAt: z.int().positive(),
  qrPayload: z.string().regex(/^hs1:pair:[^:]+:[0-9]{1,5}:[0-9A-HJKMNP-TV-Z]{6}$/),
});
export type PairingInfo = z.infer<typeof PairingInfo>;

/** `POST /sessions` answer (201) and `POST /saves/:saveId/load` answer: what the desktop needs to start and pair. */
export const SessionCredentials = z.strictObject({
  sessionId: z.uuid(),
  desktopToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  pairing: PairingInfo,
});
export type SessionCredentials = z.infer<typeof SessionCredentials>;

/** `POST /sessions/:id/pairing-code` answer: a fresh code. */
export const PairingCodeResponse = PairingInfo;

/** `GET /sessions/:id/pairing-qr` and `GET /sessions/:id/evidence-qr/:tokenId`: `size * size` characters `0`/`1`, row by row. */
export const QrMatrixResponse = z
  .strictObject({
    size: z.int().positive(),
    modules: z.string().regex(/^[01]+$/),
  })
  .refine(({ size, modules }) => modules.length === size * size, {
    path: ['modules'],
    message: 'modules must hold size * size characters',
  });
export type QrMatrixResponse = z.infer<typeof QrMatrixResponse>;

/** `POST /pair` body (the phone). */
export const PairRequest = z.object({
  code: pairingCode,
  deviceName: z.string().trim().min(1).max(128),
  appVersion: z.string().min(1).max(64),
  protocolVersion: z.int().positive(),
});
export type PairRequest = z.infer<typeof PairRequest>;

/** `POST /pair` answer. */
export const PairResponse = z.strictObject({
  sessionId: z.string().min(1),
  deviceToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  wsPath: z.string().startsWith('/'),
});
export type PairResponse = z.infer<typeof PairResponse>;

/** One entry of `GET /saves`. `gameTime` is elapsed game minutes, `null` if the metadata was lost. */
export const SaveSummary = z.strictObject({
  saveId: z.string().min(1),
  scenarioId: ScenarioId,
  updatedAt: z.iso.datetime(),
  gameTime: z.int().nonnegative().nullable(),
});
export type SaveSummary = z.infer<typeof SaveSummary>;

/** `GET /saves` answer, newest first. */
export const SaveList = z.array(SaveSummary);
export type SaveList = z.infer<typeof SaveList>;
