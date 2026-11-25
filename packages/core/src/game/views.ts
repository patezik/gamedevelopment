import type { PlayerView } from '@hs/protocol';
import {
  Calendar,
  DEFAULT_ACTION_COSTS,
  resolveActionCost,
  type ActionCostTable,
  type CostModifier,
} from '../time/index.ts';
import type { Clue, PendingCapture } from '../evidence/index.ts';
import type { Actor } from '../world/index.ts';
import {
  DesktopState,
  contradictionsOf,
  currentModifiers,
  effectiveActor,
  offeredTopics,
  pickableDoors,
  presentAt,
  readableDocuments,
  type DesktopActionType,
} from './actions/index.ts';
import { endingOf, endingView } from './ending.ts';
import type { Investigation } from './investigation.ts';

export interface PlayerViewState {
  readonly investigation: Investigation;
  readonly locationId: string;
  readonly minute: number;
  readonly actor?: Actor;
  readonly actionCosts?: ActionCostTable;
  readonly pendingCapture?: PendingCapture;
  /** ENG-003 state: what the player examined, knows, carries and who they are talking to. */
  readonly desktop?: DesktopState;
  readonly clues?: readonly Clue[];
}

type OfferedAction = PlayerView['availableActions'][number]['action'];

export function moveCost(
  from: string,
  to: string,
  minutes: number,
  costs?: ActionCostTable,
  modifiers: readonly CostModifier[] = [],
) {
  return resolveActionCost(
    'move',
    { travel: { from, to, provider: { travelTime: () => minutes } }, modifiers },
    costs,
  );
}

/** Builds a detached desktop payload from visible data at the player's location and time. */
export function projectPlayerView(state: PlayerViewState): PlayerView {
  const {
    investigation,
    locationId,
    minute,
    actor = {},
    actionCosts = DEFAULT_ACTION_COSTS,
    pendingCapture,
    desktop = new DesktopState(),
    clues = [],
  } = state;
  const { locations, durationMinutes } = investigation.world;
  const room = locations.describe(locationId);
  const { day, hh, mm, period } = new Calendar(locations.startDateTime).toDisplay(minute);
  const remainingMinutes = durationMinutes - minute;
  const ending = endingOf(desktop, minute, durationMinutes);
  const present = new Set(presentAt(investigation, locationId, minute));
  const modifiers = currentModifiers(desktop, investigation, locationId, minute);
  const availableActions: PlayerView['availableActions'] = [];
  const offer = (action: Extract<OfferedAction, { type: DesktopActionType }>, label: string) => {
    if (remainingMinutes <= 0 || ending) return;
    const context = action.type === 'rest' ? { minutes: action.minutes } : { modifiers };
    const { min, max } = resolveActionCost(action.type, context, actionCosts);
    availableActions.push({ action, label, costPreview: { min, max } });
  };
  const exits = room.connections.map(({ to, minutes }) => {
    const name = locations.describe(to).name;
    const exitActor = effectiveActor(desktop, actor, investigation, locationId, to);
    const connection = locations.directConnection(locationId, to, exitActor);
    const access = locations.isAccessible(to, exitActor, minute);
    const blockedReason = connection ? (access.ok ? undefined : access.reason) : 'locked';
    const { min, max, expected } = moveCost(
      locationId,
      to,
      connection?.minutes ?? minutes,
      actionCosts,
      modifiers,
    );
    if (remainingMinutes > 0 && !ending && !blockedReason) {
      availableActions.push({
        action: { type: 'move', locationId: to },
        label: name,
        costPreview: { min, max },
      });
    }
    return { locationId: to, name, minutes: expected, ...(blockedReason && { blockedReason }) };
  });

  const examined = desktop.examinedLocations.has(locationId);
  const hotspots = examined
    ? room.hotspots.map(({ id, name }) => ({
        id,
        name,
        examined: desktop.examinedHotspots.has(`${locationId}/${id}`),
      }))
    : [];
  if (!examined) offer({ type: 'examineLocation' }, 'Осмотреть локацию');
  for (const { id, name } of hotspots) offer({ type: 'examineHotspot', hotspotId: id }, name);
  const people = investigation.characters.filter(({ id }) => present.has(id));
  for (const { id, name } of people)
    offer({ type: 'talk', characterId: id, topicId: 'self' }, name);
  for (const documentId of readableDocuments(investigation, clues, locationId, minute)) {
    offer({ type: 'read', documentId }, 'Изучить документ');
  }
  for (const item of desktop.inventory.items) {
    const usable =
      item.kind === 'medkit' ||
      item.kind === 'sedative' ||
      (item.kind === 'flashlight' &&
        (desktop.inventory.flashlightOn || (item.chargeMinutes ?? 0) > 0));
    if (usable) offer({ type: 'useItem', itemId: item.id }, item.kind);
  }
  if (desktop.inventory.items.some(({ kind }) => kind === 'lockpick')) {
    const env = { investigation, clues, locationId, now: minute, actor, costs: actionCosts };
    for (const to of pickableDoors(desktop, env)) {
      offer({ type: 'pickLock', targetId: to }, locations.describe(to).name);
    }
  }
  const restRule = actionCosts.rest;
  const restMinutes =
    'choices' in restRule ? restRule.choices.find((value) => value > 0) : undefined;
  if (restMinutes !== undefined) offer({ type: 'rest', minutes: restMinutes }, 'Отдых');

  const wait = actionCosts.wait;
  // The wire action requires a positive duration. Offer the first selectable value.
  const waitMinutes =
    'choices' in wait
      ? wait.choices.find((value) => value > 0)
      : 'range' in wait
        ? wait.range[0] || (wait.step <= wait.range[1] ? wait.step : undefined)
        : undefined;
  if (remainingMinutes > 0 && !ending && waitMinutes !== undefined) {
    const { min, max } = resolveActionCost('wait', { minutes: waitMinutes }, actionCosts);
    availableActions.push({
      action: { type: 'wait', minutes: waitMinutes },
      label: 'Ждать',
      costPreview: { min, max },
    });
  }

  const open = desktop.interaction;
  const partner =
    open && remainingMinutes > 0 ? people.find(({ id }) => id === open.characterId) : undefined;
  const talkCost = resolveActionCost('talk', { modifiers }, actionCosts);
  const interaction: PlayerView['interaction'] = partner && {
    characterId: partner.id,
    characterName: partner.name,
    topics: offeredTopics(desktop, partner.id, investigation, locationId, minute).map(
      ({ id, label }) => ({ id, label, costPreview: { min: talkCost.min, max: talkCost.max } }),
    ),
    presentable: [
      ...[...desktop.knowledge.clues.keys()].map((id) => ({
        type: 'evidence' as const,
        id,
        label: clues.find((clue) => clue.id === id)?.presentation ?? id,
      })),
      ...contradictionsOf(desktop, clues)
        .filter(({ statementId }) => desktop.statements.get(statementId)?.speakerId === partner.id)
        .map(({ id }) => ({ type: 'contradiction' as const, id, label: 'Противоречие' })),
    ],
    history: (open?.history ?? []).map((line) => ({ ...line })),
  };

  return {
    clock: {
      t: minute,
      day,
      time: [hh, mm].map((part) => String(part).padStart(2, '0')).join(':'),
      period,
      remainingMinutes,
    },
    location: {
      id: room.id,
      name: room.name,
      description: room.description,
      lighting: room.lighting[period],
      hotspots,
      exits,
    },
    knownMap: knownMapOf(investigation, locationId),
    presentCharacters: people.map(({ id, name }) => ({ id, name, portraitRef: '', demeanor: '' })),
    availableActions,
    vitals: { ...desktop.vitals.vitals },
    static: 0,
    inventory: desktop.inventory.items.map(({ id, kind }) => ({ id, name: kind, description: '' })),
    caseBoard: caseBoard(desktop, clues),
    ...(interaction && { interaction }),
    ...(ending && { ending: endingView(ending, investigation, desktop.verdict) }),
    phone: { paired: false, online: false, battery: 100 },
    ...(pendingCapture &&
      remainingMinutes > 0 &&
      pendingCapture.locationId === locationId &&
      pendingCapture.expiresAt > minute && {
        pendingCapture: {
          tokenId: pendingCapture.tokenId,
          clueTitle: 'Фиксация улики',
          expiresInMinutes: Math.min(remainingMinutes, pendingCapture.expiresAt - minute),
        },
      }),
  };
}

