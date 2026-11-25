import {
  tracesForEvent,
  type ItemTagSource,
  type Trace,
  type TraceRuleSet,
  type TruthEventSource,
} from '../../evidence/index.ts';
import {
  THREAT,
  attackEvent,
  canAttack,
  resolveThreat,
  type AttackSetting,
  type ThreatResolution,
  type ThreatTarget,
} from '../../survival/index.ts';
import type { TruthEvent, TruthEventInput } from '../../truth/index.ts';
import type { NpcContext, NpcState } from './npc-goals.ts';
import type { Goal } from './planner.ts';

export interface ConfrontPorts {
  /** Night, player alone and location dark, as seen from the agent's place; never truth. */
  setting(context: NpcContext): Omit<AttackSetting, 'wariness'> | undefined;
  /** The player's current state and place; the port owner applies the result. */
  player(context: NpcContext): (ThreatTarget & { readonly location: string }) | undefined;
  /** Appends the attack to the truth log and returns it with its ID. */
  record(input: TruthEventInput): TruthEvent;
  readonly rules: TraceRuleSet;
  readonly items: ItemTagSource;
  readonly truth: TruthEventSource;
  /**
   * Receives the outcome (including `interrupted`: stop the hero's current action) and the traces
   * of the attack. Only `resolution.notice` may be sent to the client; the event names the attacker.
   */
  onAttack(
    context: NpcContext,
    resolution: ThreatResolution,
    event: TruthEvent,
    traces: readonly Trace[],
  ): void;
}

export function scoreConfrontPlayer(
  state: NpcState,
  setting: Omit<AttackSetting, 'wariness'> | undefined,
): number {
  if (!setting || !canAttack({ ...setting, wariness: state.wariness })) return -Infinity;
  return Math.min(0.95, 0.6 + 0.3 * state.wariness);
}

/**
 * The culprit confronts a hero who is close to the truth: at night, alone, in the dark. Register it
 * only for the culprit's agent. The attack is a truth event and must leave a trace.
 */
export function confrontPlayer(ports: ConfrontPorts): Goal<NpcState> {
  return {
    id: 'ConfrontPlayer',
    score: (context) => scoreConfrontPlayer(context.state, ports.setting(context)),
    plan(context, rng) {
      if (!ports.player(context)) return null;
      return {
        duration: THREAT.attackMinutes,
        start() {
          const player = ports.player(context);
          if (!player) return;
          const { now, agentId } = context;
          const resolution = resolveThreat(player, now, player.location, rng.fork('outcome'));
          const event = ports.record(attackEvent(agentId, player.location, now));
          const traces = tracesForEvent(event, ports.rules, ports.items, ports.truth);
          if (traces.length === 0) throw new Error(`Attack ${event.id} left no trace`);
          ports.onAttack(context, resolution, event, traces);
        },
      };
    },
  };
}
