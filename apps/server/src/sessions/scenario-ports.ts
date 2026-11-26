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
 * Tokens (SRV-013) and simulation hooks (ENG-010, TIME-006) are other tasks.
 */
export function scenarioEnginePorts(
  content: ScenarioContent,
  investigation: Investigation,
  server: ServerGenerationPayload,
): EnginePorts {
  const { knowledge, liePolicies, deductionRules } = server;
  const required = new Set(server.requiredClueIds);
  return {
    startLocationId: server.startLocationId,
    texts: new Map(Object.values(content.text.ru ?? {}).flatMap((group) => Object.entries(group))),
    clues: server.clues,
    startVitals: { ...content.preset.survival.startVitals },
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
