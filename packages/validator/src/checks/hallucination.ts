import type { Investigation } from '@hs/core/game';
import type { Check, FindingInput } from '../check.ts';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `needle` appears in `haystack` as a whole word or phrase (case-insensitive). */
function mentions(haystack: string, needle: string): boolean {
  const trimmed = needle.trim();
  if (trimmed.length === 0) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}_])`, 'iu').test(
    haystack,
  );
}

/** Everything a hallucination must not name: the facts that decide the case, with a label. */
function solutionTerms(
  { characters, world, truth }: Investigation,
  clueIds: readonly string[],
): { readonly term: string; readonly kind: string }[] {
  const terms: { term: string; kind: string }[] = [];
  for (const character of characters) {
    terms.push({ term: character.id, kind: 'character id' });
    terms.push({ term: character.name, kind: 'character name' });
    // A first name or surname alone points at the person as well; short words are too common.
    for (const part of character.name.split(/\s+/)) {
      if (part.length >= 4) terms.push({ term: part, kind: 'character name' });
    }
  }
  for (const location of world.locations.snapshot().locations) {
    terms.push({ term: location.id, kind: 'location id' });
    terms.push({ term: location.name, kind: 'location name' });
  }
  for (const { item } of world.items.snapshot().initial) {
    terms.push({ term: item.id, kind: 'item id' });
  }
  for (const event of truth.events()) terms.push({ term: event.id, kind: 'event id' });
  for (const id of clueIds) terms.push({ term: id, kind: 'clue id' });
  return terms;
}

/**
 * V-HALLUCINATION: hallucinations are atmosphere, never evidence. Every text the preset may show
 * as a hallucination (`context.hallucinations`) must not name a character, location, item, event
 * or clue of the case, so a hallucination cannot mislead the player about the solution. Without
 * `hallucinations` in the context there is nothing to inspect and the check passes.
 */
export const hallucinationCheck: Check = {
  id: 'V-HALLUCINATION',
  description: 'Hallucination content does not refer to facts of the case',
  run(investigation, { hallucinations, clues }) {
    if (hallucinations === undefined) return [];
    const terms = solutionTerms(
      investigation,
      (clues ?? []).map(({ id }) => id),
    );
    const findings: FindingInput[] = [];
    for (const text of hallucinations) {
      const hit = terms.find(({ term }) => mentions(text, term));
      if (hit === undefined) continue;
      findings.push({
        severity: 'error',
        code: 'HALLUCINATION_REFERS_TO_FACT',
        message: `The hallucination "${text}" mentions the ${hit.kind} "${hit.term}"`,
        eventIds: [],
        data: { kind: hit.kind, term: hit.term },
      });
    }
    return findings;
  },
};
