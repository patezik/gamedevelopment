/** Minutes since the scenario start (t = 0). Negative values are generation prehistory. */
export type GameMinutes = number;

export type DayPeriod = 'morning' | 'day' | 'evening' | 'night';

export interface CalendarDisplay {
  /** 1-based scenario day; prehistory before the start date gives 0 and below. */
  day: number;
  hh: number;
  mm: number;
  period: DayPeriod;
  /** Wall-clock local time, `YYYY-MM-DDTHH:mm:00`, no time zone. */
  dateIso: string;
}

const MINUTES_PER_DAY = 1440;
// Wall-clock only: no zone suffix, so parsing never depends on the host time zone.
const START_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::00)?$/;

/** Period boundaries from docs/simulation/time-system.md section 1. */
export function dayPeriodOf(hh: number): DayPeriod {
  if (hh >= 6 && hh < 12) return 'morning';
  if (hh >= 12 && hh < 18) return 'day';
  if (hh >= 18 && hh < 22) return 'evening';
  return 'night';
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Days since 1970-01-01 for a proleptic Gregorian date (Hinnant's days_from_civil). */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of {@link daysFromCivil}. */
function civilFromDays(z0: number): { y: number; m: number; d: number } {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Converts game minutes to a calendar display. The only place a calendar date exists. */
export class Calendar {
  private readonly startDays: number;
  private readonly startMinuteOfDay: number;

  /** @param startIso preset `time.startDateTime`, e.g. `2026-01-14T08:00:00` (local wall time). */
  constructor(startIso: string) {
    const match = START_ISO.exec(startIso);
    if (!match) throw new RangeError(`Invalid startDateTime: ${startIso}`);
    const [y, m, d, hh, mm] = match.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
      number,
    ];
    if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m) || hh > 23 || mm > 59) {
      throw new RangeError(`Invalid startDateTime: ${startIso}`);
    }
    this.startDays = daysFromCivil(y, m, d);
    this.startMinuteOfDay = hh * 60 + mm;
  }

  toDisplay(t: GameMinutes): CalendarDisplay {
    if (!Number.isInteger(t)) throw new RangeError(`GameMinutes must be an integer, got ${t}`);
    const total = this.startMinuteOfDay + t;
    const dayOffset = Math.floor(total / MINUTES_PER_DAY);
    const minuteOfDay = total - dayOffset * MINUTES_PER_DAY;
    const hh = Math.floor(minuteOfDay / 60);
    const mm = minuteOfDay % 60;
    const { y, m, d } = civilFromDays(this.startDays + dayOffset);
    return {
      day: dayOffset + 1,
      hh,
      mm,
      period: dayPeriodOf(hh),
      dateIso: `${pad(y, 4)}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00`,
    };
  }

  /** Display string such as `День 2, 21:40`. */
  format(t: GameMinutes): string {
    const { day, hh, mm } = this.toDisplay(t);
    return `День ${day}, ${pad(hh)}:${pad(mm)}`;
  }
}
