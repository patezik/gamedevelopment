import type { GameMinutes } from '../common/index.ts';
import type { PhoneEvent } from '../phone/reducer.ts';
import type { PhoneState } from '../phone/state.ts';
import type { Rng } from '../rng/index.ts';
import { VITALS_THRESHOLDS } from './vitals.ts';

/**
 * Phone hallucinations (survival-horror.md section 5). They are ordinary-looking phone items that
 * carry `hallucination: true` on the server only: `projectPhoneView` copies fields one by one, so
 * the flag never reaches a client, and a case file naming one is refused (INV-005).
 */

/** Static at or above this makes hallucinations possible even with healthy sanity. */
export const HALLUCINATION_STATIC_FROM = 50;

/** Most hallucinations a phone may hold at once, so they stay a seasoning, not a flood. */
export const HALLUCINATION_MAX_ACTIVE = 4;

/**
 * Text and image fragments a preset offers. They are atmosphere only: the validator
 * (V-HALLUCINATION) refuses fragments that mention names or places of the case.
 */
export interface HallucinationPool {
  readonly messages: readonly string[];
  readonly notifications: readonly string[];
  readonly photos: readonly { readonly imageRef: string; readonly title: string }[];
}

export interface HallucinationInput {
  readonly sanity: number;
  /** Global Static, 0 to 100. */
  readonly staticLevel: number;
  readonly minute: GameMinutes;
  /** Hallucinations already on the phone (`hallucinationIds(phone).size`). */
  readonly active: number;
}

/** Chance that one roll produces a hallucination; 0 while the mind is steady. */
export function hallucinationChance(sanity: number, staticLevel: number): number {
  const limit = VITALS_THRESHOLDS.phoneInterferenceSanity;
  const lowSanity = sanity <= limit;
  const highStatic = staticLevel >= HALLUCINATION_STATIC_FROM;
  if (!lowSanity && !highStatic) return 0;
  const sanityPart = lowSanity ? (limit - sanity + 1) / (limit + 1) : 0;
  const staticPart = highStatic
    ? (Math.min(100, staticLevel) - HALLUCINATION_STATIC_FROM + 10) / 100
    : 0;
  return Math.min(0.9, Math.max(sanityPart, staticPart));
}

/**
 * Rolls once and returns the phone events of at most one hallucination: a message, a notification,
 * a photo or a missed call from a number without digits. The caller passes a dedicated `Rng` fork,
 * so the same state gives the same hallucination.
 */
export function rollHallucination(
  rng: Rng,
  input: HallucinationInput,
  pool: HallucinationPool,
): readonly PhoneEvent[] {
  if (input.active >= HALLUCINATION_MAX_ACTIVE) return [];
  if (!rng.chance(hallucinationChance(input.sanity, input.staticLevel))) return [];
  const kinds: ('message' | 'notification' | 'photo' | 'call')[] = ['call'];
  if (pool.messages.length > 0) kinds.push('message');
  if (pool.notifications.length > 0) kinds.push('notification');
  if (pool.photos.length > 0) kinds.push('photo');
  const kind = rng.pick(kinds);
  const id = `ev_${input.minute}_${rng.int(0, 0xffff).toString(16)}`;
  const contactId = `${id}_c`;
  const at = input.minute;
  const unknownContact: PhoneEvent = {
    type: 'ContactAdded',
    contact: { id: contactId, name: 'Unknown', number: '', hallucination: true },
  };
  switch (kind) {
    case 'message':
      return [
        unknownContact,
        {
          type: 'MessageReceived',
          thread: { id: `${id}_t`, contactId },
          message: { id, text: rng.pick(pool.messages), at, hallucination: true },
        },
      ];
    case 'notification':
      return [
        {
          type: 'NotificationPosted',
          notification: {
            id,
            appId: 'messages',
            title: 'Unknown',
            text: rng.pick(pool.notifications),
            at,
            read: false,
            hallucination: true,
          },
        },
      ];
    case 'photo': {
      const photo = rng.pick(pool.photos);
      return [
        {
          type: 'PhotoAdded',
          photo: {
            id,
            title: photo.title,
            imageRef: photo.imageRef,
            takenAt: at,
            hallucination: true,
          },
        },
      ];
    }
    case 'call':
      return [
        unknownContact,
        { type: 'CallMissed', entry: { id, contactId, at, durationMinutes: 0 } },
      ];
  }
}

/** IDs of every hallucinated item on the phone; pass them as `hallucinatedClueIds` to accusations. */
export function hallucinationIds(phone: PhoneState): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const c of phone.contacts) if (c.hallucination) ids.add(c.id);
  for (const t of phone.threads) {
    for (const m of t.messages) if (m.hallucination) ids.add(m.id);
  }
  for (const p of phone.gallery) if (p.hallucination) ids.add(p.id);
  for (const n of phone.notifications) if (n.hallucination) ids.add(n.id);
  return ids;
}

/**
 * After rest the hallucinations are gone: flagged messages, photos, notifications and contacts
 * (with their threads and call-log entries) disappear. Real items are untouched.
 */
export function clearHallucinations(phone: PhoneState): PhoneState {
  const gone = new Set(phone.contacts.filter((c) => c.hallucination).map((c) => c.id));
  return {
    ...phone,
    contacts: phone.contacts.filter((c) => !gone.has(c.id)),
    threads: phone.threads
      .filter((t) => !gone.has(t.contactId))
      .map((t) => ({ ...t, messages: t.messages.filter((m) => !m.hallucination) })),
    callLog: phone.callLog.filter((c) => !gone.has(c.contactId)),
    gallery: phone.gallery.filter((p) => !p.hallucination),
    notifications: phone.notifications.filter((n) => !n.hallucination),
  };
}
