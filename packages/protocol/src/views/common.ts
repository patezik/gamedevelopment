import { z } from 'zod';

export const id = z.string().min(1);
export const text = z.string();
/** Game minutes since scenario start; negative values are prehistory. */
export const minutes = z.int();
/** A length of time in whole minutes. */
export const duration = z.int().nonnegative();
export const percent = z.int().min(0).max(100);
/** `HH:mm`, the clock face shown to the player. */
export const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const dayPeriod = z.enum(['morning', 'day', 'evening', 'night']);

/** Cost shown before the player confirms; the range exists for outcome-dependent actions. */
export const costPreview = z
  .strictObject({ min: duration, max: duration })
  .refine(({ min, max }) => min <= max, { message: 'min must not exceed max' });

export const clueKind = z.enum(['physical', 'document', 'digital', 'testimonial']);
export const speaker = z.enum(['player', 'other']);

/**
 * Keys that must never appear in a view: they are server-side truth or hallucination markers
 * (AGENTS.md rule 1). Views are the player's knowledge only; see views/README in protocol.md.
 */
export const FORBIDDEN_VIEW_KEYS = ['veracity', 'culpritIds', 'truth', 'hallucination'] as const;
