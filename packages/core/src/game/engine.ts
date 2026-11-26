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
import { createRng } from '../rng/index.ts';
import {
  PlayerReactions,
  SimulationRunner,
  refuseWhenAccused,
  type ReactionPorts,
  type ReactionsSnapshot,
  type PerceptibleEvent,
  type SimulationSnapshot,
} from '../simulation/index.ts';
import { projectPhoneView, type PhoneEvent } from '../phone/index.ts';
import {
  burnFlashlight,
  clearHallucinations,
  costModifiers,
  hallucinationIds,
  isOverwhelmed,
  rest,
  restoreStaticState,
  tickAwake,
  StaticTimer,
  STATIC_GROWTH_MINUTES,
  STATIC_DELTAS,
  createStaticState,
  type StaticState,
  type HallucinationPool,
  type PackItem,
  type Vitals,
} from '../survival/index.ts';
import {
  ActionCostError,
  Calendar,
  DEFAULT_ACTION_COSTS,
  TickPhase,
  TimeSystem,
  resolveActionCost,
  type ActionCostTable,
} from '../time/index.ts';
import type { AccusationOutcome } from '../investigation/index.ts';
import { WorldError, type Actor } from '../world/index.ts';
import {
  DesktopState,
  PhoneRuntime,
  currentModifiers,
  effectiveActor,
  isPhoneAction,
  planPhoneAction,
  planDesktopAction,
  presentAt,
  type ActionPlan,
  type DesktopActionType,
  type DesktopStateSnapshot,
  type GameEvent,
  type PhoneActionType,
  type PhonePlan,
  type PhonePort,
  type PlayerActionObserved,
  type TestimonyPort,
} from './actions/index.ts';
import { accuse, type AccusationPort } from './actions/accuse.ts';
import { applyMarkSuspicion } from './actions/suspicion.ts';
import { startConfrontLoop, type ThreatPorts } from './confront.ts';
import { endingOf, type EndingId } from './ending.ts';
import { rollHallucinationsBetween } from './hallucinate.ts';
import { blockReason, type BlockReason } from './interaction.ts';
import {
  deserializeInvestigation,
  serializeInvestigation,
  type Investigation,
} from './investigation.ts';
import type { TextTemplates } from './dialogue-text.ts';
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
  /** Scenario text templates (CNT-005) used to render NPC lines in the view (ENG-009). */
  readonly texts?: TextTemplates;
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
  /**
   * Turns on global Static (ENG-010): growth by the clock, deltas on contradictions and false
   * accusations, the forced ending at 100. Off by default, so engines and saves made without it
   * keep their state hash.
   */
  readonly static?: {
    /** Level at the start; default 0. */
    readonly start?: number;
    /** Ending at Static 100; default `madness`, the only ending the MVP preset assigns. */
    readonly endingAt100?: EndingId;
  };
  /**
   * Turns on the characters' routines (ENG-014): a `SimulationRunner` on the engine's clock moves
   * everyone between locations by their schedules from minute 0, so they are present for `talk`
   * and `interrogate`. The player's actions are observed by those present. Off by default: the
   * state hash and old saves stay as they were. Routines only; goals and reactions (SIM-004..006)
   * are not driven yet. Saves made with it replay only with it.
   */
  readonly npcSimulation?: true;
  /**
   * Remembers what the hero did and said (ENG-010, SIM-006): witnesses grow wary of sensitive
   * topics, a false accusation makes some refuse to talk (`refuseWhenAccused` wraps `testimony`),
   * and the culprit's wariness feeds `ConfrontPlayer`. Its state is saved in `GameSnapshot.reactions`.
   * Off by default.
   */
  readonly reactions?: Omit<ReactionPorts, 'wake'>;
  /**
   * The culprit attacks a hero who is close to the truth (ENG-010, SURV-003): at night, alone, in the
   * dark, with enough wariness (needs `reactions`). Needs `npcSimulation`. Off by default.
   */
  readonly threats?: ThreatPorts;
  /**
   * Phone hallucinations (ENG-010, SURV-005): a roll every 30 game minutes while sanity is low or
   * Static is high; rest clears them. Needs a phone. Off by default.
   */
  readonly hallucinations?: { readonly pool: HallucinationPool };
  /** The hero's phone (ENG-004): starting content and the simulation's answers to calls and messages. */
  readonly phone?: PhonePort;
  /** The phone call state for arbitration (ENG-005); no phone in the engine yet means no call. */
  readonly callState?: () => 'ringing' | 'active' | undefined;
}

