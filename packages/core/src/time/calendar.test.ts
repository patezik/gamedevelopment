import { describe, expect, it } from 'vitest';
import { Calendar, dayPeriodOf } from './calendar.ts';

const cal = new Calendar('2026-01-14T08:00:00');

describe('Calendar.toDisplay', () => {
  it('t = 0 is day 1 at the preset start time', () => {
    expect(cal.toDisplay(0)).toEqual({
      day: 1,
      hh: 8,
      mm: 0,
      period: 'morning',
      dateIso: '2026-01-14T08:00:00',
    });
  });

  it.each([
    [959, 1, 23, 59, '2026-01-14T23:59:00'], // 23:59 still day 1
    [960, 2, 0, 0, '2026-01-15T00:00:00'], // midnight changes the day
    [1439, 2, 7, 59, '2026-01-15T07:59:00'],
    [4320, 4, 8, 0, '2026-01-17T08:00:00'], // scenario end, 3 days
  ])('t = %i -> day %i %i:%i', (t, day, hh, mm, dateIso) => {
    expect(cal.toDisplay(t)).toMatchObject({ day, hh, mm, dateIso });
  });

  it.each([
    [-1, 1, 7, 59],
    [-479, 1, 0, 1],
    [-480, 1, 0, 0], // prehistory still inside day 1 until midnight
    [-481, 0, 23, 59], // before the start date: day 0
    [-1920, 0, 0, 0], // first minute of day 0
    [-1921, -1, 23, 59],
  ])('negative t = %i -> day %i %i:%i', (t, day, hh, mm) => {
    expect(cal.toDisplay(t)).toMatchObject({ day, hh, mm });
  });

  it('crosses month, year and leap-day boundaries', () => {
    expect(new Calendar('2026-12-31T23:00:00').toDisplay(60).dateIso).toBe('2027-01-01T00:00:00');
    expect(new Calendar('2024-02-28T12:00:00').toDisplay(1440).dateIso).toBe('2024-02-29T12:00:00');
    expect(new Calendar('2026-02-28T12:00:00').toDisplay(1440).dateIso).toBe('2026-03-01T12:00:00');
    expect(new Calendar('2026-03-01T00:00:00').toDisplay(-1).dateIso).toBe('2026-02-28T23:59:00');
  });

  it('is a pure function of its inputs', () => {
    expect(cal.toDisplay(777)).toEqual(new Calendar('2026-01-14T08:00:00').toDisplay(777));
  });

  it('rejects non-integer minutes', () => {
    expect(() => cal.toDisplay(1.5)).toThrow(RangeError);
    expect(() => cal.toDisplay(Number.NaN)).toThrow(RangeError);
  });
});

describe('day periods', () => {
  it.each([
    [5, 'night'],
    [6, 'morning'], // 05:59 -> 06:00: night -> morning
    [11, 'morning'],
    [12, 'day'],
    [17, 'day'],
    [18, 'evening'],
    [21, 'evening'],
    [22, 'night'],
    [0, 'night'],
  ] as const)('hour %i is %s', (hh, period) => {
    expect(dayPeriodOf(hh)).toBe(period);
  });

  it('changes night -> morning at 06:00 on the clock', () => {
    const c = new Calendar('2026-01-14T05:59:00');
    expect(c.toDisplay(0).period).toBe('night');
    expect(c.toDisplay(1).period).toBe('morning');
  });
});

describe('Calendar.format', () => {
  it('formats "День N, hh:mm"', () => {
    expect(cal.format(0)).toBe('День 1, 08:00');
    expect(cal.format(1060)).toBe('День 2, 01:40');
    expect(new Calendar('2026-01-14T21:40:00').format(1440)).toBe('День 2, 21:40');
    expect(cal.format(-481)).toBe('День 0, 23:59');
  });
});

describe('Calendar constructor', () => {
  it('accepts a start without seconds', () => {
    expect(new Calendar('2026-01-14T08:00').toDisplay(0).hh).toBe(8);
  });

  it.each([
    '2026-01-14',
    '2026-01-14T08:00:00Z', // zone suffixes are not wall time
    '2026-01-14T08:00:00+03:00',
    '2026-01-14T08:00:30',
    '2026-13-01T00:00:00',
    '2026-02-30T00:00:00',
    '2026-01-14T24:00:00',
    '2026-01-14T08:60:00',
    '',
  ])('rejects %j', (iso) => {
    expect(() => new Calendar(iso)).toThrow(RangeError);
  });
});
