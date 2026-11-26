import type { ErrorCode, PlayerAction } from '@hs/protocol';
import {
  discoverable,
  type Clue,
  type DiscoveryAction,
  type DiscoveryRequirement,
} from '../../evidence/index.ts';
import {
  contradictionEvents,
  detectContradictions,
  parsePresence,
  type Contradiction,
} from '../../investigation/index.ts';
import {
  answer,
  reactToRebuttal,
  type KnowledgeStore,
  type LiePolicy,
  type Question,
  type SpeakerContext,
  type Statement,
} from '../../knowledge/index.ts';
import { createRng } from '../../rng/index.ts';
import { consume, costModifiers, lightMinutes, setFlashlight } from '../../survival/index.ts';
import {
  ActionCostError,
  Calendar,
  resolveActionCost,
  type ActionCostTable,
  type CostModifier,
} from '../../time/index.ts';
import type { EntityRef } from '../../truth/index.ts';
import type { Actor } from '../../world/index.ts';
import { BODY_HOTSPOT_ID, visibleHotspots } from '../body.ts';
import type { Investigation } from '../investigation.ts';
import type { DesktopActionType, GameEvent } from './events.ts';
import { doorKey, type DesktopState, type DialogueLine } from './state.ts';

/** Chance that one `pickLock` attempt opens the door (starting value, game-design.md section 2). */
export const PICK_LOCK_SUCCESS = 0.5;
/** Window of the "where were you" and "did you see anything" topics offered in a dialogue. */
export const TOPIC_WINDOW_MINUTES = 240;
/** Item kinds that can be read where they lie. */
const DOCUMENT_KINDS: ReadonlySet<string> = new Set(['book', 'document', 'letter', 'note']);

/** A witness's memory and lie policy (KNOW-001/002), supplied by the simulation or generator. */
export interface TestimonyPort {
  witness(
    characterId: string,
  ): { readonly knowledge: Pick<KnowledgeStore, 'query'>; readonly policy: LiePolicy } | undefined;
}

export interface ActionEnv {
  readonly investigation: Investigation;
  readonly clues: readonly Clue[];
  readonly locationId: string;
  readonly now: number;
  /** The player's actor from the engine ports; pack items and picked doors are added here. */
  readonly actor: Actor;
  readonly costs: ActionCostTable;
  readonly testimony?: TestimonyPort;
  /** Issues the QR token for a found `captureMode: "qr"` clue (engine `requestEvidenceCapture`). */
  readonly requestCapture: (clue: Clue, has: (r: DiscoveryRequirement) => boolean) => boolean;
}

export interface ActionPlan {
  readonly type: DesktopActionType;
  readonly minutes: number;
  readonly interruptible: boolean;
  readonly verb: string;
  readonly targets: readonly EntityRef[];
  readonly noisy: boolean;
  readonly characterId?: string;
  readonly topicId?: string;
  readonly clueId?: string;
  readonly contradictionId?: string;
  /** Applies the effect after time has passed; `completed` is false if time ran out first. */
  resolve(done: { readonly at: number; readonly completed: boolean }): GameEvent[];
}

type Desktop = Extract<PlayerAction, { type: DesktopActionType }>;

class Rejection extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
}
const notAvailable = (): never => {
  throw new Rejection('ACTION_NOT_AVAILABLE');
};
const invalid = (): never => {
  throw new Rejection('ACTION_INVALID');
};

export function presentAt(
  investigation: Investigation,
  locationId: string,
  minute: number,
): string[] {
  return investigation.truth.whoWasAt(locationId, { from: minute, to: minute + 1 });
}

