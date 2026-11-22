import { ACTIONS_BY_ROLE, PlayerAction, type ErrorCode } from '@hs/protocol';
import { stateHash } from '../common/index.ts';
import {
  ActionCostError,
  Calendar,
  TimeSystem,
  resolveActionCost,
  type ActionCostTable,
  type ClockEvent,
} from '../time/index.ts';
import { WorldError, type Actor } from '../world/index.ts';
import {
  deserializeInvestigation,
  serializeInvestigation,
  type Investigation,
} from './investigation.ts';

export interface EnginePorts {
  readonly startLocationId: string;
  readonly actionCosts?: ActionCostTable;
  readonly player?: Actor;
}

export interface GameSnapshot {
  readonly investigation: string;
  readonly initialInvestigationHash: string;
  readonly minute: number;
  readonly locationId: string;
}

export interface DispatchResult {
  readonly ok: boolean;
  readonly error?: ErrorCode;
  readonly minutesSpent: number;
  readonly events: ClockEvent[];
  readonly outcome?: 'time_expired';
}

function rejected(error: ErrorCode): DispatchResult {
  return { ok: false, error, minutesSpent: 0, events: [] };
}

export class GameEngine {
  readonly #time: TimeSystem;

  private constructor(
    private readonly investigation: Investigation,
    private readonly initialInvestigationHash: string,
    private readonly ports: EnginePorts,
    private locationId: string,
    minute: number,
  ) {
    const { locations, durationMinutes } = investigation.world;
    const { startDateTime } = locations;
    locations.isAccessible(locationId, ports.player ?? {}, minute);
    if (!Number.isSafeInteger(minute) || minute < 0 || minute > durationMinutes) {
      throw new RangeError('Snapshot minute is outside the scenario');
    }
    this.#time = new TimeSystem(new Calendar(startDateTime), durationMinutes, minute);
  }

  static create(investigation: Investigation, ports: EnginePorts): GameEngine {
    const serialized = serializeInvestigation(investigation);
    return new GameEngine(
      deserializeInvestigation(serialized),
      stateHash(serialized),
      ports,
      ports.startLocationId,
      0,
    );
  }

  static restore(
    snapshot: GameSnapshot,
    investigation: Investigation,
    ports: EnginePorts,
  ): GameEngine {
    if (snapshot.initialInvestigationHash !== stateHash(serializeInvestigation(investigation))) {
      throw new Error('Snapshot belongs to a different investigation');
    }
    return new GameEngine(
      deserializeInvestigation(snapshot.investigation),
      snapshot.initialInvestigationHash,
      ports,
      snapshot.locationId,
      snapshot.minute,
    );
  }

  dispatch(source: 'desktop' | 'phone', input: PlayerAction): DispatchResult {
    const parsed = PlayerAction.safeParse(input);
    const allowed: readonly PlayerAction['type'][] | undefined = ACTIONS_BY_ROLE[source];
    if (!parsed.success || !allowed?.includes(parsed.data.type)) return rejected('ACTION_INVALID');

    const action = parsed.data;
    const { locations, durationMinutes } = this.investigation.world;
    const now = this.#time.now();
    if (now >= durationMinutes) return rejected('GAME_OVER');
    if (action.type !== 'move' && action.type !== 'wait') return rejected('ACTION_NOT_AVAILABLE');

    const actor = this.ports.player ?? {};
    let minutes: number;
    let destination = this.locationId;
    try {
      if (action.type === 'move') {
        destination = action.locationId;
        if (
          locations.path(this.locationId, destination, actor).length !== 2 ||
          !locations.isAccessible(destination, actor, now).ok
        ) {
          return rejected('ACTION_NOT_AVAILABLE');
        }
        minutes = resolveActionCost(
          'move',
          {
            travel: {
              from: this.locationId,
              to: destination,
              provider: { travelTime: (from, to) => locations.travelTime(from, to, actor) },
            },
          },
          this.ports.actionCosts,
        ).expected;
      } else {
        minutes = resolveActionCost(
          'wait',
          { minutes: action.minutes },
          this.ports.actionCosts,
        ).expected;
      }
    } catch (error) {
      if (error instanceof WorldError) return rejected('ACTION_NOT_AVAILABLE');
      if (error instanceof ActionCostError && error.code === 'ACTION_INVALID')
        return rejected('ACTION_INVALID');
      throw error;
    }

    const elapsed = this.#time.advance(minutes);
    const minutesSpent = elapsed.to - elapsed.from;
    this.investigation.truth.append({
      t: now,
      duration: minutesSpent,
      verb: action.type,
      actorIds: ['player'],
      location: this.locationId,
      targets: action.type === 'move' ? [{ kind: 'location', id: destination }] : [],
      causes: [],
      facts: [],
      traceIds: [],
      visibility: 'public',
    });
    if (minutesSpent === minutes) this.locationId = destination;
    return {
      ok: true,
      minutesSpent,
      events: elapsed.events,
      ...(elapsed.to === durationMinutes ? { outcome: 'time_expired' as const } : {}),
    };
  }

  snapshot(): GameSnapshot {
    return {
      investigation: serializeInvestigation(this.investigation),
      initialInvestigationHash: this.initialInvestigationHash,
      minute: this.#time.now(),
      locationId: this.locationId,
    };
  }

  stateHash(): string {
    return stateHash(this.snapshot());
  }
}
