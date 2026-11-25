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
import { burnFlashlight, rest, tickAwake, type PackItem, type Vitals } from '../survival/index.ts';
import {
  ActionCostError,
  Calendar,
  DEFAULT_ACTION_COSTS,
  TimeSystem,
  resolveActionCost,
  type ActionCostTable,
} from '../time/index.ts';
import type { AccusationOutcome } from '../investigation/index.ts';
import { WorldError, type Actor } from '../world/index.ts';
import {
  DesktopState,
  currentModifiers,
  effectiveActor,
  planDesktopAction,
  presentAt,
  type ActionPlan,
  type DesktopActionType,
  type DesktopStateSnapshot,
  type GameEvent,
  type PlayerActionObserved,
  type TestimonyPort,
} from './actions/index.ts';
import { accuse, type AccusationPort } from './actions/accuse.ts';
import { endingOf, type EndingId } from './ending.ts';
import {
  deserializeInvestigation,
  serializeInvestigation,
  type Investigation,
} from './investigation.ts';
import { moveCost, projectPlayerView } from './views.ts';

export interface EnginePorts {
  readonly startLocationId: string;
  readonly actionCosts?: ActionCostTable;
  readonly player?: Actor;
  readonly evidenceTokens?: EvidenceTokenPort;
  /** Clues of the generated case (EVD-002); examine and read discover them. */
  readonly clues?: readonly Clue[];
  /** Witness memories and lie policies for talk and interrogate (KNOW-002). */
  readonly testimony?: TestimonyPort;
  /** Starting vitals; default 10 / 10 / 0. */
  readonly startVitals?: Vitals;
  /** Starting pack (SURV-004): flashlight, medkits, lockpick, keys. */
  readonly inventory?: readonly PackItem[];
  /** Receives every `PlayerActionObserved` (SIM-006). */
  readonly simulation?: {
    onPlayerAction(event: PlayerActionObserved): void;
    /** A judged accusation (ENG-006). Its consequences name characters: server side only. */
    onAccusation?(outcome: AccusationOutcome, at: number): void;
  };
  /** Deduction rules for `accuse` (ENG-006); without them `accuse` is not available. */
  readonly accusation?: AccusationPort;
  /**
   * Lets the simulation register phase handlers in the engine's `TimeSystem`. A handler that
   * returns `{ interrupt }` during an interruptible action (rest) stops it at that minute.
   */
  readonly attachTime?: (time: TimeSystem) => void;
}

const DESKTOP_ACTIONS: readonly string[] = [
  'examineLocation',
  'examineHotspot',
  'talk',
  'interrogate',
  'read',
  'useItem',
  'pickLock',
  'rest',
] satisfies DesktopActionType[];

export interface GameSnapshot {
  readonly investigation: string;
  readonly initialInvestigationHash: string;
  readonly minute: number;
  readonly locationId: string;
  readonly pendingCapture?: PendingCapture;
  /** ENG-003 state; absent in snapshots taken before it, which restore to the starting state. */
  readonly desktop?: DesktopStateSnapshot;
}

export interface DispatchResult {
  readonly ok: boolean;
  readonly error?: ErrorCode;
  readonly minutesSpent: number;
  readonly events: GameEvent[];
  /** Set when the game is over: the clock ran out, the hero died or lost their mind, or an accusation ended it. */
  readonly outcome?: 'time_expired' | Exclude<EndingId, 'time_up'>;
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
  #desktop: DesktopState | undefined;

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

