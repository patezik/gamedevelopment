import { Calendar } from '../time/index.ts';
import { createRng } from '../rng/index.ts';
import { renderTestimony } from '../text/index.ts';
import type { Statement } from '../knowledge/index.ts';
import type { Proposition } from '../truth/index.ts';
import type { DialogueLine } from './actions/index.ts';
import type { Investigation } from './investigation.ts';

export type TextTemplates = ReadonlyMap<string, readonly string[]>;

/** Key an old save or a client without templates uses for "nothing was said". */
const LEGACY_NONE = 'testimony_none';
const NONE = 'testimony_unknown';

function interval(
  calendar: Calendar,
  { from, to }: { from: number; to: number },
): Record<string, string> {
  const clock = (minute: number) => {
    const { hh, mm } = calendar.toDisplay(minute);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  return { from: clock(from), to: clock(to), time: clock(from) };
}

/**
 * Template values taken from the speaker's own proposition. They are the same for a true and a
 * false statement, so the text never shows whether the speaker lies (rule 1).
 */
function valuesOf(proposition: Proposition, investigation: Investigation): Record<string, string> {
  const { locations } = investigation.world;
  const calendar = new Calendar(locations.startDateTime);
  const person = (id: string) => investigation.characters.find((c) => c.id === id)?.name ?? id;
  const place = (id: string) => {
    try {
      return locations.describe(id).name;
    } catch {
      return id;
    }
  };
  // The data has no grammatical gender yet, so every ending is the masculine default.
  const base = { who_f: '', me_f: '' };
  switch (proposition.kind) {
    case 'at':
      return {
        ...base,
        who: person(proposition.who),
        where: place(proposition.where),
        ...interval(calendar, proposition.interval),
      };
    case 'did':
      return {
        ...base,
        who: person(proposition.who),
        where: place(proposition.where),
        action: proposition.verb,
        ...interval(calendar, { from: proposition.at, to: proposition.at }),
      };
    case 'possessed': {
      const item = investigation.world.items
        .snapshot()
        .initial.find((i) => i.item.id === proposition.item);
      return {
        ...base,
        who: person(proposition.who),
        item: item?.item.kind ?? proposition.item,
        ...interval(calendar, proposition.interval),
      };
    }
    case 'relation':
      return {
        ...base,
        a: person(proposition.a),
        b: person(proposition.b),
        relation: proposition.relType,
      };
    case 'motive':
      return {
        ...base,
        who: person(proposition.who),
        against: person(proposition.against),
        motive: proposition.motiveType,
      };
    case 'state':
      return {
        ...base,
        subject:
          proposition.entity.kind === 'character'
            ? person(proposition.entity.id)
            : proposition.entity.id,
        state: `${proposition.property}: ${String(proposition.value)}`,
        ...interval(calendar, proposition.interval),
      };
  }
}

export interface DialogueTextContext {
  readonly investigation: Investigation;
  readonly templates: TextTemplates;
  readonly statements: ReadonlyMap<string, Statement>;
}

/**
 * Turns a history line into text the player reads. A line that cannot be rendered (old save,
 * missing template or statement) keeps its stored text, so older histories still load.
 */
export function renderDialogueLine(
  line: DialogueLine,
  index: number,
  characterId: string,
  context: DialogueTextContext | undefined,
): string {
  if (line.speaker === 'player' || !context) return line.text;
  const { investigation, templates, statements } = context;
  const key = line.text === LEGACY_NONE ? NONE : line.text;
  const statement = line.statementId === undefined ? undefined : statements.get(line.statementId);
  const speaker = investigation.characters.find(({ id }) => id === characterId);
  const { agreeableness = 0.5, neuroticism = 0.5 } = speaker?.personality ?? {};
  try {
    const values = statement ? valuesOf(statement.proposition, investigation) : { me_f: '' };
    const rng = createRng(investigation.seed)
      .fork('dialogue')
      .fork(`${characterId}/${line.at}/${index}`);
    return renderTestimony(templates, key, values, rng, { agreeableness, neuroticism });
  } catch {
    return line.text;
  }
}