const NIGHTFALL = 'survival.nightFall';
const NIGHT_HOUR = 22;
const MINUTES_PER_DAY = 24 * 60;

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
  /** ENG-004 phone; present only for engines created with `ports.phone`. */
  readonly phone?: unknown;
  /** ENG-010 Static state; absent in older snapshots and in engines without `ports.static`. */
  readonly static?: StaticState;
  /** ENG-010 `PlayerReactions` state; present only for engines with `ports.reactions`. */
  readonly reactions?: ReactionsSnapshot;
  /** ENG-014 state of the characters' routines; present only for engines with `npcSimulation`. */
  readonly simulation?: SimulationSnapshot;
}

export interface DispatchResult {
  readonly ok: boolean;
  readonly error?: ErrorCode;
  readonly minutesSpent: number;
  readonly events: GameEvent[];
  /** Set when the game is over: the clock ran out, the hero died or lost their mind, or an accusation ended it. */
  readonly outcome?: 'time_expired' | Exclude<EndingId, 'time_up'>;
  /** Why `ACTION_BLOCKED` was returned, for the UI. */
  readonly blockedReason?: BlockReason;
}

function isPhonePlan(plan: { readonly type: string }): plan is PhonePlan {
  return isPhoneAction(plan.type);
}

/**
 * Where each character stands when the clock starts, read from the truth: the place of their
 * latest presence or arrival. Characters with no record are left to their routine.
 */
