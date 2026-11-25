import { z } from 'zod';
import type { Statement } from '../../knowledge/index.ts';
import { PlayerKnowledge } from '../../investigation/index.ts';
import {
  createInventory,
  createVitalsState,
  restoreVitalsState,
  type Inventory,
  type PackItem,
  type Vitals,
  type VitalsState,
} from '../../survival/index.ts';

const id = z.string().min(1);
const minute = z.int();

export interface DialogueLine {
  readonly speaker: 'player' | 'other';
  /** The player's prompt, or the template key of an NPC line (old saves hold keys only). */
  readonly text: string;
  readonly at: number;
  /** Statement the NPC line renders; lets the view fill the template (ENG-009). */
  readonly statementId?: string | undefined;
}

/** The open conversation (`activeInteraction`); ENG-005 decides which actions it blocks. */
export interface ActiveInteraction {
  readonly kind: 'dialogue';
  readonly characterId: string;
  /** The latest exchange was an interrogation; it blocks walking away (ENG-005). */
  readonly interrogation?: true | undefined;
  readonly history: readonly DialogueLine[];
}

/** The player's accusation that ended the game (ENG-006). */
export interface Verdict {
  readonly endingId: 'solved' | 'partial' | 'wrong_accusation';
  readonly proven: {
    readonly motive: boolean;
    readonly means: boolean;
    readonly opportunity: boolean;
  };
}

const packItemSchema = z.strictObject({
  id,
  kind: z.enum(['flashlight', 'medkit', 'sedative', 'lockpick', 'key', 'clue']),
  chargeMinutes: z.int().nonnegative().optional(),
});
const statementSchema = z.strictObject({
  id,
  speakerId: id,
  proposition: z.looseObject({ kind: id }),
  veracity: z.enum(['true', 'mistaken', 'lie']),
  topic: z.enum([
    'whereWereYou',
    'whatDoYouKnowAbout',
    'whatIsThis',
    'aboutYourself',
    'sawAnything',
  ]),
  at: minute,
  templateKey: id,
});
const snapshotSchema = z.strictObject({
  knowledge: z.unknown(),
  statements: z.array(statementSchema),
  examinedLocations: z.array(id),
  examinedHotspots: z.array(id),
  unlockedDoors: z.array(id),
  announcedContradictions: z.array(id),
  interaction: z
    .strictObject({
      kind: z.literal('dialogue'),
      characterId: id,
      interrogation: z.literal(true).optional(),
      history: z.array(
        z.strictObject({
          speaker: z.enum(['player', 'other']),
          text: z.string(),
          at: minute,
          statementId: z.string().optional(),
        }),
      ),
    })
    .optional(),
  failedAccusations: z.int().positive().optional(),
  verdict: z
    .strictObject({
      endingId: z.enum(['solved', 'partial', 'wrong_accusation']),
      proven: z.strictObject({ motive: z.boolean(), means: z.boolean(), opportunity: z.boolean() }),
    })
    .optional(),
  vitals: z.unknown(),
  inventory: z.strictObject({ items: z.array(packItemSchema), flashlightOn: z.boolean() }),
});
export type DesktopStateSnapshot = z.infer<typeof snapshotSchema>;

export const DEFAULT_START_VITALS: Vitals = { health: 10, sanity: 10, fatigue: 0 };

/** `from->to` of a directed connection. A picked door opens both ways. */
export const doorKey = (from: string, to: string): string => `${from}->${to}`;

const sorted = (values: Iterable<string>): string[] => [...values].sort();

/**
 * Server-side state of the desktop actions (ENG-003). `statements` keeps what witnesses said
 * together with its veracity, which KNOW-002 needs to react to a rebuttal; it stays in the
 * server snapshot and reaches the player only through `PlayerKnowledge` (veracity stripped).
 */
export class DesktopState {
  knowledge = new PlayerKnowledge();
  readonly statements = new Map<string, Statement>();
  readonly examinedLocations = new Set<string>();
  readonly examinedHotspots = new Set<string>();
  readonly unlockedDoors = new Set<string>();
  readonly announcedContradictions = new Set<string>();
  interaction: ActiveInteraction | undefined;
  /** Wrong accusations the investigation survived; only one is forgiven. */
  failedAccusations = 0;
  /** Set once an accusation ends the game. */
  verdict: Verdict | undefined;
  vitals: VitalsState;
  inventory: Inventory;

  constructor(start: { vitals?: Vitals; inventory?: readonly PackItem[] } = {}) {
    this.vitals = createVitalsState(start.vitals ?? DEFAULT_START_VITALS);
    this.inventory = createInventory(start.inventory ?? []);
  }

  serialize(): DesktopStateSnapshot {
    return structuredClone({
      knowledge: this.knowledge.serialize(),
      statements: [...this.statements.values()],
      examinedLocations: sorted(this.examinedLocations),
      examinedHotspots: sorted(this.examinedHotspots),
      unlockedDoors: sorted(this.unlockedDoors),
      announcedContradictions: sorted(this.announcedContradictions),
      ...(this.interaction && { interaction: this.interaction }),
      ...(this.failedAccusations > 0 && { failedAccusations: this.failedAccusations }),
      ...(this.verdict && { verdict: this.verdict }),
      vitals: this.vitals,
      inventory: this.inventory,
    }) as unknown as DesktopStateSnapshot;
  }

  static restore(saved: unknown): DesktopState {
    const data = snapshotSchema.parse(saved);
    const state = new DesktopState();
    state.knowledge = PlayerKnowledge.restore(data.knowledge);
    for (const statement of data.statements) {
      state.statements.set(statement.id, statement as unknown as Statement);
    }
    data.examinedLocations.forEach((value) => state.examinedLocations.add(value));
    data.examinedHotspots.forEach((value) => state.examinedHotspots.add(value));
    data.unlockedDoors.forEach((value) => state.unlockedDoors.add(value));
    data.announcedContradictions.forEach((value) => state.announcedContradictions.add(value));
    state.interaction = data.interaction;
    state.failedAccusations = data.failedAccusations ?? 0;
    state.verdict = data.verdict;
    state.vitals = restoreVitalsState(data.vitals);
    state.inventory = {
      items: createInventory(
        data.inventory.items.map(({ chargeMinutes, ...item }) => ({
          ...item,
          ...(chargeMinutes !== undefined && { chargeMinutes }),
        })),
      ).items,
      flashlightOn: data.inventory.flashlightOn,
    };
    return state;
  }
}
