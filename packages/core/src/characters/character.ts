import { z } from 'zod';
import { PERSONALITY_TRAITS } from '../common/index.ts';

const id = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const text = z.string().min(1);

/**
 * Portrait reference `<archetype_id>.<variant>` (art-direction.md §7.2), the form the desktop
 * art library accepts: a `snake_case` id of at most 64 characters, a letter and digits.
 */
export const PORTRAIT_REF = /^[a-z][a-z0-9_]{0,63}\.[a-z][0-9]+$/;
const unit = z.number().min(0).max(1);

const personalitySchema = z.record(z.enum(PERSONALITY_TRAITS), unit);
const biographyFactSchema = z.strictObject({ text, tags: z.array(id) });
const goalSeedSchema = z.strictObject({ kind: id, weight: unit });
const habitSchema = z.strictObject({ activity: id });
const accessGrantSchema = z.union([
  z.strictObject({ locationId: id }),
  z.strictObject({ itemId: id }),
  z.strictObject({ locationId: id, itemId: id }),
]);
const routineBlockSchema = z.strictObject({
  from: z.int().min(0).max(1439),
  to: z.int().min(0).max(1440),
  location: id,
  activity: id,
  flexibility: unit,
});

export const characterSchema = z.strictObject({
  id: z.string().regex(/^ch_[a-z0-9][a-z0-9_-]*$/),
  name: text,
  archetypeId: id,
  /** ENG-008: portrait variant chosen by name; absent when the archetype has none for it. */
  portraitRef: z.string().regex(PORTRAIT_REF).optional(),
  age: z.int().nonnegative(),
  socialStatus: id,
  personality: personalitySchema,
  biography: z.array(biographyFactSchema),
  goals: z.array(goalSeedSchema),
  fears: z.array(text),
  habits: z.array(habitSchema),
  desires: z.array(text),
  secrets: z.array(id),
  access: z.array(accessGrantSchema),
  routine: z.array(routineBlockSchema),
});

export type Character = z.infer<typeof characterSchema>;
export type Personality = Character['personality'];
export type BiographyFact = Character['biography'][number];
export type GoalSeed = Character['goals'][number];
export type Habit = Character['habits'][number];
export type AccessGrant = Character['access'][number];
export type RoutineBlock = Character['routine'][number];
export type SocialStatus = Character['socialStatus'];

export function serializeCharacter(character: Character): string {
  return JSON.stringify(characterSchema.parse(character));
}

export function deserializeCharacter(json: string): Character {
  return characterSchema.parse(JSON.parse(json));
}
