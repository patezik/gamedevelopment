import {
  RelationshipGraph,
  relationshipSchema,
  type Character,
  type RelationType,
} from '@hs/core/characters';
import type { ScenarioContent } from '@hs/core/content';
import type { Secret } from '@hs/core/game';
import type { Rng } from '@hs/core/rng';
import { TruthLog, type Fact, type TruthEvent, type TruthEventInput } from '@hs/core/truth';
import type { Stage } from '../pipeline/index.ts';

type CharacterId = Character['id'];
type TemplateData = ScenarioContent['relationships'][number];

/** Every character has relationships with at least this many distinct other characters. */
export const MIN_RELATIONSHIP_PARTNERS = 2;
/** Every character is the subject of at least this many secrets. */
export const MIN_SECRETS_PER_CHARACTER = 1;
/** SocialGen creates only significant relationships: intensity is never below this value. */
export const SIGNIFICANT_INTENSITY = 0.4;
/** A parent is at least this many years older than the child. */
export const MIN_PARENT_AGE_GAP = 16;
export const MAX_PARENT_AGE_GAP = 60;
export const MAX_SIBLING_AGE_GAP = 25;
/** Both sides of a non-kinship relationship are at least this old when it begins. */
export const ADULT_AGE = 18;

export const RELATIONSHIP_EVENT_VERB = 'form_relationship';
export const SECRET_EVENT_VERB = 'keep_secret';

const RELATION_TYPES: readonly string[] = relationshipSchema.shape.type.options;
const CONSTRAINT_KEYS = ['maxCount', 'minAgeGap', 'maxAgeGap'] as const;
const MINUTES_PER_DAY = 1440;
const DAYS_PER_YEAR = 365;
const MINUTES_PER_YEAR = DAYS_PER_YEAR * MINUTES_PER_DAY;
const ATTEMPTS = 16;
const EXTRA_SECRET_CHANCE = 0.3;

type Range = readonly [number, number];
interface Profile {
  /** How long ago a non-kinship relationship began, in days. Kinship begins at birth. */
  readonly days?: Range;
  readonly trust: Range;
  readonly valence: Range;
  readonly intensity: Range;
}

const KIN: Profile = { trust: [0, 0.8], valence: [0.3, 0.9], intensity: [0.5, 1] };
const PROFILES: Record<RelationType, Profile> = {
  parent: KIN,
  child: KIN,
  sibling: KIN,
  spouse: { days: [730, 9125], trust: [0.2, 0.9], valence: [0.4, 0.9], intensity: [0.6, 1] },
  romance: { days: [30, 1095], trust: [0.3, 0.9], valence: [0.6, 1], intensity: [0.6, 1] },
  friendship: { days: [365, 9125], trust: [0.4, 0.9], valence: [0.6, 1], intensity: [0.4, 0.8] },
  rivalry: { days: [90, 3650], trust: [-0.8, -0.1], valence: [0, 0.4], intensity: [0.4, 0.9] },
  debt: { days: [30, 1825], trust: [-0.4, 0.3], valence: [0.2, 0.6], intensity: [0.4, 0.8] },
  employment: { days: [180, 7300], trust: [0, 0.6], valence: [0.3, 0.7], intensity: [0.4, 0.7] },
  blackmail: { days: [14, 730], trust: [-1, -0.4], valence: [0, 0.2], intensity: [0.7, 1] },
  past_conflict: {
    days: [365, 7300],
    trust: [-0.9, -0.2],
    valence: [0, 0.3],
    intensity: [0.5, 1],
  },
};

/** A relationship template from `relationships.json` in canonical form. */
interface Template {
  readonly id: string;
  readonly type: RelationType;
  readonly from?: ReadonlySet<string>;
  readonly to?: ReadonlySet<string>;
  readonly secrets: readonly { readonly kind: string; readonly template: string }[];
  readonly maxCount?: number;
  readonly minAgeGap?: number;
  readonly maxAgeGap?: number;
}

interface Candidate {
  readonly template: Template;
  readonly from: Character;
  readonly to: Character;
}

