import type { ScenarioContent } from '@hs/core/content';
import type { EnginePorts, Investigation } from '@hs/core/game';
import { initialPhoneState, type PhoneTemplate } from '@hs/core/phone';
import type { ServerGenerationPayload } from '@hs/generator';

/** Drops `undefined` fields of parsed rows: `PhoneTemplate` expects them absent. */
const toPhoneTemplate = (row: unknown): PhoneTemplate =>
  JSON.parse(JSON.stringify(row)) as PhoneTemplate;

/**
 * Engine ports of one accepted generation attempt and the scenario preset (SRV-012). Everything
 * here names the truth (memories, lie policies, required clues, rules): it stays in the server
 * process and reaches a client only through the engine's projections. Pure: the same inputs give
 * equal ports, and nothing is shared between calls except the immutable generation payload.
 *
 * Deliberately left to the engine defaults: `actionCosts`, `player`, `inventory`, the call
 * arbitration (`callState`) and the phone answers (`callGreeting`, `callReply`, `messageReply`).
 * Tokens (SRV-013) and the simulation hooks of ENG-010 are other tasks. The preset's critical
 * events and deadlines (TIME-006) are on: the engine runs them on its own clock.
 */
/** The locale of the source texts: the fallback of every missing template (QA-003). */
export const SOURCE_TEXT_LOCALE = 'ru';

/** The text locale a scenario can serve: the requested one if it has templates, else `ru`. */
export function resolveTextLocale(content: ScenarioContent, locale?: string): string {
  return locale !== undefined && content.text[locale] !== undefined ? locale : SOURCE_TEXT_LOCALE;
}

const flattenTexts = (content: ScenarioContent, locale: string) =>
  Object.values(content.text[locale] ?? {}).flatMap((group) => Object.entries(group));

/** Templates of the resolved locale over the Russian ones: a key a translation lacks stays ru. */
export function scenarioTexts(content: ScenarioContent, locale?: string): Map<string, string[]> {
  const texts = new Map(flattenTexts(content, SOURCE_TEXT_LOCALE));
  const resolved = resolveTextLocale(content, locale);
  if (resolved !== SOURCE_TEXT_LOCALE) {
    for (const [key, text] of flattenTexts(content, resolved)) texts.set(key, text);
  }
  return texts;
}

export function scenarioEnginePorts(
  content: ScenarioContent,
  investigation: Investigation,
  server: ServerGenerationPayload,
  locale?: string,
): EnginePorts {
  const { knowledge, liePolicies, deductionRules } = server;
  const required = new Set(server.requiredClueIds);
  return {
    startLocationId: server.startLocationId,
    texts: scenarioTexts(content, locale),
    clues: server.clues,
    startVitals: { ...content.preset.survival.startVitals },
    scenarioEvents: {
      criticalEvents: content.preset.criticalEvents,
      deadlines: content.preset.deadlines,
    },
    phone: {
      initial: initialPhoneState(Object.values(content.phone).flat().map(toPhoneTemplate)),
    },
    testimony: {
      witness(characterId) {
        const store = knowledge.get(characterId);
        const policy = liePolicies.get(characterId);
        return store && policy ? { knowledge: store, policy } : undefined;
      },
    },
    accusation: {
      rules: deductionRules,
      // PROVISIONAL (open-questions.md): the incident the player has worked out is the real
      // location and window once any clue of the incident's key events is found. Until then
      // `$incident` rules do not fire, so an unrevealed window proves no opportunity.
      incident: (known) => {
        if (![...known.clues.keys()].some((id) => required.has(id))) return undefined;
        const { incident } = investigation.truth;
        const first = investigation.truth.events().find(({ id }) => id === incident.keyEventIds[0]);
        return first ? { location: first.location, window: incident.window } : undefined;
      },
    },
  };
}
