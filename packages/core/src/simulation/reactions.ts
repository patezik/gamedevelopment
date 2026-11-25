import type { ConsequenceRef } from '../investigation/index.ts';
import type { NpcContext, NpcState, SeekTopic } from './goals/npc-goals.ts';
import type { Goal } from './goals/planner.ts';

/** What a character could notice of a player action; structurally a `PlayerActionObserved`. */
export interface ObservedPlayerAction {
  readonly witnessIds: readonly string[];
  readonly heardByIds: readonly string[];
  readonly characterId?: string;
  readonly topicId?: string;
}

export interface ReactionPorts {
  /**
   * 0–1 sensitivity of the topic for the character; 0 when the topic is not in their
   * `LiePolicy.conceal`, so unaffected characters never grow wary.
   */
  topicSensitivity(characterId: string, topicId: string): number;
  /** Acquaintances who react when the character dies or disappears. */
  closeTo(characterId: string): readonly string[];
  /** Wakes the character's goal loop after a reaction changed their state. */
  wake?(characterId: string): void;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Share of a question's sensitivity that bystanders who only overheard it take on. */
export const BYSTANDER_FACTOR = 0.5;
export const TRUST_LOSS_ON_FALSE_ACCUSATION = 0.2;
export const STRESS_ON_DEATH = 0.2;
export const STRESS_ON_DISAPPEARANCE = 0.15;
/** Above `CONCEAL_WARINESS_THRESHOLD` (0.5): a freed culprit may hide evidence. */
export const WARINESS_WHEN_FREED = 0.6;

/**
 * The world's memory of the player: per-character wariness and stress additions, who refuses to
 * talk, how far the group trusts the player, and who has gone missing. Plain state, advanced only
 * by the events fed to it (no clock, no randomness).
 */
export class PlayerReactions {
  readonly #ports: ReactionPorts;
  readonly #wariness = new Map<string, number>();
  readonly #stress = new Map<string, number>();
  readonly #refusing = new Set<string>();
  readonly #freed = new Set<string>();
  readonly #gone = new Map<string, SeekTopic['trigger']>();
  #trust = 1;

  constructor(ports: ReactionPorts) {
    this.#ports = ports;
  }

  /** Feed every `PlayerActionObserved` here (`EnginePorts.simulation.onPlayerAction`). */
  onPlayerAction(event: ObservedPlayerAction): void {
    const { topicId, characterId } = event;
    if (topicId === undefined) return;
    const present = new Set([...event.witnessIds, ...event.heardByIds]);
    if (characterId !== undefined) present.add(characterId);
    for (const id of [...present].sort()) {
      const sensitivity = clamp01(this.#ports.topicSensitivity(id, topicId));
      if (sensitivity <= 0) continue;
      const share = id === characterId ? sensitivity : sensitivity * BYSTANDER_FACTOR;
      this.#add(this.#wariness, id, share);
      this.#ports.wake?.(id);
    }
  }

  /** Carries out the consequences of `evaluateAccusation` (investigation-model.md section 6). */
  applyConsequences(consequences: readonly ConsequenceRef[]): void {
    for (const consequence of consequences) {
      switch (consequence.kind) {
        case 'refuses_to_talk':
          this.#refusing.add(consequence.characterId);
          for (const id of this.#ports.closeTo(consequence.characterId)) this.#refusing.add(id);
          break;
        case 'trust_falls':
          this.#trust = clamp01(this.#trust - TRUST_LOSS_ON_FALSE_ACCUSATION);
          break;
        case 'culprit_freed':
          this.#freed.add(consequence.characterId);
          this.#raiseTo(consequence.characterId, WARINESS_WHEN_FREED);
          break;
        case 'culprit_destroys_evidence':
          this.#raiseTo(consequence.characterId, 1);
          break;
      }
    }
  }

  /** A death or disappearance: acquaintances get stressed and start looking for answers. */
  onCharacterGone(characterId: string, kind: 'death' | 'disappearance'): void {
    this.#gone.set(characterId, kind);
    const stress = kind === 'death' ? STRESS_ON_DEATH : STRESS_ON_DISAPPEARANCE;
    for (const id of [...this.#ports.closeTo(characterId)].sort()) {
      this.#add(this.#stress, id, stress);
      this.#ports.wake?.(id);
    }
  }

  /** Extra wariness the player has caused, 0–1 (added to the character's own baseline). */
  wariness(characterId: string): number {
    return this.#wariness.get(characterId) ?? 0;
  }

  /** Extra stress from deaths and disappearances, 0–1. */
  stress(characterId: string): number {
    return this.#stress.get(characterId) ?? 0;
  }

  refuses(characterId: string): boolean {
    return this.#refusing.has(characterId);
  }

  /** Whether the culprit got free rein after a false accusation. */
  isFreed(characterId: string): boolean {
    return this.#freed.has(characterId);
  }

  /** How much the others still trust the player, 0–1. */
  get trust(): number {
    return this.#trust;
  }

  /** Dead or missing characters as `SeekInformation` topics. */
  missingTopics(): SeekTopic[] {
    return [...this.#gone]
      .map(([subjectId, trigger]) => ({ subjectId, trigger }))
      .sort((a, b) => (a.subjectId < b.subjectId ? -1 : 1));
  }

  /** The state an agent decides from: its baseline plus what the player caused. */
  applyTo(characterId: string, state: NpcState): NpcState {
    return {
      ...state,
      wariness: clamp01(state.wariness + this.wariness(characterId)),
      stress: clamp01(state.stress + this.stress(characterId)),
    };
  }

  #add(map: Map<string, number>, id: string, amount: number): void {
    map.set(id, clamp01((map.get(id) ?? 0) + amount));
  }

  #raiseTo(id: string, level: number): void {
    this.#wariness.set(id, Math.max(this.wariness(id), level));
    this.#ports.wake?.(id);
  }
}

/** Wraps a testimony source: a character who refuses to talk has nothing to say. */
export function refuseWhenAccused<Witness>(
  base: { witness(characterId: string): Witness | undefined },
  reactions: Pick<PlayerReactions, 'refuses'>,
): { witness(characterId: string): Witness | undefined } {
  return {
    witness: (characterId) =>
      reactions.refuses(characterId) ? undefined : base.witness(characterId),
  };
}

// ---------------------------------------------------------------- AvoidPlayer

export const AVOID_WARINESS_THRESHOLD = 0.6;
export const AVOID_MINUTES = 10;

export interface AvoidPorts {
  /** The player is where the agent is, or in a neighbouring place the agent can see. */
  playerNearby(context: NpcContext): boolean;
  /** A place away from the player the agent can reach, if any. */
  refuge(context: NpcContext): string | undefined;
  /** Moves the agent there; the port records the availability change. */
  retreat(context: NpcContext, locationId: string): void;
}

export function scoreAvoidPlayer(state: NpcState, nearby: boolean): number {
  if (!nearby || state.wariness <= AVOID_WARINESS_THRESHOLD) return -Infinity;
  const courage = clamp01(state.personality.courage);
  return Math.min(0.95, 0.35 + 0.4 * state.wariness + 0.15 * (1 - courage));
}

/** Wary characters move away from the player instead of waiting to be questioned again. */
export function avoidPlayer(ports: AvoidPorts): Goal<NpcState> {
  return {
    id: 'AvoidPlayer',
    score: (context) => scoreAvoidPlayer(context.state, ports.playerNearby(context)),
    plan(context) {
      const refuge = ports.refuge(context);
      if (refuge === undefined) return null;
      return { duration: AVOID_MINUTES, start: () => ports.retreat(context, refuge) };
    },
  };
}
