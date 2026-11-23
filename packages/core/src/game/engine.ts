import { ACTIONS_BY_ROLE, PlayerAction, type ErrorCode } from '@hs/protocol';
import { stateHash } from '../common/index.ts';
import {
  discoverable,
  issueEvidenceCapture,
  type Clue,
  type DiscoveryContext,
  type EvidenceTokenPort,
  type PendingCapture,
} from '../evidence/index.ts';
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
  readonly evidenceTokens?: EvidenceTokenPort;
}

export interface GameSnapshot {
  readonly investigation: string;
  readonly initialInvestigationHash: string;
  readonly minute: number;
  readonly locationId: string;
  readonly pendingCapture?: PendingCapture;
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
  private readonly investigation: Investigation;
  private readonly initialInvestigationHash: string;
  private readonly ports: EnginePorts;
  private locationId: string;
  #pendingCapture: PendingCapture | undefined;

  private constructor(
    investigation: Investigation,
    initialInvestigationHash: string,
    ports: EnginePorts,
    locationId: string,
    minute: number,
  ) {
    const { locations, durationMinutes } = investigation.world;
    const { startDateTime } = locations;
    locations.isAccessible(locationId, ports.player ?? {}, minute);
    if (!Number.isSafeInteger(minute) || minute < 0 || minute > durationMinutes) {
      throw new RangeError('Snapshot minute is outside the scenario');
    }
    this.investigation = investigation;
    this.initialInvestigationHash = initialInvestigationHash;
    this.ports = ports;
    this.locationId = locationId;
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
    const engine = new GameEngine(
      deserializeInvestigation(snapshot.investigation),
      snapshot.initialInvestigationHash,
      ports,
      snapshot.locationId,
      snapshot.minute,
    );
    engine.#pendingCapture = snapshot.pendingCapture && { ...snapshot.pendingCapture };
    return engine;
  }

  pendingEvidenceCapture(): PendingCapture | undefined {
    const pending = this.#pendingCapture;
    if (
      !pending ||
      pending.locationId !== this.locationId ||
      pending.expiresAt <= this.#time.now() ||
      this.#time.now() >= this.investigation.world.durationMinutes
    )
      return undefined;
    return { ...pending };
  }

  requestEvidenceCapture(
    clue: Clue,
    context: Pick<DiscoveryContext, 'action' | 'has'>,
  ): PendingCapture | undefined {
    const port = this.ports.evidenceTokens;
    const minute = this.#time.now();
    if (
      !port ||
      clue.captureMode !== 'qr' ||
      minute >= this.investigation.world.durationMinutes ||
      !discoverable(clue, { ...context, locationId: this.locationId, minute })
    )
      return undefined;

    const pending = this.pendingEvidenceCapture();
    if (pending?.clueId === clue.id) return pending;
    if (this.#pendingCapture) {
      port.revoke(this.#pendingCapture.tokenId);
      this.#pendingCapture = undefined;
    }
    const issued = issueEvidenceCapture(clue, minute, port);
    this.#pendingCapture = issued;
    return { ...issued };
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
    let movementKey: string | undefined;
    try {
      if (action.type === 'move') {
        destination = action.locationId;
        const connection = locations.directConnection(this.locationId, destination, actor);
        if (!connection || !locations.isAccessible(destination, actor, now).ok) {
          return rejected('ACTION_NOT_AVAILABLE');
        }
        movementKey = connection.locked?.itemId;
        minutes = resolveActionCost(
          'move',
          {
            travel: {
              from: this.locationId,
              to: destination,
              provider: { travelTime: () => connection.minutes },
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
    const completed = minutesSpent === minutes;
    this.investigation.truth.append({
      t: now,
      duration: minutesSpent,
      verb: action.type === 'move' && !completed ? 'attempt_move' : action.type,
      actorIds: ['player'],
      location: this.locationId,
      targets:
        action.type === 'move'
          ? [
              { kind: 'location', id: destination },
              ...(movementKey ? [{ kind: 'item' as const, id: movementKey }] : []),
            ]
          : [],
      causes: [],
      facts: [],
      traceIds: [],
      visibility: 'public',
    });
    if (completed) this.locationId = destination;
    return {
      ok: true,
      minutesSpent,
      events: elapsed.events,
      ...(elapsed.to === durationMinutes ? { outcome: 'time_expired' as const } : {}),
    };
  }

  snapshot(): GameSnapshot {
    const pendingCapture = this.#pendingCapture;
    return {
      investigation: serializeInvestigation(this.investigation),
      initialInvestigationHash: this.initialInvestigationHash,
      minute: this.#time.now(),
      locationId: this.locationId,
      ...(pendingCapture ? { pendingCapture: { ...pendingCapture } } : {}),
    };
  }

  stateHash(): string {
    return stateHash(this.snapshot());
  }
}
