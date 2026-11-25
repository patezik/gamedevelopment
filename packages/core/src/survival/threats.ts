import type { GameMinutes } from '../common/index.ts';
import type { Rng } from '../rng/index.ts';
import type { TruthEventInput } from '../truth/index.ts';
import { drop, lightMinutes, type Inventory } from './inventory.ts';
import { applyDelta, type VitalsState, type VitalsStep } from './vitals.ts';

/** Numbers of survival-horror.md section 4. */
export const THREAT = {
  /** The culprit attacks only when the hero is this close to the solution (wariness, 0-1). */
  attackWariness: 0.7,
  damageMin: 2,
  damageMax: 4,
  /** Chance of escaping, before it is moved by fatigue and health. */
  baseEscape: 0.75,
  minEscape: 0.1,
  maxEscape: 0.9,
  /** Injury risk of exploring a dangerous location without light. */
  hazardChance: 0.3,
  hazardDamage: 1,
  attackMinutes: 3,
} as const;

export const ATTACK_VERB = 'attack';

export interface AttackSetting {
  /** The culprit's wariness of the player, 0-1. */
  readonly wariness: number;
  readonly night: boolean;
  readonly playerAlone: boolean;
  readonly locationDark: boolean;
}

export const canAttack = (s: AttackSetting): boolean =>
  s.wariness >= THREAT.attackWariness && s.night && s.playerAlone && s.locationDark;

export interface ThreatTarget {
  readonly vitals: VitalsState;
  readonly inventory: Inventory;
}

/**
 * What the client may learn about an attack: it happened and how it ended. Deliberately has no
 * attacker field; the attacker exists only in the truth event (rule 1 of AGENTS.md).
 */
export interface PlayerAttacked {
  readonly type: 'PlayerAttacked';
  readonly at: GameMinutes;
  readonly location: string;
  readonly outcome: 'escaped' | 'injured';
  readonly damage: number;
  readonly lostItemId?: string;
}

export interface ThreatResolution extends ThreatTarget {
  readonly outcome: 'escaped' | 'injured';
  readonly damage: number;
  readonly lostItemId?: string;
  readonly vitalsStep: VitalsStep;
  /** The hero's current action is cut short; the caller must stop it. */
  readonly interrupted: true;
  readonly notice: PlayerAttacked;
}

/** Chance to get away: worse when tired or hurt. */
export function escapeChance(state: VitalsState): number {
  const { fatigue, health } = state.vitals;
  const chance = THREAT.baseEscape - fatigue / 200 + (health - 5) * 0.03;
  return Math.min(THREAT.maxEscape, Math.max(THREAT.minEscape, chance));
}

/**
 * Outcome of an attack: flight (check by fatigue and health) or 2-4 damage and a lost item
 * (never a clue item: an attack does not remove evidence). Same state and rng, same outcome.
 */
export function resolveThreat(
  target: ThreatTarget,
  at: GameMinutes,
  location: string,
  rng: Rng,
): ThreatResolution {
  const escaped = rng.chance(escapeChance(target.vitals));
  const damage = escaped ? 0 : rng.int(THREAT.damageMin, THREAT.damageMax);
  const losable = target.inventory.items.filter(({ kind }) => kind !== 'clue');
  const lostItemId = escaped || losable.length === 0 ? undefined : rng.pick(losable).id;
  const vitalsStep = applyDelta(target.vitals, { health: -damage }, at, 'attack');
  const inventory =
    lostItemId === undefined ? target.inventory : drop(target.inventory, lostItemId);
  const outcome = escaped ? 'escaped' : 'injured';
  const lost = lostItemId === undefined ? {} : { lostItemId };
  return {
    outcome,
    damage,
    ...lost,
    vitals: vitalsStep.state,
    vitalsStep,
    inventory,
    interrupted: true,
    notice: { type: 'PlayerAttacked', at, location, outcome, damage, ...lost },
  };
}

/** The truth event of an attack; its trace rules must yield a trace, so the attack leaves a clue. */
export function attackEvent(
  attackerId: string,
  location: string,
  at: GameMinutes,
): TruthEventInput {
  return {
    t: at,
    duration: THREAT.attackMinutes,
    verb: ATTACK_VERB,
    actorIds: [attackerId],
    location,
    targets: [],
    causes: [],
    facts: [{ kind: 'did', who: attackerId, verb: ATTACK_VERB, at, where: location }],
    traceIds: [],
    visibility: 'covert',
  };
}

/** Exploring a dangerous place (boiler room, cellar, forest) without light may cost 1 health. */
export function exploreHazard(
  target: ThreatTarget,
  dangerous: boolean,
  at: GameMinutes,
  rng: Rng,
): VitalsStep {
  const dark = lightMinutes(target.inventory) === 0;
  const hurt = dangerous && dark && rng.chance(THREAT.hazardChance);
  return applyDelta(target.vitals, { health: hurt ? -THREAT.hazardDamage : 0 }, at, 'hazard');
}
