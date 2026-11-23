import type { GameMinutes, Interval } from '../../common/index.ts';
import type { Goal, GoalContext } from './planner.ts';

export interface PlotStep {
  readonly id: string;
  readonly window: Readonly<Interval>;
  readonly duration: GameMinutes;
}

export function executePlot<State>(
  plans: ReadonlyMap<string, readonly PlotStep[]>,
  execute: (context: GoalContext<State>, step: PlotStep) => void,
): Goal<State> {
  const stepsByAgent = new Map<string, readonly PlotStep[]>();
  const cursor = new Map<string, number>();
  for (const [agentId, steps] of plans) {
    const ids = new Set<string>();
    for (const {
      id,
      window: { from, to },
      duration,
    } of steps) {
      if (
        !id ||
        ids.has(id) ||
        ![from, to, duration].every(Number.isSafeInteger) ||
        duration <= 0 ||
        duration > to - from
      ) {
        throw new RangeError(`Invalid plot step ${id} for ${agentId}`);
      }
      ids.add(id);
    }
    stepsByAgent.set(agentId, structuredClone(steps));
  }

  const next = ({ agentId }: GoalContext<State>) =>
    stepsByAgent.get(agentId)?.[cursor.get(agentId) ?? 0];
  function ready(context: GoalContext<State>, step: PlotStep): boolean {
    return (
      context.now >= step.window.from &&
      step.duration <= Math.min(step.window.to, context.endAt) - context.now
    );
  }

  return {
    id: 'ExecutePlot',
    score(context) {
      const step = next(context);
      return step && ready(context, step) ? 1 : -Infinity;
    },
    plan(context) {
      const step = next(context);
      if (!step || !ready(context, step)) return null;
      return {
        duration: step.duration,
        start() {
          execute(context, structuredClone(step));
          cursor.set(context.agentId, (cursor.get(context.agentId) ?? 0) + 1);
        },
      };
    },
    nextWake(context) {
      return next(context)?.window.from;
    },
  };
}
