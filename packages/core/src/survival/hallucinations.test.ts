import { FORBIDDEN_VIEW_KEYS } from '@hs/protocol';
import { expect, test } from 'vitest';
import {
  createPhoneState,
  projectPhoneView,
  reducePhone,
  type PhoneEvent,
  type PhoneState,
} from '../phone/index.ts';
import { createRng } from '../rng/index.ts';
import { Calendar } from '../time/index.ts';
import {
  HALLUCINATION_MAX_ACTIVE,
  clearHallucinations,
  hallucinationChance,
  hallucinationIds,
  rollHallucination,
  type HallucinationPool,
} from './index.ts';

const pool: HallucinationPool = {
  messages: ['Do not turn around.', 'Are you still there?'],
  notifications: ['3 new messages'],
  photos: [{ imageRef: 'img_blur', title: 'IMG_0042' }],
};
const calendar = new Calendar('2025-01-10T08:00');
const ctx = { minute: 75, calendar };
const calm = { vitals: { health: 10, sanity: 10, fatigue: 0 }, static: 0 };
const mad = { sanity: 0, staticLevel: 100, minute: 100, active: 0 };

function haunted(seed: string, rolls = 40, from: PhoneState = createPhoneState()): PhoneState {
  const rng = createRng(seed);
  let phone = from;
  for (let i = 0; i < rolls; i++) {
    const events = rollHallucination(rng, { ...mad, minute: i, active: 0 }, pool);
    phone = events.reduce(reducePhone, phone);
  }
  return phone;
}

test('no hallucinations while sanity and Static are steady', () => {
  expect(hallucinationChance(10, 49)).toBe(0);
  const rng = createRng('calm');
  for (let i = 0; i < 100; i++) {
    const input = { sanity: 10, staticLevel: 49, minute: i, active: 0 };
    expect(rollHallucination(rng, input, pool)).toEqual([]);
  }
});

test('chance grows as sanity falls and as Static rises, and is capped', () => {
  expect(hallucinationChance(5, 0)).toBeLessThan(hallucinationChance(2, 0));
  expect(hallucinationChance(10, 50)).toBeLessThan(hallucinationChance(10, 90));
  expect(hallucinationChance(0, 100)).toBeLessThanOrEqual(0.9);
  expect(hallucinationChance(0, 100)).toBeGreaterThan(0);
});

test('is deterministic for the same Rng state and differs between seeds', () => {
  expect(haunted('a')).toEqual(haunted('a'));
  expect(JSON.stringify(haunted('a'))).not.toBe(JSON.stringify(haunted('b')));
});

test('produces every kind, all flagged and drawn from the pool', () => {
  const phone = haunted('kinds', 200);
  expect(phone.gallery.length).toBeGreaterThan(0);
  expect(phone.notifications.length).toBeGreaterThan(0);
  expect(phone.threads.length).toBeGreaterThan(0);
  expect(phone.callLog.length).toBeGreaterThan(0);
  expect(phone.gallery.every((p) => p.hallucination === true)).toBe(true);
  expect(phone.notifications.every((n) => n.hallucination === true)).toBe(true);
  const texts = phone.threads.flatMap((t) => t.messages);
  expect(texts.every((m) => m.hallucination === true && pool.messages.includes(m.text))).toBe(true);
  expect(phone.contacts.every((c) => c.hallucination === true && c.number === '')).toBe(true);
});

test('stops when the phone already holds the maximum', () => {
  const rng = createRng('cap');
  for (let i = 0; i < 50; i++) {
    const input = { ...mad, active: HALLUCINATION_MAX_ACTIVE };
    expect(rollHallucination(rng, input, pool)).toEqual([]);
  }
});

test('rest clears hallucinations and leaves real items alone', () => {
  const realMessage: PhoneEvent = {
    type: 'MessageReceived',
    thread: { id: 't1', contactId: 'c1' },
    message: { id: 'm1', text: 'real', at: 1 },
  };
  const real = reducePhone(
    createPhoneState({
      contacts: [{ id: 'c1', name: 'Anna', number: '+100' }],
      gallery: [{ id: 'p1', title: 'Real', imageRef: 'r', takenAt: 1 }],
      notifications: [
        { id: 'n1', appId: 'messages', title: 'Anna', text: 'hi', at: 1, read: false },
      ],
    }),
    realMessage,
  );
  const phone = haunted('rest', 60, real);
  expect(hallucinationIds(phone).size).toBeGreaterThan(0);
  expect(clearHallucinations(phone)).toEqual(real);
  expect(hallucinationIds(clearHallucinations(phone)).size).toBe(0);
});

test('leak test: the flag never reaches the view, and fake items look like real ones', () => {
  const json = JSON.stringify(projectPhoneView(haunted('leak', 120), calm, ctx));
  expect(json).not.toContain('hallucination');
  // Item ids are shown to the client, so they must not tell a hallucination apart by their shape.
  expect(json).not.toMatch(/hal/i);
  for (const key of FORBIDDEN_VIEW_KEYS) expect(json).not.toContain(`"${key}"`);
  const item = { id: 'p', title: 'T', imageRef: 'r', takenAt: 1 };
  const real = createPhoneState({ gallery: [item] });
  const fake = createPhoneState({ gallery: [{ ...item, hallucination: true }] });
  expect(projectPhoneView(fake, calm, ctx)).toEqual(projectPhoneView(real, calm, ctx));
});
