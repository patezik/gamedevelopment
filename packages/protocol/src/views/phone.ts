import { z } from 'zod';
import { clockTime, duration, id, minutes, percent, speaker, text } from './common.ts';

export const ContactView = z.strictObject({
  id,
  /** An unknown caller shows its number here, as a real phone would. */
  name: text,
  number: text,
  portraitRef: text.optional(),
});
export type ContactView = z.infer<typeof ContactView>;

export const MessageView = z.strictObject({
  id,
  from: z.enum(['me', 'them']),
  text,
  at: minutes,
  read: z.boolean(),
});
export type MessageView = z.infer<typeof MessageView>;

export const ThreadView = z.strictObject({
  id,
  contactId: id,
  messages: z.array(MessageView),
  /** Template replies the player may send; sending one is the `message` action. */
  availableReplies: z.array(z.strictObject({ id, text })),
  unread: duration,
  /** Set while the other side is "typing" (the server simulates a delayed reply). */
  typing: z.boolean().optional(),
});
export type ThreadView = z.infer<typeof ThreadView>;

export const CallLogEntryView = z.strictObject({
  id,
  contactId: id,
  direction: z.enum(['incoming', 'outgoing', 'missed']),
  at: minutes,
  durationMinutes: duration,
});
export type CallLogEntryView = z.infer<typeof CallLogEntryView>;

export const ActiveCallView = z.strictObject({
  callId: id,
  contactId: id,
  state: z.enum(['ringing', 'active']),
  lines: z.array(z.strictObject({ speaker, text })),
  /** Replies the player can pick now; sending one is the `callChoice` action. */
  choices: z.array(z.strictObject({ id, text })),
});
export type ActiveCallView = z.infer<typeof ActiveCallView>;

/**
 * Every gallery item has the same shape whatever its origin: a photo that is not evidence must
 * not be distinguishable by its fields (survival-horror.md section 5).
 */
export const GalleryItemView = z.strictObject({
  id,
  title: text,
  imageRef: text,
  takenAt: minutes,
  caption: text.optional(),
});
export type GalleryItemView = z.infer<typeof GalleryItemView>;

/** A locked file carries no `content` until `unlockFile` succeeds, so it cannot leak by mistake. */
export const FileView = z
  .strictObject({
    id,
    name: text,
    locked: z.boolean(),
    passwordHint: text.optional(),
    content: text.optional(),
  })
  .refine(({ locked, content }) => !locked || content === undefined, {
    message: 'a locked file must not include its content',
  });
export type FileView = z.infer<typeof FileView>;

export const NoteView = z.strictObject({
  id,
  source: z.enum(['auto', 'player']),
  text,
  at: minutes,
});
export type NoteView = z.infer<typeof NoteView>;

export const MapPinView = z.strictObject({
  id,
  locationId: id,
  label: text,
  /** When a character was last seen here, from the player's own observations. */
  seenAt: minutes.optional(),
});
export type MapPinView = z.infer<typeof MapPinView>;

export const BrowserPageView = z.strictObject({ id, title: text, url: text, text });
export type BrowserPageView = z.infer<typeof BrowserPageView>;

export const NotificationView = z.strictObject({
  id,
  appId: id,
  title: text,
  text,
  at: minutes,
  read: z.boolean(),
});
export type NotificationView = z.infer<typeof NotificationView>;

export const PhoneView = z.strictObject({
  status: z.strictObject({
    time: clockTime,
    battery: percent,
    /** 0-100; falls as the global static rises. */
    signal: percent,
  }),
  apps: z.array(z.strictObject({ id, badge: duration, enabled: z.boolean() })),
  contacts: z.array(ContactView),
  threads: z.array(ThreadView),
  callLog: z.array(CallLogEntryView),
  activeCall: ActiveCallView.optional(),
  gallery: z.array(GalleryItemView),
  files: z.array(FileView),
  notes: z.array(NoteView),
  mapPins: z.array(MapPinView),
  browserPages: z.array(BrowserPageView),
  notifications: z.array(NotificationView),
  effects: z.strictObject({
    /** 0-100; drives interface distortion (low sanity, high static). */
    glitchLevel: percent,
    wallpaperVariant: text.optional(),
  }),
});
export type PhoneView = z.infer<typeof PhoneView>;