function knownMapOf(investigation: Investigation, locationId: string): PlayerView['knownMap'] {
  const { locations } = investigation.world;
  const visited = new Set<string>();
  for (const event of investigation.truth.events()) {
    if (event.verb !== 'move' || !event.actorIds.includes('player')) continue;
    visited.add(event.location);
    for (const target of event.targets) {
      if (target.kind === 'location') visited.add(target.id);
    }
  }
  visited.add(locationId);
  const known = new Map<string, { id: string; name: string; visited: boolean }>();
  const links: { from: string; to: string }[] = [];
  const add = (id: string, visit: boolean) => {
    const entry = known.get(id);
    if (entry) entry.visited ||= visit;
    else known.set(id, { id, name: locations.describe(id).name, visited: visit });
  };
  for (const id of visited) add(id, true);
  for (const from of visited) {
    for (const { to } of locations.describe(from).connections) {
      if (to === from) continue;
      add(to, false);
      links.push({ from, to });
    }
  }

  return { locations: [...known.values()], links };
}

function caseBoard(desktop: DesktopState, clues: readonly Clue[]): PlayerView['caseBoard'] {
  const byId = new Map(clues.map((clue) => [clue.id, clue]));
  return {
    clues: [...desktop.knowledge.clues.values()].map((found) => {
      const clue = byId.get(found.clueId);
      return {
        id: found.clueId,
        title: clue?.presentation ?? found.clueId,
        description: '',
        kind: clue?.discovery.action.type === 'read' ? 'document' : 'physical',
        discoveredAt: found.discoveredAt,
        locationId: found.location,
        captured: found.captured,
      };
    }),
    statements: desktop.knowledge.statements.map((statement) => ({
      id: statement.id,
      characterId: statement.speakerId,
      topicId: statement.topic,
      text: statement.templateKey,
      heardAt: statement.at,
    })),
    contradictions: contradictionsOf(desktop, clues).map(({ id, statementId, clueId }) => ({
      id,
      statementId,
      againstId: clueId,
      summary: 'Показание расходится с уликой',
    })),
    personsOfInterest: [],
    suspicions: [],
    timeline: [],
  };
}
