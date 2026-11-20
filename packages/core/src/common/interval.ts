/** Whole minutes since the start of the scenario. */
export type GameMinutes = number;

export interface Interval {
  from: GameMinutes;
  to: GameMinutes;
}

export function contains(interval: Interval, minute: GameMinutes): boolean {
  return interval.from <= minute && minute < interval.to;
}

export function overlaps(left: Interval, right: Interval): boolean {
  return Math.max(left.from, right.from) < Math.min(left.to, right.to);
}

export function intersect(left: Interval, right: Interval): Interval | null {
  const from = Math.max(left.from, right.from);
  const to = Math.min(left.to, right.to);
  return from < to ? { from, to } : null;
}
