import { expect, test } from 'vitest';
import { createRng } from '../rng/index.ts';
import { createInventory, setFlashlight } from './inventory.ts';
import {
  THREAT,
  attackEvent,
  canAttack,
  escapeChance,
  exploreHazard,
  resolveThreat,
} from './threats.ts';
import { createVitalsState } from './vitals.ts';

const pack = () =>
  setFlashlight(
    createInventory([
      { id: 'fl', kind: 'flashlight', chargeMinutes: 50 },
      { id: 'mk', kind: 'medkit' },
      { id: 'cl', kind: 'clue' },
    ]),
    true,
  );
const target = (fatigue = 0, health = 10) => ({
  vitals: createVitalsState({ health, sanity: 10, fatigue }),
  inventory: pack(),
});
const run = (seed: string, t = target()) => resolveThreat(t, 600, 'loc_cellar', createRng(seed));

test('attack needs wary culprit, night, a lone hero and darkness', () => {
  const ok = { wariness: 0.7, night: true, playerAlone: true, locationDark: true };
  expect(canAttack(ok)).toBe(true);
  expect(canAttack({ ...ok, wariness: 0.69 })).toBe(false);
  expect(canAttack({ ...ok, night: false })).toBe(false);
  expect(canAttack({ ...ok, playerAlone: false })).toBe(false);
  expect(canAttack({ ...ok, locationDark: false })).toBe(false);
});

test('escape chance falls with fatigue and injury and stays within bounds', () => {
  const at = (fatigue: number, health: number) => escapeChance(target(fatigue, health).vitals);
  expect(at(80, 10)).toBeLessThan(at(0, 10));
  expect(at(0, 2)).toBeLessThan(at(0, 10));
  expect(at(100, 0)).toBe(THREAT.minEscape);
  expect(at(0, 10)).toBe(THREAT.maxEscape);
});

test('outcomes are deterministic and consistent over many seeds', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const r = run(`s${i}`);
    expect(JSON.stringify(run(`s${i}`))).toBe(JSON.stringify(r));
    seen.add(r.outcome);
    expect(r.interrupted).toBe(true);
    if (r.outcome === 'escaped') {
      expect(r.damage).toBe(0);
      expect(r.lostItemId).toBeUndefined();
      expect(r.vitals.vitals.health).toBe(10);
      expect(r.inventory.items).toHaveLength(3);
    } else {
      expect(r.damage).toBeGreaterThanOrEqual(2);
      expect(r.damage).toBeLessThanOrEqual(4);
      expect(r.vitals.vitals.health).toBe(10 - r.damage);
      expect(['fl', 'mk']).toContain(r.lostItemId);
      expect(r.inventory.items.some((x) => x.id === r.lostItemId)).toBe(false);
      expect(r.inventory.items.some((x) => x.id === 'cl')).toBe(true);
    }
  }
  expect(seen).toEqual(new Set(['escaped', 'injured']));
});

test('a lost lit flashlight goes dark; a pack of clues loses nothing', () => {
  const lostLight = Array.from({ length: 300 }, (_, i) => run(`l${i}`)).find(
    (r) => r.lostItemId === 'fl',
  );
  expect(lostLight?.inventory.flashlightOn).toBe(false);
  const clues = {
    vitals: target(100, 3).vitals,
    inventory: createInventory([{ id: 'cl', kind: 'clue' }]),
  };
  for (let i = 0; i < 50; i += 1) expect(run(`c${i}`, clues).lostItemId).toBeUndefined();
});

test('the client notice never carries the attacker', () => {
  for (let i = 0; i < 50; i += 1) {
    const text = JSON.stringify(run(`n${i}`).notice);
    expect(text).not.toMatch(/attacker|culprit|actor|ch_/i);
  }
  expect(Object.keys(run('x').notice)).toContain('location');
});

test('attack event names the attacker in truth only and is covert', () => {
  const event = attackEvent('ch_k', 'loc_cellar', 600);
  expect(event).toMatchObject({ verb: 'attack', actorIds: ['ch_k'], visibility: 'covert' });
});

test('dangerous place without light hurts sometimes; lit or safe never', () => {
  const dark = { ...target(), inventory: createInventory() };
  const hp = (t: typeof dark, dangerous: boolean, seed: string) =>
    exploreHazard(t, dangerous, 600, createRng(seed)).state.vitals.health;
  const results = Array.from({ length: 200 }, (_, i) => hp(dark, true, `h${i}`));
  expect(new Set(results)).toEqual(new Set([9, 10]));
  for (let i = 0; i < 100; i += 1) {
    expect(hp(dark, false, `h${i}`)).toBe(10);
    expect(hp(target(), true, `h${i}`)).toBe(10);
  }
});
