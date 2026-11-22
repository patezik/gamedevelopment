import { z } from 'zod';

/** Action verb shared by truth events and content rules that match them. */
export const verbSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
