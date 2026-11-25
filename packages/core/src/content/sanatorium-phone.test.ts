import { fileURLToPath } from 'node:url';
import { FORBIDDEN_VIEW_KEYS, PhoneView } from '@hs/protocol';
import { describe, expect, it } from 'vitest';
import {
  initialPhoneState,
  projectPhoneView,
  reducePhone,
  type PhoneEvent,
  type PhoneSurvival,
  type PhoneTemplate,
} from '../phone/index.ts';
import { Calendar } from '../time/index.ts';
import { createContentRepo, phoneTemplatesSchema, type ScenarioContent } from './index.ts';

const root = fileURLToPath(new URL('../../../../content/scenarios/', import.meta.url));
const content: ScenarioContent = createContentRepo(root).load('sanatorium_winter');
const files = content.phone;
const all: readonly ScenarioContent['phone'][string][number][] = Object.values(files).flat();
/** Parsed rows keep absent optional fields as `undefined`; `PhoneTemplate` expects them omitted. */
const templates = all.map((t) => JSON.parse(JSON.stringify(t)) as PhoneTemplate);
const ofKind = (kind: PhoneTemplate['kind']) => all.filter((t) => t.kind === kind);
const start = all.filter((t) => t.event === undefined);

/** Placeholders the delivery engine supplies per message event (`allowed`), and must fill (`required`). */
const speaker = ['me_f'];
const person = ['who', 'who_f'];
const MESSAGE_EVENTS: Record<string, { allowed: string[]; required: string[] }> = {
  npc_tip_presence: {
    allowed: [...speaker, ...person, 'where', 'time'],
    required: ['who', 'where', 'time'],
  },
  npc_tip_item: { allowed: [...speaker, ...person, 'item', 'time'], required: ['who', 'item'] },
  npc_tip_place: { allowed: [...speaker, 'where'], required: ['where'] },
  npc_rumor_presence: {
    allowed: [...speaker, ...person, 'where', 'time'],
    required: ['who', 'where'],
  },
  npc_rumor_relation: {
    allowed: [...speaker, 'a', 'b', 'relation'],
    required: ['a', 'b', 'relation'],
  },
  npc_rumor_vague: { allowed: speaker, required: [] },
  npc_threat: { allowed: [], required: [] },
  npc_request_meet: { allowed: [...speaker, 'where', 'time'], required: ['where', 'time'] },
  npc_request_item: { allowed: [...speaker, 'item'], required: ['item'] },
  npc_request_discretion: { allowed: speaker, required: [] },
  contact_shared: { allowed: speaker, required: [] },
  interrogated_calm: { allowed: speaker, required: [] },
  interrogated_nervous: { allowed: speaker, required: [] },
  interrogated_hostile: { allowed: speaker, required: [] },
  incident_discovered: { allowed: [...speaker, ...person, 'where'], required: ['who', 'where'] },
  secondary_incident: { allowed: [...speaker, ...person, 'where'], required: ['who', 'where'] },
  blackout: { allowed: speaker, required: [] },
  night: { allowed: speaker, required: [] },
  static_50: { allowed: [], required: [] },
  static_75: { allowed: [], required: [] },
};
/** Events that must deliver at least one page, file or (exactly one) wallpaper. */
const REQUIRED_DELIVERIES: Record<Exclude<PhoneTemplate['kind'], 'message'>, string[]> = {
  page: ['blackout', 'static_50', 'static_75'],
  file: ['static_50', 'static_75'],
  wallpaper: ['static_25', 'static_50', 'static_75', 'sanity_low', 'blackout', 'rest'],
};
const EVENTS = new Set([
  ...Object.keys(MESSAGE_EVENTS),
  ...Object.values(REQUIRED_DELIVERIES).flat(),
]);
const ID_PREFIX = { message: 'msg_', page: 'page_', file: 'file_', wallpaper: 'wp_' } as const;
const FILE_OF_KIND = {
  message: 'messages',
  page: 'browser',
  file: 'files',
  wallpaper: 'wallpapers',
};

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1] ?? '');
}
const texts = (t: { template: string; title?: string | undefined }) => [t.template, t.title ?? ''];
const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const calm: PhoneSurvival = { vitals: { health: 10, sanity: 8, fatigue: 10 }, static: 0 };
const calendar = new Calendar(content.preset.time.startDateTime);

