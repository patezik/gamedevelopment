import { expect, test } from 'vitest';
import { Calendar } from '../time/index.ts';
import { createPhoneState, projectPhoneView } from '../phone/index.ts';
import {
  INVENTORY_SLOTS,
  burnFlashlight,
  chargePhone,
  consume,
  createInventory,
  createPhonePower,
  createVitalsState,
  drainPhone,
  drop,
  lightMinutes,
  phoneCall,
  phoneIsOff,
  phoneScan,
  pickUp,
  recharge,
  setFlashlight,
  type InventoryError,
  type PackItem,
} from './index.ts';

const torch = (chargeMinutes: number): PackItem => ({
  id: 'fl',
  kind: 'flashlight',
  chargeMinutes,
});
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as InventoryError).code;
  }
  return undefined;
};

test('six slots: a seventh item is refused, dropping frees a slot', () => {
  let inv = createInventory();
  for (let i = 0; i < INVENTORY_SLOTS; i++) inv = pickUp(inv, { id: `k${i}`, kind: 'key' });
  expect(code(() => pickUp(inv, { id: 'extra', kind: 'clue' }))).toBe('INVENTORY_FULL');
  inv = drop(inv, 'k3');
  expect(code(() => pickUp(inv, { id: 'k0', kind: 'key' }))).toBe('INVENTORY_BAD_ITEM');
  expect(pickUp(inv, { id: 'extra', kind: 'clue' }).items).toHaveLength(INVENTORY_SLOTS);
  expect(code(() => drop(inv, 'nope'))).toBe('INVENTORY_UNKNOWN_ITEM');
  expect(code(() => createInventory([torch(-1)]))).toBe('INVENTORY_BAD_ITEM');
  expect(code(() => createInventory([{ id: 'x', kind: 'key', chargeMinutes: 5 }]))).toBe(
    'INVENTORY_BAD_ITEM',
  );
});

test.each([
  // [start charge, on, minutes burned, charge left, still lit]
  [60, true, 10, 50, true],
  [60, true, 60, 0, false],
  [60, true, 90, 0, false],
  [60, false, 30, 60, false],
  [0, true, 5, 0, false],
])('flashlight %i min, on=%s, burn %i -> %i left, lit=%s', (start, on, burn, left, lit) => {
  const inv = burnFlashlight(setFlashlight(createInventory([torch(start)]), on), burn);
  expect(inv.items[0]?.chargeMinutes).toBe(left);
  expect(inv.flashlightOn).toBe(lit);
  expect(lightMinutes(inv)).toBe(lit ? left : 0);
});

test('a flashlight is recharged and then relit by the player, not automatically', () => {
  let inv = burnFlashlight(setFlashlight(createInventory([torch(5)]), true), 5);
  expect(inv.flashlightOn).toBe(false);
  inv = recharge(inv, 'fl', 30);
  expect(inv.flashlightOn).toBe(false);
  expect(setFlashlight(inv, true).flashlightOn).toBe(true);
  expect(code(() => recharge(createInventory([{ id: 'm', kind: 'medkit' }]), 'm', 3))).toBe(
    'INVENTORY_BAD_ITEM',
  );
});

test.each([
  ['medkit', { health: 7, sanity: 10 }, { health: 10, sanity: 10 }],
  ['medkit', { health: 9, sanity: 10 }, { health: 10, sanity: 10 }],
  ['sedative', { health: 10, sanity: 4 }, { health: 10, sanity: 6 }],
  ['sedative', { health: 10, sanity: 9 }, { health: 10, sanity: 10 }],
] as const)('%s on %j restores to %j and is spent', (kind, from, to) => {
  const state = createVitalsState({ ...from, fatigue: 0 });
  const result = consume(createInventory([{ id: 'c', kind }]), state, 'c', 10);
  expect(result.vitals.state.vitals).toEqual({ ...to, fatigue: 0 });
  expect(result.inventory.items).toEqual([]);
});

test('only medkits and sedatives are consumable', () => {
  const state = createVitalsState({ health: 5, sanity: 5, fatigue: 0 });
  expect(code(() => consume(createInventory([{ id: 'k', kind: 'key' }]), state, 'k', 1))).toBe(
    'INVENTORY_BAD_ITEM',
  );
});

test.each([
  [100, 0, 10, 99, 0],
  [100, 0, 9, 100, 9],
  [100, 9, 1, 99, 0],
  [100, 0, 95, 91, 5],
  [3, 0, 100, 0, 0],
])(
  'phone %i %% carry %i drains over %i min -> %i %% (carry %i)',
  (percent, carry, minutes, left, c) => {
    expect(drainPhone({ percent, carryMinutes: carry }, minutes)).toEqual({
      percent: left,
      carryMinutes: c,
    });
  },
);

test('draining in pieces equals draining at once', () => {
  let split = createPhonePower(80);
  for (let i = 0; i < 47; i++) split = drainPhone(split, 1);
  expect(split).toEqual(drainPhone(createPhonePower(80), 47));
});

test('calls cost 2 %, scans 1 %, never below zero; charging gives 1 % per minute up to 100', () => {
  expect(phoneCall(createPhonePower(50)).percent).toBe(48);
  expect(phoneScan(createPhonePower(50)).percent).toBe(49);
  expect(phoneCall(createPhonePower(1)).percent).toBe(0);
  expect(chargePhone(createPhonePower(40), 25).percent).toBe(65);
  expect(chargePhone(createPhonePower(90), 25).percent).toBe(100);
  expect(phoneIsOff(createPhonePower(0))).toBe(true);
  expect(() => drainPhone(createPhonePower(), -1)).toThrow(RangeError);
});

test('at 0 % every app is disabled except the charging screen', () => {
  const calendar = new Calendar('2026-01-14T08:00:00');
  const calm = { vitals: { health: 10, sanity: 10, fatigue: 0 }, static: 0 };
  const show = (battery: number) =>
    projectPhoneView(createPhoneState({ battery }), calm, { minute: 0, calendar }).apps;
  expect(
    show(0)
      .filter(({ enabled }) => enabled)
      .map(({ id }) => id),
  ).toEqual(['charging']);
  expect(show(1).some(({ id }) => id === 'charging')).toBe(false);
  expect(show(1).every(({ enabled }) => enabled)).toBe(true);
});
