import { isDeepStrictEqual } from 'node:util';
import { BODY_HOTSPOT_ID, GameEngine, type EnginePorts, type Investigation } from '@hs/core/game';
import {
  PlayerKnowledge,
  evaluateClaims,
  type ClaimContext,
  type DeductionRules,
} from '@hs/core/investigation';
import type { Check, ValidationContext } from '../check.ts';
import { GUILT_KINDS } from '../solver/index.ts';

type PlayerAction = Parameters<GameEngine['dispatch']>[1];
type PlayerView = ReturnType<GameEngine['playerView']>;
export type SolutionPath = readonly PlayerAction[];
type SearchResult = SolutionPath | null | 'limit' | 'missing-incident' | 'replay-mismatch';
type RuleTerm = DeductionRules['rules'][number]['requires'][number]['args'][number];

/** The role that replays a step: the server dispatches a validated QR capture from the phone. */
export function solutionSource(action: PlayerAction): 'desktop' | 'phone' {
  return action.type === 'captureEvidence' ? 'phone' : 'desktop';
}
export type PlannerOptions = Required<Pick<ValidationContext, 'clues' | 'deductionRules'>> &
  Pick<ValidationContext, 'startLocationId' | 'knownIncident' | 'createSimulationPorts'> & {
    readonly timeBudget: number;
  };

const WIDTH = 8;
// Includes replay of prefixes. A deterministic work limit also bounds cases where every action
// is free or none of the available actions can produce the missing evidence.
const MAX_DISPATCHES = 2500;
// The same action after new knowledge may still yield a new clue or reply, but usually repeats
// one. It ranks with a return to a visited location, so it cannot crowd useful moves out of the beam.
const REPEATED = 4;
// A move on the shortest known route to a witness who can still be asked about a person in focus.
// It ranks above exploring an unvisited location, below finding evidence and asking.
const TOWARDS_WITNESS = 1;
/** Events after which the player's knowledge may prove more. */
const PROGRESS: ReadonlySet<string> = new Set([
  'ClueDiscovered',
  'EvidenceCaptured',
  'StatementHeard',
]);

interface Branch {
  engine: GameEngine;
  path: SolutionPath;
  view: PlayerView;
  coverage: number;
  /** People with the most guilt links in this branch's knowledge; every person counts. */
  focus: readonly string[];
  /** Last minute this branch tried an action with the same evidence. */
  attempts: ReadonlyMap<string, number>;
  /** Actions already on the path, by `actionId`. */
  done: ReadonlySet<string>;
  /** Locations where the player saw each character in `presentCharacters`. */
  seen: ReadonlyMap<string, ReadonlySet<string>>;
  /** Open exits of the locations this branch has visited, as the view showed them. */
  exits: ReadonlyMap<string, readonly string[]>;
}

interface Candidate {
  parent: Branch;
  action: PlayerAction;
  id: string;
  key: string;
  priority: number;
  earliest: number;
  sibling: number;
}

function byCostThenId(a: Candidate, b: Candidate): number {
  return a.earliest - b.earliest || (a.key < b.key ? -1 : Number(a.key > b.key));
}

function offers(view: PlayerView): { action: PlayerAction; min: number }[] {
  // The body point only costs Static and sanity (OQ-28) and holds no evidence, so no path needs it.
  const result = view.availableActions
    .filter(
      ({ action }) => !(action.type === 'examineHotspot' && action.hotspotId === BODY_HOTSPOT_ID),
    )
    .map(({ action, costPreview }) => ({
      action,
      min: costPreview.min,
    }));
  if (view.pendingCapture) {
    // The cost table bounds it from below; dispatch spends the real minutes.
    result.push({
      action: { type: 'captureEvidence', tokenId: view.pendingCapture.tokenId },
      min: 0,
    });
  }
  const dialogue = view.interaction;
  if (dialogue) {
    const characterId = dialogue.characterId;
    for (const topic of dialogue.topics) {
      if (topic.id === 'self') continue; // Already offered for each present character.
      result.push({
        action: { type: 'talk', characterId, topicId: topic.id },
        min: topic.costPreview.min,
      });
    }
    for (const item of dialogue.presentable) {
      const subject =
        item.type === 'evidence'
          ? { type: 'evidence' as const, clueId: item.id }
          : { type: 'contradiction' as const, contradictionId: item.id };
      result.push({ action: { type: 'interrogate', characterId, subject }, min: 0 });
    }
  }
  return result;
}

