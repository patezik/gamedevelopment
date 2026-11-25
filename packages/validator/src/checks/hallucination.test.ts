import { describe, expect, it } from 'vitest';
import { cleanContext, cleanInvestigation } from '../../test/mutations.ts';
import type { ValidationContext } from '../check.ts';
import { validateInvestigation } from '../validate.ts';
import { hallucinationCheck } from './index.ts';

const run = (hallucinations?: readonly string[], extra: ValidationContext = {}) =>
  validateInvestigation(cleanInvestigation(), {
    checks: [hallucinationCheck],
    context: { ...cleanContext(), ...(hallucinations && { hallucinations }), ...extra },
  }).findings.map(({ code, data }) => ({ code, term: data?.term }));

describe('V-HALLUCINATION', () => {
  it('passes atmosphere-only content', () => {
    expect(run(['Do not turn around.', 'Are you still there?', '3 new messages'])).toEqual([]);
  });

  it('has nothing to inspect without a hallucination pool', () => {
    expect(run(undefined)).toEqual([]);
    expect(run([])).toEqual([]);
  });

  it.each([
    ['a character name', 'Morgan Pike is behind you', 'Morgan Pike'],
    ['a first name alone', 'Where is Morgan?', 'Morgan'],
    ['a surname alone, any case', 'tell PIKE', 'Pike'],
    ['a location name', 'He went to the Archive', 'Archive'],
    ['a character id', 'ch_bursar did it', 'ch_bursar'],
    ['a location id', 'meet at loc_study', 'loc_study'],
    ['an item id', 'take it_study_key', 'it_study_key'],
  ])('rejects %s', (_name, text, term) => {
    expect(run([text])).toEqual([{ code: 'HALLUCINATION_REFERS_TO_FACT', term }]);
  });

  it('rejects a clue id and an event id', () => {
    const investigation = cleanInvestigation();
    const eventId = investigation.truth.events()[0]?.id ?? '';
    const clueId = cleanContext().clues?.[0]?.id ?? '';
    expect(eventId).not.toBe('');
    expect(clueId).not.toBe('');
    expect(run([`see ${eventId}`]).map(({ code }) => code)).toEqual([
      'HALLUCINATION_REFERS_TO_FACT',
    ]);
    expect(run([`open ${clueId}`]).map(({ code }) => code)).toEqual([
      'HALLUCINATION_REFERS_TO_FACT',
    ]);
  });

  it('matches whole words only', () => {
    expect(run(['The archives are quiet', 'Hallway lights flicker'])).toEqual([]);
  });

  it('reports each offending text once and keeps the clean ones', () => {
    expect(run(['fine', 'Ada Vale', 'also fine', 'the Pantry']).map(({ term }) => term)).toEqual([
      'Ada Vale',
      'Pantry',
    ]);
  });
});
