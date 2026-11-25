import type { Character } from '@hs/core/characters';
import type { ScenarioContent } from '@hs/core/content';
import {
  compileTraceRules,
  deriveClues,
  deriveTraces,
  type Clue,
  type Trace,
} from '@hs/core/evidence';
import { buildLiePolicy, KnowledgeStore, type LieMotive, type LiePolicy } from '@hs/core/knowledge';
import { TruthModel, type TruthEvent, type TruthEventInput } from '@hs/core/truth';
import type { Fact } from '@hs/core/truth/facts';
import type { Stage } from '../pipeline/index.ts';
import { ruleFor } from './evidence-gen.ts';
import { exactPattern, idleAlternative, type TestimonyWorld } from './testimony-gen.ts';

type CharacterId = Character['id'];

export const MIN_RED_HERRINGS = 1;
export const MAX_RED_HERRINGS = 3;
/** A misdeed never falls closer than this to the incident window (minutes). */
export const INCIDENT_MARGIN_MINUTES = 60;
/** A stay shorter than this has no room for an event with margins. */
const MIN_STAY_MINUTES = 10;

/** A real misdeed of an innocent character, with what it left behind. */
export interface RedHerring {
  /** The secret the misdeed belongs to. */
  readonly secretId: string;
  readonly characterId: CharacterId;
  /** The truth event of the misdeed. */
  readonly eventId: string;
  readonly traceIds: readonly string[];
  readonly clueIds: readonly string[];
}

export interface RedHerringReport {
  /** Number of secrets that got a misdeed. */
  readonly count: number;
  /** Number of false trails: clues the misdeeds left. */
  readonly clues: number;
  readonly traces: number;
}

