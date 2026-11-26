import type { Trace, TraceRuleSet } from '../evidence/index.ts';
import { KnowledgeStore } from '../knowledge/index.ts';
import type { Rng } from '../rng/index.ts';
import type { PlayerReactions } from '../simulation/index.ts';
import { GoalLoop, GoalPlanner, confrontPlayer, type NpcState } from '../simulation/goals/index.ts';
import { ATTACK_VERB, lightMinutes } from '../survival/index.ts';
import { Calendar, TickPhase, type TimeSystem } from '../time/index.ts';
import { presentAt, type DesktopState, type GameEvent } from './actions/index.ts';
import type { Investigation } from './investigation.ts';

/** The culprit weighs an attack on the clock grid only, so a resumed engine decides the same. */
export const CONFRONT_CHECK_MINUTES = 10;
/** Pause after an attack before the same culprit may attack again. */
export const CONFRONT_COOLDOWN_MINUTES = 60;
export const ATTACK_INTERRUPT = 'survival.attackInterrupt';

export interface ThreatPorts {
  /** Trace rules for the `attack` verb; an attack must leave a trace (conservation of evidence). */
  readonly traceRules: TraceRuleSet;
  /** Receives the traces of an attack; turning them into clues is the content pipeline's job. */
  readonly onTraces?: (traces: readonly Trace[]) => void;
}

export interface ConfrontEnv {
  readonly time: TimeSystem;
  readonly investigation: Investigation;
  readonly threats: ThreatPorts;
  readonly rng: Rng;
  readonly reactions: Pick<PlayerReactions, 'wariness'> | undefined;
  readonly knowledgeOf: (characterId: string) => KnowledgeStore | undefined;
  readonly desktop: () => DesktopState | undefined;
  readonly location: () => string;
  /** Receives the client-safe events of an attack; none of them names the attacker. */
  readonly notify: (events: readonly GameEvent[]) => void;
}

/**
 * Gives every culprit the goal `ConfrontPlayer` (SURV-003): at night, alone with the hero in a dark
 * place and wary enough, the culprit attacks. The hero's state changes, the attack is recorded in
 * the truth with its traces, and a resting hero is woken. The loop runs on the engine's `TimeSystem`.
 */
export function startConfrontLoop(env: ConfrontEnv): void {
  const { time, investigation, threats, rng, reactions } = env;
  const { truth, characters, world } = investigation;
  const calendar = new Calendar(world.locations.startDateTime);
  const from = time.now();
  const culprits = new Set(truth.incident.culpritIds);
  const planner = new GoalPlanner<NpcState>();

  const setting = (agentId: string, now: number) => {
    const desktop = env.desktop();
    if (!desktop || now <= from || now % CONFRONT_CHECK_MINUTES !== 0) return undefined;
    const lastAttack = truth
      .events()
      .findLast((event) => event.verb === ATTACK_VERB && event.actorIds.includes(agentId));
    if (lastAttack && now < lastAttack.t + CONFRONT_COOLDOWN_MINUTES) return undefined;
    const location = env.location();
    const present = presentAt(investigation, location, now);
    if (!present.includes(agentId)) return undefined;
    const { period } = calendar.toDisplay(now);
    return {
      night: period === 'night',
      playerAlone: present.length === 1,
      locationDark:
        world.locations.lightingAt(location, period) === 'dark' &&
        lightMinutes(desktop.inventory) === 0,
    };
  };

  planner.register(
    confrontPlayer({
      setting: ({ agentId, now }) => setting(agentId, now),
      player: () => {
        const desktop = env.desktop();
        return (
          desktop && {
            vitals: desktop.vitals,
            inventory: desktop.inventory,
            location: env.location(),
          }
        );
      },
      record: (input) => {
        const id = truth.append(input);
        return truth.events().find((event) => event.id === id)!;
      },
      rules: threats.traceRules,
      items: world.items,
      truth,
      onAttack: (_context, resolution, _event, traces) => {
        const desktop = env.desktop();
        if (!desktop) return;
        desktop.vitals = resolution.vitals;
        desktop.inventory = resolution.inventory;
        env.notify([...resolution.vitalsStep.events, resolution.notice]);
        threats.onTraces?.(traces);
        time.schedule({ kind: ATTACK_INTERRUPT, at: time.now(), priority: 0, payload: null });
      },
    }),
  );

  time.registerHandler(ATTACK_INTERRUPT, {
    phase: TickPhase.Timers,
    handle: () => ({ interrupt: 'attack' }),
  });
  new GoalLoop<NpcState>({
    time,
    planner,
    rng,
    endAt: world.durationMinutes,
    agents: characters
      .filter(({ id }) => culprits.has(id))
      .map(({ id, personality }) => ({
        id,
        readState: () => ({
          personality,
          stress: 0,
          wariness: Math.min(1, reactions?.wariness(id) ?? 0),
          knowledge: env.knowledgeOf(id) ?? new KnowledgeStore(),
        }),
        nextRoutineBoundary: (now) =>
          (Math.floor(now / CONFRONT_CHECK_MINUTES) + 1) * CONFRONT_CHECK_MINUTES,
      })),
  });
}