function priority(action: PlayerAction, view: PlayerView): number {
  switch (action.type) {
    case 'captureEvidence':
    case 'read':
    case 'examineHotspot':
      return 0;
    case 'talk':
      // A conversation about a person or oneself is where motives come from; minute-by-minute
      // sighting topics are many and mostly repeat what a clue already shows.
      return action.topicId.startsWith('saw:') ? 1 : 0;
    case 'interrogate':
      return 2; // Free, but one per clue and character: it must not crowd out `talk`.
    case 'pickLock':
      return 1;
    case 'move':
      return view.knownMap?.locations.some((l) => l.id === action.locationId && l.visited) ? 4 : 2;
    case 'examineLocation':
      return 2;
    case 'useItem':
      return 3;
    case 'wait':
      return 5;
    default:
      return 6;
  }
}

const ROLLING_TOPIC = /^(where|saw):-?\d+:-?\d+$/;

/**
 * Identity of an action for repeat detection. Topics about the recent hours are renamed every
 * minute (`where:<from>:<now>`), so asking the same speaker again is one topic, not a new one.
 */
function actionId(action: PlayerAction): string {
  const rolling = action.type === 'talk' && ROLLING_TOPIC.exec(action.topicId);
  return action.type === 'talk' && rolling
    ? JSON.stringify({ type: 'talk', characterId: action.characterId, topicId: rolling[1] })
    : JSON.stringify(action);
}

/** First moves of the shortest known routes from `from` to any of `targets`. */
function firstSteps(
  exits: ReadonlyMap<string, readonly string[]>,
  from: string,
  targets: ReadonlySet<string>,
): Set<string> {
  // Each reached location keeps the first moves that lead to it in the fewest moves.
  const via = new Map<string, Set<string>>([[from, new Set()]]);
  let frontier = [from];
  while (frontier.length > 0) {
    const layer = new Map<string, Set<string>>();
    for (const at of frontier) {
      for (const to of exits.get(at) ?? []) {
        if (via.has(to)) continue;
        const steps = layer.get(to) ?? new Set<string>();
        for (const step of at === from ? [to] : via.get(at)!) steps.add(step);
        layer.set(to, steps);
      }
    }
    const result = new Set<string>();
    for (const [at, steps] of layer) {
      via.set(at, steps);
      if (targets.has(at)) for (const step of steps) result.add(step);
    }
    if (result.size > 0) return result;
    frontier = [...layer.keys()];
  }
  return new Set();
}

function candidates(branch: Branch, budget: number): Candidate[] {
  const { view } = branch;
  const result: Candidate[] = [];
  // People the dialogue may offer as `person:` topics: those heard from and those present.
  const present = new Set(view.presentCharacters.map(({ id }) => id));
  const known = new Set([...view.caseBoard.statements.map((s) => s.characterId), ...present]);
  const unasked = (speaker: string, about: Iterable<string>) => {
    for (const person of about) {
      if (person === speaker || !known.has(person)) continue;
      if (
        !branch.done.has(
          actionId({ type: 'talk', characterId: speaker, topicId: `person:${person}` }),
        )
      )
        return true;
    }
    return false;
  };
  // Go back to where the player saw someone who has not yet been asked about a person in focus.
  const haunts = new Set<string>();
  for (const [characterId, places] of branch.seen) {
    if (present.has(characterId) || !unasked(characterId, branch.focus)) continue;
    for (const place of places) if (place !== view.location.id) haunts.add(place);
  }
  const towards = haunts.size > 0 ? firstSteps(branch.exits, view.location.id, haunts) : undefined;
  for (const { action, min } of offers(view)) {
    const earliest = view.clock.t + min;
    if (earliest > budget) continue;
    const id = actionId(action);
    const key = `${view.location.id}|${view.caseBoard.clues.length}|${view.caseBoard.statements.length}|${id}`;
    const previous = branch.attempts.get(key);
    if (previous === view.clock.t) continue;
    // Reopening a conversation is new while the speaker can be asked about someone new.
    const reopens =
      action.type === 'talk' && action.topicId === 'self' && unasked(action.characterId, known);
    result.push({
      parent: branch,
      action,
      id,
      key,
      earliest,
      priority:
        previous !== undefined
          ? 7
          : action.type === 'move' && towards?.has(action.locationId)
            ? TOWARDS_WITNESS
            : action.type !== 'move' && branch.done.has(id) && !reopens
              ? REPEATED
              : priority(action, view),
      sibling: 0,
    });
  }
  result
    .sort((a, b) => a.priority - b.priority || byCostThenId(a, b))
    .forEach((edge, index) => {
      edge.sibling = index;
    });
  return result;
}

