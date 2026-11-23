import type { GameMinutes } from '../common/index.ts';
import type {
  PhoneActiveCall,
  PhoneBrowserPage,
  PhoneCallLogEntry,
  PhoneContact,
  PhoneFile,
  PhoneGalleryItem,
  PhoneMapPin,
  PhoneMessage,
  PhoneNote,
  PhoneNotification,
  PhoneState,
  PhoneThread,
} from './state.ts';

/** Domain events that change the phone. Other events are ignored by `reducePhone`. */
export type PhoneEvent =
  | { readonly type: 'ContactAdded'; readonly contact: PhoneContact }
  | { readonly type: 'ContactChanged'; readonly contact: PhoneContact }
  | {
      readonly type: 'MessageReceived';
      readonly thread: Pick<PhoneThread, 'id' | 'contactId'> &
        Partial<Pick<PhoneThread, 'availableReplies'>>;
      readonly message: Omit<PhoneMessage, 'from' | 'read'>;
    }
  | {
      readonly type: 'MessageSent';
      readonly threadId: string;
      readonly message: Omit<PhoneMessage, 'from' | 'read'>;
    }
  | { readonly type: 'ThreadRead'; readonly threadId: string }
  | { readonly type: 'TypingChanged'; readonly threadId: string; readonly typing: boolean }
  | { readonly type: 'CallStarted'; readonly call: PhoneActiveCall }
  | { readonly type: 'CallAnswered'; readonly callId: string }
  | {
      readonly type: 'CallLineAdded';
      readonly callId: string;
      readonly speaker: 'player' | 'other';
      readonly text: string;
      readonly choices?: PhoneActiveCall['choices'];
    }
  | { readonly type: 'CallEnded'; readonly callId: string; readonly at: GameMinutes }
  | { readonly type: 'CallMissed'; readonly entry: Omit<PhoneCallLogEntry, 'direction'> }
  | { readonly type: 'PhotoAdded'; readonly photo: PhoneGalleryItem }
  | { readonly type: 'FileAdded'; readonly file: PhoneFile }
  | { readonly type: 'FileRevealed'; readonly fileId: string }
  | { readonly type: 'FileUnlocked'; readonly fileId: string }
  | { readonly type: 'NoteAdded'; readonly note: PhoneNote }
  | { readonly type: 'MapPinAdded'; readonly pin: PhoneMapPin }
  | { readonly type: 'PageAdded'; readonly page: PhoneBrowserPage }
  | { readonly type: 'NotificationPosted'; readonly notification: PhoneNotification }
  | { readonly type: 'NotificationRead'; readonly notificationId: string }
  | { readonly type: 'BatteryChanged'; readonly battery: number }
  | { readonly type: 'WallpaperChanged'; readonly variant: string | undefined };

function upsert<T extends { readonly id: string }>(list: readonly T[], item: T): readonly T[] {
  return list.some(({ id }) => id === item.id)
    ? list.map((x) => (x.id === item.id ? item : x))
    : [...list, item];
}

function addUnique<T extends { readonly id: string }>(list: readonly T[], item: T): readonly T[] {
  return list.some(({ id }) => id === item.id) ? list : [...list, item];
}

function mapThread(
  s: PhoneState,
  threadId: string,
  f: (t: PhoneThread) => PhoneThread,
): PhoneState {
  if (!s.threads.some(({ id }) => id === threadId)) return s;
  return { ...s, threads: s.threads.map((t) => (t.id === threadId ? f(t) : t)) };
}

function mapFile(s: PhoneState, fileId: string, f: (x: PhoneFile) => PhoneFile): PhoneState {
  return { ...s, files: s.files.map((x) => (x.id === fileId ? f(x) : x)) };
}