/** The player's actor, with pack items and the key of a picked door to `to`. */
export function effectiveActor(
  state: DesktopState,
  base: Actor,
  investigation: Investigation,
  from: string,
  to?: string,
): Actor {
  const itemIds = new Set([...(base.itemIds ?? []), ...state.inventory.items.map(({ id }) => id)]);
  if (to !== undefined && state.unlockedDoors.has(doorKey(from, to))) {
    const lock = investigation.world.locations
      .describe(from)
      .connections.find((connection) => connection.to === to)?.locked?.itemId;
    if (lock !== undefined) itemIds.add(lock);
  }
  return { ...base, itemIds };
}

/** Cost modifiers of SURV-001 that apply right now (darkness: dark room without a lit flashlight). */
export function currentModifiers(
  state: DesktopState,
  investigation: Investigation,
  locationId: string,
  minute: number,
): CostModifier[] {
  const { locations } = investigation.world;
  const period = new Calendar(locations.startDateTime).toDisplay(minute).period;
  const darkWithoutLight =
    locations.lightingAt(locationId, period) === 'dark' && lightMinutes(state.inventory) === 0;
  return costModifiers(state.vitals.vitals, { darkWithoutLight });
}

/** Locked doors from here that the player cannot pass but could pick. */
export function pickableDoors(
  state: DesktopState,
  env: Omit<ActionEnv, 'requestCapture'>,
): string[] {
  const { locations } = env.investigation.world;
  return locations
    .describe(env.locationId)
    .connections.filter(
      ({ to, locked }) =>
        locked?.itemId !== undefined &&
        !locations.directConnection(
          env.locationId,
          to,
          effectiveActor(state, env.actor, env.investigation, env.locationId, to),
        ),
    )
    .map(({ to }) => to);
}

/** Documents readable in a location: those a clue is read from and document items lying there. */
export function readableDocuments(
  investigation: Investigation,
  clues: readonly Clue[],
  locationId: string,
  minute: number,
): string[] {
  const ids = new Set<string>();
  for (const { discovery } of clues) {
    if (discovery.locationId === locationId && discovery.action.type === 'read') {
      ids.add(discovery.action.documentId);
    }
  }
  const { items } = investigation.world;
  for (const id of items.idsOfKinds(DOCUMENT_KINDS)) {
    const placement = items.locate(id, minute);
    if (placement.kind === 'location' && placement.id === locationId) ids.add(id);
  }
  return [...ids].sort();
}

export interface Topic {
  readonly id: string;
  readonly label: string;
  readonly question: Question;
}

/** Parses a topic id; `undefined` for a malformed one. */
export function parseTopic(
  topicId: string,
  speakerId: string,
  investigation: Investigation,
  locationId: string,
  now: number,
): Topic | undefined {
  const name = (id: string) => investigation.characters.find((c) => c.id === id)?.name;
  if (topicId === 'self') {
    return { id: topicId, label: 'Расскажите о себе', question: { type: 'aboutYourself' } };
  }
  const person = /^person:(.+)$/.exec(topicId);
  if (person) {
    const characterId = person[1]!;
    const known = name(characterId);
    if (known === undefined || characterId === speakerId) return undefined;
    return {
      id: topicId,
      label: `Что вы знаете о: ${known}`,
      question: { type: 'whatDoYouKnowAbout', characterId },
    };
  }
  const span = /^(where|saw):(-?\d+):(-?\d+)$/.exec(topicId);
  if (!span) return undefined;
  const [from, to] = [Number(span[2]), Number(span[3])];
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to || to > now) {
    return undefined;
  }
  const interval = { from, to };
  return span[1] === 'where'
    ? { id: topicId, label: 'Где вы были?', question: { type: 'whereWereYou', interval } }
    : {
        id: topicId,
        label: 'Вы видели здесь что-нибудь?',
        question: { type: 'sawAnything', interval, location: locationId },
      };
}

