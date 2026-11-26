import { z } from 'zod';

const id = z.string().min(1);
const minutes = z.int().positive();

export const PlayerAction = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('move'), locationId: id }),
  z.strictObject({ type: z.literal('examineLocation') }),
  z.strictObject({ type: z.literal('examineHotspot'), hotspotId: id }),
  z.strictObject({ type: z.literal('talk'), characterId: id, topicId: id }),
  z.strictObject({
    type: z.literal('interrogate'),
    characterId: id,
    subject: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('evidence'), clueId: id }),
      z.strictObject({ type: z.literal('contradiction'), contradictionId: id }),
    ]),
  }),
  z.strictObject({ type: z.literal('read'), documentId: id }),
  z.strictObject({ type: z.literal('useItem'), itemId: id, targetId: id.optional() }),
  z.strictObject({ type: z.literal('pickLock'), targetId: id }),
  z.strictObject({ type: z.literal('rest'), minutes }),
  z.strictObject({ type: z.literal('wait'), minutes }),
  z.strictObject({
    type: z.literal('accuse'),
    caseFile: z.strictObject({
      accusedIds: z.array(id).min(1),
      motive: id.optional(),
      means: id.optional(),
      opportunity: id.optional(),
      evidence: z.array(id),
    }),
    confirm: z.boolean(),
    /** Stable ID of an irreversible accusation; the gateway requires it with `confirm: true` (ADR 0022). */
    operationId: id.optional(),
  }),
  z.strictObject({
    type: z.literal('markSuspicion'),
    characterId: id,
    level: z.int().nonnegative(),
    note: z.string().optional(),
  }),
  z.strictObject({ type: z.literal('call'), contactId: id }),
  z.strictObject({ type: z.literal('answerCall'), callId: id }),
  z.strictObject({ type: z.literal('callChoice'), choiceId: id }),
  z.strictObject({ type: z.literal('message'), contactId: id, templateId: id }),
  z.strictObject({ type: z.literal('browse'), pageId: id }),
  z.strictObject({ type: z.literal('openFile'), fileId: id }),
  z.strictObject({ type: z.literal('unlockFile'), fileId: id, password: z.string() }),
  z.strictObject({ type: z.literal('addNote'), text: z.string().min(1) }),
  z.strictObject({ type: z.literal('captureEvidence'), tokenId: id }),
]);
export type PlayerAction = z.infer<typeof PlayerAction>;

/** Capture is dispatched by the server after validating qr.scan. */
export const ACTIONS_BY_ROLE = {
  desktop: [
    'move',
    'examineLocation',
    'examineHotspot',
    'talk',
    'interrogate',
    'read',
    'useItem',
    'pickLock',
    'rest',
    'wait',
    'accuse',
    'markSuspicion',
  ],
  phone: [
    'call',
    'answerCall',
    'callChoice',
    'message',
    'browse',
    'openFile',
    'unlockFile',
    'addNote',
  ],
} as const satisfies Record<'desktop' | 'phone', readonly PlayerAction['type'][]>;
