import { z } from 'zod';
import { PlayerAction } from '../messages/actions.ts';
import {
  clockTime,
  clueKind,
  costPreview,
  dayPeriod,
  duration,
  id,
  minutes,
  percent,
  speaker,
  text,
} from './common.ts';

const lighting = z.enum(['bright', 'dim', 'dark']);

/** A point of interest. `examined` is the player's own history, never whether it hides a clue. */
export const HotspotView = z.strictObject({ id, name: text, examined: z.boolean() });
export type HotspotView = z.infer<typeof HotspotView>;

export const ExitView = z.strictObject({
  locationId: id,
  name: text,
  /** Estimated travel time in minutes. */
  minutes: duration,
  blockedReason: text.optional(),
});
export type ExitView = z.infer<typeof ExitView>;

export const CharacterView = z.strictObject({
  id,
  name: text,
  portraitRef: text,
  /** Visible bearing ("nervous", "calm"): what the player can see, not what the character knows. */
  demeanor: text,
});
export type CharacterView = z.infer<typeof CharacterView>;

export const ItemView = z.strictObject({ id, name: text, description: text });
export type ItemView = z.infer<typeof ItemView>;

export const ClueView = z.strictObject({
  id,
  title: text,
  description: text,
  kind: clueKind,
  discoveredAt: minutes,
  locationId: id,
  /** True once the clue is fixed with the phone camera (`captureMode: "qr"` clues). */
  captured: z.boolean(),
});
export type ClueView = z.infer<typeof ClueView>;

export const StatementView = z.strictObject({
  id,
  characterId: id,
  topicId: id,
  text,
  heardAt: minutes,
});
export type StatementView = z.infer<typeof StatementView>;

/** Shown only once the player holds both sides (investigation-model.md section 4). */
export const ContradictionView = z.strictObject({
  id,
  statementId: id,
  /** The clue or statement that disproves it. */
  againstId: id,
  summary: text,
});
export type ContradictionView = z.infer<typeof ContradictionView>;

/** A hint derived from what the player found; not an accusation. */
export const PersonOfInterestView = z.strictObject({
  characterId: id,
  name: text,
  linkedClueIds: z.array(id),
});
export type PersonOfInterestView = z.infer<typeof PersonOfInterestView>;

export const SuspicionView = z.strictObject({
  characterId: id,
  level: z.enum(['none', 'possible', 'prime']),
  note: text.optional(),
});
export type SuspicionView = z.infer<typeof SuspicionView>;

export const TimelineEntryView = z.strictObject({
  id,
  from: minutes,
  to: minutes.optional(),
  text,
  sourceIds: z.array(id),
});
export type TimelineEntryView = z.infer<typeof TimelineEntryView>;

export const CaseBoardView = z.strictObject({
  clues: z.array(ClueView),
  statements: z.array(StatementView),
  contradictions: z.array(ContradictionView),
  personsOfInterest: z.array(PersonOfInterestView),
  suspicions: z.array(SuspicionView),
  timeline: z.array(TimelineEntryView),
});
export type CaseBoardView = z.infer<typeof CaseBoardView>;

export const DialogueView = z.strictObject({
  characterId: id,
  characterName: text,
  topics: z.array(z.strictObject({ id, label: text, costPreview })),
  /** What can be shown to the character: clues and contradictions the player holds. */
  presentable: z.array(
    z.strictObject({ type: z.enum(['evidence', 'contradiction']), id, label: text }),
  ),
  history: z.array(z.strictObject({ speaker, text, at: minutes })),
});
export type DialogueView = z.infer<typeof DialogueView>;

export const ENDING_IDS = [
  'solved',
  'partial',
  'wrong_accusation',
  'time_up',
  'death',
  'madness',
] as const;

/**
 * Shown only when the game is over. `recap` is the one place where the solution is revealed
 * (ENG-006); it is named neutrally so no forbidden key appears in any view.
 */
export const EndingView = z.strictObject({
  endingId: z.enum(ENDING_IDS),
  title: text,
  text,
  /** Which parts of the case the attached evidence proved. */
  proven: z
    .strictObject({ motive: z.boolean(), means: z.boolean(), opportunity: z.boolean() })
    .optional(),
  recap: z
    .strictObject({
      summary: text,
      responsible: z.array(z.strictObject({ id, name: text })),
    })
    .optional(),
});
export type EndingView = z.infer<typeof EndingView>;

export const PlayerView = z.strictObject({
  clock: z.strictObject({
    t: minutes,
    day: z.int(),
    time: clockTime,
    period: dayPeriod,
    remainingMinutes: duration,
  }),
  location: z.strictObject({
    id,
    name: text,
    description: text,
    lighting,
    hotspots: z.array(HotspotView),
    exits: z.array(ExitView),
  }),
  presentCharacters: z.array(CharacterView),
  availableActions: z.array(
    z.strictObject({
      action: PlayerAction,
      label: text,
      costPreview,
      blockedReason: text.optional(),
    }),
  ),
  vitals: z.strictObject({
    /** 0-10; at 0 the game ends. */
    health: z.int().min(0).max(10),
    /** 0-10; at 0 the game ends. */
    sanity: z.int().min(0).max(10),
    /** 0-100. */
    fatigue: percent,
  }),
  /** The global "static" signal, 0-100. */
  static: percent,
  inventory: z.array(ItemView),
  caseBoard: CaseBoardView,
  pendingCapture: z
    .strictObject({ tokenId: id, clueTitle: text, expiresInMinutes: duration })
    .optional(),
  interaction: DialogueView.optional(),
  phone: z.strictObject({ paired: z.boolean(), online: z.boolean(), battery: percent }),
  ending: EndingView.optional(),
});
export type PlayerView = z.infer<typeof PlayerView>;
