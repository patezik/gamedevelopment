import type { EndingView } from '@hs/protocol';
import { endingFor, type Vitals } from '../survival/index.ts';
import type { Verdict } from './actions/state.ts';
import type { Investigation } from './investigation.ts';

export type EndingId = EndingView['endingId'];

/** The six endings of game-design.md section 5. Texts are placeholders for CONTENT work. */
const TEXTS: Readonly<Record<EndingId, { title: string; text: string }>> = {
  solved: {
    title: 'Дело раскрыто',
    text: 'Виновные названы, и каждое звено обвинения подтверждено уликами.',
  },
  partial: {
    title: 'За недостатком улик',
    text: 'Вы назвали верно, но доказательств не хватило: виновного отпустили.',
  },
  wrong_accusation: {
    title: 'Ложное обвинение',
    text: 'Вы обвинили не того. Настоящий виновный остался на свободе.',
  },
  time_up: {
    title: 'Время вышло',
    text: 'Срок расследования истёк, и обвинение так и не прозвучало.',
  },
  death: { title: 'Гибель', text: 'Вы не пережили это расследование.' },
  madness: { title: 'Сигнал победил', text: 'Рассудок оставил вас. Сигнал победил.' },
};

/**
 * The ending the game is in, or `undefined` while it goes on. The accusation that ended the game
 * comes first; then the vitals (death before madness); then Static at 100; then the clock.
 */
export function endingOf(
  state: { readonly verdict: Verdict | undefined; readonly vitals: { readonly vitals: Vitals } },
  now: number,
  durationMinutes: number,
  /** Ending Static forces at 100 (ENG-010); `undefined` while Static is below it. */
  staticEnding?: EndingId,
): EndingId | undefined {
  if (state.verdict) return state.verdict.endingId;
  const forced = endingFor(state.vitals.vitals);
  if (forced) return forced;
  if (staticEnding) return staticEnding;
  return now >= durationMinutes ? 'time_up' : undefined;
}

/**
 * `EndingView` with the `TruthRecap`. This is the only projection of the truth to a client, and
 * it exists only for an ended game: callers pass an ending only when `endingOf` returned one.
 */
export function endingView(
  endingId: EndingId,
  investigation: Pick<Investigation, 'characters' | 'truth'>,
  verdict: Verdict | undefined,
): EndingView {
  const names = new Map(investigation.characters.map(({ id, name }) => [id, name]));
  const responsible = investigation.truth.incident.culpritIds.map((id) => ({
    id,
    name: names.get(id) ?? id,
  }));
  return {
    endingId,
    ...TEXTS[endingId],
    ...(verdict && { proven: { ...verdict.proven } }),
    recap: {
      summary: `Ответственны: ${responsible.map(({ name }) => name).join(', ')}.`,
      responsible,
    },
  };
}
