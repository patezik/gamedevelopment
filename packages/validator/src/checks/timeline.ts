import { ScheduleError, validateRoutine, type Character } from '@hs/core/characters';
import type { Investigation } from '@hs/core/game';
import { WorldError, type Actor } from '@hs/core/world';
import type { Check, FindingInput, ValidationContext } from '../check.ts';

function eventBounds(
  { truth, world }: Investigation,
  { historyStartMinutes }: ValidationContext,
): FindingInput[] {
  const end = world.durationMinutes;
  const findings: FindingInput[] = [];

  for (const event of truth.events()) {
    if (historyStartMinutes !== undefined && event.t < historyStartMinutes) {
      findings.push({
        severity: 'error',
        code: 'TIMELINE_EVENT_BEFORE_HISTORY',
        message: `${event.id} (${event.verb}) starts at ${event.t}, before the prehistory begins at ${historyStartMinutes}`,
        eventIds: [event.id],
        minute: event.t,
      });
    }
    if (event.t + event.duration > end) {
      findings.push({
        severity: 'error',
        code: 'TIMELINE_EVENT_AFTER_END',
        message: `${event.id} (${event.verb}) ends at ${event.t + event.duration}, after the scenario ends at ${end}`,
        eventIds: [event.id],
        minute: event.t,
      });
    }
  }

  const { window, keyEventIds } = truth.incident;
  if (historyStartMinutes !== undefined && window.from < historyStartMinutes) {
    findings.push({
      severity: 'error',
      code: 'TIMELINE_INCIDENT_WINDOW_BEFORE_HISTORY',
      message: `The incident window starts at ${window.from}, before the prehistory begins at ${historyStartMinutes}`,
      eventIds: keyEventIds,
      minute: window.from,
    });
  }
  if (window.to > end) {
    findings.push({
      severity: 'error',
      code: 'TIMELINE_INCIDENT_WINDOW_AFTER_END',
      message: `The incident window ends at ${window.to}, after the scenario ends at ${end}`,
      eventIds: keyEventIds,
      minute: window.to,
    });
  }
  return findings;
}

/** Whether a character holding every key can walk from one location to the other. */
function routeExists(
  world: Investigation['world'],
  actor: Actor,
  from: string,
  to: string,
): boolean {
  return world.locations.travelTime(from, to, actor) !== null;
}

function routines(investigation: Investigation): FindingInput[] {
  const { world } = investigation;
  // Structural reachability: assume every key is in hand, so only a missing or permanent lock fails.
  const keys: Actor['itemIds'] = new Set(world.items.snapshot().initial.map(({ item }) => item.id));
  const findings: FindingInput[] = [];

  const characters = [...investigation.characters].sort((a, b) =>
    a.id < b.id ? -1 : Number(a.id > b.id),
  );
  for (const character of characters) {
    const subject = { kind: 'character', id: character.id } as const;
    try {
      validateRoutine(character);
    } catch (error) {
      if (!(error instanceof ScheduleError)) throw error;
      findings.push({
        severity: 'error',
        code: error.code,
        message: `The routine of ${character.id} is not a full 24 hours: ${error.code} at minute ${error.minute} of the day`,
        eventIds: [],
        subject,
        data: { minuteOfDay: error.minute },
      });
      continue; // a broken routine has no reliable order of blocks
    }
    findings.push(...transitions(world, character, keys));
  }
  return findings;
}

function transitions(
  world: Investigation['world'],
  character: Character,
  keys: Actor['itemIds'],
): FindingInput[] {
  const actor: Actor = { archetypeId: character.archetypeId, ...(keys ? { itemIds: keys } : {}) };
  const subject = { kind: 'character', id: character.id } as const;
  const blocks = [...character.routine].sort((a, b) => a.from - b.from);
  const findings: FindingInput[] = [];
  const seen = new Set<string>();

  blocks.forEach((block, i) => {
    const next = blocks[(i + 1) % blocks.length];
    if (!next) return;
    const pair = `${block.location}>${next.location}`;
    if (seen.has(pair)) return;
    seen.add(pair);
    try {
      if (routeExists(world, actor, block.location, next.location)) return;
    } catch (error) {
      if (!(error instanceof WorldError)) throw error;
      findings.push({
        severity: 'error',
        code: 'TIMELINE_ROUTINE_UNKNOWN_LOCATION',
        message: `${character.id}: the routine refers to a location that does not exist (${error.message})`,
        eventIds: [],
        subject,
      });
      return;
    }
    findings.push({
      severity: 'error',
      code: 'TIMELINE_ROUTINE_UNREACHABLE',
      message: `${character.id}: the routine moves from ${block.location} to ${next.location} at minute ${next.from} of the day, but there is no route between them`,
      eventIds: [],
      subject,
      data: { minuteOfDay: next.from },
    });
  });
  return findings;
}

/**
 * V-TIMELINE: the chronology is sound. Events and the incident window lie inside the scenario;
 * every character's routine covers the whole day without gaps or overlaps; and the places a routine
 * moves between are connected. How *fast* a move is made is invariant 2 of V-TRUTH-INV and is not
 * repeated here.
 */
export const timelineCheck: Check = {
  id: 'V-TIMELINE',
  description: 'Events inside the scenario, routines without gaps, routine moves possible',
  run(investigation, context) {
    return [...eventBounds(investigation, context), ...routines(investigation)];
  },
};
