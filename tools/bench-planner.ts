import assert from 'node:assert/strict';
import { InvestigationBuilder, GameEngine } from '@hs/core/game';
import { compileDeductionRules, evaluateClaims, PlayerKnowledge } from '@hs/core/investigation';
import type { Clue } from '@hs/core/evidence';
import { factId, TruthModel } from '@hs/core/truth';
import { motiveFact } from '@hs/generator';
import { incidentInput, sanatorium, select } from '../packages/generator/test/support/incident.ts';
import { solve, timeFeasibleCheck } from '@hs/validator';

// Reuse the accepted sanatorium world, cast, social history and incident selection. The three
// discoverable records and supplementary rules are explicit fixtures until evidence packaging.
const seed = 'plot-unit';
const draft = select(incidentInput(sanatorium, seed), sanatorium, seed);
const { culpritId, victimId, meansItemIds, motive, type } = draft.incident;
const source = draft.history.find((e) =>
  e.facts.some((f) => factId(f) === factId(motiveFact(motive))),
)!;
const truth = new TruthModel(
  {
    culpritIds: [culpritId],
    victimIds: [victimId],
    type,
    means: meansItemIds[0]!,
    motive: factId(motiveFact(motive)),
    keyEventIds: [source.id],
    window: { from: -30, to: -20 },
  },
  draft.history,
);
const owners = new Map(draft.characters.map((c) => [c.archetypeId, c.id]));
const investigation = new InvestigationBuilder({
  scenarioId: sanatorium.preset.id,
  seed,
  generatorVersion: 'benchmark',
})
  .withWorld(draft.world.createWorldState(owners))
  .withCharacters(draft.characters)
  .withRelationships(draft.relationships)
  .withTruth(truth)
  .withSecrets(draft.secrets.map(({ id, fact, knownBy }) => ({ id, fact, knownBy })))
  .build();
const knownIncident = { location: 'loc_dining', window: { from: -35, to: -10 } };
const startLocationId = 'loc_hall';
function record(
  id: string,
  locationId: string,
  supports: string[],
  action: Clue['discovery']['action'],
): Clue {
  return {
    id,
    traceId: id,
    sourceEventId: source.id,
    supports,
    discovery: {
      action,
      locationId,
      availableFrom: 0,
      requires: [],
    },
    captureMode: 'auto',
    presentation: id,
  };
}
const clues = [
  record('letter', startLocationId, [`knows(${culpritId},secret)`, `about(secret,${victimId})`], {
    type: 'read',
    documentId: 'letter',
  }),
  record('record', 'loc_dining', [`access_to_record(${culpritId})`], {
    type: 'read',
    documentId: 'record',
  }),
  record('sighting', 'loc_dining', [`presence(${culpritId},loc_dining,-25)`], {
    type: 'examineHotspot',
    hotspotId: 'hs_dining_tables',
  }),
];
const deductionRules = compileDeductionRules([
  ...sanatorium.deductionRules,
  {
    id: 'means_record',
    establishes: 'means($c)',
    requires: ['access_to_record($c)'],
  },
]);
const options = {
  timeBudget: Math.floor((investigation.world.durationMinutes * 7) / 10),
  startLocationId,
  clues,
  deductionRules,
  knownIncident,
};
const samples: number[] = [];
for (let i = 0; i < 10; i++) {
  const start = process.hrtime.bigint();
  const path = solve(investigation, options);
  samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  assert.ok(path, 'No playable path on the benchmark fixture');
  const engine = GameEngine.create(investigation, { startLocationId, clues });
  for (const action of path) assert.ok(engine.dispatch('desktop', action).ok);
  const knowledge = PlayerKnowledge.restore(engine.snapshot().desktop?.knowledge);
  const claims = evaluateClaims(knowledge, deductionRules, {
    clues: new Map(clues.map((c) => [c.id, c])),
    incident: knownIncident,
  });
  assert.deepEqual(
    claims
      .filter((c) => c.subject === culpritId)
      .map((c) => c.kind)
      .sort(),
    ['means', 'motive', 'opportunity'],
  );
  assert.ok(engine.playerView().clock.t <= options.timeBudget);
  if (i === 0)
    console.log(
      `${draft.characters.length} NPC, ${sanatorium.locations.length} rooms, ${draft.history.length} events, ${path.length} actions, ${engine.playerView().clock.t} game minutes`,
    );
}
console.log('Planner samples (ms):', samples.map((n) => n.toFixed(1)).join(', '));
assert.ok(Math.max(...samples) <= 300, 'An individual planner run exceeded 300 ms');
const negative: number[] = [];
for (let i = 0; i < 10; i++) {
  const start = process.hrtime.bigint();
  const findings = timeFeasibleCheck.run(investigation, { ...options, clues: clues.slice(0, 2) });
  negative.push(Number(process.hrtime.bigint() - start) / 1e6);
  assert.equal(findings[0]?.severity, 'error');
  if (i === 0) console.log('Missing sighting:', findings[0]?.code);
}
console.log('Rejected fixture (ms):', negative.map((n) => n.toFixed(1)).join(', '));
assert.ok(Math.max(...negative) <= 300, 'An individual negative planner run exceeded 300 ms');
