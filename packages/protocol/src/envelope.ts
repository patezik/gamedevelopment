import { z } from 'zod';

/**
 * Message envelope: `{ v, type, id, seq?, ack?, payload }`.
 * `v` is not pinned to PROTOCOL_VERSION here: a peer of another version must still parse so the
 * server can answer PROTOCOL_MISMATCH. The payload shape is defined per `type` (PROTO-001).
 */
export const Envelope = z.strictObject({
  v: z.int().positive(),
  type: z.string().min(1),
  id: z.string().min(1),
  /** Server -> client: monotonic session event number. */
  seq: z.int().nonnegative().optional(),
  /** Client -> server: last processed `seq`. */
  ack: z.int().nonnegative().optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type Envelope = z.infer<typeof Envelope>;
