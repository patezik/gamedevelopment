import { expect, test } from 'vitest';
import { Calendar } from '../time/index.ts';
import { validateRoutine, whereShouldBe, type RoutineBlock } from './index.ts';

const calendar = new Calendar('2026-01-14T08:00');
const night: RoutineBlock = { from: 1320, to: 360, location: 'loc_room', activity: 'sleep', flexibility: 0 };
const day: RoutineBlock = { from: 360, to: 1320, location: 'loc_office', activity: 'work', flexibility: 0.5 };
const character = { id: 'ch_anna', routine: [night, day] };

test.each([
  [-121, night], [-120, day], [0, day], [839, day], [840, night],
  [959, night], [960, night], [1319, night], [1320, day], [2280, night],
])('looks up the wall-clock routine at scenario minute %i', (minute, expected) => {
  expect(whereShouldBe(character, minute, [], calendar)).toEqual(expected);
});

test('uses the last matching character override on the half-open game-minute interval', () => {
  const first = { ...night, location: 'loc_archive' };
  const second = { ...day, location: 'loc_hall' };
  const overrides = [
    { characterId: character.id, interval: { from: -1, to: 2 }, block: first },
    { characterId: character.id, interval: { from: 0, to: 1 }, block: second },
    { characterId: 'ch_other', interval: { from: -1, to: 2 }, block: day },
  ];
  expect(whereShouldBe(character, -1, overrides, calendar)).toBe(first);
  expect(whereShouldBe(character, 0, overrides, calendar)).toBe(second);
  expect(whereShouldBe(character, 1, overrides, calendar)).toBe(first);
  expect(whereShouldBe(character, 2, overrides, calendar)).toBe(day);
});

test('accepts a complete day, including overnight coverage and a block ending at midnight', () => {
  expect(() => validateRoutine(character)).not.toThrow();
  expect(() => validateRoutine({ ...character, routine: [{ ...day, from: 0, to: 1440 }] })).not.toThrow();
  expect(() => validateRoutine({
    ...character,
    routine: [{ ...day, from: 0 }, { ...night, to: 0 }],
  })).not.toThrow();
});

test.each([
  [[], 'CHAR_SCHEDULE_GAP', 0],
  [[night], 'CHAR_SCHEDULE_GAP', 360],
  [[night, { ...day, from: 361 }], 'CHAR_SCHEDULE_GAP', 360],
  [[night, { ...day, from: 359 }], 'CHAR_SCHEDULE_OVERLAP', 359],
  [[{ ...night, to: night.from }], 'CHAR_INVALID_SCHEDULE', night.from],
] as const)('rejects invalid coverage %#', (routine, code, minute) => {
  expect(() => validateRoutine({ ...character, routine: [...routine] }))
    .toThrow(expect.objectContaining({ code, minute, characterId: character.id }));
});

test('reports a gap at lookup if the base routine was not validated', () => {
  expect(() => whereShouldBe({ ...character, routine: [night] }, 0, [], calendar))
    .toThrow(expect.objectContaining({ code: 'CHAR_SCHEDULE_GAP', minute: 480 }));
});