/** Pure: returns a new state; events that do not apply (unknown id, stale call) are no-ops. */
export function reducePhone(s: PhoneState, e: { readonly type: string }): PhoneState {
  const event = e as PhoneEvent;
  switch (event.type) {
    case 'ContactAdded':
      return { ...s, contacts: addUnique(s.contacts, event.contact) };
    case 'ContactChanged':
      return s.contacts.some(({ id }) => id === event.contact.id)
        ? { ...s, contacts: upsert(s.contacts, event.contact) }
        : s;
    case 'MessageReceived': {
      const message: PhoneMessage = { ...event.message, from: 'them', read: false };
      const existing = s.threads.find(({ id }) => id === event.thread.id);
      if (existing?.messages.some(({ id }) => id === message.id)) return s;
      const thread: PhoneThread = {
        id: event.thread.id,
        contactId: event.thread.contactId,
        messages: [...(existing?.messages ?? []), message],
        availableReplies: event.thread.availableReplies ?? existing?.availableReplies ?? [],
      };
      return { ...s, threads: upsert(s.threads, thread) };
    }
    case 'MessageSent':
      return mapThread(s, event.threadId, (t) =>
        t.messages.some(({ id }) => id === event.message.id)
          ? t
          : { ...t, messages: [...t.messages, { ...event.message, from: 'me', read: true }] },
      );
    case 'ThreadRead':
      return mapThread(s, event.threadId, (t) => ({
        ...t,
        messages: t.messages.map((m) => (m.read ? m : { ...m, read: true })),
      }));
    case 'TypingChanged':
      return mapThread(s, event.threadId, ({ typing: _, ...t }) => ({
        ...t,
        ...(event.typing && { typing: true }),
      }));
    case 'CallStarted':
      return { ...s, activeCall: event.call };
    case 'CallAnswered':
      return s.activeCall?.callId === event.callId
        ? { ...s, activeCall: { ...s.activeCall, state: 'active' } }
        : s;
    case 'CallLineAdded': {
      const call = s.activeCall;
      if (call?.callId !== event.callId) return s;
      return {
        ...s,
        activeCall: {
          ...call,
          lines: [...call.lines, { speaker: event.speaker, text: event.text }],
          choices: event.choices ?? call.choices,
        },
      };
    }
    case 'CallEnded': {
      const call = s.activeCall;
      if (call?.callId !== event.callId) return s;
      const { activeCall: _, ...rest } = s;
      const answered = call.state === 'active';
      const outgoing = call.lines[0]?.speaker === 'player';
      const entry: PhoneCallLogEntry = {
        id: call.callId,
        contactId: call.contactId,
        direction: answered ? (outgoing ? 'outgoing' : 'incoming') : 'missed',
        at: call.startedAt,
        durationMinutes: answered ? Math.max(0, event.at - call.startedAt) : 0,
      };
      return { ...rest, callLog: addUnique(s.callLog, entry) };
    }
    case 'CallMissed':
      return { ...s, callLog: addUnique(s.callLog, { ...event.entry, direction: 'missed' }) };
    case 'PhotoAdded':
      return { ...s, gallery: addUnique(s.gallery, event.photo) };
    case 'FileAdded':
      return { ...s, files: addUnique(s.files, event.file) };
    case 'FileRevealed':
      return mapFile(s, event.fileId, (f) => ({ ...f, hidden: false }));
    case 'FileUnlocked':
      return mapFile(s, event.fileId, (f) => ({ ...f, locked: false, hidden: false }));
    case 'NoteAdded':
      return { ...s, notes: addUnique(s.notes, event.note) };
    case 'MapPinAdded':
      return { ...s, mapPins: upsert(s.mapPins, event.pin) };
    case 'PageAdded':
      return { ...s, browserPages: addUnique(s.browserPages, event.page) };
    case 'NotificationPosted':
      return { ...s, notifications: addUnique(s.notifications, event.notification) };
    case 'NotificationRead':
      return {
        ...s,
        notifications: s.notifications.map((n) =>
          n.id === event.notificationId ? { ...n, read: true } : n,
        ),
      };
    case 'BatteryChanged':
      return { ...s, battery: Math.min(100, Math.max(0, Math.round(event.battery))) };
    case 'WallpaperChanged': {
      const { wallpaperVariant: _, ...rest } = s;
      return event.variant === undefined ? rest : { ...rest, wallpaperVariant: event.variant };
    }
    default:
      return s;
  }
}
