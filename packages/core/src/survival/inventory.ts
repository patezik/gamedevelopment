import type { GameMinutes } from '../common/index.ts';
import { VITALS_DELTAS, applyDelta, type VitalsState, type VitalsStep } from './vitals.ts';

/** Six slots (survival-horror.md section 2). Clue items take a slot too. */
export const INVENTORY_SLOTS = 6;
/** Phone battery costs and recharge rate, in percent (survival-horror.md section 2). */
export const PHONE_POWER = {
  drainMinutesPerPercent: 10,
  callCost: 2,
  scanCost: 1,
  chargePercentPerMinute: 1,
} as const;

export type ItemKind = 'flashlight' | 'medkit' | 'sedative' | 'lockpick' | 'key' | 'clue';

export interface PackItem {
  readonly id: string;
  readonly kind: ItemKind;
  /** Flashlight only: minutes of light left. */
  readonly chargeMinutes?: number;
}

export interface Inventory {
  readonly items: readonly PackItem[];
  /** Whether the flashlight is switched on; it burns charge only while lit. */
  readonly flashlightOn: boolean;
}

export class InventoryError extends Error {
  readonly code: 'INVENTORY_FULL' | 'INVENTORY_UNKNOWN_ITEM' | 'INVENTORY_BAD_ITEM';

  constructor(code: InventoryError['code'], message: string) {
    super(message);
    this.name = 'InventoryError';
    this.code = code;
  }
}

export const createInventory = (items: readonly PackItem[] = []): Inventory => {
  if (items.length > INVENTORY_SLOTS) {
    throw new InventoryError('INVENTORY_FULL', `At most ${INVENTORY_SLOTS} items fit`);
  }
  return { items: items.map(checked), flashlightOn: false };
};

function checked(item: PackItem): PackItem {
  const charge = item.chargeMinutes;
  const bad =
    (item.kind === 'flashlight') !== (charge !== undefined) ||
    (charge !== undefined && (!Number.isSafeInteger(charge) || charge < 0));
  if (bad) {
    throw new InventoryError('INVENTORY_BAD_ITEM', `Invalid item ${item.id} (${item.kind})`);
  }
  return item;
}

const find = (inventory: Inventory, id: string): PackItem => {
  const item = inventory.items.find((x) => x.id === id);
  if (!item) throw new InventoryError('INVENTORY_UNKNOWN_ITEM', `No item ${id} in the pack`);
  return item;
};

export const freeSlots = (inventory: Inventory): number => INVENTORY_SLOTS - inventory.items.length;

/** Takes an item; throws `INVENTORY_FULL` when all slots are taken. */
export function pickUp(inventory: Inventory, item: PackItem): Inventory {
  if (freeSlots(inventory) === 0) {
    throw new InventoryError('INVENTORY_FULL', `No free slot for ${item.id}`);
  }
  if (inventory.items.some(({ id }) => id === item.id)) {
    throw new InventoryError('INVENTORY_BAD_ITEM', `Item ${item.id} is already in the pack`);
  }
  return { ...inventory, items: [...inventory.items, checked(item)] };
}

export function drop(inventory: Inventory, id: string): Inventory {
  find(inventory, id);
  const items = inventory.items.filter((x) => x.id !== id);
  const lit = inventory.flashlightOn && items.some(({ kind }) => kind === 'flashlight');
  return { items, flashlightOn: lit };
}

/** Switching on needs a flashlight with charge left. Returns the same inventory if it cannot. */
export function setFlashlight(inventory: Inventory, on: boolean): Inventory {
  const light = inventory.items.find(({ kind }) => kind === 'flashlight');
  const able = on ? (light?.chargeMinutes ?? 0) > 0 : true;
  return able && inventory.flashlightOn !== on ? { ...inventory, flashlightOn: on } : inventory;
}