/** Topics offered to the player: about the speaker, recent hours, and people the player knows. */
export function offeredTopics(
  state: DesktopState,
  speakerId: string,
  investigation: Investigation,
  locationId: string,
  now: number,
): Topic[] {
  const from = now - TOPIC_WINDOW_MINUTES;
  const people = new Set([
    ...presentAt(investigation, locationId, now),
    ...state.knowledge.statements.map(({ speakerId: id }) => id),
  ]);
  people.delete(speakerId);
  return [
    'self',
    `where:${from}:${now}`,
    `saw:${from}:${now}`,
    ...[...people].sort().map((id) => `person:${id}`),
  ]
    .map((id) => parseTopic(id, speakerId, investigation, locationId, now))
    .filter((topic): topic is Topic => topic !== undefined);
}

export function contradictionsOf(state: DesktopState, clues: readonly Clue[]): Contradiction[] {
  return detectContradictions(state.knowledge, { clues: new Map(clues.map((c) => [c.id, c])) });
}

function cost(
  type: DesktopActionType,
  env: ActionEnv,
  state: DesktopState,
  minutes?: number,
): { expected: number; max: number } {
  try {
    const modifiers =
      minutes === undefined
        ? currentModifiers(state, env.investigation, env.locationId, env.now)
        : [];
    return resolveActionCost(
      type,
      { ...(minutes !== undefined && { minutes }), modifiers },
      env.costs,
    );
  } catch (error) {
    if (error instanceof ActionCostError && error.code === 'ACTION_INVALID') return invalid();
    throw error;
  }
}

/**
 * Checks a desktop action and prices it. Returns the plan the engine runs after advancing time,
 * or the error code of a refused action; a refused action never changes state.
 */
export function planDesktopAction(
  action: Desktop,
  state: DesktopState,
  env: ActionEnv,
): ActionPlan | ErrorCode {
  try {
    return plan(action, state, env);
  } catch (error) {
    if (error instanceof Rejection) return error.code;
    throw error;
  }
}

