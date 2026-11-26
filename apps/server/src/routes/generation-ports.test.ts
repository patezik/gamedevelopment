import { loadScenarioFromDir } from '@hs/core/content';
import { GameEngine } from '@hs/core/game';
import { generateInvestigation, type GenerationResult } from '@hs/generator';
import { FORBIDDEN_VIEW_KEYS } from '@hs/protocol';
import { describe, expect, test, vi } from 'vitest';
import { scenarioEnginePorts } from '../sessions/scenario-ports.ts';
import {
  defaultScenariosDir,
  GenerationUnsolvableError,
  GeneratorInvestigationProvider,
  ScenarioCatalog,
} from './generation.ts';

const SCENARIO = 'sanatorium_winter';
/** Accepted on its second attempt: the first one is rejected by the gate. */
const SEED = '2';

const content = loadScenarioFromDir(`${defaultScenariosDir()}${SCENARIO}`);
const catalog = new ScenarioCatalog([content]);

/** The real generator behind the provider; the last result is kept for comparison. */
function recordingProvider() {
  const results: GenerationResult[] = [];
  const generate = vi.fn<typeof generateInvestigation>((req, scenario, options) => {
    const result = generateInvestigation(req, scenario, options);
    results.push(result);
    return result;
  });
  return { provider: new GeneratorInvestigationProvider(catalog, { generate }), results, generate };
}

function accepted(results: readonly GenerationResult[]) {
  const result = results.at(-1);
  if (!result?.ok) throw new Error('the seed is expected to be solvable');
  return result;
}

describe('GeneratorInvestigationProvider ports (SRV-012)', () => {
  test('start, clues, memories and rules belong to the accepted attempt', () => {
    const { provider, results, generate } = recordingProvider();
    const { ports } = provider.create(SCENARIO, SEED);
    const result = accepted(results);

    expect(result.server.attempt).toBe(2);
    expect(ports.startLocationId).toBe(result.server.startLocationId);
    expect(ports.clues).toBe(result.server.clues);
    expect(ports.accusation?.rules).toBe(result.server.deductionRules);
    expect(ports.startVitals).toEqual(content.preset.survival.startVitals);
    expect(ports.texts).toEqual(new Map(Object.values(content.text.ru!).flatMap(Object.entries)));
    const [character] = result.investigation.characters;
    const witness = ports.testimony?.witness(character!.id);
    expect(witness?.knowledge).toBe(result.server.knowledge.get(character!.id));
    expect(witness?.policy).toBe(result.server.liePolicies.get(character!.id));
    expect(ports.testimony?.witness('ch_nobody')).toBeUndefined();
    // The full validation gate stays on: the adapter passes no `checks` of its own.
    expect(generate.mock.calls[0]![2]).not.toHaveProperty('checks');
  });

  test('every call generates on its own: nothing is shared between sessions', () => {
    const { provider, results } = recordingProvider();
    const first = provider.create(SCENARIO, SEED);
    const second = provider.create(SCENARIO, SEED);
    expect(results).toHaveLength(2);
    expect(second.ports.clues).not.toBe(first.ports.clues);
    expect(second.ports.testimony).not.toBe(first.ports.testimony);

    const a = GameEngine.create(first.investigation, first.ports);
    const b = GameEngine.create(second.investigation, second.ports);
    const before = b.stateHash();
    expect(a.dispatch('desktop', { type: 'wait', minutes: 30 }).ok).toBe(true);
    expect(b.stateHash()).toBe(before);
  });

  test('a refused gate gives GENERATION_UNSOLVABLE and no ports', () => {
    const report = { generatorVersion: 'x', attempts: [], validations: [] };
    const generate = vi.fn(() => ({ ok: false, error: 'GENERATION_UNSOLVABLE', report }) as never);
    const provider = new GeneratorInvestigationProvider(catalog, { generate });
    expect(() => provider.create(SCENARIO, SEED)).toThrow(GenerationUnsolvableError);
  });
});

