import type { GameMinutes } from '../../common/index.ts';
import type { Rng } from '../../rng/index.ts';
import { TickPhase, type TimeSystem } from '../../time/index.ts';
import type { GoalContext, GoalPlanner } from './planner.ts';

const decisionEvent = 'simulation.goal-decision';

export interface GoalAgent<State> {
  readonly id: string;
  readState(): State;
  nextRoutineBoundary(now: GameMinutes): GameMinutes | undefined;
}

interface AgentEntry<State> {
  readonly agent: GoalAgent<State>;
  readonly priority: number;
  readonly rng: Rng;
  readonly triggers: Set<GameMinutes>;
  busyUntil: GameMinutes;
  pending?: { id: string; at: GameMinutes };
}

export interface GoalLoopOptions<State> {
  readonly time: TimeSystem;
  readonly planner: GoalPlanner<State>;
  readonly rng: Rng;
  readonly agents: readonly GoalAgent<State>[];
  readonly endAt: GameMinutes;
}

/** Runs on simulation ticks. The caller supplies the actor view and routine boundaries. */
export class GoalLoop<State> {
  readonly #options: GoalLoopOptions<State>;
  readonly #agents = new Map<string, AgentEntry<State>>();

  constructor(options: GoalLoopOptions<State>) {
    this.#options = options;
    const start = options.time.now();
    if (!Number.isSafeInteger(options.endAt) || options.endAt < start) {
      throw new RangeError('Invalid goal loop end');
    }
    const root = options.rng.fork('sim').fork('agent');
    const sorted = options.agents.toSorted((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)));
    for (const [priority, agent] of sorted.entries()) {
      if (!agent.id || this.#agents.has(agent.id))
        throw new RangeError(`Invalid goal agent: ${agent.id}`);
      this.#agents.set(agent.id, {
        agent,
        priority,
        rng: root.fork(agent.id).fork('goals'),
        triggers: new Set(),
        busyUntil: start,
      });
    }
    options.time.registerHandler(decisionEvent, {
      phase: TickPhase.Simulation,
      handle: ({ payload }) => {
        if (typeof payload !== 'string') throw new TypeError('Invalid goal event payload');
        this.#decide(this.#entry(payload));
      },
    });
    for (const entry of this.#agents.values()) this.#schedule(entry, start);
  }

  trigger(agentId: string, at = this.#options.time.now()): void {
    if (!Number.isSafeInteger(at) || at < this.#options.time.now()) {
      throw new RangeError('Goal trigger must be at or after the current minute');
    }
    const entry = this.#entry(agentId);
    if (at >= this.#options.endAt) return;
    entry.triggers.add(at);
    this.#schedule(entry, at);
  }

  #entry(id: string): AgentEntry<State> {
    const entry = this.#agents.get(id);
    if (!entry) throw new RangeError(`Unknown goal agent: ${id}`);
    return entry;
  }

  #schedule(entry: AgentEntry<State>, requested: GameMinutes): void {
    const { time, endAt } = this.#options;
    const at = Math.max(requested, entry.busyUntil);
    if (at >= endAt || (entry.pending && entry.pending.at <= at)) return;
    if (entry.pending) time.cancel(entry.pending.id);
    const id = time.schedule({
      at,
      kind: decisionEvent,
      priority: entry.priority,
      payload: entry.agent.id,
    });
    entry.pending = { id, at };
  }

  #decide(entry: AgentEntry<State>): void {
    const { planner, time, endAt } = this.#options;
    const now = time.now();
    delete entry.pending;
    for (const trigger of entry.triggers) if (trigger <= now) entry.triggers.delete(trigger);
    const context: GoalContext<State> = {
      agentId: entry.agent.id,
      now,
      endAt,
      state: entry.agent.readState(),
    };
    // Block re-entrant same-minute triggers raised by a plan's start callback.
    entry.busyUntil = now + 1;
    const selection = planner.choose(context, entry.rng.fork(String(now)));
    if (selection) {
      entry.busyUntil = now + Math.max(1, selection.plan.duration);
      selection.plan.start();
    }
    if (selection?.plan.duration) {
      this.#schedule(entry, entry.busyUntil);
      return;
    }
    const boundary = entry.agent.nextRoutineBoundary(now);
    const validBoundary =
      boundary !== undefined && Number.isSafeInteger(boundary) && boundary > now ? boundary : endAt;
    let next = Math.min(validBoundary, planner.nextWake(context) ?? endAt);
    for (const trigger of entry.triggers) next = Math.min(next, trigger);
    this.#schedule(entry, next);
  }
}