interface Score {
  readonly coverage: number;
  readonly focus: readonly string[];
}

/** Culprit IDs are used only to certify a completed proof. Every person's links count in ranking. */
function proofScore(
  engine: GameEngine,
  rules: DeductionRules,
  context: ClaimContext,
  culprits: readonly string[],
): Score | 'solved' {
  const knowledge = PlayerKnowledge.restore(engine.knowledgeSnapshot());
  const byPerson = new Map<string, Set<string>>();
  for (const { subject, kind } of evaluateClaims(knowledge, rules, context)) {
    if (!GUILT_KINDS.some((k) => k === kind)) continue;
    const kinds = byPerson.get(subject) ?? new Set<string>();
    kinds.add(kind);
    byPerson.set(subject, kinds);
  }
  if (culprits.every((id) => byPerson.get(id)?.size === GUILT_KINDS.length)) return 'solved';
  const coverage = Math.max(0, ...Array.from(byPerson.values(), (kinds) => kinds.size));
  const focus = [...byPerson]
    .filter(([, kinds]) => coverage > 0 && kinds.size === coverage)
    .map(([id]) => id)
    .sort();
  return { coverage, focus };
}

function readsIncident(term: RuleTerm): boolean {
  return term.k === 'path'
    ? term.name.startsWith('incident.')
    : term.k === 'call' && term.args.some(readsIncident);
}

/** Adds what the player sees here: the characters present and the open exits. */
function observe(
  seen: Branch['seen'],
  exits: Branch['exits'],
  view: PlayerView,
): Pick<Branch, 'seen' | 'exits'> {
  const here = view.location.id;
  const met = view.presentCharacters.filter(({ id }) => !seen.get(id)?.has(here));
  let updated = seen;
  if (met.length > 0) {
    const copy = new Map(seen);
    for (const { id } of met) copy.set(id, new Set([...(seen.get(id) ?? []), here]));
    updated = copy;
  }
  const open = view.location.exits.filter((exit) => !exit.blockedReason).map((e) => e.locationId);
  return {
    seen: updated,
    exits: exits.has(here) ? exits : new Map(exits).set(here, open),
  };
}

