import { PhoneView } from '@hs/protocol';
import fixture from '@hs/protocol/fixtures/views/phone-view.mid.json';
import { OS_APPS, findApp } from '../src/os-apps/registry';

const MVP_IDS = [
  'camera',
  'contacts',
  'calls',
  'messages',
  'gallery',
  'files',
  'notes',
  'maps',
  'browser',
  'settings',
];

test('app ids are unique and every app has a component', () => {
  const ids = OS_APPS.map((a) => a.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const app of OS_APPS) expect(typeof app.component).toBe('function');
});

test('registry holds the ten MVP apps, ordered', () => {
  expect(OS_APPS.map((a) => a.id).sort()).toEqual([...MVP_IDS].sort());
  const orders = OS_APPS.map((a) => a.order);
  expect(orders).toEqual([...orders].sort((a, b) => a - b));
  expect(findApp('nope')).toBeUndefined();
});

test('every app the server lists in PhoneView is registered', () => {
  const view = PhoneView.parse(fixture);
  for (const entry of view.apps) expect(findApp(entry.id)).toBeDefined();
});
