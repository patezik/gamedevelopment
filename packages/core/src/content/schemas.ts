import { z } from 'zod';
import { PERSONALITY_TRAITS } from '../common/index.ts';

export const scenarioIdSchema = z.string().regex(/^_?[a-z0-9]+(?:[_-][a-z0-9]+)*$/);
const id = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const text = z.string().trim().min(1);
const ids = z.array(id);
const minutes = z.int().nonnegative();
const positiveMinutes = z.int().positive();
const share = z.number().min(0).max(1);
const dayMinute = minutes.max(1440);
const condition = z.record(z.string(), z.json());

export const presetSchema = z.strictObject({
  id: scenarioIdSchema,
  version: z.int().positive(),
  title: z.record(z.string().min(1), text).refine((title) => Object.keys(title).length > 0),
  time: z.strictObject({
    startDateTime: z.iso.datetime({ local: true }).refine((value) => !value.endsWith('Z'), {
      error: 'Expected a local date and time without a time zone',
    }),
    durationMinutes: positiveMinutes,
    historyStartMinutes: z.int().max(0),
  }),
  cast: z
    .strictObject({
      min: z.int().positive(),
      max: z.int().positive(),
      quotas: z.array(
        z
          .strictObject({ archetype: id, min: minutes, max: minutes })
          .refine(({ min, max }) => min <= max, {
            path: ['max'],
            error: 'Maximum must be at least minimum',
          }),
      ),
    })
    .refine(({ min, max }) => min <= max, {
      path: ['max'],
      error: 'Maximum must be at least minimum',
    }),
  incident: z.strictObject({
    types: ids.min(1),
    templates: ids.min(1),
    minMotive: share,
    victimConstraints: z.strictObject({ excludeArchetypes: ids }),
  }),
  criticalEvents: z.array(
    z.strictObject({
      id,
      at: minutes,
      earlierIf: z
        .strictObject({ staticAtLeast: z.number().min(0).max(100), at: minutes })
        .optional(),
    }),
  ),
  deadlines: z.array(z.strictObject({ id, at: minutes, outcome: id })),
  endings: ids.min(1),
  survival: z.strictObject({
    startVitals: z.strictObject({ health: minutes, sanity: minutes, fatigue: minutes }),
    staticCurve: id,
  }),
  phone: z.strictObject({ minQrShare: share }),
});

const light = z.enum(['bright', 'dim', 'dark']);
const accessRule = z.strictObject({
  from: dayMinute.optional(),
  to: dayMinute.optional(),
  archetypes: ids.optional(),
  itemId: id.optional(),
});

export const locationsSchema = z
  .array(
    z.strictObject({
      id,
      name: text,
      description: text,
      tags: ids,
      lighting: z.strictObject({ morning: light, day: light, evening: light, night: light }),
      access: z.array(accessRule),
      hotspots: z.array(
        z.strictObject({ id, name: text, description: text, itemIds: ids.optional() }),
      ),
      connections: z.array(
        z.strictObject({
          to: id,
          minutes: positiveMinutes,
          locked: z.strictObject({ itemId: id.optional() }).optional(),
        }),
      ),
    }),
  )
  .min(1);

export const itemsSchema = z.array(
  z.strictObject({
    id,
    name: text,
    kind: id,
    tags: ids,
    locationId: id.optional(),
    containerId: id.optional(),
    ownerArchetype: id.optional(),
  }),
);

const range = z.tuple([share, share]).refine(([min, max]) => min <= max, {
  error: 'Upper bound must be at least lower bound',
});
const traits = z.enum(PERSONALITY_TRAITS);
export const archetypesSchema = z
  .array(
    z.strictObject({
      id,
      title: text,
      names: z.array(text).min(1),
      personality: z.partialRecord(traits, range),
      routine: z.array(
        z.strictObject({
          from: dayMinute,
          to: dayMinute,
          locationId: id,
          activity: id,
        }),
      ),
      access: z.array(z.strictObject({ locationId: id.optional(), itemId: id.optional() })),
      biography: z.array(z.strictObject({ text, tags: ids })),
    }),
  )
  .min(1);

export const relationshipsSchema = z.array(
  z.strictObject({
    id,
    type: id,
    fromArchetypes: ids.optional(),
    toArchetypes: ids.optional(),
    constraints: condition.optional(),
    secrets: z.array(z.strictObject({ kind: id, template: id })).optional(),
  }),
);

export const motivesSchema = z.array(
  z.strictObject({
    id,
    when: z.strictObject({
      relation: z.strictObject({ type: id, from: text, to: text }).optional(),
      secret: z.strictObject({ kind: id, about: text, knownBy: text }).optional(),
    }),
    strength: z.strictObject({
      base: share,
      plus: z.array(
        z.strictObject({
          if: z.strictObject({ trait: text, lt: share.optional(), gt: share.optional() }),
          add: z.number().min(-1).max(1),
        }),
      ),
    }),
    evidenceHints: ids,
  }),
);

export const crimesSchema = z
  .array(
    z.strictObject({
      id,
      incidentType: id,
      requires: z.strictObject({
        means: z.strictObject({ itemTag: id, itemId: id.optional() }),
        minWindowMinutes: positiveMinutes,
        locationTags: ids,
        traits: condition,
      }),
      plan: z
        .array(
          z.strictObject({
            step: id,
            verb: id,
            target: text,
            duration: minutes.optional(),
            before: id.optional(),
            after: id.optional(),
            optional: z.boolean().optional(),
          }),
        )
        .min(1),
      deathDelayMinutes: z
        .tuple([minutes, minutes])
        .refine(([min, max]) => min <= max, {
          error: 'Upper bound must be at least lower bound',
        })
        .optional(),
    }),
  )
  .min(1);

export const traceRulesSchema = z.array(
  z.strictObject({
    verb: id,
    when: z.strictObject({ targetTag: id.optional(), itemId: id.optional() }).optional(),
    produces: z
      .array(
        z.strictObject({
          kind: z.enum(['physical', 'document', 'digital', 'testimonial']),
          at: z.union([id, z.string().regex(/^\$[a-z][a-zA-Z0-9_]*$/)]),
          template: id,
          supports: z.array(text),
          captureMode: z.enum(['direct', 'qr']).optional(),
          decaysAfter: minutes.nullable().optional(),
          requires: z.strictObject({ itemId: id }).optional(),
        }),
      )
      .min(1),
  }),
);

export const deductionRulesSchema = z.array(
  z.strictObject({
    id,
    establishes: text,
    requires: z.array(text).min(1),
    excludes: z.array(text).optional(),
  }),
);

export const textTemplatesSchema = z.record(id, z.array(text).min(1));

export const phoneTemplatesSchema = z.array(
  z.strictObject({
    id,
    kind: z.enum(['message', 'page', 'file', 'wallpaper']),
    template: text,
    title: text.optional(),
    event: id.optional(),
    hidden: z.boolean().optional(),
    password: text.optional(),
  }),
);