function plan(action: Desktop, state: DesktopState, env: ActionEnv): ActionPlan {
  const { investigation, locationId, now } = env;
  const actor = effectiveActor(state, env.actor, investigation, locationId);
  const has = (requirement: DiscoveryRequirement): boolean => {
    switch (requirement.kind) {
      case 'item':
        return actor.itemIds?.has(requirement.id) ?? false;
      case 'clue':
        return state.knowledge.clues.has(requirement.id);
      case 'contact':
        return state.knowledge.contacts.has(requirement.id);
      case 'password':
        return false;
    }
  };
  const discover = (discovery: DiscoveryAction, at: number): GameEvent[] => {
    const events: GameEvent[] = [];
    for (const clue of env.clues) {
      if (state.knowledge.clues.has(clue.id)) continue;
      if (!discoverable(clue, { locationId, action: discovery, minute: at, has })) continue;
      const captureRequested = clue.captureMode === 'qr';
      if (captureRequested) {
        if (!env.requestCapture(clue, has)) continue;
      } else {
        state.knowledge.addClue({ clueId: clue.id, discoveredAt: at, location: locationId });
      }
      events.push({ type: 'ClueDiscovered', clueId: clue.id, locationId, at, captureRequested });
    }
    return [...events, ...announceContradictions(state, env.clues, at)];
  };
  const simple = (
    type: DesktopActionType,
    verb: string,
    targets: readonly EntityRef[],
    effect: (at: number) => GameEvent[],
    extra: Partial<ActionPlan> = {},
  ): ActionPlan => ({
    type,
    minutes: cost(type, env, state).expected,
    interruptible: false,
    verb,
    targets,
    noisy: false,
    ...extra,
    resolve: ({ at, completed }) => (completed ? effect(at) : []),
  });

  switch (action.type) {
    case 'examineLocation':
      if (state.examinedLocations.has(locationId)) return notAvailable();
      return simple('examineLocation', 'examine_location', [], () => {
        state.examinedLocations.add(locationId);
        return [];
      });

    case 'examineHotspot': {
      const { hotspotId } = action;
      if (
        !state.examinedLocations.has(locationId) ||
        !visibleHotspots(investigation, locationId, now).some(({ id }) => id === hotspotId)
      ) {
        return notAvailable();
      }
      return simple('examineHotspot', 'examine_hotspot', [], (at) => {
        const key = `${locationId}/${hotspotId}`;
        const found = hotspotId === BODY_HOTSPOT_ID && !state.examinedHotspots.has(key);
        state.examinedHotspots.add(key);
        const events = discover({ type: 'examineHotspot', hotspotId }, at);
        // The body is found once, at the moment of the inspection (OQ-28).
        return found ? [{ type: 'BodyFound', locationId, at }, ...events] : events;
      });
    }

    case 'read': {
      const { documentId } = action;
      if (!readableDocuments(investigation, env.clues, locationId, now).includes(documentId)) {
        return notAvailable();
      }
      return simple('read', 'read', [{ kind: 'document', id: documentId }], (at) =>
        discover({ type: 'read', documentId }, at),
      );
    }

    case 'talk': {
      const { characterId, topicId } = action;
      const topic = parseTopic(topicId, characterId, investigation, locationId, now) ?? invalid();
      requirePresent(env, characterId);
      return dialogue(state, env, 'talk', characterId, { topicId }, topic.label, (ctx) =>
        answer(topic.question, ctx),
      );
    }

    case 'interrogate': {
      const { characterId, subject } = action;
      requirePresent(env, characterId);
      if (subject.type === 'evidence') {
        const clue = env.clues.find(({ id }) => id === subject.clueId);
        if (!clue || !state.knowledge.clues.has(clue.id)) return notAvailable();
        const subjects = clue.supports.flatMap((reference) => {
          const seen = parsePresence(reference);
          return seen ? [{ kind: 'at' as const, who: seen.who, where: seen.where }] : [];
        });
        return dialogue(
          state,
          env,
          'interrogate',
          characterId,
          { clueId: clue.id },
          clue.presentation,
          (ctx) => answer({ type: 'whatIsThis', clue: { id: clue.id, subjects } }, ctx),
        );
      }
      const found = contradictionsOf(state, env.clues).find(
        ({ id }) => id === subject.contradictionId,
      );
      const challenged = found && state.statements.get(found.statementId);
      if (!found || !challenged || challenged.speakerId !== characterId) return notAvailable();
      return dialogue(
        state,
        env,
        'interrogate',
        characterId,
        { contradictionId: found.id },
        'Противоречие',
        (ctx, events, at, lead) => {
          const reaction = reactToRebuttal(
            challenged,
            { kind: 'at', who: found.subject, where: found.found.where },
            ctx,
          );
          events.push({ type: 'InterrogationReaction', characterId, reaction: reaction.kind, at });
          lead.push(`rebuttal_${reaction.kind}`);
          return reaction.kind === 'refuse' ? [] : [reaction.statement];
        },
      );
    }

    case 'useItem': {
      const item = state.inventory.items.find(({ id }) => id === action.itemId);
      if (!item || action.targetId !== undefined) return notAvailable();
      const use = (at: number): GameEvent[] => {
        const used: GameEvent = { type: 'ItemUsed', itemId: item.id, at };
        if (item.kind === 'flashlight') {
          state.inventory = setFlashlight(state.inventory, !state.inventory.flashlightOn);
          return [used];
        }
        const result = consume(state.inventory, state.vitals, item.id, at);
        state.inventory = result.inventory;
        state.vitals = result.vitals.state;
        return [used, ...result.vitals.events];
      };
      const usable =
        item.kind === 'medkit' ||
        item.kind === 'sedative' ||
        (item.kind === 'flashlight' &&
          (state.inventory.flashlightOn || (item.chargeMinutes ?? 0) > 0));
      if (!usable) return notAvailable();
      return simple('useItem', 'use_item', [], use);
    }

    case 'pickLock': {
      const { targetId } = action;
      if (
        !state.inventory.items.some(({ kind }) => kind === 'lockpick') ||
        !pickableDoors(state, env).includes(targetId)
      ) {
        return notAvailable();
      }
      const { expected, max } = cost('pickLock', env, state);
      const success = createRng(investigation.seed)
        .fork('engine/pickLock')
        .fork(`${now}/${doorKey(locationId, targetId)}`)
        .chance(PICK_LOCK_SUCCESS);
      return {
        type: 'pickLock',
        minutes: success ? expected : max,
        interruptible: false,
        verb: success ? 'pick_lock' : 'attempt_pick_lock',
        targets: [{ kind: 'location', id: targetId }],
        noisy: true,
        resolve: ({ at, completed }) => {
          if (!completed) return [];
          if (success) {
            state.unlockedDoors.add(doorKey(locationId, targetId));
            state.unlockedDoors.add(doorKey(targetId, locationId));
          }
          return [{ type: 'LockPicked', targetId, success, at }];
        },
      };
    }

    case 'rest':
      return {
        type: 'rest',
        minutes: cost('rest', env, state, action.minutes).expected,
        interruptible: true,
        verb: 'rest',
        targets: [],
        noisy: false,
        resolve: () => [],
      };
  }
}

