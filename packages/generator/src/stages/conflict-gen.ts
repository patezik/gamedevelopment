import { relationshipSchema, type Character, type RelationType } from '@hs/core/characters';
import { PERSONALITY_TRAITS } from '@hs/core/common';
import type { ScenarioContent } from '@hs/core/content';
import {
  factId,
  TruthLog,
  type Fact,
  type FactId,
  type TruthEvent,
  type TruthEventInput,
} from '@hs/core/truth';
import type { Stage } from '../pipeline/index.ts';
import type { SocialWorld } from './social-gen.ts';

type CharacterId = Character['id'];
type Trait = (typeof PERSONALITY_TRAITS)[number];
type RuleData = ScenarioContent['motives'][number];

export const MOTIVE_EVENT_VERB = 'harbor_motive';
/** Number of equal-width bins in `MotiveReport.histogram` over [0, 1]. */
export const MOTIVE_HISTOGRAM_BINS = 10;
/** Strength is rounded to this many decimals, so float noise never decides the threshold. */
const STRENGTH_DECIMALS = 6;

const RELATION_TYPES: readonly string[] = relationshipSchema.shape.type.options;
const TRAITS: readonly string[] = PERSONALITY_TRAITS;
/** Mirrors RelationshipGraph: `debt`, `employment`, `blackmail` are directed and have no reverse. */
const REVERSE: Partial<Record<RelationType, RelationType>> = {
  parent: 'child',
  child: 'parent',
  sibling: 'sibling',
  spouse: 'spouse',
  romance: 'romance',
  friendship: 'friendship',
  rivalry: 'rivalry',
  past_conflict: 'past_conflict',
};

/**
 * A potential conflict: `who` has a reason of type `motiveType` to act against `against`.
 * `basis` lists the ids of the relation and secret facts that satisfied the rule.
 * It is not an accusation: IncidentSelection (GEN-006) picks the culprit among candidates.
 */
export interface MotiveCandidate {
  readonly who: CharacterId;
  readonly against: CharacterId;
  /** The `motives.json` rule id. */
  readonly motiveType: string;
  /** base + matching adds, clamped to [0, 1]. */
  readonly strength: number;
  readonly basis: readonly FactId[];
}

export interface MotiveTypeStats {
  readonly count: number;
  readonly aboveThreshold: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
}

/** Server diagnostics: the distribution of motive strength. Keep out of player and phone views. */
export interface MotiveReport {
  /** Ordered pairs (c, v), c ≠ v, each checked against every rule. */
  readonly pairsEvaluated: number;
  readonly rules: number;
  readonly candidates: number;
  /** `preset.incident.minMotive`: candidates at or above it become `motive` facts. */
  readonly threshold: number;
  readonly aboveThreshold: number;
  /** Ordered pairs with at least one candidate. */
  readonly pairsWithMotive: number;
  /** Characters with a candidate at or above the threshold against someone. */
  readonly charactersWithMotive: number;
  /** Candidate counts per strength bin `[i/10, (i+1)/10)`; strength 1 is in the last bin. */
  readonly histogram: readonly number[];
  /** Per rule id, in rule id order; rules without candidates have `count: 0` and zero stats. */
  readonly byType: Readonly<Record<string, MotiveTypeStats>>;
}

export interface ConflictWorld extends SocialWorld {
  /** Candidates for every ordered pair, sorted by `who`, `against`, `motiveType`. */
  readonly motives: readonly MotiveCandidate[];
  readonly motiveReport: MotiveReport;
  /**
   * SocialGen history followed by one `harbor_motive` event per candidate at or above the
   * threshold, ids continuing after SocialGen's events.
   */
  readonly history: readonly TruthEvent[];
}

type Role = 'c' | 'v';

interface Bonus {
  readonly role: Role;
  readonly trait: Trait;
  readonly lt?: number;
  readonly gt?: number;
  readonly add: number;
}