/** Minutes of light left in the lit flashlight; 0 when dark. */
export function lightMinutes(inventory: Inventory): number {
  if (!inventory.flashlightOn) return 0;
  return inventory.items.find(({ kind }) => kind === 'flashlight')?.chargeMinutes ?? 0;
}

/** Burns charge for `minutes` while lit; the light goes out at zero. */
export function burnFlashlight(inventory: Inventory, minutes: number): Inventory {
  whole(minutes, 'minutes');
  if (!inventory.flashlightOn || minutes === 0) return inventory;
  const items = inventory.items.map((item) =>
    item.kind === 'flashlight'
      ? { ...item, chargeMinutes: Math.max(0, (item.chargeMinutes ?? 0) - minutes) }
      : item,
  );
  const left = items.find(({ kind }) => kind === 'flashlight')?.chargeMinutes ?? 0;
  return { items, flashlightOn: left > 0 };
}

export function recharge(inventory: Inventory, id: string, chargeMinutes: number): Inventory {
  const item = find(inventory, id);
  if (item.kind !== 'flashlight') {
    throw new InventoryError('INVENTORY_BAD_ITEM', `${id} cannot be charged`);
  }
  whole(chargeMinutes, 'chargeMinutes');
  return {
    ...inventory,
    items: inventory.items.map((x) => (x.id === id ? { ...x, chargeMinutes } : x)),
  };
}

export interface ConsumeResult {
  readonly inventory: Inventory;
  readonly vitals: VitalsStep;
}

/** Uses up a medkit (+3 health) or a sedative (+2 sanity); the item is spent even at full vitals. */
export function consume(
  inventory: Inventory,
  vitals: VitalsState,
  id: string,
  at: GameMinutes,
): ConsumeResult {
  const item = find(inventory, id);
  if (item.kind !== 'medkit' && item.kind !== 'sedative') {
    throw new InventoryError('INVENTORY_BAD_ITEM', `${id} cannot be consumed`);
  }
  return {
    inventory: drop(inventory, id),
    vitals: applyDelta(vitals, VITALS_DELTAS[item.kind], at, item.kind),
  };
}

// ----------------------------------------------------------------- phone battery

/** Virtual battery. `carryMinutes` (0 to 9) is awake time not yet turned into a percent. */
export interface PhonePower {
  readonly percent: number;
  readonly carryMinutes: number;
}

export const createPhonePower = (percent = 100): PhonePower => {
  whole(percent, 'percent');
  if (percent > 100) throw new RangeError('percent must be at most 100');
  return { percent, carryMinutes: 0 };
};

export const phoneIsOff = (power: PhonePower): boolean => power.percent === 0;

/** -1 % per 10 minutes of use, carrying the remainder so splitting time changes nothing. */
export function drainPhone(power: PhonePower, minutes: number): PhonePower {
  whole(minutes, 'minutes');
  const total = power.carryMinutes + minutes;
  const lost = Math.floor(total / PHONE_POWER.drainMinutesPerPercent);
  const percent = Math.max(0, power.percent - lost);
  return { percent, carryMinutes: percent === 0 ? 0 : total % PHONE_POWER.drainMinutesPerPercent };
}

const spend = (power: PhonePower, cost: number): PhonePower => ({
  ...power,
  percent: Math.max(0, power.percent - cost),
});
export const phoneCall = (power: PhonePower): PhonePower => spend(power, PHONE_POWER.callCost);
export const phoneScan = (power: PhonePower): PhonePower => spend(power, PHONE_POWER.scanCost);

/** +1 % per minute of waiting or resting at a charging place (the hero's room, the hall). */
export function chargePhone(power: PhonePower, minutes: number): PhonePower {
  whole(minutes, 'minutes');
  return {
    percent: Math.min(100, power.percent + minutes * PHONE_POWER.chargePercentPerMinute),
    carryMinutes: 0,
  };
}

function whole(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative whole number, got ${String(value)}`);
  }
}
