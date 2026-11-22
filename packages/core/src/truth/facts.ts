import { z } from 'zod';
import { canonicalJson, hashId, verbSchema } from '../common/index.ts';

export { verbSchema };

const idSchema = z.string().min(1);
const minuteSchema = z.int();
const intervalSchema = z
  .strictObject({ from: minuteSchema, to: minuteSchema })
  .refine(({ from, to }) => from < to, { error: 'Interval must have positive length' });

export const entityRefSchema = z.strictObject({
  kind: z.enum(['character', 'item', 'document', 'location']),
  id: idSchema,
});

export const factIdSchema = z.string().regex(/^f_[a-f0-9]{16}$/);
export const factSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('at'), who: idSchema, where: idSchema, interval: intervalSchema }),
  z.strictObject({
    kind: z.literal('did'),
    who: idSchema,
    verb: verbSchema,
    target: entityRefSchema.optional(),
    at: minuteSchema,
    where: idSchema,
  }),
  z.strictObject({ kind: z.literal('possessed'), who: idSchema, item: idSchema, interval: intervalSchema }),
  z.strictObject({
    kind: z.literal('relation'),
    a: idSchema,
    b: idSchema,
    relType: idSchema,
    since: minuteSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('motive'),
    who: idSchema,
    against: idSchema,
    motiveType: idSchema,
    basis: z.array(factIdSchema),
  }),
  z.strictObject({
    kind: z.literal('state'),
    entity: entityRefSchema,
    property: idSchema,
    value: z.union([z.string(), z.number(), z.boolean()]),
    interval: intervalSchema,
  }),
]);

export type EntityRef = z.infer<typeof entityRefSchema>;
export type Verb = z.infer<typeof verbSchema>;
export type FactId = z.infer<typeof factIdSchema>;
export type Fact = z.infer<typeof factSchema>;
export type Proposition = Fact;

interface Variable {
  var: string;
}

type Pattern<T extends Proposition> = {
  [Key in keyof T]?: Exclude<T[Key], undefined> | Variable;
} & { kind: T['kind'] };

export type PropositionPattern = {
  [Kind in Proposition['kind']]: Pattern<Extract<Proposition, { kind: Kind }>>;
}[Proposition['kind']];

export function factId(fact: Fact): FactId {
  const fields = Object.entries(fact).filter(([, value]) => value !== undefined);
  return hashId('f', canonicalJson(Object.fromEntries(fields)), 16);
}

function isVariable(value: unknown): value is Variable {
  return typeof value === 'object' && value !== null && 'var' in value && typeof value.var === 'string';
}

export function matchProposition(
  proposition: Proposition,
  pattern: PropositionPattern,
): ReadonlyMap<string, unknown> | null {
  if (proposition.kind !== pattern.kind) return null;

  const fields = new Map<string, unknown>(Object.entries(proposition));
  const bindings = new Map<string, unknown>();
  for (const [key, expected] of Object.entries(pattern)) {
    const actual = fields.get(key);
    if (expected === undefined) continue;
    if (actual === undefined) return null;

    if (isVariable(expected)) {
      if (bindings.has(expected.var) && canonicalJson(bindings.get(expected.var)) !== canonicalJson(actual)) {
        return null;
      }
      bindings.set(expected.var, actual);
    } else if (canonicalJson(expected) !== canonicalJson(actual)) {
      return null;
    }
  }
  return bindings;
}