interface Rule {
  readonly id: string;
  readonly relation?: { readonly type: RelationType; readonly from: Role; readonly to: Role };
  readonly secret?: { readonly kind: string; readonly about: Role; readonly knownBy: Role };
  readonly base: number;
  readonly plus: readonly Bonus[];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

function role(rule: RuleData, field: string, value: string): Role {
  if (value === '$c' || value === '$v') return value === '$c' ? 'c' : 'v';
  throw new RangeError(`Motive rule ${rule.id}: ${field} must be $c or $v, got ${value}`);
}

function bonusOf(rule: RuleData, { if: condition, add }: RuleData['strength']['plus'][number]) {
  const match = /^(\$[cv])\.(.+)$/.exec(condition.trait);
  if (!match || !TRAITS.includes(match[2]!)) {
    throw new RangeError(
      `Motive rule ${rule.id}: trait must be $c.<trait> or $v.<trait> with a personality trait, got ${condition.trait}`,
    );
  }
  const { lt, gt } = condition;
  if (lt === undefined && gt === undefined) {
    throw new RangeError(`Motive rule ${rule.id}: condition on ${condition.trait} needs lt or gt`);
  }
  if (lt !== undefined && gt !== undefined && gt >= lt) {
    throw new RangeError(`Motive rule ${rule.id}: condition on ${condition.trait} never holds`);
  }
  return {
    role: role(rule, 'trait', match[1]!),
    trait: match[2] as Trait,
    ...(lt !== undefined && { lt }),
    ...(gt !== undefined && { gt }),
    add,
  };
}

/** Validates and canonicalizes `motives.json`. Rule order does not matter. */
function rulesOf(content: ScenarioContent): Rule[] {
  const ids = new Set<string>();
  return content.motives
    .toSorted((a, b) => compare(a.id, b.id))
    .map((rule): Rule => {
      if (ids.has(rule.id)) throw new RangeError(`Motive rule ${rule.id}: duplicate id`);
      ids.add(rule.id);
      const { relation, secret } = rule.when;
      if (!relation && !secret) {
        throw new RangeError(
          `Motive rule ${rule.id}: when needs a relation or a secret, so every motive has a basis`,
        );
      }
      if (relation && !RELATION_TYPES.includes(relation.type)) {
        throw new RangeError(`Motive rule ${rule.id}: unsupported relation type ${relation.type}`);
      }
      const from = relation && role(rule, 'relation.from', relation.from);
      const to = relation && role(rule, 'relation.to', relation.to);
      if (relation && from === to) {
        throw new RangeError(`Motive rule ${rule.id}: relation must link $c and $v`);
      }
      return {
        id: rule.id,
        ...(relation && {
          relation: { type: relation.type as RelationType, from: from!, to: to! },
        }),
        ...(secret && {
          secret: {
            kind: secret.kind,
            about: role(rule, 'secret.about', secret.about),
            knownBy: role(rule, 'secret.knownBy', secret.knownBy),
          },
        }),
        base: rule.strength.base,
        plus: rule.strength.plus.map((bonus) => bonusOf(rule, bonus)),
      };
    });
}

function holds({ lt, gt }: Bonus, value: number | undefined): boolean {
  return (
    value !== undefined && (lt === undefined || value < lt) && (gt === undefined || value > gt)
  );
}

function strengthOf(rule: Rule, bind: Record<Role, Character>): number {
  const raw = rule.plus.reduce(
    (sum, bonus) =>
      holds(bonus, bind[bonus.role].personality[bonus.trait]) ? sum + bonus.add : sum,
    rule.base,
  );
  const scale = 10 ** STRENGTH_DECIMALS;
  return Math.round(Math.min(1, Math.max(0, raw)) * scale) / scale;
}

/** The `motive` fact a candidate asserts in the server truth. */
export function motiveFact(candidate: MotiveCandidate): Fact {
  const { who, against, motiveType, basis } = candidate;
  return { kind: 'motive', who, against, motiveType, basis: [...basis] };
}

function reportOf(
  rules: readonly Rule[],
  motives: readonly MotiveCandidate[],
  pairsEvaluated: number,
  threshold: number,
): MotiveReport {
  const histogram = Array.from({ length: MOTIVE_HISTOGRAM_BINS }, () => 0);
  for (const { strength } of motives) {
    histogram[Math.min(MOTIVE_HISTOGRAM_BINS - 1, Math.floor(strength * MOTIVE_HISTOGRAM_BINS))]!++;
  }
  const above = motives.filter(({ strength }) => strength >= threshold);
  const byType = Object.fromEntries(
    rules.map(({ id }): [string, MotiveTypeStats] => {
      const values = motives.filter(({ motiveType }) => motiveType === id).map((m) => m.strength);
      const count = values.length;
      return [
        id,
        {
          count,
          aboveThreshold: values.filter((value) => value >= threshold).length,
          min: count ? Math.min(...values) : 0,
          max: count ? Math.max(...values) : 0,
          mean: count ? values.reduce((sum, value) => sum + value, 0) / count : 0,
        },
      ];
    }),
  );
  return {
    pairsEvaluated,
    rules: rules.length,
    candidates: motives.length,
    threshold,
    aboveThreshold: above.length,
    pairsWithMotive: new Set(motives.map(({ who, against }) => `${who}|${against}`)).size,
    charactersWithMotive: new Set(above.map(({ who }) => who)).size,
    histogram,
    byType,
  };
}

/**
 * ConflictGen (GEN-005): evaluates every `motives.json` rule for every ordered pair (c, v), c ≠ v.
 * A rule matches when its relation `from → to` exists in the RelationshipGraph (reverse edges
 * included, so `child $c → $v` and `parent $v → $c` are the same condition) and a secret of its
 * kind is about the bound character and known by the other bound character. Strength is the base
 * plus every trait bonus whose condition holds, clamped to [0, 1]. Each candidate cites the
 * relation and secret facts of the SocialGen history. Candidates at or above
 * `preset.incident.minMotive` become `motive` facts of private backstory events.
 * It assigns no culprit and no victim, and it uses no randomness.
 */
export const conflictGen: Stage<SocialWorld, ConflictWorld> = {
  name: 'ConflictGen',
  generate(world, { content }) {
    const rules = rulesOf(content);
    const threshold = content.preset.incident.minMotive;
    const cast = world.characters.toSorted((a, b) => compare(a.id, b.id));
    if (new Set(cast.map(({ id }) => id)).size !== cast.length) {
      throw new RangeError('Character ids must be unique');
    }
    if (world.history.some(({ facts }) => facts.some(({ kind }) => kind === 'motive'))) {
      throw new RangeError('ConflictGen input already has motive events');
    }
    const events = new Map(world.history.map((event) => [event.id, event]));
    const sources = new Map<FactId, TruthEvent>();
    for (const event of world.history) {
      for (const fact of event.facts)
        if (!sources.has(factId(fact))) sources.set(factId(fact), event);
    }

    /** The relation fact behind an edge, from the events in its history. */
    const relationFact = (a: CharacterId, b: CharacterId, type: RelationType): FactId => {
      const edge = world.relationships.get(a, b, type)!;
      const reverse = REVERSE[type];
      for (const id of edge.history) {
        const fact = events
          .get(id)
          ?.facts.find(
            (f) =>
              f.kind === 'relation' &&
              ((f.a === a && f.b === b && f.relType === type) ||
                (reverse !== undefined && f.a === b && f.b === a && f.relType === reverse)),
          );
        if (fact) return factId(fact);
      }
      throw new RangeError(`Relationship ${a} → ${b} (${type}) has no relation fact in history`);
    };
    const secretFact = (fact: Fact): FactId => {
      const id = factId(fact);
      if (!sources.has(id)) throw new RangeError(`Secret fact ${id} is not in history`);
      return id;
    };

    const motives: MotiveCandidate[] = [];
    for (const c of cast) {
      for (const v of cast) {
        if (c.id === v.id) continue;
        const bind: Record<Role, Character> = { c, v };
        for (const rule of rules) {
          const basis: FactId[] = [];
          if (rule.relation) {
            const { type, from, to } = rule.relation;
            if (!world.relationships.get(bind[from].id, bind[to].id, type)) continue;
            basis.push(relationFact(bind[from].id, bind[to].id, type));
          }
          if (rule.secret) {
            const { kind, about, knownBy } = rule.secret;
            const matches = world.secrets.filter(
              (secret) =>
                secret.kind === kind &&
                secret.about === bind[about].id &&
                secret.knownBy.includes(bind[knownBy].id),
            );
            if (matches.length === 0) continue;
            basis.push(...matches.map(({ fact }) => secretFact(fact)));
          }
          motives.push({
            who: c.id,
            against: v.id,
            motiveType: rule.id,
            strength: strengthOf(rule, bind),
            basis: [...new Set(basis)].sort(),
          });
        }
      }
    }

    const log = new TruthLog();
    for (const { id, ...input } of world.history) {
      if (log.append(input).id !== id) throw new RangeError(`History event ${id} is out of order`);
    }
    for (const candidate of motives) {
      if (candidate.strength < threshold) continue;
      const causes = [...new Set(candidate.basis.map((id) => sources.get(id)!))].sort(
        (a, b) => a.t + a.duration - (b.t + b.duration) || compare(a.id, b.id),
      );
      const latest = causes.at(-1)!;
      const input: TruthEventInput = {
        t: latest.t + latest.duration,
        duration: 0,
        verb: MOTIVE_EVENT_VERB,
        actorIds: [],
        location: latest.location,
        targets: [
          { kind: 'character', id: candidate.who },
          { kind: 'character', id: candidate.against },
        ],
        causes: causes.map(({ id }) => id),
        facts: [motiveFact(candidate)],
        traceIds: [],
        visibility: 'private',
      };
      log.append(input);
    }

    return {
      ...world,
      motives,
      motiveReport: reportOf(rules, motives, cast.length * (cast.length - 1), threshold),
      history: log.inAppendOrder(),
    };
  },
};
