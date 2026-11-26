import type { ClaimContext } from './claims.ts';
import type { HeardStatement, PlayerKnowledge } from './player-knowledge.ts';

/** How strongly the player suspects someone, in the order the case board offers them. */
export const SUSPICION_LEVELS = ['none', 'possible', 'prime'] as const;
export type SuspicionLevel = (typeof SUSPICION_LEVELS)[number];

/**
 * The player's own mark on a character (investigation-model.md section 1: a Suspect exists only
 * as this mark). Nothing in the game sets it but the player.
 */
export interface Suspicion {
  readonly characterId: string;
  readonly level: SuspicionLevel;
  readonly note?: string;
}

/** How a character figures in what the player holds: as the one it is about, or the one aimed at. */
export type LinkRole = 'subject' | 'target';

/** One reason a character is a person of interest, pointing at the clue or statement it comes from. */
export type PersonLink =
  | {
      readonly source: 'clue';
      readonly clueId: string;
      /** The clue's claim reference that names the character, for example `means(ch_bursar)`. */
      readonly claim: string;
      readonly role: LinkRole;
    }
  | {
      readonly source: 'statement';
      readonly statementId: string;
      /** The kind of the heard proposition, for example `at` or `motive`. */
      readonly proposition: string;
      readonly role: LinkRole;
    };

/** A character linked to at least one clue found or statement heard. A hint, never an accusation. */
export interface PersonOfInterest {
  readonly characterId: string;
  /** Distinct, in the order the player got them. */
  readonly linkedClueIds: readonly string[];
  readonly linkedStatementIds: readonly string[];
  readonly links: readonly PersonLink[];
}

/**
 * Which arguments of a clue reference name characters. The claim kinds of investigation-model.md
 * section 3: the first argument is the character the claim is about; `motive(c, victim)` also aims
 * at the victim. `contradiction(statement, fact)` and unknown references name no one.
 */
const CHARACTER_ARGUMENTS: Readonly<Record<string, readonly LinkRole[]>> = {
  presence: ['subject'],
  opportunity: ['subject'],
  means: ['subject'],
  alibi: ['subject'],
  motive: ['subject', 'target'],
};

/** Clue references are ground atoms `name(arg,...)`; nested terms name no character here. */
const REFERENCE = /^([A-Za-z_][\w-]*)\(([^()]*)\)$/;

function charactersOfReference(reference: string): [string, LinkRole][] {
  const match = REFERENCE.exec(reference);
  const roles =
    match && Object.hasOwn(CHARACTER_ARGUMENTS, match[1] ?? '')
      ? CHARACTER_ARGUMENTS[match[1] ?? '']
      : undefined;
  if (!match || !roles) return [];
  const args = (match[2] ?? '').split(',');
  return roles.flatMap((role, i): [string, LinkRole][] => {
    const arg = args[i] ?? '';
    return arg === '' || arg.startsWith('$') ? [] : [[arg, role]];
  });
}

/**
 * The characters a heard proposition is about. The proposition's shape is the truth model's,
 * which this module must not import, so it is read field by field and anything unexpected is
 * skipped. The speaker is not linked for speaking: a witness is not a person of interest until
 * something the player holds is about them (a self-report is).
 */
function charactersOfStatement(statement: HeardStatement): [string, LinkRole][] {
  const p = statement.proposition as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof p[key] === 'string' && p[key] !== '' ? p[key] : undefined;
  const character = (key: string): string | undefined => {
    const ref = p[key] as { kind?: unknown; id?: unknown } | undefined;
    return typeof ref === 'object' &&
      ref !== null &&
      ref.kind === 'character' &&
      typeof ref.id === 'string' &&
      ref.id !== ''
      ? ref.id
      : undefined;
  };
  const found: [string | undefined, LinkRole][] = [];
  switch (p.kind) {
    case 'at':
    case 'possessed':
      found.push([text('who'), 'subject']);
      break;
    case 'did':
      found.push([text('who'), 'subject'], [character('target'), 'target']);
      break;
    case 'motive':
      found.push([text('who'), 'subject'], [text('against'), 'target']);
      break;
    case 'relation':
      found.push([text('a'), 'subject'], [text('b'), 'subject']);
      break;
    case 'state':
      found.push([character('entity'), 'subject']);
      break;
  }
  return found.filter((pair): pair is [string, LinkRole] => pair[0] !== undefined);
}

