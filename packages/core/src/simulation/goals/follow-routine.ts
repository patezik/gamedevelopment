import type { Goal, GoalContext } from './planner.ts';

/** Updates the routine at the decision boundary without reserving a plot action slot. */
export function followRoutine<State>(apply: (context: GoalContext<State>) => void): Goal<State> {
  return {
    id: 'FollowRoutine',
    score: () => 0,
    plan: (context) => ({ duration: 0, start: () => apply(context) }),
  };
}