function lastKnownLocations(
  truth: Investigation['truth'],
  characters: readonly { readonly id: string }[],
): Map<string, string> {
  const events = truth.events();
  const known = new Map<string, string>();
  for (const { id } of characters) {
    let end = -Infinity;
    let place: string | undefined;
    for (const { location, interval } of truth.presenceIntervals(id)) {
      if (interval.to >= end) [end, place] = [interval.to, location];
    }
    for (const { verb, actorIds, targets, t, duration } of events) {
      const arrival = targets.find(({ kind }) => kind === 'location');
      if (verb === 'move' && actorIds.includes(id) && arrival && t + duration >= end) {
        [end, place] = [t + duration, arrival.id];
      }
    }
    if (place !== undefined) known.set(id, place);
  }
  return known;
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
  #phone: PhoneRuntime | undefined;
  #static: StaticTimer | undefined;
  #savedStatic: StaticState | undefined;
  #npcs: SimulationRunner | undefined;
  #savedNpcs: SimulationSnapshot | undefined;
  #reactions: PlayerReactions | undefined;
  #savedReactions: ReactionsSnapshot | undefined;
  #attackEvents: GameEvent[] = [];

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

  /** Hands the clock to the simulation and starts Static; called once the desktop rules begin. */
  #wireTime(): void {
    this.ports.attachTime?.(this.#time);
    this.#startStatic();
    this.#startReactions();
    this.#startNpcs();
  }

  #startReactions(): void {
    const ports = this.ports.reactions;
    if (!ports || this.#reactions) return;
    this.#reactions = new PlayerReactions(ports);
    if (this.#savedReactions) this.#reactions.restore(this.#savedReactions);
  }

  /** The testimony the player's actions can reach: a character who refuses has nothing to say. */
  #testimony(): TestimonyPort | undefined {
    const base = this.ports.testimony;
    return base && this.#reactions ? refuseWhenAccused(base, this.#reactions) : base;
  }

  #startStatic(): void {
    const config = this.ports.static;
    if (!config || this.#static) return;
    const saved = this.#savedStatic;
    const state = saved ?? createStaticState(config.start ?? 0);
    const now = this.#time.now();
    // The scheduler is not saved: put the next hourly tick back on the same grid.
    const resume = now > 0;
    this.#static = new StaticTimer(this.#time, state, {
      endingAt100: config.endingAt100 ?? 'madness',
      resume,
    });
    if (resume && !isOverwhelmed(state)) {
      this.#time.schedule({
        kind: 'survival.staticTick',
        at: (Math.floor(now / STATIC_GROWTH_MINUTES) + 1) * STATIC_GROWTH_MINUTES,
        priority: 0,
        payload: null,
      });
    }
    this.#wireNightfall(now);
  }

  /**
   * +3 Static once per game night (survival-horror.md section 3): at the moment the clock enters
   * `night` (22:00). A night already in progress at the start or after a restore is not counted
   * again; the next one is found from the clock, so the grid needs no saved state.
   */
  #wireNightfall(now: number): void {
    const timers = this.#static;
    if (!timers) return;
    const calendar = new Calendar(this.investigation.world.locations.startDateTime);
    this.#time.registerHandler(NIGHTFALL, {
      phase: TickPhase.Timers,
      handle: (event, context) => {
        timers.apply(STATIC_DELTAS.night, event.at, 'night');
        if (isOverwhelmed(timers.state())) return { interrupt: 'static' };
        context.schedule({
          kind: NIGHTFALL,
          at: event.at + MINUTES_PER_DAY,
          priority: 0,
          payload: null,
        });
        return undefined;
      },
    });
    const { hh, mm } = calendar.toDisplay(now);
    const untilNight =
      ((((NIGHT_HOUR - hh) * 60 - mm) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    if (!isOverwhelmed(timers.state())) {
      this.#time.schedule({
        kind: NIGHTFALL,
        at: now + (untilNight === 0 ? MINUTES_PER_DAY : untilNight),
        priority: 0,
        payload: null,
      });
    }
  }

  /** Characters follow their routines from the current minute; positions come from the truth. */
  #startNpcs(): void {
    if (!this.ports.npcSimulation || this.#npcs) return;
    const { truth, characters, world, seed } = this.investigation;
    const saved = this.#savedNpcs;
    const dead = new Map<string, number>();
    for (const fact of truth.facts({ kind: 'state' })) {
      if (
        fact.kind === 'state' &&
        fact.entity.kind === 'character' &&
        fact.property === 'alive' &&
        fact.value === false
      ) {
        dead.set(
          fact.entity.id,
          Math.min(dead.get(fact.entity.id) ?? Infinity, fact.interval.from),
        );
      }
    }
    this.#npcs = new SimulationRunner({
      time: this.#time,
      calendar: new Calendar(world.locations.startDateTime),
      world: world.locations,
      items: world.items,
      truth,
      rng: createRng(seed).fork('engine'),
      characters,
      ...(saved ? { restore: saved } : { initialLocations: lastKnownLocations(truth, characters) }),
      exits: new Map([...dead].filter(([id]) => characters.some((c) => c.id === id))),
      endAt: world.durationMinutes,
    });
    // The first tick of the minute establishes presence before the first action.
    if (this.ports.threats) {
      startConfrontLoop({
        time: this.#time,
        investigation: this.investigation,
        threats: this.ports.threats,
        rng: createRng(seed).fork('engine').fork('threat'),
        reactions: this.#reactions,
        knowledgeOf: (id) => this.#npcs?.knowledgeOf(id),
        desktop: () => this.#desktop,
        location: () => this.locationId,
        notify: (events) => this.#attackEvents.push(...events),
      });
    }
    if (!saved) this.#time.advance(0);
  }

  /** Current Static level for the simulation (TIME-006 `earlierIf.staticAtLeast`); 0 when off. */
  staticLevel(): number {
    return this.#static?.level() ?? 0;
  }

  #staticEnding(): EndingId | undefined {
    const state = this.#static?.state();
    return state && isOverwhelmed(state)
      ? (this.ports.static?.endingAt100 ?? 'madness')
      : undefined;
  }

  /** Names the phone's hallucinated items so a case file citing one is refused (SURV-005). */
  #withHallucinations(port: AccusationPort): AccusationPort {
    if (!this.#phone) return port;
    const hallucinated = hallucinationIds(this.#phone.state);
    if (hallucinated.size === 0) return port;
    return {
      ...port,
      hallucinatedClueIds: new Set([...(port.hallucinatedClueIds ?? []), ...hallucinated]),
    };
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
    return GameEngine.#start(serialized, stateHash(serialized), ports, rules);
  }

  /** Reuses the immutable starting data while each simulation gets its own world and ports. */
  static prepareStart(investigation: Investigation): (ports: EnginePorts) => GameEngine {
    const serialized = serializeInvestigation(investigation);
    const hash = stateHash(serialized);
    return (ports) => GameEngine.#start(serialized, hash, ports, 'desktop');
  }

  static #start(
    serialized: ReturnType<typeof serializeInvestigation>,
    hash: string,
    ports: EnginePorts,
    rules: 'desktop' | 'beforeDesktop',
  ): GameEngine {
    const engine = new GameEngine(
      deserializeInvestigation(serialized),
      hash,
      ports,
      ports.startLocationId,
      0,
    );
    if (rules === 'desktop') {
      engine.#desktop = engine.#startingDesktop();
      engine.#wireTime();
    }
    if (ports.phone) engine.#phone = new PhoneRuntime(ports.phone.initial);
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
    engine.#savedReactions = snapshot.reactions;
    if (snapshot.static !== undefined) engine.#savedStatic = restoreStaticState(snapshot.static);
    engine.#savedNpcs = snapshot.simulation;
    if (snapshot.desktop !== undefined) {
      engine.#desktop = DesktopState.restore(snapshot.desktop);
      engine.#wireTime();
    }
    if (snapshot.phone !== undefined) engine.#phone = PhoneRuntime.restore(snapshot.phone);
    else if (ports.phone) engine.#phone = new PhoneRuntime(ports.phone.initial);
    return engine;
  }

  /**
   * Lets the simulation change the phone (an incoming call, a message, a revealed file). Call it
   * only from deterministic code driven by game time, so that a replay repeats it.
   */
  receivePhoneEvent(event: PhoneEvent): PhoneEvent | undefined {
    return this.#phone?.emit(event);
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
      this.#staticEnding(),
    );
    return ending && ending !== 'time_up' ? { ...result, outcome: ending } : result;
  }

  #dispatch(source: 'desktop' | 'phone', input: PlayerAction): DispatchResult {
    const parsed = PlayerAction.safeParse(input);
    const allowed: readonly PlayerAction['type'][] | undefined = ACTIONS_BY_ROLE[source];
    // The server dispatches `captureEvidence` itself after it validated `qr.scan`.
    const capture = source === 'phone' && parsed.success && parsed.data.type === 'captureEvidence';
    if (!parsed.success || !(capture || allowed?.includes(parsed.data.type))) {
      return rejected('ACTION_INVALID');
    }

    const action = parsed.data;
    const { durationMinutes } = this.investigation.world;
    const now = this.#time.now();
    if (now >= durationMinutes) return rejected('GAME_OVER');
    if (this.#desktop && endingOf(this.#desktop, now, durationMinutes, this.#staticEnding())) {
      return rejected('GAME_OVER');
    }
    const port = this.ports.accusation;
    if (action.type === 'accuse' && !port) return rejected('ACTION_NOT_AVAILABLE');
    const desktop = this.#desktop ?? this.#startingDesktop();
    if (action.type === 'accuse' && port) {
      const judged = accuse(action, desktop, {
        investigation: this.investigation,
        clues: this.ports.clues ?? [],
        port: this.#withHallucinations(port),
        now,
      });
      if (!judged.ok) return rejected('ACTION_INVALID');
      if (!this.#desktop) {
        this.#desktop = desktop;
        this.#wireTime();
      }
      if (judged.outcome) {
        this.ports.simulation?.onAccusation?.(judged.outcome, now);
        this.#reactions?.applyConsequences(judged.outcome.consequences);
      }
      const events: GameEvent[] = [...judged.events];
      if (this.#static && judged.outcome?.endingId === 'wrong_accusation') {
        this.#static.apply(STATIC_DELTAS.falseAccusation, now, 'falseAccusation');
        events.push(...this.#static.drain());
      }
      return { ok: true, minutesSpent: 0, events };
    }
    if (action.type === 'markSuspicion') {
      const known = new Set(this.investigation.characters.map(({ id }) => id));
      if (!applyMarkSuspicion(desktop.knowledge, known, action)) return rejected('ACTION_INVALID');
      if (!this.#desktop) {
        this.#desktop = desktop;
        this.#wireTime();
      }
      return { ok: true, minutesSpent: 0, events: [] };
    }
    const reason = blockReason(action.type, {
      dialogue:
        desktop.interaction && (desktop.interaction.interrogation ? 'interrogation' : 'talk'),
      call: this.ports.callState?.() ?? this.#phone?.state.activeCall?.state,
    });
    if (reason) return { ...rejected('ACTION_BLOCKED'), blockedReason: reason };
    if (action.type === 'move' || action.type === 'wait') return this.#moveOrWait(action, desktop);
    if (isPhoneAction(action.type)) {
      return this.#phoneAction(action as Extract<PlayerAction, { type: PhoneActionType }>, desktop);
    }
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
        ...(this.#testimony() && { testimony: this.#testimony() as TestimonyPort }),
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

  #phoneAction(
    action: Extract<PlayerAction, { type: PhoneActionType }>,
    desktop: DesktopState,
  ): DispatchResult {
    const runtime = this.#phone;
    if (!runtime) return rejected('ACTION_NOT_AVAILABLE');
    const pending = this.pendingEvidenceCapture();
    const plan = planPhoneAction(action, {
      runtime,
      desktop,
      clues: this.ports.clues ?? [],
      now: this.#time.now(),
      costs: this.ports.actionCosts ?? DEFAULT_ACTION_COSTS,
      modifiers: costModifiers(desktop.vitals.vitals),
      ...(this.ports.phone && { port: this.ports.phone }),
      ...(pending && { pendingCapture: pending }),
    });
    if (typeof plan === 'string') return rejected(plan);
    const result = this.#perform(plan, desktop);
    if (result.events.some(({ type }) => type === 'EvidenceCaptured')) {
      this.#pendingCapture = undefined;
    }
    return result;
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
    plan: (Omit<ActionPlan, 'type'> & { type: ActionPlan['type'] | 'move' | 'wait' }) | PhonePlan,
    desktop: DesktopState | undefined,
  ): DispatchResult {
    const now = this.#time.now();
    const from = this.locationId;
    const { durationMinutes, locations } = this.investigation.world;
    if (desktop && !this.#desktop) {
      this.#desktop = desktop;
      this.#wireTime();
    }
    const witnessIds = desktop ? presentAt(this.investigation, from, now) : [];

    const elapsed = this.#time.advance(
      plan.minutes,
      plan.interruptible ? { interruptible: true } : undefined,
    );
    const minutesSpent = elapsed.to - elapsed.from;
    const interrupted = elapsed.interruptedAt !== undefined;
    const completed = minutesSpent === plan.minutes && !interrupted;
    const phonePlan = isPhonePlan(plan);

    // Using the phone is not an event of the world: the truth log and the witnesses ignore it.
    let playerEvent: PerceptibleEvent | undefined;
    if (!phonePlan) {
      const event = {
        t: now,
        verb:
          completed || plan.type === 'wait' || plan.type === 'rest'
            ? plan.verb
            : `attempt_${plan.verb}`,
        actorIds: ['player'],
        location: from,
        visibility: 'public' as const,
      };
      const id = this.investigation.truth.append({
        ...event,
        duration: minutesSpent,
        targets: [...plan.targets],
        causes: [],
        facts: [],
        traceIds: [],
      });
      playerEvent = { ...event, id };
    }
    // Those present remember what the hero did in front of them (the presence is already in truth).
    if (playerEvent && desktop) this.#npcs?.observe(playerEvent);

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
    events.push(...this.#attackEvents.splice(0));
    if (this.#static) events.push(...this.#static.drain());

    if (this.#phone) {
      const pool = this.ports.hallucinations?.pool;
      if (pool && plan.type !== 'rest') {
        events.push(
          ...rollHallucinationsBetween(this.#phone, elapsed.from, elapsed.to, {
            seed: this.investigation.seed,
            pool,
            sanity: desktop.vitals.vitals.sanity,
            staticLevel: this.staticLevel(),
          }),
        );
      }
      // Rest clears what the tired mind showed; real items stay.
      if (pool && plan.type === 'rest' && minutesSpent > 0) {
        this.#phone.state = clearHallucinations(this.#phone.state);
      }
      events.push(...this.#phone.drain(minutesSpent), ...this.#phone.deliverDue(elapsed.to));
    }

    const dialogue = plan.type === 'talk' || plan.type === 'interrogate';
    const open = desktop.interaction;
    if (open && !phonePlan && (!dialogue || open.characterId !== plan.characterId)) {
      desktop.interaction = undefined;
      events.push({ type: 'InteractionEnded', characterId: open.characterId, at: elapsed.to });
    }
    const resolved = plan.resolve({ at: elapsed.to, completed });
    events.push(...resolved);
    if (this.#static) {
      for (const event of resolved) {
        if (event.type === 'ContradictionFound') {
          this.#static.apply(
            STATIC_DELTAS.contradictionRevealed,
            elapsed.to,
            'contradictionRevealed',
          );
        }
      }
      events.push(...this.#static.drain());
    }
    if (interrupted) {
      events.push({
        type: 'ActionInterrupted',
        at: elapsed.to,
        reason: elapsed.interruptReason ?? 'interrupted',
      });
    }

    if (phonePlan) {
      return {
        ok: true,
        minutesSpent,
        events,
        ...(elapsed.to === durationMinutes ? { outcome: 'time_expired' as const } : {}),
      };
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
    this.#reactions?.onPlayerAction(observed);
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
      staticLevel: this.staticLevel(),
      ...(this.#staticEnding() && { staticEnding: this.#staticEnding() as EndingId }),
      clues: this.ports.clues ?? [],
      ...(this.ports.texts && { texts: this.ports.texts }),
    });
  }

  /** What the phone app shows; `undefined` when the engine has no phone. No truth in it. */
  phoneView() {
    const runtime = this.#phone;
    if (!runtime) return undefined;
    const minute = this.#time.now();
    return projectPhoneView(
      runtime.state,
      {
        vitals: (this.#desktop ?? this.#startingDesktop()).vitals.vitals,
        static: this.staticLevel(),
      },
      { minute, calendar: new Calendar(this.investigation.world.locations.startDateTime) },
    );
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
      ...(this.#phone && { phone: this.#phone.serialize() }),
      ...(this.#static && { static: this.#static.state() }),
      ...(this.#reactions && { reactions: this.#reactions.snapshot() }),
      ...(this.#npcs && { simulation: this.#npcs.snapshot() }),
    };
  }

  /**
   * What the hero has learned so far, in the serialized form of `snapshot().desktop.knowledge`.
   * It holds no truth, but a validator needs it often and `snapshot()` also serializes the world.
   */
  knowledgeSnapshot(): unknown {
    return this.#desktop?.serialize().knowledge;
  }

  stateHash(): string {
    return stateHash(this.snapshot());
  }
}
