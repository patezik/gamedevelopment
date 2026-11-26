import type { PhoneEvent } from '../phone/index.ts';
import { createRng } from '../rng/index.ts';
import { hallucinationIds, rollHallucination, type HallucinationPool } from '../survival/index.ts';
import type { PhoneRuntime } from './actions/index.ts';

/** One roll per this many game minutes (survival-horror.md section 5). */
export const HALLUCINATION_ROLL_MINUTES = 30;

export interface HallucinationEnv {
  readonly seed: string;
  readonly pool: HallucinationPool;
  readonly sanity: number;
  readonly staticLevel: number;
}

/**
 * Rolls for every grid minute in `(from, to]` and puts the results on the phone. Each roll has its
 * own stream named by its minute, so the outcome needs no saved state and a resumed game agrees.
 */
export function rollHallucinationsBetween(
  phone: PhoneRuntime,
  from: number,
  to: number,
  env: HallucinationEnv,
): PhoneEvent[] {
  const events: PhoneEvent[] = [];
  const root = createRng(env.seed).fork('hallucination');
  const first = (Math.floor(from / HALLUCINATION_ROLL_MINUTES) + 1) * HALLUCINATION_ROLL_MINUTES;
  for (let minute = first; minute <= to; minute += HALLUCINATION_ROLL_MINUTES) {
    const rolled = rollHallucination(
      root.fork(String(minute)),
      {
        sanity: env.sanity,
        staticLevel: env.staticLevel,
        minute,
        active: hallucinationIds(phone.state).size,
      },
      env.pool,
    );
    for (const event of rolled) events.push(phone.emit(event));
  }
  return events;
}