interface Building {
  readonly clueIds: Set<string>;
  readonly statementIds: Set<string>;
  readonly links: PersonLink[];
  readonly seen: Set<string>;
}

/**
 * Characters linked to what the player holds, each with the reasons. A clue links the characters
 * its claim references name (`ClaimContext.clues`, the clue's `supports`); a heard statement links
 * the characters its proposition is about. Nothing else does: a contact, a conversation or the
 * truth never makes anyone a person of interest, and no one is ever singled out as the culprit.
 *
 * Reads `PlayerKnowledge` and the clues' references only. Deterministic: people and their links
 * follow the journal (game time, then the order learned); the same reason is listed once.
 */
export function personsOfInterest(
  knowledge: PlayerKnowledge,
  context: Pick<ClaimContext, 'clues'>,
): PersonOfInterest[] {
  const people = new Map<string, Building>();
  const statements = new Map(knowledge.statements.map((statement) => [statement.id, statement]));
  const link = (characterId: string, reason: PersonLink): void => {
    let person = people.get(characterId);
    if (!person) {
      person = { clueIds: new Set(), statementIds: new Set(), links: [], seen: new Set() };
      people.set(characterId, person);
    }
    const key =
      reason.source === 'clue'
        ? `clue|${reason.clueId}|${reason.claim}|${reason.role}`
        : `statement|${reason.statementId}|${reason.role}`;
    if (person.seen.has(key)) return;
    person.seen.add(key);
    person.links.push(reason);
    if (reason.source === 'clue') person.clueIds.add(reason.clueId);
    else person.statementIds.add(reason.statementId);
  };

  for (const entry of knowledge.journal) {
    if (entry.kind === 'clue') {
      for (const claim of context.clues.get(entry.clueId)?.supports ?? []) {
        for (const [characterId, role] of charactersOfReference(claim)) {
          link(characterId, { source: 'clue', clueId: entry.clueId, claim, role });
        }
      }
    } else if (entry.kind === 'statement') {
      const statement = statements.get(entry.statementId);
      if (!statement) continue;
      for (const [characterId, role] of charactersOfStatement(statement)) {
        link(characterId, {
          source: 'statement',
          statementId: statement.id,
          proposition: String((statement.proposition as { kind: unknown }).kind),
          role,
        });
      }
    }
  }

  return [...people].map(([characterId, person]) => ({
    characterId,
    linkedClueIds: [...person.clueIds],
    linkedStatementIds: [...person.statementIds],
    links: person.links,
  }));
}

/**
 * Characters the player may name as the target of a motive: those the clues found and the
 * statements heard say something is aimed at (`motive(_, v)`, `about(_, v)`, a heard motive
 * `against`). Only the second argument is read, never whose motive it is, so the list names no
 * culprit and does not depend on the truth. In the order the player learned them, without repeats.
 */
export function motiveTargets(
  knowledge: PlayerKnowledge,
  context: Pick<ClaimContext, 'clues'>,
): string[] {
  const targets = new Set<string>();
  const add = (id: unknown): void => {
    if (typeof id === 'string' && id !== '' && !id.startsWith('$')) targets.add(id);
  };
  const statements = new Map(knowledge.statements.map((statement) => [statement.id, statement]));
  for (const entry of knowledge.journal) {
    if (entry.kind === 'clue') {
      for (const claim of context.clues.get(entry.clueId)?.supports ?? []) {
        const match = REFERENCE.exec(claim);
        if (match?.[1] === 'motive' || match?.[1] === 'about') add((match[2] ?? '').split(',')[1]);
      }
    } else if (entry.kind === 'statement') {
      const p = statements.get(entry.statementId)?.proposition as
        Record<string, unknown> | undefined;
      if (p?.kind === 'motive') add(p.against);
    }
  }
  return [...targets];
}
