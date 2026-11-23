import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { PERSONALITY_TRAITS } from '../common/index.ts';
import { loadScenarioFromDir } from './index.ts';
import type { ScenarioContent } from './scenario.ts';

/*
 * Static feasibility of the sanatorium_winter crime templates and motive rules (CNT-003).
 *
 * The generator stages that decide motives and culprits (GEN-004..GEN-006) do not exist yet, so
 * this test works at the archetype level: a relationship template "can" produce a relation and a
 * secret, an archetype "can" have a trait value inside its range, and the daily routine is the
 * only source of presence. A culprit is feasible when a motive rule can fire, the means can be
 * reached, the personality can satisfy the template and a witness-free window exists in which
 * only the culprit leaves their routine. The seed sweep over generated worlds stays with GEN-006.
 */

const root = fileURLToPath(new URL('../../../../content/scenarios/', import.meta.url));
const content = loadScenarioFromDir(join(root, 'sanatorium_winter'));

type Crime = ScenarioContent['crimes'][number];
type Motive = ScenarioContent['motives'][number];
type Archetype = ScenarioContent['archetypes'][number];
type Bound = { gt?: number | undefined; lt?: number | undefined };

const DAY = 1440;
const PLACEHOLDERS = new Set(['$c', '$v']);
const PLAN_TARGETS = new Set(['$means', '$victim', '$location']);
// Verbs that cause the death; the plan has exactly one such step, named "act".
const LETHAL_VERBS = new Set(['poison', 'strike', 'tamper']);
// Mechanisms that kill some time after the act, so the template needs deathDelayMinutes.
const DELAYED_VERBS = new Set(['poison', 'tamper']);
const SYMMETRIC_RELATIONS = new Set([
  'sibling',
  'spouse',
  'romance',
  'friendship',
  'rivalry',
  'past_conflict',
]);
const REVERSE_RELATIONS: Record<string, string> = { parent: 'child', child: 'parent' };

const archetypes = new Map(content.archetypes.map((archetype) => [archetype.id, archetype]));
const locations = new Map(content.locations.map((location) => [location.id, location]));
const items = new Map(content.items.map((item) => [item.id, item]));

function inDayWindow(minute: number, from = 0, to = DAY): boolean {
  return from <= to ? minute >= from && minute < to : minute >= from || minute < to;
}

function buildSchedule(archetype: Archetype): { location: string; activity: string }[] {
  const day = Array.from({ length: DAY }, () => ({ location: '', activity: '' }));
  for (const block of archetype.routine) {
    for (let minute = 0; minute < DAY; minute++) {
      if (inDayWindow(minute, block.from, block.to)) {
        day[minute] = { location: block.locationId, activity: block.activity };
      }
    }
  }
  return day;
}
const schedules = new Map(content.archetypes.map((a) => [a.id, buildSchedule(a)]));

function owned(archetype: string): Set<string> {
  return new Set(
    content.items.filter((item) => item.ownerArchetype === archetype).map((item) => item.id),
  );
}

function canEnter(archetype: string, locationId: string, minute: number, held: Set<string>) {
  const rules = locations.get(locationId)?.access ?? [];
  return (
    rules.length === 0 ||
    rules.some(
      (rule) =>
        (rule.from === undefined && rule.to === undefined
          ? true
          : inDayWindow(minute, rule.from, rule.to)) &&
        (rule.archetypes?.includes(archetype) ?? true) &&
        (rule.itemId === undefined || held.has(rule.itemId)),
    )
  );
}

const reachCache = new Map<string, Set<string>[]>();

/** For each minute of the day: locations an archetype can walk to from its routine location. */
function reachableByMinute(archetype: string, held: Set<string>): Set<string>[] {
  const key = `${archetype}|${[...held].sort().join(',')}`;
  let result = reachCache.get(key);
  if (!result) {
    result = Array.from({ length: DAY }, (_, minute) => explore(archetype, minute, held));
    reachCache.set(key, result);
  }
  return result;
}