/** Forward beam search. Every retained edge is accepted and priced by a real GameEngine. */
function search(investigation: Investigation, options: PlannerOptions): SearchResult {
  const { timeBudget, clues, deductionRules, knownIncident } = options;
  if (!Number.isSafeInteger(timeBudget) || timeBudget < 0)
    throw new RangeError('Invalid time budget');
  const startLocationId =
    options.startLocationId ?? investigation.world.locations.snapshot().locations[0]?.id;
  const culprits = investigation.truth.incident.culpritIds;
  if (startLocationId === undefined || culprits.length === 0) return null;
  for (const kind of GUILT_KINDS) {
    const rules = deductionRules.rules.filter((rule) => rule.establishes.fn === kind);
    if (rules.length === 0) return null;
    // A required premise with an unbound incident path cannot match, even with every clue.
    if (!knownIncident && rules.every((rule) => rule.requires.some(readsIncident))) {
      return 'missing-incident';
    }
  }
  const context: ClaimContext = {
    clues: new Map(clues.map((clue) => [clue.id, clue])),
    ...(knownIncident && { incident: knownIncident }),
  };
  const startEngine = GameEngine.prepareStart(investigation);
  const create = () => {
    const ports: EnginePorts = { ...options.createSimulationPorts?.(), startLocationId, clues };
    return startEngine(ports);
  };
  const root = create();
  // INV-002 reads the discovered clues and heard statements in order. A statement ID hashes its
  // speaker, topic, minute, proposition and veracity, so the ordered IDs determine the claims.
  // Memoize the score, never a mutable engine or its knowledge. A solved branch returns at once.
  const scores = new Map<string, Score>();
  let dispatches = 0;
  const start = root.playerView();
  let beam: Branch[] = [
    {
      engine: root,
      path: [],
      view: start,
      coverage: 0,
      focus: [],
      attempts: new Map(),
      done: new Set(),
      ...observe(new Map(), new Map(), start),
    },
  ];
  while (beam.length > 0) {
    const edges = beam
      .flatMap((branch) => candidates(branch, timeBudget))
      .sort(
        (a, b) =>
          b.parent.coverage - a.parent.coverage ||
          b.parent.view.caseBoard.clues.length - a.parent.view.caseBoard.clues.length ||
          a.sibling - b.sibling ||
          a.priority - b.priority ||
          byCostThenId(a, b),
      );
    const consumed = new Set<Branch>();
    const next: Branch[] = [];
    for (const { parent, action, id, key } of edges) {
      // Transfer the parent's engine to its first child. Siblings replay into fresh engines AND
      // fresh simulation ports: snapshots alone do not contain testimony, callbacks or token state.
      let engine = parent.engine;
      dispatches += 1 + (consumed.has(parent) ? parent.path.length : 0);
      if (dispatches > MAX_DISPATCHES) return 'limit';
      if (consumed.has(parent)) {
        engine = create();
        for (const step of parent.path) {
          const replayed = engine.dispatch(solutionSource(step), step);
          if (!replayed.ok || replayed.outcome) return 'replay-mismatch';
        }
        if (options.createSimulationPorts && !isDeepStrictEqual(engine.playerView(), parent.view)) {
          return 'replay-mismatch';
        }
      }
      consumed.add(parent);
      const result = engine.dispatch(solutionSource(action), action);
      if (!result.ok || result.outcome) continue;
      const view = engine.playerView();
      if (view.clock.t > timeBudget) continue;
      const path = [...parent.path, action];
      let { coverage, focus } = parent;
      if (result.events.some((e) => PROGRESS.has(e.type))) {
        const { clues: found, statements } = view.caseBoard;
        const learned = JSON.stringify([found.map((c) => c.id), statements.map((s) => s.id)]);
        const score = scores.get(learned) ?? proofScore(engine, deductionRules, context, culprits);
        if (score === 'solved') return path;
        ({ coverage, focus } = score);
        scores.set(learned, score);
      }
      const attempts = new Map(parent.attempts).set(key, parent.view.clock.t);
      const done = new Set(parent.done).add(id);
      next.push({
        engine,
        path,
        view,
        coverage,
        focus,
        attempts,
        done,
        ...observe(parent.seen, parent.exits, view),
      });
      if (next.length === WIDTH) break;
    }
    beam = next;
  }
  return null;
}

export function solve(investigation: Investigation, options: PlannerOptions): SolutionPath | null {
  const result = search(investigation, options);
  return typeof result === 'string' ? null : result;
}

export const timeFeasibleCheck: Check = {
  id: 'V-TIME-FEASIBLE',
  description: 'A playable path proves the case within 70% of the scenario',
  run(investigation, context) {
    const { clues, deductionRules } = context;
    if (!clues || !deductionRules)
      return [
        {
          severity: 'error',
          code: 'PLANNER_INPUT_MISSING',
          message: 'The time planner needs clues and deductionRules',
          eventIds: [],
        },
      ];
    const timeBudget = Math.floor((investigation.world.durationMinutes * 7) / 10);
    const path = search(investigation, { ...context, clues, deductionRules, timeBudget });
    if (path === 'missing-incident' || path === 'replay-mismatch') {
      return [
        {
          severity: 'error',
          code:
            path === 'missing-incident' ? 'TIME_INCIDENT_CONTEXT_MISSING' : 'TIME_REPLAY_MISMATCH',
          message:
            path === 'missing-incident'
              ? 'A required claim depends on the incident briefing known to the player'
              : 'Independent simulation ports did not reproduce an accepted action prefix',
          eventIds: [],
        },
      ];
    }
    if (path === 'limit')
      return [
        {
          severity: 'error',
          code: 'TIME_SEARCH_LIMIT',
          message: 'Search work limit reached before proving a playable path',
          data: { timeBudget, maxDispatches: MAX_DISPATCHES },
          eventIds: [],
        },
      ];
    return path
      ? []
      : [
          {
            severity: 'error',
            code: 'TIME_PATH_NOT_FOUND',
            message: 'No playable proof found within the time budget',
            data: { timeBudget },
            eventIds: investigation.truth.incident.keyEventIds.slice(0, 1),
          },
        ];
  },
};