/** Walks every reachable room, examining it and reading/examining the clues found there. */
function collect(
  engine: GameEngine,
  clues: ReturnType<typeof accepted>['server']['clues'],
  skip: ReadonlySet<string>,
) {
  const byLocation = new Map<string, (typeof clues)[number][]>();
  for (const clue of clues) {
    const list = byLocation.get(clue.discovery.locationId) ?? [];
    list.push(clue);
    byLocation.set(clue.discovery.locationId, list);
  }
  const seen = new Set<string>();
  const found: string[] = [];
  const visit = (location: string) => {
    seen.add(location);
    engine.dispatch('desktop', { type: 'examineLocation' });
    for (const clue of byLocation.get(location) ?? []) {
      if (skip.has(clue.id)) continue;
      const { action } = clue.discovery;
      const result = engine.dispatch(
        'desktop',
        action.type === 'read'
          ? { type: 'read', documentId: action.documentId }
          : { type: 'examineHotspot', hotspotId: action.hotspotId },
      );
      if (result.ok) found.push(clue.id);
    }
    for (const exit of engine.playerView().location.exits) {
      if (seen.has(exit.locationId)) continue;
      if (!engine.dispatch('desktop', { type: 'move', locationId: exit.locationId }).ok) continue;
      visit(exit.locationId);
      engine.dispatch('desktop', { type: 'move', locationId: location });
    }
  };
  visit(engine.playerView().location.id);
  return found;
}

describe('GameEngine on the ports of a generated case (SRV-012)', () => {
  const { provider, results } = recordingProvider();
  void provider.create(SCENARIO, SEED);
  const generated = accepted(results);
  const { server } = generated;
  const { culpritIds, victimIds } = generated.investigation.truth.incident;
  const culprit = culpritIds[0]!;
  const required = new Set(server.requiredClueIds);

  const fresh = () =>
    GameEngine.create(
      generated.investigation,
      scenarioEnginePorts(content, generated.investigation, server),
    );

  const accuse = (engine: GameEngine, evidence: string[]) =>
    engine.dispatch('desktop', {
      type: 'accuse',
      caseFile: {
        accusedIds: [culprit],
        motive: `motive(${culprit},${victimIds[0]})`,
        means: `means(${culprit})`,
        opportunity: `opportunity(${culprit})`,
        evidence,
      },
      confirm: true,
    });
  const proven = (engine: GameEngine, evidence: string[] = []) =>
    accuse(engine, evidence).events.find(({ type }) => type === 'AccusationMade');

  test('starts at the preset start with its vitals and the phone of the hero', () => {
    const engine = fresh();
    const view = engine.playerView();
    expect(view.location.id).toBe(server.startLocationId);
    expect(view.vitals).toEqual(content.preset.survival.startVitals);

    const phone = engine.phoneView();
    expect(phone?.files.length).toBeGreaterThan(0);
    const templates = Object.values(content.phone).flat();
    const json = JSON.stringify([view, phone]);
    for (const hidden of templates.filter((t) => t.hidden || t.password !== undefined)) {
      expect(json).not.toContain(hidden.template);
      if (hidden.password !== undefined) expect(json).not.toContain(hidden.password);
    }
    for (const key of FORBIDDEN_VIEW_KEYS) expect(json).not.toContain(`"${key}"`);
    expect(json).not.toContain(culprit);
  });

  test('clues are discovered by the actions the generator gave them', () => {
    const engine = fresh();
    const found = collect(engine, server.clues, new Set());
    expect(found.length).toBeGreaterThan(server.clues.length / 2);
    expect(found.some((id) => required.has(id))).toBe(true);
    for (const id of found) expect(server.clues.some((clue) => clue.id === id)).toBe(true);
  });

  test('`$incident` rules need the incident to be known: opportunity appears with the key clue', () => {
    const blind = fresh();
    const withoutKey = collect(blind, server.clues, required);
    expect(withoutKey.length).toBeGreaterThan(0);
    expect(proven(blind, withoutKey)).toMatchObject({ proven: { opportunity: false } });

    const informed = fresh();
    const foundAll = collect(informed, server.clues, new Set());
    expect(foundAll.some((id) => required.has(id))).toBe(true);
    expect(proven(informed, foundAll)).toMatchObject({ proven: { opportunity: true } });
  });

  test('an accusation with nothing found proves nothing', () => {
    expect(proven(fresh())).toMatchObject({
      result: 'partial',
      proven: { motive: false, means: false, opportunity: false },
    });
  });
});
