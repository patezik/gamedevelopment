/*
 * Incident feasibility sweep (CNT-003 acceptance): for every crime template of a scenario, the share
 * of seeds whose generated world has at least one feasible culprit (some victim, some character).
 *
 *   node --experimental-transform-types --no-warnings packages/generator/scripts/incident-sweep.ts \
 *     --scenario sanatorium_winter --from 0 --count 500 --threshold 0.9
 *
 * Each seed is attempt 1 of `runPipeline` (WorldGen, CastGen, SocialGen, ConflictGen), assessed by
 * IncidentSelection's `assessIncidents`: the same feasibility the stage uses, with no retries. The
 * chosen incident comes from `selectIncident` on the stage stream. The output is deterministic.
 * Exit code 1 when a template is below the threshold. The report holds server truth: keep it out of
 * player and phone views. `--experimental-transform-types` is needed because generator sources use
 * TypeScript parameter properties, which Node's default type stripping rejects.
 */
import { parseArgs } from 'node:util';
import { createRng } from '@hs/core/rng';
import { incidentInput, scenario } from '../test/support/incident.ts';
import { assessIncidents, FEASIBILITY_CRITERIA, selectIncident } from '../src/index.ts';

const { values } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'sanatorium_winter' },
    from: { type: 'string', default: '0' },
    count: { type: 'string', default: '500' },
    threshold: { type: 'string', default: '0.9' },
    json: { type: 'boolean', default: false },
  },
});
const from = Number(values.from);
const count = Number(values.count);
const threshold = Number(values.threshold);
if (
  ![from, count].every(Number.isSafeInteger) ||
  count <= 0 ||
  !(threshold >= 0 && threshold <= 1)
) {
  throw new RangeError('Expected whole --from, positive --count and --threshold in [0, 1]');
}

const content = scenario(values.scenario);
const minMotive = content.preset.incident.minMotive;
const templates = content.preset.incident.templates.toSorted();
type Tally = Record<string, number>;
const add = (tally: Tally, key: string, by = 1) => (tally[key] = (tally[key] ?? 0) + by);

const feasibleWorlds: Tally = Object.fromEntries(templates.map((id) => [id, 0]));
const rejected: Record<string, Tally> = Object.fromEntries(templates.map((id) => [id, {}]));
const victims: Record<string, Tally> = Object.fromEntries(templates.map((id) => [id, {}]));
const culprits: Record<string, Tally> = Object.fromEntries(templates.map((id) => [id, {}]));
const motiveWorlds: Tally = {};
const chosen = { template: {} as Tally, motive: {} as Tally, culprit: {} as Tally };
let anyTemplate = 0;
let withoutMotive = 0;
const failedSeeds: string[] = [];

for (let n = from; n < from + count; n++) {
  const seed = String(n);
  let input;
  try {
    input = incidentInput(content, seed);
  } catch {
    // A world that earlier stages cannot build has no feasible culprit for any template.
    failedSeeds.push(seed);
    continue;
  }
  const archetype = new Map(input.characters.map(({ id, archetypeId }) => [id, archetypeId]));
  const strong = input.motives.filter(({ strength }) => strength >= minMotive);
  if (strong.length === 0) withoutMotive++;
  for (const type of new Set(strong.map(({ motiveType }) => motiveType))) add(motiveWorlds, type);

  const assessment = assessIncidents(input, content);
  let any = false;
  for (const option of assessment.options) {
    const { templateId } = option;
    for (const criterion of FEASIBILITY_CRITERIA) {
      add(rejected[templateId]!, criterion, option.rejected[criterion]);
    }
    if (option.feasible.length === 0) continue;
    add(victims[templateId]!, archetype.get(option.victimId)!);
    for (const { characterId } of option.feasible) {
      add(culprits[templateId]!, archetype.get(characterId)!);
    }
  }
  for (const id of templates) {
    if (assessment.options.some((o) => o.templateId === id && o.feasible.length > 0)) {
      feasibleWorlds[id]!++;
      any = true;
    }
  }
  if (!any) continue;
  anyTemplate++;
  const stream = createRng(`${seed}#1`).fork('gen/IncidentSelection');
  const { incident } = selectIncident(input, assessment, content, stream);
  add(chosen.template, incident.templateId);
  add(chosen.motive, incident.motive.motiveType);
  add(chosen.culprit, archetype.get(incident.culpritId)!);
}

const required = Math.ceil(threshold * count);
const results = templates.map((id) => ({
  template: id,
  feasibleWorlds: feasibleWorlds[id]!,
  share: feasibleWorlds[id]! / count,
  pass: feasibleWorlds[id]! >= required,
}));
const report = {
  scenario: content.preset.id,
  seeds: { from, to: from + count - 1, count },
  threshold,
  required,
  results,
  anyTemplate,
  withoutMotive,
  failedSeeds,
  motiveWorlds,
  rejected,
  victims,
  culprits,
  chosen,
};

if (values.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
  const line = (tally: Tally) =>
    Object.entries(tally)
      .sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
  console.log(`${report.scenario}: seeds ${from}..${from + count - 1}, need ${required}/${count}`);
  for (const { template, feasibleWorlds: worlds, share, pass } of results) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'} ${template}: ${worlds}/${count} (${percent(share)})`);
    console.log(`       rejected by first failed criterion: ${line(rejected[template]!)}`);
    console.log(`       victims (worlds): ${line(victims[template]!)}`);
  }
  console.log(`  any template: ${anyTemplate}/${count}; worlds without a motive: ${withoutMotive}`);
  console.log(`  failed to generate: ${failedSeeds.length ? failedSeeds.join(', ') : 'none'}`);
  console.log(`  worlds per motive type: ${line(motiveWorlds)}`);
  console.log(`  chosen template: ${line(chosen.template)}`);
  console.log(`  chosen motive: ${line(chosen.motive)}`);
  console.log(`  chosen culprit archetype: ${line(chosen.culprit)}`);
}
if (results.some(({ pass }) => !pass)) process.exitCode = 1;