interface Edge extends Candidate {
  readonly since: number;
  readonly trust: number;
  readonly valence: number;
  readonly intensity: number;
}

/** Where a secret came from: the relationship in which the counterpart learned it. */
export interface SecretOrigin {
  readonly templateId: string;
  readonly a: CharacterId;
  readonly b: CharacterId;
  readonly type: RelationType;
}

/**
 * A `Secret` with the metadata later stages need. Packaging keeps `{ id, fact, knownBy }`.
 * The fact is `state(character about, property = kind, value = true)` over the backstory.
 */
export interface SocialSecret extends Secret {
  readonly kind: string;
  /** Text template key (CNT-005). */
  readonly template: string;
  /** The character the secret is about. Always in `knownBy`. */
  readonly about: CharacterId;
  readonly origin: SecretOrigin;
}

export interface SocialWorld {
  /** Input characters in input order, with `secrets` set to the secrets about them. */
  readonly characters: readonly Character[];
  readonly relationships: RelationshipGraph;
  readonly secrets: readonly SocialSecret[];
  /**
   * Backstory events before `preset.time.historyStartMinutes`, ids `ev_1…ev_N`. They are the
   * first events of the investigation truth: `new TruthModel(incident, history)`.
   */
  readonly history: readonly TruthEvent[];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

function byId<T extends { readonly id: string }>(a: T, b: T): number {
  return compare(a.id, b.id);
}

function uniform(rng: Rng, [min, max]: Range): number {
  return min + (max - min) * rng.float();
}

function constraint(template: TemplateData, key: string): number | undefined {
  const value = template.constraints?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Relationship template ${template.id}: ${key} must be a whole number ≥ 0`);
  }
  return value;
}

function templatesOf(content: ScenarioContent): Template[] {
  return content.relationships.toSorted(byId).map((template) => {
    if (!RELATION_TYPES.includes(template.type)) {
      throw new RangeError(
        `Relationship template ${template.id}: unsupported type ${template.type}`,
      );
    }
    const unknown = Object.keys(template.constraints ?? {}).filter(
      (key) => !(CONSTRAINT_KEYS as readonly string[]).includes(key),
    );
    if (unknown.length > 0) {
      throw new RangeError(
        `Relationship template ${template.id}: unsupported constraints ${unknown.join(', ')}`,
      );
    }
    const [maxCount, minAgeGap, maxAgeGap] = CONSTRAINT_KEYS.map((key) =>
      constraint(template, key),
    );
    return {
      id: template.id,
      type: template.type as RelationType,
      ...(template.fromArchetypes && { from: new Set(template.fromArchetypes) }),
      ...(template.toArchetypes && { to: new Set(template.toArchetypes) }),
      secrets: (template.secrets ?? []).toSorted(
        (a, b) => compare(a.kind, b.kind) || compare(a.template, b.template),
      ),
      ...(maxCount !== undefined && { maxCount }),
      ...(minAgeGap !== undefined && { minAgeGap }),
      ...(maxAgeGap !== undefined && { maxAgeGap }),
    };
  });
}

function anchorOf(content: ScenarioContent): string {
  const anchor = content.preset.world?.startLocationId ?? content.locations[0]?.id;
  if (!anchor || !content.locations.some(({ id }) => id === anchor)) {
    throw new RangeError('SocialGen needs the scenario start location for backstory events');
  }
  return anchor;
}

const pairKey = (a: CharacterId, b: CharacterId) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const isKin = (type: RelationType) => type === 'parent' || type === 'child' || type === 'sibling';
const isLove = (type: RelationType) => type === 'spouse' || type === 'romance';
/** Parent and child are one relation seen from both ends. */
const canonicalType = (type: RelationType): RelationType => (type === 'child' ? 'parent' : type);

/** [parent, child] of a parent/child candidate. */
function parentAndChild({ template, from, to }: Candidate): [Character, Character] {
  return template.type === 'child' ? [to, from] : [from, to];
}

/** Social state of one attempt. Every rule that spans several relationships lives here. */
class Network {
  readonly edges: Edge[] = [];
  readonly #partners = new Map<CharacterId, Set<CharacterId>>();
  readonly #pairs = new Map<string, Set<RelationType>>();
  readonly #spouses = new Set<CharacterId>();
  readonly #parents = new Map<CharacterId, number>();
  readonly #templateCounts = new Map<string, number>();

  // A plain field, not a parameter property: the server loads this file in native Node, which
  // only strips types.
  private readonly historyStart: number;

  constructor(historyStart: number) {
    this.historyStart = historyStart;
  }

  partners(id: CharacterId): ReadonlySet<CharacterId> {
    return this.#partners.get(id) ?? new Set();
  }

  /** The earliest and latest minute the relationship can begin, or null if it is impossible. */
  window(candidate: Candidate): Range | null {
    const { template, from, to } = candidate;
    const gap = from.age - to.age;
    if (
      (template.minAgeGap !== undefined && gap < template.minAgeGap) ||
      (template.maxAgeGap !== undefined && gap > template.maxAgeGap)
    ) {
      return null;
    }
    if (template.type === 'parent' || template.type === 'child') {
      const [parent, child] = parentAndChild(candidate);
      const years = parent.age - child.age;
      if (years < MIN_PARENT_AGE_GAP || years > MAX_PARENT_AGE_GAP) return null;
      const birth = this.historyStart - child.age * MINUTES_PER_YEAR;
      return [birth, birth];
    }
    if (template.type === 'sibling') {
      if (Math.abs(gap) > MAX_SIBLING_AGE_GAP) return null;
      const birth = this.historyStart - Math.min(from.age, to.age) * MINUTES_PER_YEAR;
      return [birth, birth];
    }
    const [minDays, maxDays] = PROFILES[template.type].days!;
    const latest = Math.min(maxDays, (Math.min(from.age, to.age) - ADULT_AGE) * DAYS_PER_YEAR);
    if (latest < minDays) return null;
    return [
      this.historyStart - latest * MINUTES_PER_DAY,
      this.historyStart - minDays * MINUTES_PER_DAY,
    ];
  }

  fits(candidate: Candidate): boolean {
    const { template, from, to } = candidate;
    const type = canonicalType(template.type);
    const existing = this.#pairs.get(pairKey(from.id, to.id)) ?? new Set<RelationType>();
    if (existing.has(type)) return false;
    if (isKin(type) && [...existing].some((other) => isKin(other) || isLove(other))) return false;
    if (isLove(type) && [...existing].some((other) => isKin(other) || isLove(other))) return false;
    if (type === 'spouse' && (this.#spouses.has(from.id) || this.#spouses.has(to.id))) return false;
    if (type === 'parent' && (this.#parents.get(parentAndChild(candidate)[1].id) ?? 0) >= 2) {
      return false;
    }
    if (
      template.maxCount !== undefined &&
      (this.#templateCounts.get(template.id) ?? 0) >= template.maxCount
    ) {
      return false;
    }
    return this.window(candidate) !== null;
  }

  add(candidate: Candidate, rng: Rng): void {
    const { template, from, to } = candidate;
    const [earliest, latest] = this.window(candidate)!;
    const profile = PROFILES[template.type];
    this.edges.push({
      ...candidate,
      since: rng.int(earliest, latest),
      trust: uniform(rng, profile.trust),
      valence: uniform(rng, profile.valence),
      intensity: uniform(rng, profile.intensity),
    });
    const type = canonicalType(template.type);
    const key = pairKey(from.id, to.id);
    this.#pairs.set(key, new Set([...(this.#pairs.get(key) ?? []), type]));
    for (const [self, other] of [
      [from.id, to.id],
      [to.id, from.id],
    ] as const) {
      this.#partners.set(self, new Set([...this.partners(self), other]));
    }
    if (type === 'spouse') {
      this.#spouses.add(from.id);
      this.#spouses.add(to.id);
    }
    if (type === 'parent') {
      const child = parentAndChild(candidate)[1].id;
      this.#parents.set(child, (this.#parents.get(child) ?? 0) + 1);
    }
    this.#templateCounts.set(template.id, (this.#templateCounts.get(template.id) ?? 0) + 1);
  }
}

function candidatesOf(templates: readonly Template[], cast: readonly Character[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const template of templates) {
    for (const from of cast) {
      if (template.from && !template.from.has(from.archetypeId)) continue;
      for (const to of cast) {
        if (from.id === to.id || (template.to && !template.to.has(to.archetypeId))) continue;
        candidates.push({ template, from, to });
      }
    }
  }
  return candidates;
}

/** Gives everyone enough distinct partners first, then adds density. Null if stuck. */
function tryNetwork(
  cast: readonly Character[],
  candidates: readonly Candidate[],
  historyStart: number,
  rng: Rng,
): Network | null {
  const network = new Network(historyStart);
  const values = rng.fork('values');
  const needs = (id: CharacterId) => network.partners(id).size < MIN_RELATIONSHIP_PARTNERS;
  for (const character of rng.shuffle(cast)) {
    while (needs(character.id)) {
      const options = candidates.filter((candidate) => {
        const { from, to } = candidate;
        const other = from.id === character.id ? to : to.id === character.id ? from : undefined;
        return (
          other !== undefined &&
          !network.partners(character.id).has(other.id) &&
          network.fits(candidate)
        );
      });
      if (options.length === 0) return null;
      const chosen = rng.weighted(
        options.map((option) => ({
          value: option,
          weight: needs(option.from.id) && needs(option.to.id) ? 3 : 1,
        })),
      );
      network.add(chosen, values);
    }
  }
  let extra = rng.int(0, cast.length);
  for (const candidate of rng.shuffle(candidates)) {
    if (extra === 0) break;
    if (!network.fits(candidate)) continue;
    network.add(candidate, values);
    extra--;
  }
  return network;
}

function buildNetwork(
  cast: readonly Character[],
  templates: readonly Template[],
  historyStart: number,
  rng: Rng,
): Network {
  const candidates = candidatesOf(templates, cast);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const network = tryNetwork(cast, candidates, historyStart, rng.fork(`attempt/${attempt}`));
    if (network) return network;
  }
  throw new RangeError(
    `Relationship templates cannot give every character ${MIN_RELATIONSHIP_PARTNERS} distinct partners`,
  );
}

interface SecretDraft {
  readonly edge: Edge;
  readonly kind: string;
  readonly template: string;
  readonly about: Character;
  readonly since: number;
}

function secretsOf(
  cast: readonly Character[],
  edges: readonly Edge[],
  historyStart: number,
  rng: Rng,
): SecretDraft[] {
  const drafts: SecretDraft[] = [];
  const kinds = new Map<CharacterId, Set<string>>(cast.map(({ id }) => [id, new Set()]));
  const open = (edge: Edge, about: Character) =>
    edge.template.secrets.filter(({ kind }) => !kinds.get(about.id)!.has(kind));
  const draft = (edge: Edge, about: Character, random: Rng) => {
    const { kind, template } = random.pick(open(edge, about));
    // The secret begins once the subject is an adult (or at the start of the relationship).
    const latest = historyStart - MINUTES_PER_DAY;
    const adult = historyStart - Math.max(0, about.age - ADULT_AGE) * MINUTES_PER_YEAR;
    const earliest = Math.min(Math.max(edge.since, adult), latest);
    kinds.get(about.id)!.add(kind);
    drafts.push({ edge, kind, template, about, since: random.int(earliest, latest) });
  };

  const required = rng.fork('required');
  for (const character of cast) {
    while (kinds.get(character.id)!.size < MIN_SECRETS_PER_CHARACTER) {
      const options = edges.filter(
        (edge) =>
          (edge.from.id === character.id || edge.to.id === character.id) &&
          open(edge, character).length > 0,
      );
      if (options.length === 0) {
        throw new RangeError(`No relationship template gives ${character.id} a secret`);
      }
      draft(required.pick(options), character, required);
    }
  }
  const extra = rng.fork('extra');
  for (const edge of edges) {
    if (edge.template.secrets.length === 0 || !extra.chance(EXTRA_SECRET_CHANCE)) continue;
    const about = extra.chance(0.5) ? edge.from : edge.to;
    if (open(edge, about).length > 0) draft(edge, about, extra);
  }
  return drafts;
}

function characterRef(id: CharacterId) {
  return { kind: 'character' as const, id };
}

/**
 * SocialGen (GEN-004): relationships from `relationships.json` templates and secrets about every
 * character, both backed by backstory events in the truth log. It assigns no culprit.
 *
 * Rules: archetype filters per template; at most one spouse; a parent is 16–60 years older than
 * the child and a child has at most two parents; siblings differ by at most 25 years; a pair has
 * at most one kinship or love relation and never both; non-kinship relationships begin after
 * both sides turn 18. Each character gets ≥ 2 distinct partners and is the subject of ≥ 1 secret,
 * known initially by the subject and the counterpart of the relationship it came from.
 */
export const socialGen: Stage<readonly Character[], SocialWorld> = {
  name: 'SocialGen',
  generate(characters, { rng, content }) {
    const ids = new Set(characters.map(({ id }) => id));
    if (ids.size !== characters.length) throw new RangeError('Character ids must be unique');
    const cast = characters.toSorted(byId);
    const historyStart = content.preset.time.historyStartMinutes;
    const location = anchorOf(content);
    const { edges } = buildNetwork(
      cast,
      templatesOf(content),
      historyStart,
      rng.fork('relationships'),
    );
    const drafts = secretsOf(cast, edges, historyStart, rng.fork('secrets'));

    // Append chronologically so event ids follow time; relationships before secrets at a tie.
    const entries = [
      ...edges.map((edge, index) => ({ t: edge.since, order: index, edge })),
      ...drafts.map((secret, index) => ({ t: secret.since, order: edges.length + index, secret })),
    ].sort((a, b) => a.t - b.t || a.order - b.order);
    const log = new TruthLog();
    const edgeEvents = new Map<Edge, string>();
    const secretFacts = new Map<SecretDraft, Fact>();
    for (const entry of entries) {
      const base = { t: entry.t, duration: 0, actorIds: [], location, causes: [], traceIds: [] };
      let input: TruthEventInput;
      if ('edge' in entry) {
        const { from, to, template, since } = entry.edge;
        input = {
          ...base,
          verb: RELATIONSHIP_EVENT_VERB,
          targets: [characterRef(from.id), characterRef(to.id)],
          facts: [{ kind: 'relation', a: from.id, b: to.id, relType: template.type, since }],
          visibility: 'private',
        };
      } else {
        const { about, kind, since } = entry.secret;
        const fact: Fact = {
          kind: 'state',
          entity: characterRef(about.id),
          property: kind,
          value: true,
          interval: { from: since, to: historyStart },
        };
        secretFacts.set(entry.secret, fact);
        input = {
          ...base,
          verb: SECRET_EVENT_VERB,
          targets: [characterRef(about.id)],
          facts: [fact],
          visibility: 'covert',
        };
      }
      const event = log.append(input);
      if ('edge' in entry) edgeEvents.set(entry.edge, event.id);
    }

    const relationships = new RelationshipGraph(
      edges.map((edge) => ({
        a: edge.from.id,
        b: edge.to.id,
        type: edge.template.type,
        trust: edge.trust,
        valence: edge.valence,
        intensity: edge.intensity,
        history: [edgeEvents.get(edge)!],
      })),
    );
    const secrets = drafts.map((draft, index): SocialSecret => {
      const { edge, kind, template, about } = draft;
      const counterpart = edge.from.id === about.id ? edge.to.id : edge.from.id;
      return {
        id: `sec_${index + 1}`,
        fact: secretFacts.get(draft)!,
        knownBy: [about.id, counterpart].sort(),
        kind,
        template,
        about: about.id,
        origin: {
          templateId: edge.template.id,
          a: edge.from.id,
          b: edge.to.id,
          type: edge.template.type,
        },
      };
    });
    return {
      characters: characters.map((character) => ({
        ...character,
        secrets: secrets.filter(({ about }) => about === character.id).map(({ id }) => id),
      })),
      relationships,
      secrets,
      history: log.inAppendOrder(),
    };
  },
};
