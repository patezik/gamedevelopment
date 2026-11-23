import type { PhoneView } from '@hs/protocol';
import type { GameMinutes } from '../common/index.ts';
import { VITALS_THRESHOLDS, type Vitals } from '../survival/index.ts';
import type { Calendar } from '../time/index.ts';
import type { PhoneState } from './state.ts';

/** What the projection needs from survival: vitals and the global static (0 to 100). */
export interface PhoneSurvival {
  readonly vitals: Vitals;
  readonly static: number;
}

export interface PhoneViewContext {
  readonly minute: GameMinutes;
  readonly calendar: Calendar;
}

/** Static at or above this switches the browser off (mobile-app.md section 3). */
export const BROWSER_STATIC_LIMIT = 90;

const clamp = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

/** Glitch grows with lost sanity below the interference threshold and with static. */
export function glitchLevel({ vitals, static: staticLevel }: PhoneSurvival): number {
  const limit = VITALS_THRESHOLDS.phoneInterferenceSanity;
  const sanityPart = vitals.sanity <= limit ? ((limit - vitals.sanity + 1) / (limit + 1)) * 100 : 0;
  return clamp(Math.max(sanityPart, staticLevel));
}

/**
 * Projects the phone for the client. Builds every object field by field, so server-only data
 * (`hallucination`, file passwords, locked content, hidden files) cannot be copied by accident.
 */
export function projectPhoneView(
  s: PhoneState,
  survival: PhoneSurvival,
  context: PhoneViewContext,
): PhoneView {
  const { hh, mm } = context.calendar.toDisplay(context.minute);
  const pad = (n: number) => String(n).padStart(2, '0');
  const staticLevel = clamp(survival.static);
  const threads = s.threads.map((t) => {
    const unread = t.messages.filter((m) => m.from === 'them' && !m.read).length;
    return {
      id: t.id,
      contactId: t.contactId,
      messages: t.messages.map(({ id, from, text, at, read }) => ({ id, from, text, at, read })),
      availableReplies: t.availableReplies.map(({ id, text }) => ({ id, text })),
      unread,
      ...(t.typing && { typing: true }),
    };
  });
  const missed = s.callLog.filter((c) => c.direction === 'missed').length;
  const unreadMessages = threads.reduce((sum, t) => sum + t.unread, 0);
  const call = s.activeCall;
  return {
    status: {
      time: `${pad(hh)}:${pad(mm)}`,
      battery: clamp(s.battery),
      signal: clamp(100 - staticLevel),
    },
    apps: [
      { id: 'camera', badge: 0, enabled: true },
      { id: 'contacts', badge: 0, enabled: true },
      { id: 'calls', badge: missed, enabled: true },
      { id: 'messages', badge: unreadMessages, enabled: true },
      { id: 'gallery', badge: 0, enabled: true },
      { id: 'files', badge: 0, enabled: true },
      { id: 'notes', badge: 0, enabled: true },
      { id: 'maps', badge: 0, enabled: true },
      { id: 'browser', badge: 0, enabled: staticLevel < BROWSER_STATIC_LIMIT },
      { id: 'settings', badge: 0, enabled: true },
    ],
    contacts: s.contacts.map(({ id, name, number, portraitRef }) => ({
      id,
      name,
      number,
      ...(portraitRef !== undefined && { portraitRef }),
    })),
    threads,
    callLog: s.callLog.map(({ id, contactId, direction, at, durationMinutes }) => ({
      id,
      contactId,
      direction,
      at,
      durationMinutes,
    })),
    ...(call && {
      activeCall: {
        callId: call.callId,
        contactId: call.contactId,
        state: call.state,
        lines: call.lines.map(({ speaker, text }) => ({ speaker, text })),
        choices: call.choices.map(({ id, text }) => ({ id, text })),
      },
    }),
    gallery: s.gallery.map(({ id, title, imageRef, takenAt, caption }) => ({
      id,
      title,
      imageRef,
      takenAt,
      ...(caption !== undefined && { caption }),
    })),
    files: s.files
      .filter((f) => !f.hidden)
      .map((f) => ({
        id: f.id,
        name: f.name,
        locked: f.locked,
        ...(f.passwordHint !== undefined && { passwordHint: f.passwordHint }),
        ...(!f.locked && { content: f.content }),
      })),
    notes: s.notes.map(({ id, source, text, at }) => ({ id, source, text, at })),
    mapPins: s.mapPins.map(({ id, locationId, label, seenAt }) => ({
      id,
      locationId,
      label,
      ...(seenAt !== undefined && { seenAt }),
    })),
    browserPages: s.browserPages.map(({ id, title, url, text }) => ({ id, title, url, text })),
    notifications: s.notifications.map(({ id, appId, title, text, at, read }) => ({
      id,
      appId,
      title,
      text,
      at,
      read,
    })),
    effects: {
      glitchLevel: glitchLevel(survival),
      ...(s.wallpaperVariant !== undefined && { wallpaperVariant: s.wallpaperVariant }),
    },
  };
}
