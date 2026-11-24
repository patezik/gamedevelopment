import type { PlayerView } from '@hs/protocol';
import {
  Calendar,
  DEFAULT_ACTION_COSTS,
  resolveActionCost,
  type ActionCostTable,
} from '../time/index.ts';
import type { PendingCapture } from '../evidence/index.ts';
import type { Actor } from '../world/index.ts';
import type { Investigation } from './investigation.ts';

export interface PlayerViewState {
  readonly investigation: Investigation;
  readonly locationId: string;
  readonly minute: number;
  readonly actor?: Actor;
  readonly actionCosts?: ActionCostTable;
  readonly pendingCapture?: PendingCapture;
}

export function moveCost(from: string, to: string, minutes: number, costs?: ActionCostTable) {
  return resolveActionCost(
    'move',
    { travel: { from, to, provider: { travelTime: () => minutes } } },
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
  } = state;
  const { locations, durationMinutes } = investigation.world;
  const room = locations.describe(locationId);
  const { day, hh, mm, period } = new Calendar(locations.startDateTime).toDisplay(minute);
  const remainingMinutes = durationMinutes - minute;
  const present = new Set(
    investigation.truth.whoWasAt(locationId, { from: minute, to: minute + 1 }),
  );
  const availableActions: PlayerView['availableActions'] = [];
  const exits = room.connections.map(({ to, minutes }) => {
    const name = locations.describe(to).name;
    const connection = locations.directConnection(locationId, to, actor);
    const access = locations.isAccessible(to, actor, minute);
    const blockedReason = connection ? (access.ok ? undefined : access.reason) : 'locked';
    const { min, max, expected } = moveCost(
      locationId,
      to,
      connection?.minutes ?? minutes,
      actionCosts,
    );
    if (remainingMinutes > 0 && !blockedReason) {
      availableActions.push({
        action: { type: 'move', locationId: to },
        label: name,
        costPreview: { min, max },
      });
    }
    return { locationId: to, name, minutes: expected, ...(blockedReason && { blockedReason }) };
  });

  const wait = actionCosts.wait;
  // The wire action requires a positive duration. Offer the first selectable value.
  const waitMinutes =
    'choices' in wait
      ? wait.choices.find((value) => value > 0)
      : 'range' in wait
        ? wait.range[0] || (wait.step <= wait.range[1] ? wait.step : undefined)
        : undefined;
  if (remainingMinutes > 0 && waitMinutes !== undefined) {
    const { min, max } = resolveActionCost('wait', { minutes: waitMinutes }, actionCosts);
    availableActions.push({
      action: { type: 'wait', minutes: waitMinutes },
      label: 'Ждать',
      costPreview: { min, max },
    });
  }

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
      hotspots: room.hotspots.map(({ id, name }) => ({ id, name, examined: false })),
      exits,
    },
    knownMap: { locations: [...known.values()], links },
    presentCharacters: investigation.characters
      .filter(({ id }) => present.has(id))
      .map(({ id, name }) => ({ id, name, portraitRef: '', demeanor: '' })),
    availableActions,
    vitals: { health: 10, sanity: 10, fatigue: 0 },
    static: 0,
    inventory: [],
    caseBoard: {
      clues: [],
      statements: [],
      contradictions: [],
      personsOfInterest: [],
      suspicions: [],
      timeline: [],
    },
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
