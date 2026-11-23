import type { Clue } from '@hs/core/evidence';
import type { Investigation } from '@hs/core/game';
import {
  PlayerKnowledge,
  evaluateClaims,
  type DeductionRules,
  type EstablishedClaim,
  type HeardStatement,
} from '@hs/core/investigation';

/** Why a clue cannot be reached, for the finding message. */
export type UnreachableReason =
  | { readonly kind: 'location'; readonly locationId: string }
  | { readonly kind: 'requirement'; readonly requirement: string }
  | { readonly kind: 'cycle' };

export interface DiscoveryResult {
  /** Clue IDs the ideal player can find, in the order the search reached them. */
  readonly reachable: readonly string[];
  readonly unreachable: ReadonlyMap<string, UnreachableReason>;
}

export interface DiscoveryInput {
  readonly investigation: Investigation;
  readonly clues: readonly Clue[];
  /** Where the player starts; defaults to the first location of the scenario. */
  readonly startLocationId?: string;
}

/** Locations reachable over connections from the start (time and access items are VAL-003). */
export function reachableLocations(
  investigation: Investigation,
  startLocationId?: string,
): ReadonlySet<string> {
  const { locations } = investigation.world.locations.snapshot();
  const byId = new Map(locations.map((location) => [location.id, location]));
  const start = startLocationId ?? locations[0]?.id;
  const seen = new Set<string>();
  if (start === undefined || !byId.has(start)) return seen;
  const queue = [start];
  seen.add(start);
  for (let i = 0; i < queue.length; i++) {
    for (const { to } of byId.get(queue[i] as string)?.connections ?? []) {
      if (!seen.has(to) && byId.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return seen;
}

/**
 * Discovery graph: a clue is a node, its prerequisites are edges. Search runs to a fixed point
 * from nothing found: a clue is reachable when its location is reachable and every requirement
 * holds. `clue` and `password` requirements name a clue that must be reachable first (a password
 * is carried by a clue; one nobody carries is unreachable); `item` needs an item of the scenario; `contact` needs a character.
 */
export function discover({
  investigation,
  clues,
  startLocationId,
}: DiscoveryInput): DiscoveryResult {
  const locations = reachableLocations(investigation, startLocationId);
  const characters = new Set(investigation.characters.map(({ id }) => id));
  const itemIds = new Set(investigation.world.items.snapshot().initial.map(({ item }) => item.id));
  const byId = new Map(clues.map((clue) => [clue.id, clue]));
  const found = new Set<string>();
  const order: string[] = [];
  const blocker = (clue: Clue): UnreachableReason | undefined => {
    const { locationId, requires } = clue.discovery;
    if (!locations.has(locationId)) return { kind: 'location', locationId };
    for (const { kind, id } of requires) {
      const met =
        kind === 'clue' || kind === 'password'
          ? found.has(id)
          : kind === 'item'
            ? itemIds.has(id)
            : characters.has(id);
      if (!met) return { kind: 'requirement', requirement: `${kind}:${id}` };
    }
    return undefined;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const clue of clues) {
      if (!found.has(clue.id) && blocker(clue) === undefined) {
        found.add(clue.id);
        order.push(clue.id);
        changed = true;
      }
    }
  }
  // A clue that waits for itself through other clues is a cycle; one that waits for a clue that
  // is merely unreachable or unknown reports the blocking requirement.
  const waitsFor = (clue: Clue) =>
    clue.discovery.requires
      .filter(({ kind, id }) => (kind === 'clue' || kind === 'password') && !found.has(id))
      .flatMap(({ id }) => byId.get(id) ?? []);
  const inCycle = (clue: Clue): boolean => {
    const seen = new Set<string>();
    const stack = [...waitsFor(clue)];
    for (let next = stack.pop(); next; next = stack.pop()) {
      if (next.id === clue.id) return true;
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      stack.push(...waitsFor(next));
    }
    return false;
  };
  const unreachable = new Map<string, UnreachableReason>();
  for (const clue of clues) {
    if (found.has(clue.id)) continue;
    const reason = blocker(clue);
    unreachable.set(clue.id, inCycle(clue) || !reason ? { kind: 'cycle' } : reason);
  }
  return { reachable: order, unreachable };
}

export interface SolveInput extends DiscoveryInput {
  readonly rules: DeductionRules;
  /** Testimony the player can obtain by talking to characters. */
  readonly statements?: readonly HeardStatement[];
}

export interface Solution {
  readonly discovery: DiscoveryResult;
  readonly claims: readonly EstablishedClaim[];
  readonly culpritIds: readonly string[];
  /** Characters with motive, means and opportunity all established, culprit or not. */
  readonly provable: readonly string[];
  /** Kinds (`motive`, `means`, `opportunity`) established per character. */
  readonly kindsBy: ReadonlyMap<string, ReadonlySet<string>>;
}

export const GUILT_KINDS = ['motive', 'means', 'opportunity'] as const;

/** The incident as a perfect player works it out: where it happened and when. */
function knownIncident(investigation: Investigation) {
  const { incident } = investigation.truth;
  const first = investigation.truth.events().find(({ id }) => id === incident.keyEventIds[0]);
  return first ? { location: first.location, window: incident.window } : undefined;
}

/** Runs discovery, then the deduction rules over everything reachable. */
export function solveDeduction(input: SolveInput): Solution {
  const discovery = discover(input);
  const byId = new Map(input.clues.map((clue) => [clue.id, clue]));
  const knowledge = new PlayerKnowledge();
  for (const clueId of discovery.reachable) {
    knowledge.addClue({
      clueId,
      discoveredAt: byId.get(clueId)?.discovery.availableFrom ?? 0,
      location: byId.get(clueId)?.discovery.locationId ?? '',
    });
  }
  for (const statement of input.statements ?? []) knowledge.addStatement(statement);
  const incident = knownIncident(input.investigation);
  const claims = evaluateClaims(knowledge, input.rules, {
    clues: new Map(input.clues.map((clue) => [clue.id, clue])),
    ...(incident && { incident }),
  });
  const kindsBy = new Map<string, Set<string>>();
  for (const { kind, subject } of claims) {
    if (!kindsBy.has(subject)) kindsBy.set(subject, new Set());
    kindsBy.get(subject)?.add(kind);
  }
  const provable = [...kindsBy]
    .filter(([, kinds]) => GUILT_KINDS.every((kind) => kinds.has(kind)))
    .map(([id]) => id)
    .sort();
  return {
    discovery,
    claims,
    culpritIds: input.investigation.truth.incident.culpritIds,
    provable,
    kindsBy,
  };
}
