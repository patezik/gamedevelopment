/**
 * Game minutes since the start of the case as `H:MM` ("0:00" is the opening of the scenario).
 * The view carries no calendar date, so notes and map pins show the case clock.
 */
export function formatCaseTime(at: number): string {
  const abs = Math.abs(at);
  const text = `${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`;
  return at < 0 ? `до начала, ${text}` : text;
}