export interface RedHerringWorld extends TestimonyWorld {
  /** The input truth with the misdeed events appended. The input model is not changed. */
  readonly truth: TruthModel;
  /** Traces of the incident and of the misdeeds. */
  readonly traces: readonly Trace[];
  /** Clues of the incident and of the misdeeds (misdeed clues are never required). */
  readonly clues: readonly Clue[];
  readonly redHerrings: readonly RedHerring[];
  readonly redHerringReport: RedHerringReport;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

/**
 * Verbs a misdeed may use: a rule without conditions whose traces are physical, documentary or
 * digital, are left where the misdeed happened, and only place the character at a time and place.
 * A means or an opportunity claim would tie the innocent to the incident, not to their secret.
 */
function misdeedVerbs(rules: ScenarioContent['traceRules']): string[] {
  const verbs = new Set<string>();
  for (const rule of rules) {
    if (rule.when !== undefined) continue;
    const usable = rule.produces.every(
      (spec) =>
        spec.kind === 'testimonial' ||
        (spec.at === '$location' &&
          spec.requires === undefined &&
          spec.supports.every((claim) => claim.startsWith('presence('))),
    );
    if (usable && rule.produces.some((spec) => spec.kind !== 'testimonial')) verbs.add(rule.verb);
  }
  return [...verbs].sort(compare);
}

interface Slot {
  readonly where: string;
  readonly t: number;
  readonly interval: { readonly from: number; readonly to: number };
}

/** A free minute of a stay of `who`: inside the history, away from the incident. */
function pickSlot(
  world: TestimonyWorld,
  who: CharacterId,
  keyLocations: ReadonlySet<string>,
  rng: { int(min: number, max: number): number },
  historyStart: number,
): Slot | undefined {
  const { window } = world.truth.incident;
  const from = window.from - INCIDENT_MARGIN_MINUTES;
  const to = window.to + INCIDENT_MARGIN_MINUTES;
  const stays = world.truth
    .presenceIntervals(who)
    .filter(
      ({ location, interval }) =>
        !keyLocations.has(location) &&
        interval.from >= historyStart &&
        interval.to <= 0 &&
        interval.to - interval.from >= MIN_STAY_MINUTES &&
        (interval.to <= from || interval.from >= to),
    );
  if (stays.length === 0) return undefined;
  const stay = stays[rng.int(0, stays.length - 1)]!;
  const t = stay.interval.from + rng.int(1, stay.interval.to - stay.interval.from - 2);
  return { where: stay.location, t, interval: stay.interval };
}

/**
 * RedHerrings: for one to three secrets of innocent characters appends a real misdeed to the
 * truth, a `hide` or `destroy` event at a place where the character really was, and derives the
 * traces and clues it leaves. The false trail is true: the clue says "this person was here
 * then", and the culprit is not distinguished from the innocent by anything but the incident
 * itself (the misdeed claims no means or opportunity). The innocent knows their misdeed and hides it:
 * it is concealed, and a character who may lie says they only stayed there (KNOW-002). When
 * no innocent secret has a free stay (a short scenario), no misdeed is placed and `count` is 0.
 */
export const redHerrings: Stage<TestimonyWorld, RedHerringWorld> = {
  name: 'RedHerrings',
  generate(input, { rng, content }) {
    const rules = compileTraceRules(content.traceRules);
    const verbs = misdeedVerbs(content.traceRules);
    const { culpritIds, victimIds, keyEventIds } = input.truth.incident;
    const excluded = new Set([...culpritIds, ...victimIds]);
    const keyEvents = new Set(keyEventIds);
    const keyLocations = new Set(
      input.truth
        .events()
        .filter(({ id }) => keyEvents.has(id))
        .map(({ location }) => location),
    );
    const wanted = rng.int(MIN_RED_HERRINGS, MAX_RED_HERRINGS);

    const truth = TruthModel.deserialize(input.truth.serialize());
    const knowledge = new Map<CharacterId, KnowledgeStore>();
    for (const [id, store] of input.knowledge)
      knowledge.set(id, KnowledgeStore.deserialize(store.serialize()));
    const motives = new Map(input.lieMotives);
    const policies = new Map(input.liePolicies);
    const traces: Trace[] = [...input.traces];
    const clues: Clue[] = [...input.clues];
    const redHerrings: RedHerring[] = [];

    const candidates = rng
      .fork('select')
      .shuffle(
        input.secrets
          .filter(({ about }) => !excluded.has(about))
          .sort((a, b) => compare(a.id, b.id)),
      );
    const placement = rng.fork('place');
    const used = new Set<CharacterId>();
    for (const secret of candidates) {
      if (redHerrings.length >= wanted) break;
      const who = secret.about;
      const character = input.characters.find(({ id }) => id === who);
      if (used.has(who) || !character || verbs.length === 0) continue;
      const slot = pickSlot(
        input,
        who,
        keyLocations,
        placement,
        content.preset.time.historyStartMinutes,
      );
      if (!slot) continue;

      const verb = placement.pick(verbs);
      const fact: Fact = { kind: 'did', who, verb, at: slot.t, where: slot.where };
      const event: TruthEventInput = {
        t: slot.t,
        duration: 0,
        verb,
        actorIds: [who],
        location: slot.where,
        targets: [],
        causes: [],
        facts: [fact],
        traceIds: [],
        visibility: 'covert',
      };
      // Probe with a provisional ID: an event that leaves no clue is not appended at all.
      const probe: TruthEvent = { ...event, id: 'ev_probe' };
      const probed = deriveTraces({ events: () => [probe] }, rules, input.worldState.items);
      if (!probed.some((trace) => ruleFor(trace) !== undefined)) continue;

      const eventId = truth.append(event);
      const made = deriveTraces(
        { events: () => [{ ...event, id: eventId }] },
        rules,
        input.worldState.items,
      );
      const clueRules = new Map(
        made.flatMap((trace) => {
          const rule = ruleFor(trace);
          return rule ? [[trace.template, rule] as const] : [];
        }),
      );
      const derived = deriveClues(made, clueRules);
      traces.push(...made);
      clues.push(...derived);
      redHerrings.push({
        secretId: secret.id,
        characterId: who,
        eventId,
        traceIds: made.map(({ id }) => id),
        clueIds: derived.map(({ id }) => id),
      });
      used.add(who);

      // The misdeed is a memory of the character and something they hide, with a cover story.
      const store = knowledge.get(who) ?? new KnowledgeStore();
      knowledge.set(who, store);
      store.add({
        proposition: fact,
        confidence: 1,
        source: 'observed',
        acquiredAt: slot.t,
        fuzzMinutes: 0,
      });
      const cover = idleAlternative(fact);
      const motive: LieMotive = {
        protect: [exactPattern(fact)],
        alternatives: cover ? [cover] : [],
      };
      const all: readonly LieMotive[] = [...(motives.get(who) ?? []), motive];
      motives.set(who, all);
      const policy: LiePolicy = buildLiePolicy(character, store, all);
      policies.set(who, policy);
    }

    const added = redHerrings.flatMap(({ clueIds }) => clueIds).length;
    return {
      ...input,
      truth,
      traces,
      clues,
      knowledge,
      lieMotives: motives,
      liePolicies: policies,
      redHerrings,
      redHerringReport: {
        count: redHerrings.length,
        clues: added,
        traces: redHerrings.flatMap(({ traceIds }) => traceIds).length,
      },
    };
  },
};
