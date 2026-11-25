import type { Personality } from '../characters/index.ts';
import type { Rng } from '../rng/index.ts';

function substitute(template: string, key: string, values: Readonly<Record<string, string>>) {
  return template.replace(/\{([a-z][a-z0-9_]*)\}/g, (_placeholder, name: string) => {
    if (!Object.hasOwn(values, name) || values[name] === undefined) {
      throw new Error(`Missing value for {${name}} in text template ${key}`);
    }
    return values[name];
  });
}

/** Selects a template with the supplied RNG and substitutes its named values once. */
export function renderTemplate(
  templates: ReadonlyMap<string, readonly string[]>,
  key: string,
  values: Readonly<Record<string, string>>,
  rng: Rng,
): string {
  const variants = templates.get(key);
  if (variants === undefined || variants.length === 0) {
    throw new Error(`No variants for text template ${key}`);
  }

  return substitute(rng.pick(variants), key, values);
}

/** Testimony variants are ordered neutral, calm, nervous and hostile. */
export function renderTestimony(
  templates: ReadonlyMap<string, readonly string[]>,
  key: string,
  values: Readonly<Record<string, string>>,
  rng: Rng,
  personality: Pick<Personality, 'agreeableness' | 'neuroticism'>,
): string {
  const variants = templates.get(key);
  const [neutral, calm, nervous, hostile] = variants ?? [];
  if (variants?.length !== 4 || !neutral || !calm || !nervous || !hostile) {
    throw new Error(`Expected four tone variants for testimony template ${key}`);
  }
  const tone =
    personality.agreeableness < 0.4 ? hostile : personality.neuroticism > 0.6 ? nervous : calm;
  return substitute(rng.pick([neutral, tone]), key, values);
}