function requirePresent(env: ActionEnv, characterId: string): void {
  if (!presentAt(env.investigation, env.locationId, env.now).includes(characterId)) notAvailable();
}

export function announceContradictions(
  state: DesktopState,
  clues: readonly Clue[],
  at: number,
): GameEvent[] {
  const events = contradictionEvents(
    contradictionsOf(state, clues),
    state.announcedContradictions,
    at,
  );
  for (const { contradictionId } of events) state.announcedContradictions.add(contradictionId);
  return events;
}

function dialogue(
  state: DesktopState,
  env: ActionEnv,
  type: 'talk' | 'interrogate',
  characterId: string,
  subject: Pick<ActionPlan, 'topicId' | 'clueId' | 'contradictionId'>,
  prompt: string,
  reply: (ctx: SpeakerContext, events: GameEvent[], at: number, lead: string[]) => Statement[],
): ActionPlan {
  const character = env.investigation.characters.find(({ id }) => id === characterId)!;
  return {
    type,
    minutes: cost(type, env, state).expected,
    interruptible: false,
    verb: type,
    targets: [{ kind: 'character', id: characterId }],
    noisy: false,
    characterId,
    ...subject,
    resolve: ({ at, completed }) => {
      if (!completed) return [];
      const events: GameEvent[] = [];
      const witness = env.testimony?.witness(characterId);
      const lead: string[] = [];
      const statements = witness
        ? reply(
            { character, knowledge: witness.knowledge, policy: witness.policy, now: at },
            events,
            at,
            lead,
          )
        : [];
      const lines: DialogueLine[] = [{ speaker: 'player', text: prompt, at }];
      // Admission, change of version and refusal are separate lines with their own keys.
      for (const key of lead) lines.push({ speaker: 'other', text: key, at });
      for (const statement of statements) {
        state.statements.set(statement.id, statement);
        lines.push({
          speaker: 'other',
          text: statement.templateKey,
          at,
          statementId: statement.id,
        });
        if (state.knowledge.addStatement(statement)) {
          events.push({
            type: 'StatementHeard',
            statementId: statement.id,
            characterId,
            topicId: statement.topic,
            at,
          });
        }
      }
      if (statements.length === 0 && lead.length === 0) {
        lines.push({ speaker: 'other', text: 'testimony_none', at });
      }
      const previous =
        state.interaction?.characterId === characterId ? state.interaction.history : [];
      state.interaction = {
        kind: 'dialogue',
        characterId,
        ...(type === 'interrogate' && { interrogation: true as const }),
        history: [...previous, ...lines],
      };
      return [...events, ...announceContradictions(state, env.clues, at)];
    },
  };
}
