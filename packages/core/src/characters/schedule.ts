import { contains, type GameMinutes, type Interval } from '../common/index.ts';
import type { Calendar } from '../time/index.ts';
import type { Character, RoutineBlock } from './character.ts';

const MINUTES_PER_DAY = 1440;

export interface ScheduleOverride {
  readonly characterId: string;
  readonly interval: Interval;
  readonly block: RoutineBlock;
}

type ScheduleErrorCode = 'CHAR_SCHEDULE_GAP' | 'CHAR_SCHEDULE_OVERLAP' | 'CHAR_INVALID_SCHEDULE';

export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;
  readonly characterId: string;
  readonly minute: number;

  constructor(
    code: ScheduleErrorCode,
    characterId: string,
    minute: number,
  ) {
    super(`${code} for ${characterId} at minute ${minute}`);
    this.code = code;
    this.characterId = characterId;
    this.minute = minute;
    this.name = 'ScheduleError';
  }
}

function dayIntervals({ from, to }: RoutineBlock): Interval[] {
  if (from <= to) return [{ from, to }];
  return [{ from, to: MINUTES_PER_DAY }, { from: 0, to }].filter((part) => part.from < part.to);
}

export function validateRoutine(c: Pick<Character, 'id' | 'routine'>): void {
  const intervals = c.routine.flatMap((block) => {
    const { from, to } = block;
    if (!Number.isInteger(from) || from < 0 || from >= MINUTES_PER_DAY ||
        !Number.isInteger(to) || to < 0 || to > MINUTES_PER_DAY || from === to) {
      throw new ScheduleError('CHAR_INVALID_SCHEDULE', c.id, from);
    }
    return dayIntervals(block);
  }).sort((a, b) => a.from - b.from || a.to - b.to);

  let coveredUntil = 0;
  for (const interval of intervals) {
    if (interval.from > coveredUntil) throw new ScheduleError('CHAR_SCHEDULE_GAP', c.id, coveredUntil);
    if (interval.from < coveredUntil) throw new ScheduleError('CHAR_SCHEDULE_OVERLAP', c.id, interval.from);
    coveredUntil = interval.to;
  }
  if (coveredUntil < MINUTES_PER_DAY) {
    throw new ScheduleError('CHAR_SCHEDULE_GAP', c.id, coveredUntil);
  }
}

export function whereShouldBe(
  c: Pick<Character, 'id' | 'routine'>,
  t: GameMinutes,
  overrides: readonly ScheduleOverride[],
  calendar: Calendar,
): RoutineBlock {
  const { hh, mm } = calendar.toDisplay(t);
  const override = overrides.findLast(({ characterId, interval }) => characterId === c.id && contains(interval, t));
  if (override) return override.block;

  const minute = hh * 60 + mm;
  const block = c.routine.find((entry) => dayIntervals(entry).some((interval) => contains(interval, minute)));
  if (!block) throw new ScheduleError('CHAR_SCHEDULE_GAP', c.id, minute);
  return block;
}
