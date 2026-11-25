import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { PERSONALITY_TRAITS } from '../common/index.ts';
import { LocationGraph } from '../world/index.ts';
import { loadScenarioFromDir } from './index.ts';
import type { ScenarioContent } from './scenario.ts';

/*
 * Structural checks of the sanatorium_winter crime templates and motive rules (CNT-003): means,
 * scenes and traits exist, plans are ordered and leave traces, and motive rules rest on relations
 * and secrets that relationships.json can produce. Whether culprits are feasible in generated
 * worlds is decided by IncidentSelection (GEN-006); the 500-seed acceptance sweep is
 * packages/generator/scripts/incident-sweep.ts.
 */

const root = fileURLToPath(new URL('../../../../content/scenarios/', import.meta.url));
const content = loadScenarioFromDir(join(root, 'sanatorium_winter'));

type Crime = ScenarioContent['crimes'][number];
type Motive = ScenarioContent['motives'][number];
type Archetype = ScenarioContent['archetypes'][number];
type Bound = { gt?: number | undefined; lt?: number | undefined };

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

test('boiler room has daytime access from the hall and a free exit after closing', () => {
  const graph = new LocationGraph(content);
  const keyHolder = { itemIds: new Set(['it_key_boiler']) };
  const closing = 13 * 60; // The preset starts at 08:00 and the public entrance closes at 21:00.
  expect(graph.directConnection('loc_hall', 'loc_boiler', {})).toBeDefined();
  expect(graph.isAccessible('loc_boiler', {}, closing - 1)).toEqual({ ok: true });
  expect(graph.isAccessible('loc_boiler', {}, closing)).toMatchObject({ ok: false });
  expect(graph.isAccessible('loc_boiler', keyHolder, closing)).toEqual({ ok: true });
  expect(graph.directConnection('loc_kitchen', 'loc_boiler', {})).toBeUndefined();
  expect(graph.directConnection('loc_treatment', 'loc_boiler', {})).toBeUndefined();
  expect(graph.directConnection('loc_boiler', 'loc_hall', {})).toBeDefined();
  expect(graph.isAccessible('loc_hall', {}, closing)).toEqual({ ok: true });
});

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

function traitBounds(crime: Crime): [string, Bound][] {
  return Object.entries(crime.requires.traits) as [string, Bound][];
}

function traitPossible(archetype: string, trait: string, bound: Bound): boolean {
  const range = archetypes.get(archetype)!.personality[trait as keyof Archetype['personality']];
  const [min, max] = range ?? [0, 1];
  return (bound.gt === undefined || max > bound.gt) && (bound.lt === undefined || min < bound.lt);
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
      expect(relation ?? secret, 'every rule rests on a relation or a secret fact').toBeDefined();
      if (secret) {
        expect(secretKinds).toContain(secret.kind);
        expect(PLACEHOLDERS).toContain(secret.about);
        expect(PLACEHOLDERS).toContain(secret.knownBy);
        expect(secret.about).not.toBe(secret.knownBy);
      }
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
