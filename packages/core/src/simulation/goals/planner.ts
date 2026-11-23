import type { GameMinutes } from '../../common/index.ts';
import type { Rng } from '../../rng/index.ts';

export interface GoalContext<State> {
  readonly agentId: string;
  readonly state: State;
  readonly now: GameMinutes;
  readonly endAt: GameMinutes;
}

export interface GoalPlan {
  readonly duration: GameMinutes;
  start(): void;
}

export interface Goal<State> {
  readonly id: string;
  score(context: GoalContext<State>): number;
  plan(context: GoalContext<State>, rng: Rng): GoalPlan | null;
  nextWake?(context: GoalContext<State>): GameMinutes | undefined;
}

export class GoalPlanner<State> {
  readonly #goals = new Map<string, Goal<State>>();

  register(goal: Goal<State>): this {
    if (goal.id.trim() === '' || this.#goals.has(goal.id)) {
      throw new RangeError(`Invalid or duplicate goal ID: ${goal.id}`);
    }
    this.#goals.set(goal.id, goal);
    return this;
  }

  choose(context: GoalContext<State>, rng: Rng): { id: string; plan: GoalPlan } | undefined {
    const ranked = [...this.#goals.values()]
      .map((goal) => ({ goal, score: goal.score(context) }))
      .filter(({ score }) => Number.isFinite(score))
      .sort((a, b) => b.score - a.score || (a.goal.id < b.goal.id ? -1 : 1));
    for (const { goal } of ranked) {
      const plan = goal.plan(context, rng.fork(goal.id));
      if (!plan) continue;
      if (!Number.isSafeInteger(plan.duration) || plan.duration < 0) {
        throw new RangeError(`Invalid duration for goal ${goal.id}`);
      }
      if (plan.duration <= context.endAt - context.now) return { id: goal.id, plan };
    }
    return undefined;
  }

  nextWake(context: GoalContext<State>): GameMinutes | undefined {
    let next = context.endAt;
    for (const goal of this.#goals.values()) {
      const at = goal.nextWake?.(context);
      if (at !== undefined && Number.isSafeInteger(at) && at > context.now && at < next) next = at;
    }
    return next < context.endAt ? next : undefined;
  }
}
