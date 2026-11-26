import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadScenarioFromDir } from '@hs/core/content';
import { GameEngine, type EnginePorts } from '@hs/core/game';
import { evaluateClaims, PlayerKnowledge } from '@hs/core/investigation';
import { KnowledgeStore } from '@hs/core/knowledge';
import { generateInvestigation } from '@hs/generator';
import { solutionSource, solve, timeFeasibleCheck, type PlannerOptions } from '@hs/validator';

// Version 0.4.0 changes the generated cases: seed 1 is now rejected by the static gate.
// These fixtures replay current cases; broader beam-search coverage is tracked in VAL-009.
export const seeds = ['3', '4', '7', '9'] as const;
type Witness = NonNullable<ReturnType<NonNullable<EnginePorts['testimony']>['witness']>>;
const content = loadScenarioFromDir(
  fileURLToPath(new URL('../content/scenarios/sanatorium_winter/', import.meta.url)),
);

export function generatedPlannerCase(seed: string) {
  const result = generateInvestigation({ scenarioId: content.preset.id, seed }, content);
  assert.ok(result.ok, `Seed ${seed}: default gate rejected: ${JSON.stringify(result.report)}`);
  assert.equal(result.report.validations.at(-1)?.ok, true);
  const { investigation, server } = result;
  const { clues, deductionRules, startLocationId } = server;
  const memories = new Map(
    Array.from(server.knowledge, ([id, memory]) => [id, memory.serialize()]),
  );
  const createSimulationPorts = (): Omit<EnginePorts, 'clues' | 'startLocationId'> => {
    const witnesses = new Map<string, Witness>();
    return {
      startVitals: content.preset.survival.startVitals,
      npcSimulation: true,
      phone: {},
      // Stateless, so a snapshot restored with fresh ports issues the same tokens.
      evidenceTokens: {
        issue: (clueId, expiresAt) => `planner_qr_${clueId}_${expiresAt}`,
        revoke: () => {},
      },
      testimony: {
        witness(id) {
          const cached = witnesses.get(id);
          if (cached) return cached;
          const memory = memories.get(id);
          const policy = server.liePolicies.get(id);
          if (!memory || !policy) return undefined;
          const witness = {
            knowledge: KnowledgeStore.deserialize(memory),
            policy: structuredClone(policy),
          };
          witnesses.set(id, witness);
          return witness;
        },
      },
    };
  };

  // OQ-25 assumption, same as SRV-012: once the body is found the player knows the place of the
  // first key event and the incident window (the briefing the player is shown, not a culprit).
  const keyEvent = investigation.truth
    .events()
    .find(({ id }) => id === investigation.truth.incident.keyEventIds[0]);
  const knownIncident = keyEvent && {
    location: keyEvent.location,
    window: investigation.truth.incident.window,
  };
  const timeBudget = Math.floor((investigation.world.durationMinutes * 7) / 10);
  // The accepted payload has no player-facing briefing. Its question bank is an oracle used by
  // the static gate. Conversations in this experiment must obtain their own answers via dispatch.
  const options: PlannerOptions = {
    clues,
    deductionRules,
    startLocationId,
    timeBudget,
    ...(knownIncident && { knownIncident }),
    createSimulationPorts,
  };
  const createEngine = () =>
    GameEngine.create(investigation, { ...createSimulationPorts(), clues, startLocationId });
  return { investigation, server, options, createEngine };
}

export function examineGeneratedCase(seed: string, generated = generatedPlannerCase(seed)) {
  const { investigation, server, options, createEngine } = generated;
  const start = process.hrtime.bigint();
  const path = solve(investigation, options);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;

  const unknownHotspots = new Set(
    server.clues
      .filter(({ discovery }) => {
        const { action, locationId } = discovery;
        return (
          action.type === 'examineHotspot' &&
          !investigation.world.locations
            .describe(locationId)
            .hotspots.some((hotspot) => hotspot.id === action.hotspotId)
        );
      })
      .map(({ id }) => id),
  );
  const qrClues = server.clues.filter(({ captureMode }) => captureMode === 'qr');
  const summary = {
    seed,
    attempt: server.attempt,
    clues: server.clues.length,
    testimony: server.testimony.length,
    requiredWithoutHotspot: server.requiredClueIds.filter((id) => unknownHotspots.has(id)).length,
    qrWithoutHotspot: qrClues.filter(({ id }) => unknownHotspots.has(id)).length,
    qrClues: qrClues.length,
    budget: options.timeBudget,
    ms: Math.round(ms),
  };
  if (!path) {
    const failure = timeFeasibleCheck.run(investigation, options)[0]?.code;
    assert.ok(failure, 'The timed search and validation must agree');
    return { ...summary, failure };
  }

  const engine = createEngine();
  let captures = 0;
  for (const action of path) {
    const role = solutionSource(action);
    const result = engine.dispatch(role, action);
    assert.ok(result.ok && !result.outcome, `Replay of ${action.type}: ${JSON.stringify(result)}`);
    if (role === 'phone') {
      assert.ok(result.events.some(({ type }) => type === 'EvidenceCaptured'));
      captures++;
    }
  }
  const snapshot = engine.snapshot();
  const knowledge = PlayerKnowledge.restore(snapshot.desktop?.knowledge);
  const claims = evaluateClaims(knowledge, options.deductionRules, {
    clues: new Map(options.clues.map((clue) => [clue.id, clue])),
    ...(options.knownIncident && { incident: options.knownIncident }),
  });
  for (const id of investigation.truth.incident.culpritIds) {
    const kinds = claims.filter((claim) => claim.subject === id).map((claim) => claim.kind);
    for (const kind of ['motive', 'means', 'opportunity'] as const)
      assert.ok(kinds.includes(kind), kind);
  }
  assert.ok(snapshot.minute <= options.timeBudget);
  return { ...summary, actions: path.length, captures, minutes: snapshot.minute };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = seeds.map((seed) => examineGeneratedCase(seed));
  console.table(results);
  // VAL-003: the planner budget on the full MVP case is 2000 ms (owner decision 26.11.2026, see validation.md).
  const BUDGET_MS = 2000;
  console.log(
    `Within ${BUDGET_MS} ms: ${results.filter(({ ms }) => ms <= BUDGET_MS).length}/${results.length}`,
  );
  if (results.some((result) => 'failure' in result || result.ms > BUDGET_MS)) process.exitCode = 1;
}