  #startingDesktop(): DesktopState {
    const { startVitals, inventory } = this.ports;
    return new DesktopState({
      ...(startVitals && { vitals: startVitals }),
      ...(inventory && { inventory }),
    });
  }

  static create(
    investigation: Investigation,
    ports: EnginePorts,
    rules: 'desktop' | 'beforeDesktop' = 'desktop',
  ): GameEngine {
    const serialized = serializeInvestigation(investigation);
    const engine = new GameEngine(
      deserializeInvestigation(serialized),
      stateHash(serialized),
      ports,
      ports.startLocationId,
      0,
    );
    if (rules === 'desktop') {
      engine.#desktop = engine.#startingDesktop();
      ports.attachTime?.(engine.#time);
    }
    return engine;
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
    if (snapshot.desktop !== undefined) {
      engine.#desktop = DesktopState.restore(snapshot.desktop);
      ports.attachTime?.(engine.#time);
    }
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
    const result = this.#dispatch(source, input);
    if (!result.ok || result.outcome || !this.#desktop) return result;
    const ending = endingOf(
      this.#desktop,
      this.#time.now(),
      this.investigation.world.durationMinutes,
    );
    return ending && ending !== 'time_up' ? { ...result, outcome: ending } : result;
  }

  #dispatch(source: 'desktop' | 'phone', input: PlayerAction): DispatchResult {
    const parsed = PlayerAction.safeParse(input);
    const allowed: readonly PlayerAction['type'][] | undefined = ACTIONS_BY_ROLE[source];
    if (!parsed.success || !allowed?.includes(parsed.data.type)) return rejected('ACTION_INVALID');

    const action = parsed.data;
    const { durationMinutes } = this.investigation.world;
    const now = this.#time.now();
    if (now >= durationMinutes) return rejected('GAME_OVER');
    if (this.#desktop && endingOf(this.#desktop, now, durationMinutes)) {
      return rejected('GAME_OVER');
    }
    if (action.type === 'markSuspicion') return rejected('ACTION_NOT_AVAILABLE');
    const port = this.ports.accusation;
    if (action.type === 'accuse' && !port) return rejected('ACTION_NOT_AVAILABLE');
    const desktop = this.#desktop ?? this.#startingDesktop();
    if (action.type === 'accuse' && port) {
      const judged = accuse(action, desktop, {
        investigation: this.investigation,
        clues: this.ports.clues ?? [],
        port,
        now,
      });
      if (!judged.ok) return rejected('ACTION_INVALID');
      if (!this.#desktop) {
        this.#desktop = desktop;
        this.ports.attachTime?.(this.#time);
      }
      if (judged.outcome) this.ports.simulation?.onAccusation?.(judged.outcome, now);
      return { ok: true, minutesSpent: 0, events: judged.events };
    }
    if (action.type === 'move' || action.type === 'wait') return this.#moveOrWait(action, desktop);
    if (!DESKTOP_ACTIONS.includes(action.type)) return rejected('ACTION_NOT_AVAILABLE');

    const plan = planDesktopAction(
      action as Extract<PlayerAction, { type: DesktopActionType }>,
      desktop,
      {
        investigation: this.investigation,
        clues: this.ports.clues ?? [],
        locationId: this.locationId,
        now,
        actor: this.ports.player ?? {},
        costs: this.ports.actionCosts ?? DEFAULT_ACTION_COSTS,
        ...(this.ports.testimony && { testimony: this.ports.testimony }),
        requestCapture: (clue, has) => {
          const previous = this.pendingEvidenceCapture();
          const pending = this.requestEvidenceCapture(clue, { action: clue.discovery.action, has });
          return pending !== undefined && pending.tokenId !== previous?.tokenId;
        },
      },
    );
    if (typeof plan === 'string') return rejected(plan);
    return this.#perform(plan, desktop);
  }

  /** Format 1 has no upgrade marker. A resumed journal changes rules at its first new state.
   * Try the historical transition without ENG-003 effects, then try the live action from the
   * verified boundary. loadSave checks the resulting digest in either case.
   */
  replayBeforeDesktop(
    source: 'desktop' | 'phone',
    action: PlayerAction,
    expectedHash: string,
    investigation: Investigation,
  ): GameEngine {
    if (this.#desktop) {
      this.dispatch(source, action);
      return this;
    }

    const before = this.snapshot();
    if (
      source === 'desktop' &&
      (action.type === 'move' || action.type === 'wait') &&
      this.#time.now() < this.investigation.world.durationMinutes
    ) {
      this.#moveOrWait(action, undefined);
    }
    if (this.stateHash() === expectedHash) return this;

    const resumed = GameEngine.restore(before, investigation, this.ports);
    resumed.dispatch(source, action);
    return resumed;
  }

  #moveOrWait(
    action: Extract<PlayerAction, { type: 'move' | 'wait' }>,
    desktop: DesktopState | undefined,
  ): DispatchResult {
    const { locations } = this.investigation.world;
    const now = this.#time.now();
    const from = this.locationId;
    let minutes: number;
    let destination = from;
    let movementKey: string | undefined;
    try {
      if (action.type === 'move') {
        destination = action.locationId;
        const baseActor = this.ports.player ?? {};
        const actor = desktop
          ? effectiveActor(desktop, baseActor, this.investigation, from, destination)
          : baseActor;
        const connection = locations.directConnection(from, destination, actor);
        if (!connection || !locations.isAccessible(destination, actor, now).ok) {
          return rejected('ACTION_NOT_AVAILABLE');
        }
        movementKey = connection.locked?.itemId;
        minutes = moveCost(
          from,
          destination,
          connection.minutes,
          this.ports.actionCosts,
          desktop ? currentModifiers(desktop, this.investigation, from, now) : [],
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
    return this.#perform(
      {
        type: action.type,
        minutes,
        interruptible: false,
        verb: action.type,
        targets:
          action.type === 'move'
            ? [
                { kind: 'location', id: destination },
                ...(movementKey ? [{ kind: 'item' as const, id: movementKey }] : []),
              ]
            : [],
        noisy: false,
        resolve: ({ completed }) => {
          if (completed) this.locationId = destination;
          return [];
        },
      },
      desktop,
    );
  }

  /** Spends the plan's time through `TimeSystem.advance`, then applies its effect. */
  #perform(
    plan: Omit<ActionPlan, 'type'> & { type: ActionPlan['type'] | 'move' | 'wait' },
    desktop: DesktopState | undefined,
  ): DispatchResult {
    const now = this.#time.now();
    const from = this.locationId;
    const { durationMinutes, locations } = this.investigation.world;
    if (desktop && !this.#desktop) {
      this.#desktop = desktop;
      this.ports.attachTime?.(this.#time);
    }
    const witnessIds = desktop ? presentAt(this.investigation, from, now) : [];

    const elapsed = this.#time.advance(
      plan.minutes,
      plan.interruptible ? { interruptible: true } : undefined,
    );
    const minutesSpent = elapsed.to - elapsed.from;
    const interrupted = elapsed.interruptedAt !== undefined;
    const completed = minutesSpent === plan.minutes && !interrupted;
    this.investigation.truth.append({
      t: now,
      duration: minutesSpent,
      verb:
        completed || plan.type === 'wait' || plan.type === 'rest'
          ? plan.verb
          : `attempt_${plan.verb}`,
      actorIds: ['player'],
      location: from,
      targets: [...plan.targets],
      causes: [],
      facts: [],
      traceIds: [],
      visibility: 'public',
    });

    if (!desktop) {
      // Before ENG-003 only move/wait spent time and recorded truth.
      plan.resolve({ at: elapsed.to, completed });
      return {
        ok: true,
        minutesSpent,
        events: elapsed.events,
        ...(elapsed.to === durationMinutes && { outcome: 'time_expired' as const }),
      };
    }
    const events: GameEvent[] = [...elapsed.events];
    const vitals =
      plan.type === 'rest'
        ? rest(desktop.vitals, minutesSpent, elapsed.to)
        : tickAwake(desktop.vitals, minutesSpent, elapsed.to);
    desktop.vitals = vitals.state;
    desktop.inventory = burnFlashlight(desktop.inventory, minutesSpent);
    events.push(...vitals.events);

    const dialogue = plan.type === 'talk' || plan.type === 'interrogate';
    const open = desktop.interaction;
    if (open && (!dialogue || open.characterId !== plan.characterId)) {
      desktop.interaction = undefined;
      events.push({ type: 'InteractionEnded', characterId: open.characterId, at: elapsed.to });
    }
    events.push(...plan.resolve({ at: elapsed.to, completed }));
    if (interrupted) {
      events.push({
        type: 'ActionInterrupted',
        at: elapsed.to,
        reason: elapsed.interruptReason ?? 'interrupted',
      });
    }

    const heardByIds = plan.noisy
      ? [
          ...new Set([
            ...witnessIds,
            ...locations
              .describe(from)
              .connections.flatMap(({ to }) => presentAt(this.investigation, to, now)),
          ]),
        ].sort()
      : [];
    const observed: PlayerActionObserved = {
      type: 'PlayerActionObserved',
      at: now,
      action: plan.type,
      locationId: from,
      witnessIds,
      heardByIds,
      ...(plan.characterId !== undefined && { characterId: plan.characterId }),
      ...(plan.topicId !== undefined && { topicId: plan.topicId }),
      ...(plan.clueId !== undefined && { clueId: plan.clueId }),
      ...(plan.contradictionId !== undefined && { contradictionId: plan.contradictionId }),
    };
    events.push(observed);
    this.ports.simulation?.onPlayerAction(observed);
    return {
      ok: true,
      minutesSpent,
      events,
      ...(elapsed.to === durationMinutes ? { outcome: 'time_expired' as const } : {}),
    };
  }

  playerView() {
    return projectPlayerView({
      investigation: this.investigation,
      locationId: this.locationId,
      minute: this.#time.now(),
      ...(this.ports.player && { actor: this.ports.player }),
      ...(this.ports.actionCosts && { actionCosts: this.ports.actionCosts }),
      ...(this.#pendingCapture && { pendingCapture: this.#pendingCapture }),
      desktop: this.#desktop ?? this.#startingDesktop(),
      clues: this.ports.clues ?? [],
    });
  }

  snapshot(): GameSnapshot {
    const pendingCapture = this.#pendingCapture;
    return {
      investigation: serializeInvestigation(this.investigation),
      initialInvestigationHash: this.initialInvestigationHash,
      minute: this.#time.now(),
      locationId: this.locationId,
      ...(pendingCapture ? { pendingCapture: { ...pendingCapture } } : {}),
      ...(this.#desktop && { desktop: this.#desktop.serialize() }),
    };
  }

  stateHash(): string {
    return stateHash(this.snapshot());
  }
}
