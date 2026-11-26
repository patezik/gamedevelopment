import { fileURLToPath } from 'node:url';
import { loadScenarioFromDir } from '@hs/core/content';
import { CONCEALMENT_VERBS } from '@hs/core/evidence';
import { ATTACK_VERB } from '@hs/core/survival';
import { solveDeduction } from '@hs/validator';
import { describe, expect, test } from 'vitest';
import { generateInvestigation } from './index.ts';
import { MOTIVE_EVENT_VERB } from './stages/conflict-gen.ts';
import { DEATH_VERB } from './stages/history-sim.ts';
import { RELATIONSHIP_EVENT_VERB, SECRET_EVENT_VERB } from './stages/social-gen.ts';
import { IDLE_VERB } from './stages/testimony-gen.ts';

/*
 * CNT-004: trace and deduction rules of sanatorium_winter on generated cases. Rule-level unit tests
 * are packages/core/src/content/sanatorium-rules.test.ts.
 */

const scenarios = new URL('../../../content/scenarios/', import.meta.url);
const sanatorium = loadScenarioFromDir(fileURLToPath(new URL('sanatorium_winter/', scenarios)));
const traced = new Set(sanatorium.traceRules.map(({ verb }) => verb));

/** Verbs whose events leave no trace by design (mvp-scenario-sanatorium.md, CNT-004). */
const UNTRACED: Readonly<Record<string, string>> = {
  move: 'presence is recorded by stays; a passage leaves no record in the MVP',
  talk: 'a conversation becomes knowledge and testimony, not a clue',
  [DEATH_VERB]: 'the death is the incident itself, not evidence of who caused it',
  [MOTIVE_EVENT_VERB]: 'backstory years before the game; proved by testimony (OQ-20)',
  [RELATIONSHIP_EVENT_VERB]: 'backstory years before the game; known through testimony',
  [SECRET_EVENT_VERB]: 'backstory years before the game; known through testimony',
};
/** Verbs that need a trace but have none yet; each names its open question. */
const PENDING: Readonly<Record<string, string>> = {
  [ATTACK_VERB]: 'OQ-41: the attack trace needs a template, texts and hotspots',
};

describe('sanatorium_winter verb coverage', () => {
  test('every verb of the crime plans, concealment and the routine has a trace rule', () => {
    const verbs = new Set([
      ...sanatorium.crimes.flatMap(({ plan }) => plan.map(({ verb }) => verb)),
      ...CONCEALMENT_VERBS,
      IDLE_VERB,
    ]);
    for (const verb of verbs) expect(traced.has(verb), verb).toBe(true);
  });

  test('a verb without a rule is listed with its reason, and a listed verb has no rule', () => {
    for (const verb of [...Object.keys(UNTRACED), ...Object.keys(PENDING)]) {
      expect(traced.has(verb), `${verb} has a rule now: drop it from the list`).toBe(false);
    }
  });

  test('generated truth logs use only traced or listed verbs', () => {
    const seen = new Set<string>();
    for (const seed of ['3', '7', '24']) {
      const result = generateInvestigation({ scenarioId: 'sanatorium_winter', seed }, sanatorium);
      if (!result.ok) throw new Error(`seed ${seed}: rejected`);
      for (const { verb } of result.investigation.truth.events()) seen.add(verb);
    }
    for (const verb of seen) {
      expect(traced.has(verb) || verb in UNTRACED, verb).toBe(true);
    }
    // Every routine and crime verb shows up, so the check above is not vacuous.
    for (const verb of ['stay', 'move', 'take', 'poison', 'strike', 'tamper', 'stage', 'hide'])
      expect(seen.has(verb), verb).toBe(true);
  }, 60_000);
});

interface Span {
  readonly where: string;
  readonly from: number;
  readonly to: number;
}

/** Interval of a claim argument: `a..b` or a single minute. */
function span(value: string | undefined): { from: number; to: number } | undefined {
  const match = /^(-?\d+)(?:\.\.(-?\d+))?$/.exec(value ?? '');
  if (!match) return undefined;
  const from = Number(match[1]);
  return { from, to: match[2] === undefined ? from + 1 : Number(match[2]) };
}

// One accepted case per seed: poisoning 7, 8; boiler_accident 3, 15; staged_fall 24, 40.
test('sanatorium_winter: what the ideal player can establish is true', () => {
  const templates = new Set<string>();
  for (const seed of ['3', '7', '8', '15', '24', '40']) {
    const result = generateInvestigation({ scenarioId: 'sanatorium_winter', seed }, sanatorium);
    if (!result.ok) throw new Error(`seed ${seed}: rejected`);
    templates.add(result.report.chosen?.template ?? '');
    const { investigation, server } = result;
    const { culpritIds, victimIds, window, keyEventIds } = investigation.truth.incident;
    const events = investigation.truth.events();
    const scene = events.find(({ id }) => id === keyEventIds[0])?.location;
    const where = new Map<string, Span[]>();
    const motives = new Set<string>();
    for (const event of events) {
      for (const fact of event.facts) {
        if (fact.kind === 'motive') motives.add(`${fact.who}>${fact.against}`);
        if (fact.kind === 'at') {
          where.set(fact.who, [
            ...(where.get(fact.who) ?? []),
            { where: fact.where, ...fact.interval },
          ]);
        }
      }
      for (const who of event.actorIds) {
        const lasting = {
          where: event.location,
          from: event.t,
          to: event.t + Math.max(1, event.duration),
        };
        where.set(who, [...(where.get(who) ?? []), lasting]);
      }
    }
    const atScene = (who: string, { from, to }: { from: number; to: number }) =>
      (where.get(who) ?? []).some((s) => s.where === scene && s.from < to && from < s.to);

    const solution = solveDeduction({
      investigation,
      clues: server.clues,
      rules: server.deductionRules,
      statements: server.statements,
      startLocationId: server.startLocationId,
    });
    for (const { kind, subject, claim } of solution.claims) {
      const args = claim.slice(claim.indexOf('(') + 1, -1).split(',');
      const label = `seed ${seed}: ${claim}`;
      if (kind === 'means') expect(culpritIds, label).toContain(subject);
      if (kind === 'motive') expect(motives.has(`${args[0]}>${args[1]}`), label).toBe(true);
      if (kind === 'opportunity') expect(atScene(subject, window), label).toBe(true);
      if (kind === 'alibi' || kind === 'no_access') {
        const interval = span(args[1]);
        expect(interval, label).toBeDefined();
        expect(atScene(subject, interval!), label).toBe(false);
      }
      if (kind === 'contradiction') {
        const lies = server.testimony.filter(
          ({ speakerId, proposition: p }) =>
            speakerId === subject &&
            p.kind === 'at' &&
            p.who === subject &&
            (where.get(subject) ?? []).some(
              (s) => s.where !== p.where && s.from < p.interval.to && p.interval.from < s.to,
            ),
        );
        expect(lies.length, label).toBeGreaterThan(0);
      }
    }
    expect(solution.exonerated.filter((id) => culpritIds.includes(id))).toEqual([]);
    for (const id of culpritIds) {
      expect([...(solution.kindsBy.get(id) ?? [])].sort(), `seed ${seed}: ${id}`).toEqual(
        expect.arrayContaining(['means', 'motive', 'opportunity']),
      );
    }
    expect(victimIds.length).toBeGreaterThan(0);
  }
  expect([...templates].sort()).toEqual(['boiler_accident', 'poisoning', 'staged_fall']);
}, 120_000);