function explore(archetype: string, minute: number, held: Set<string>): Set<string> {
  const start = schedules.get(archetype)![minute]!.location;
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = locations.get(queue.shift()!)!;
    for (const { to, locked } of current.connections) {
      if (seen.has(to)) continue;
      if (locked && (locked.itemId === undefined || !held.has(locked.itemId))) continue;
      if (!canEnter(archetype, to, minute, held)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return seen;
}

function means(crime: Crime) {
  const { itemTag, itemId } = crime.requires.means;
  return content.items.filter(
    (item) => item.tags.includes(itemTag) && (itemId === undefined || item.id === itemId),
  );
}

function crimeLocations(crime: Crime): string[] {
  return content.locations
    .filter(({ tags }) => crime.requires.locationTags.every((tag) => tags.includes(tag)))
    .map(({ id }) => id);
}

function placement(itemId: string): string | undefined {
  const item = items.get(itemId)!;
  return item.locationId ?? (item.containerId ? placement(item.containerId) : undefined);
}

function canAcquireMeans(crime: Crime, culprit: string, cast: readonly string[]): boolean {
  const held = owned(culprit);
  return means(crime).some((item) => {
    if (item.ownerArchetype !== undefined) {
      return item.ownerArchetype === culprit || cast.includes(item.ownerArchetype);
    }
    const at = placement(item.id);
    return at !== undefined && reachableByMinute(culprit, held).some((places) => places.has(at));
  });
}

function traitBounds(crime: Crime): [string, Bound][] {
  return Object.entries(crime.requires.traits) as [string, Bound][];
}

function traitPossible(archetype: string, trait: string, bound: Bound): boolean {
  const range = archetypes.get(archetype)!.personality[trait as keyof Archetype['personality']];
  const [min, max] = range ?? [0, 1];
  return (bound.gt === undefined || max > bound.gt) && (bound.lt === undefined || min < bound.lt);
}

function capable(crime: Crime, culprit: string): boolean {
  return traitBounds(crime).every(([trait, bound]) => traitPossible(culprit, trait, bound));
}

/** Relationship templates that can bind `from` → `to` with the given relation type. */
function relationTemplates(type: string, from: string, to: string) {
  const matches = (template: ScenarioContent['relationships'][number], a: string, b: string) =>
    (template.fromArchetypes?.includes(a) ?? true) && (template.toArchetypes?.includes(b) ?? true);
  return content.relationships.filter(
    (template) =>
      (template.type === type && matches(template, from, to)) ||
      (template.type === type && SYMMETRIC_RELATIONS.has(type) && matches(template, to, from)) ||
      (REVERSE_RELATIONS[type] === template.type && matches(template, to, from)),
  );
}

function motiveCanFire(motive: Motive, culprit: string, victim: string): boolean {
  const bind = (placeholder: string) => (placeholder === '$c' ? culprit : victim);
  const { relation, secret } = motive.when;
  let templates = content.relationships;
  if (relation) {
    templates = relationTemplates(relation.type, bind(relation.from), bind(relation.to));
  }
  if (secret) {
    const about = bind(secret.about);
    const knownBy = bind(secret.knownBy);
    templates = templates.filter(
      (template) =>
        template.secrets?.some(({ kind }) => kind === secret.kind) &&
        (relation !== undefined ||
          relationTemplates(template.type, about, knownBy).includes(template) ||
          relationTemplates(template.type, knownBy, about).includes(template)),
    );
  }
  if (templates.length === 0) return false;
  const strongest =
    motive.strength.base +
    motive.strength.plus
      .filter(({ if: condition }) => {
        const [subject, trait] = condition.trait.split('.') as [string, string];
        return traitPossible(bind(subject), trait, condition);
      })
      .reduce((sum, { add }) => sum + Math.max(add, 0), 0);
  return strongest >= content.preset.incident.minMotive;
}

function hasMotive(culprit: string, victim: string): boolean {
  return content.motives.some((motive) => motiveCanFire(motive, culprit, victim));
}

function hasOpportunity(crime: Crime, culprit: string, victim: string, cast: readonly string[]) {
  const act = crime.plan.find(({ step }) => step === 'act')!;
  const window = crime.requires.minWindowMinutes;
  const held = owned(culprit);
  // The template's means is held during the act (a key opens the locked crime scene).
  for (const item of means(crime)) held.add(item.id);
  const others = cast.filter(
    (id) => id !== culprit && (act.target === '$location' || id !== victim),
  );
  const at = (archetype: string, minute: number) => schedules.get(archetype)![minute % DAY]!;
  const reach = reachableByMinute(culprit, held);
  return crimeLocations(crime).some((location) => {
    // The culprit is on the scene and nobody awake can see them; for an act on the victim the
    // victim is there too. Windows may wrap around midnight.
    const usable = (minute: number) =>
      reach[minute]!.has(location) &&
      others.every(
        (id) => at(id, minute).location !== location || at(id, minute).activity === 'sleep',
      ) &&
      (act.target !== '$victim' || at(victim, minute).location === location);
    const day = Array.from({ length: DAY }, (_, minute) => (usable(minute) ? 1 : 0));
    const prefix = [0];
    for (let minute = 0; minute < 2 * DAY; minute++) {
      prefix.push(prefix[minute]! + day[minute % DAY]!);
    }
    const victimThere = (minute: number) => at(victim, minute).location === location;
    for (let start = 0; start < DAY; start++) {
      if (prefix[start + window]! - prefix[start]! < window) continue;
      if (act.target === '$victim') return true;
      const [minDelay, maxDelay] = crime.deathDelayMinutes!;
      const end = start + window;
      for (let delay = minDelay; delay <= maxDelay; delay++) {
        if (victimThere(end + delay)) return true;
      }
    }
    return false;
  });
}

const feasibleCache = new Map<string, string[]>();

function feasibleCulprits(crime: Crime, victim: string, cast: readonly string[]): string[] {
  const key = `${crime.id}|${victim}|${cast.join(',')}`;
  const cached = feasibleCache.get(key);
  if (cached) return cached;
  const result = cast.filter(
    (culprit) =>
      culprit !== victim &&
      hasMotive(culprit, victim) &&
      capable(crime, culprit) &&
      canAcquireMeans(crime, culprit, cast) &&
      hasOpportunity(crime, culprit, victim, cast),
  );
  feasibleCache.set(key, result);
  return result;
}

function casts(): string[][] {
  const { quotas, max } = content.preset.cast;
  const mandatory = quotas.filter(({ min }) => min >= 1).map(({ archetype }) => archetype);
  const optional = quotas.filter(({ min }) => min === 0).map(({ archetype }) => archetype);
  const pick = (from: string[], size: number): string[][] =>
    size === 0
      ? [[]]
      : from.flatMap((first, index) =>
          pick(from.slice(index + 1), size - 1).map((rest) => [first, ...rest]),
        );
  return pick(optional, max - mandatory.length).map((guests) => [...mandatory, ...guests]);
}

describe('sanatorium_winter crime templates', () => {
  test('the preset lists exactly the MVP templates', () => {
    expect(content.preset.incident.templates).toEqual([
      'poisoning',
      'staged_fall',
      'boiler_accident',
    ]);
    expect(content.crimes.map(({ id }) => id)).toEqual(content.preset.incident.templates);
  });

  test.each(content.crimes.map((crime) => [crime.id, crime] as const))(
    '%s: means, place and traits exist in the world',
    (_, crime) => {
      expect(content.preset.incident.types).toContain(crime.incidentType);
      expect(means(crime).length).toBeGreaterThan(0);
      const locationIds = crimeLocations(crime);
      expect(locationIds.length).toBeGreaterThan(0);
      for (const location of locationIds) {
        const visitors = content.archetypes.filter(({ routine }) =>
          routine.some(({ locationId }) => locationId === location),
        );
        expect(visitors.length, `nobody's routine reaches ${location}`).toBeGreaterThan(0);
      }
      for (const [trait, bound] of traitBounds(crime)) {
        expect(PERSONALITY_TRAITS).toContain(trait);
        expect(Object.keys(bound).every((key) => key === 'gt' || key === 'lt')).toBe(true);
        expect(content.archetypes.some(({ id }) => traitPossible(id, trait, bound))).toBe(true);
      }
    },
  );

  test.each(content.crimes.map((crime) => [crime.id, crime] as const))(
    '%s: the plan is causally ordered and fits the window',
    (_, crime) => {
      const steps = new Map(crime.plan.map((step) => [step.step, step]));
      expect(steps.size).toBe(crime.plan.length);
      const lethal = crime.plan.filter(({ verb }) => LETHAL_VERBS.has(verb));
      expect(lethal.map(({ step }) => step)).toEqual(['act']);
      const act = lethal[0]!;
      expect(act.optional).not.toBe(true);
      expect(DELAYED_VERBS.has(act.verb)).toBe(crime.deathDelayMinutes !== undefined);

      // Topological order: "before" and "after" must not form a cycle.
      const order = new Map<string, Set<string>>();
      for (const { step, before, after } of crime.plan) {
        if (before) order.set(step, new Set([...(order.get(step) ?? []), before]));
        if (after) order.set(after, new Set([...(order.get(after) ?? []), step]));
      }
      const visiting = new Set<string>();
      const done = new Set<string>();
      const acyclic = (step: string): boolean => {
        if (done.has(step)) return true;
        if (visiting.has(step)) return false;
        visiting.add(step);
        const ok = [...(order.get(step) ?? [])].every(acyclic);
        done.add(step);
        return ok;
      };
      expect([...steps.keys()].every(acyclic)).toBe(true);

      let onSite = 0;
      for (const step of crime.plan) {
        expect(PLAN_TARGETS.has(step.target), `${step.step} target`).toBe(true);
        expect(step.duration, `${step.step} duration`).toBeGreaterThan(0);
        // Acquisition happens before the act and elsewhere; everything else is on the scene.
        if (step.before === undefined) onSite += step.duration ?? 0;
        if (step.step !== 'act' && step.before === undefined) {
          expect(step.after, `${step.step} must follow the act`).toBeDefined();
        }
      }
      expect(onSite).toBeLessThanOrEqual(crime.requires.minWindowMinutes);
    },
  );

  test.each(content.crimes.map((crime) => [crime.id, crime] as const))(
    '%s: every plan step leaves a trace on its target',
    (_, crime) => {
      for (const step of crime.plan) {
        const rules = content.traceRules.filter(({ verb }) => verb === step.verb);
        if (step.target === '$means') {
          for (const item of means(crime)) {
            const matched = rules.some(
              ({ when }) =>
                when === undefined ||
                ((when.targetTag === undefined || item.tags.includes(when.targetTag)) &&
                  (when.itemId === undefined || when.itemId === item.id)),
            );
            expect(matched, `${step.verb} ${item.id}`).toBe(true);
          }
        } else {
          // Conditions in "when" apply to item targets, so a person or a place needs a bare rule.
          expect(
            rules.some(({ when }) => when === undefined),
            step.verb,
          ).toBe(true);
        }
      }
    },
  );

  test.each(content.crimes.map((crime) => [crime.id, crime] as const))(
    '%s: every possible cast has a victim with a feasible culprit',
    (_, crime) => {
      for (const cast of casts()) {
        const victims = cast.filter(
          (victim) =>
            !content.preset.incident.victimConstraints.excludeArchetypes.includes(victim) &&
            feasibleCulprits(crime, victim, cast).length > 0,
        );
        expect(victims, cast.join(',')).not.toEqual([]);
      }
    },
  );

  test('no template fixes the culprit: each archetype is a feasible culprit somewhere', () => {
    const culprits = new Set<string>();
    for (const crime of content.crimes) {
      for (const cast of casts()) {
        for (const victim of cast) {
          for (const culprit of feasibleCulprits(crime, victim, cast)) culprits.add(culprit);
        }
      }
    }
    expect([...culprits].sort()).toEqual(content.archetypes.map(({ id }) => id).sort());
  });

  test('templates and motives do not name culprits or suspects', () => {
    const text = JSON.stringify([content.crimes, content.motives]).toLowerCase();
    expect(text).not.toMatch(/culprit|suspect|archetype/);
  });
});

describe('sanatorium_winter motive rules', () => {
  const relationTypes = new Set(content.relationships.map(({ type }) => type));
  const secretKinds = new Set(
    content.relationships.flatMap(({ secrets = [] }) => secrets.map(({ kind }) => kind)),
  );

  test('the rules cover the MVP motives', () => {
    expect(content.motives.map(({ id }) => id)).toEqual([
      'inheritance',
      'blackmail',
      'jealousy',
      'revenge',
      'malpractice_coverup',
      'debt',
    ]);
  });

  test.each(content.motives.map((motive) => [motive.id, motive] as const))(
    '%s: references existing relations and secrets of one template',
    (_, motive) => {
      const { relation, secret } = motive.when;
      expect(secret, 'every rule rests on a secret fact').toBeDefined();
      expect(secretKinds).toContain(secret!.kind);
      expect(PLACEHOLDERS).toContain(secret!.about);
      expect(PLACEHOLDERS).toContain(secret!.knownBy);
      expect(secret!.about).not.toBe(secret!.knownBy);
      if (relation) {
        expect(relationTypes).toContain(relation.type);
        expect([relation.from, relation.to].sort()).toEqual(['$c', '$v']);
      }
      const pairs = content.archetypes.flatMap((c) =>
        content.archetypes
          .filter((v) => v.id !== c.id && motiveCanFire(motive, c.id, v.id))
          .map((v) => `${c.id}->${v.id}`),
      );
      expect(pairs.length, 'the rule can fire for some pair').toBeGreaterThan(0);
    },
  );

  test.each(content.motives.map((motive) => [motive.id, motive] as const))(
    '%s: strength stays in range and every bonus is reachable',
    (_, motive) => {
      const { base, plus } = motive.strength;
      const max = base + plus.reduce((sum, { add }) => sum + Math.max(add, 0), 0);
      const min = base + plus.reduce((sum, { add }) => sum + Math.min(add, 0), 0);
      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThanOrEqual(1);
      for (const { if: condition } of plus) {
        const [subject, trait] = condition.trait.split('.') as [string, string];
        expect(PLACEHOLDERS).toContain(subject);
        expect(PERSONALITY_TRAITS).toContain(trait);
        expect((condition.gt === undefined) !== (condition.lt === undefined)).toBe(true);
        // A bonus no eligible archetype can earn is dead data.
        const eligible = content.archetypes.filter((c) =>
          content.archetypes.some(
            (v) =>
              v.id !== c.id &&
              motiveCanFire({ ...motive, strength: { base: 1, plus: [] } }, c.id, v.id) &&
              traitPossible(subject === '$c' ? c.id : v.id, trait, condition),
          ),
        );
        expect(eligible.length, condition.trait).toBeGreaterThan(0);
      }
    },
  );
});