describe('phone content of sanatorium_winter', () => {
  it('loads through the content repo and matches the phone template schema', () => {
    expect(Object.keys(files).sort()).toEqual(['browser', 'files', 'messages', 'wallpapers']);
    for (const [name, list] of Object.entries(files)) {
      expect(phoneTemplatesSchema.safeParse(list).success, name).toBe(true);
      for (const t of list) expect(FILE_OF_KIND[t.kind], t.id).toBe(name);
    }
  });

  it('uses unique IDs with a prefix per kind', () => {
    const ids = all.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of all) expect(t.id.startsWith(ID_PREFIX[t.kind]), t.id).toBe(true);
  });

  it('uses only documented delivery events; blackout is the preset critical event', () => {
    for (const t of all) if (t.event !== undefined) expect(EVENTS, t.id).toContain(t.event);
    expect(content.preset.criticalEvents.map(({ id }) => id)).toContain('blackout');
  });

  it('covers every message event with at least three distinct variants', () => {
    for (const event of Object.keys(MESSAGE_EVENTS)) {
      const variants = ofKind('message').filter((t) => t.event === event);
      expect(variants.length, event).toBeGreaterThanOrEqual(3);
      expect(new Set(variants.map(({ template }) => template)).size, event).toBe(variants.length);
    }
    for (const t of ofKind('message'))
      expect(t.event, `${t.id} must be event-driven`).toBeDefined();
  });

  it('covers every page, file and wallpaper event; one wallpaper per event', () => {
    for (const [kind, events] of Object.entries(REQUIRED_DELIVERIES)) {
      for (const event of events) {
        const found = all.filter((t) => t.kind === kind && t.event === event);
        if (kind === 'wallpaper') expect(found, `${kind} ${event}`).toHaveLength(1);
        else expect(found.length, `${kind} ${event}`).toBeGreaterThan(0);
      }
    }
    const startWallpapers = start.filter((t) => t.kind === 'wallpaper');
    expect(startWallpapers).toHaveLength(1);
    const variants = ofKind('wallpaper').map(({ template }) => template);
    for (const variant of variants) expect(variant).toMatch(/^[a-z][a-z0-9_]*$/);
    const rest = ofKind('wallpaper').find((t) => t.event === 'rest');
    expect(rest?.template).toBe(startWallpapers[0]?.template);
    for (const t of ofKind('wallpaper')) expect(t.title, `${t.id} art brief`).toBeDefined();
  });

  it('uses only the placeholders the engine supplies, and fills the required ones', () => {
    for (const t of ofKind('message')) {
      const spec = MESSAGE_EVENTS[t.event ?? ''];
      expect(spec, t.id).toBeDefined();
      const used = placeholders(t.template);
      for (const name of used) expect(spec?.allowed, `${t.id}: {${name}}`).toContain(name);
      for (const name of spec?.required ?? []) expect(used, `${t.id}: {${name}}`).toContain(name);
      if (used.includes('who_f')) expect(used, `${t.id}: {who_f} without {who}`).toContain('who');
    }
    for (const t of all) {
      if (t.kind !== 'message') {
        for (const text of texts(t)) expect(placeholders(text), t.id).toEqual([]);
      }
      for (const text of texts(t)) {
        expect(text.replace(/\{[^{}]*\}/g, ''), `${t.id}: stray brace`).not.toMatch(/[{}]/);
      }
    }
  });

  it('keeps text clean: trimmed lines, Cyrillic, no raw content IDs', () => {
    for (const t of all) {
      if (t.kind === 'wallpaper') continue;
      for (const text of texts(t).filter(Boolean)) {
        expect(text, t.id).toMatch(/[А-Яа-яЁё]/);
        for (const line of text.split('\n')) expect(line, t.id).toBe(line.trim());
        expect(text, t.id).not.toMatch(/\b(?:loc|it|ch|hs|cl)_[a-z]/);
      }
    }
  });

  it('does not reveal the solution, name a cast member or single out an archetype', () => {
    const names = content.archetypes.flatMap(({ names }) => names);
    const surnames = names.map((name) => name.split(' ').at(-1) ?? name);
    const titles = content.archetypes.map(({ title }) => title.toLowerCase());
    for (const t of all) {
      for (const text of texts(t)) {
        expect(text, t.id).not.toMatch(/убий|убит|виновн|преступни|подозрева|culprit|truth/i);
        for (const name of [...names, ...surnames])
          expect(text, `${t.id}: ${name}`).not.toContain(name);
        if (t.kind === 'message') {
          for (const title of titles)
            expect(text.toLowerCase(), `${t.id}: ${title}`).not.toContain(title);
        }
      }
    }
  });

  it('starts the hero phone without leaking passwords or hidden files', () => {
    const state = initialPhoneState(templates);
    expect(state.threads).toEqual([]);
    expect(state.wallpaperVariant).toBe('pine_forest');
    expect(state.browserPages.map(({ id }) => id).sort()).toEqual(
      start
        .filter((t) => t.kind === 'page')
        .map(({ id }) => id)
        .sort(),
    );
    const hidden = state.files.filter((f) => f.hidden);
    expect(hidden.length).toBeGreaterThan(0);
    for (const file of hidden) expect(file.locked, file.id).toBe(true);

    const view = projectPhoneView(state, calm, { minute: 0, calendar });
    expect(PhoneView.parse(view)).toEqual(view);
    const json = JSON.stringify(view);
    for (const key of FORBIDDEN_VIEW_KEYS) expect(json).not.toContain(`"${key}"`);
    for (const t of all.filter((x) => x.password !== undefined)) {
      expect(json).not.toContain(t.password);
      expect(json).not.toContain(t.template);
    }
    for (const file of hidden) expect(json).not.toContain(file.name);
  });

  it('opens the nurse tablet files only after reveal and the right password', () => {
    const items = new Map(content.items.map((item) => [item.id, item]));
    expect(items.get('it_nurse_tablet')?.tags).toContain('password_protected');
    expect(items.get('it_password_note')?.tags).toContain('password');

    const locked = ofKind('file').filter((t) => t.password !== undefined);
    expect(locked.length).toBeGreaterThan(0);
    expect(new Set(locked.map(({ password }) => password)).size).toBe(1);
    const password = locked[0]?.password ?? '';
    expect(password).toMatch(/^[a-z0-9-]{6,}$/);
    for (const t of all) {
      expect(t.password === undefined || t.kind === 'file', t.id).toBe(true);
      if (t.event === undefined && t.hidden !== true)
        expect(t.template, t.id).not.toContain(password);
    }

    const [first] = locked;
    if (first === undefined) throw new Error('no locked file');
    let state = initialPhoneState(templates);
    const view = () => projectPhoneView(state, calm, { minute: 0, calendar });
    const reveal: PhoneEvent = { type: 'FileRevealed', fileId: first.id };
    state = reducePhone(state, reveal);
    const revealed = view().files.find(({ id }) => id === first.id);
    expect(revealed).toMatchObject({ locked: true, name: first.title });
    expect(revealed).not.toHaveProperty('content');
    const unlock: PhoneEvent = { type: 'FileUnlocked', fileId: first.id };
    state = reducePhone(state, unlock);
    expect(view().files.find(({ id }) => id === first.id)?.content).toBe(first.template);
  });

  it('agrees with the scenario data: opening hours, nurse routine, road date', () => {
    const page = (id: string) => all.find((t) => t.id === id)?.template ?? '';
    const schedule = page('page_sanatorium_schedule');
    for (const location of content.locations) {
      for (const rule of location.access) {
        if (rule.from === undefined || rule.to === undefined) continue;
        const line = schedule.split('\n').find((l) => l.startsWith(location.name));
        expect(line, location.id).toContain(`${hhmm(rule.from)}–${hhmm(rule.to)}`);
      }
    }

    const nurse = content.archetypes.find(({ id }) => id === 'nurse');
    const shifts = page('file_tablet_shifts');
    for (const entry of nurse?.routine ?? []) {
      if (entry.activity === 'sleep') continue;
      expect(shifts, `${entry.activity} ${entry.from}`).toContain(
        `${hhmm(entry.from)}–${hhmm(entry.to)}`,
      );
    }

    const police = content.preset.deadlines.find(({ id }) => id === 'police_arrival');
    const [, month, day] =
      calendar.toDisplay(police?.at ?? 0).dateIso.match(/-(\d{2})-(\d{2})T/) ?? [];
    expect(month).toBe('01');
    expect(page('page_news_snowstorm')).toContain(`утра ${Number(day)} января`);
  });
});
