import type { GameMinutes } from '../common/index.ts';

/**
 * Server-side phone content (modules.md section 11). Plain JSON. Items may carry `hallucination`
 * and files carry `password`; neither is ever projected to the client.
 */
export interface PhoneContact {
  readonly id: string;
  readonly name: string;
  readonly number: string;
  readonly portraitRef?: string;
  readonly hallucination?: boolean;
}

export interface PhoneMessage {
  readonly id: string;
  readonly from: 'me' | 'them';
  readonly text: string;
  readonly at: GameMinutes;
  readonly read: boolean;
  readonly hallucination?: boolean;
}

export interface PhoneThread {
  readonly id: string;
  readonly contactId: string;
  readonly messages: readonly PhoneMessage[];
  readonly availableReplies: readonly { readonly id: string; readonly text: string }[];
  readonly typing?: boolean;
}

export interface PhoneCallLogEntry {
  readonly id: string;
  readonly contactId: string;
  readonly direction: 'incoming' | 'outgoing' | 'missed';
  readonly at: GameMinutes;
  readonly durationMinutes: number;
}

export interface PhoneActiveCall {
  readonly callId: string;
  readonly contactId: string;
  readonly state: 'ringing' | 'active';
  readonly startedAt: GameMinutes;
  readonly lines: readonly { readonly speaker: 'player' | 'other'; readonly text: string }[];
  readonly choices: readonly { readonly id: string; readonly text: string }[];
}

export interface PhoneGalleryItem {
  readonly id: string;
  readonly title: string;
  readonly imageRef: string;
  readonly takenAt: GameMinutes;
  readonly caption?: string;
  readonly hallucination?: boolean;
}

export interface PhoneFile {
  readonly id: string;
  readonly name: string;
  readonly locked: boolean;
  readonly password?: string;
  readonly passwordHint?: string;
  readonly content: string;
  /** Hidden files are not listed until a `FileRevealed` event. */
  readonly hidden: boolean;
}

export interface PhoneNote {
  readonly id: string;
  readonly source: 'auto' | 'player';
  readonly text: string;
  readonly at: GameMinutes;
}

export interface PhoneMapPin {
  readonly id: string;
  readonly locationId: string;
  readonly label: string;
  readonly seenAt?: GameMinutes;
}

export interface PhoneBrowserPage {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly text: string;
}

export interface PhoneNotification {
  readonly id: string;
  readonly appId: string;
  readonly title: string;
  readonly text: string;
  readonly at: GameMinutes;
  readonly read: boolean;
  readonly hallucination?: boolean;
}

export interface PhoneState {
  readonly contacts: readonly PhoneContact[];
  readonly threads: readonly PhoneThread[];
  readonly callLog: readonly PhoneCallLogEntry[];
  readonly activeCall?: PhoneActiveCall;
  readonly gallery: readonly PhoneGalleryItem[];
  readonly files: readonly PhoneFile[];
  readonly notes: readonly PhoneNote[];
  readonly mapPins: readonly PhoneMapPin[];
  readonly browserPages: readonly PhoneBrowserPage[];
  readonly notifications: readonly PhoneNotification[];
  /** 0 to 100. */
  readonly battery: number;
  readonly wallpaperVariant?: string;
}

export function createPhoneState(init: Partial<PhoneState> = {}): PhoneState {
  return {
    contacts: [],
    threads: [],
    callLog: [],
    gallery: [],
    files: [],
    notes: [],
    mapPins: [],
    browserPages: [],
    notifications: [],
    battery: 100,
    ...init,
  };
}

/** Preset phone template entry (`phoneTemplatesSchema`). */
export interface PhoneTemplate {
  readonly id: string;
  readonly kind: 'message' | 'page' | 'file' | 'wallpaper';
  readonly template: string;
  readonly title?: string;
  readonly event?: string;
  readonly hidden?: boolean;
  readonly password?: string;
}

export interface InitialPhoneOptions {
  readonly contacts?: readonly PhoneContact[];
  readonly battery?: number;
}

/**
 * The hero's starting phone from preset templates. Templates tied to an `event` are delivered
 * later by that event, so only unconditional pages, files and the wallpaper start on the phone.
 */
export function initialPhoneState(
  templates: readonly PhoneTemplate[],
  options: InitialPhoneOptions = {},
): PhoneState {
  const start = templates.filter((t) => t.event === undefined);
  const wallpaper = start.find((t) => t.kind === 'wallpaper');
  return createPhoneState({
    contacts: options.contacts ?? [],
    ...(options.battery !== undefined && { battery: options.battery }),
    browserPages: start
      .filter((t) => t.kind === 'page')
      .map((t) => ({ id: t.id, title: t.title ?? t.id, url: `local://${t.id}`, text: t.template })),
    files: start
      .filter((t) => t.kind === 'file')
      .map((t) => ({
        id: t.id,
        name: t.title ?? t.id,
        locked: t.password !== undefined,
        ...(t.password !== undefined && { password: t.password }),
        content: t.template,
        hidden: t.hidden === true,
      })),
    ...(wallpaper && { wallpaperVariant: wallpaper.template }),
  });
}
