import type { ScenarioContent } from '@hs/core/content';
import { createRng } from '@hs/core/rng';
import { expect, test } from 'vitest';
import { CONCEALMENT_VERBS } from '@hs/core/evidence';
import { evidenceGen, GenerationRejection, type HistoryWorld } from '../../src/index.ts';
import { planned, simulateHistory } from '../support/history.ts';
import { minimal, sanatorium, silent } from '../support/incident.ts';

const COUNT = 1000;

function evidence(history: HistoryWorld, content: ScenarioContent, seed: string) {
  return evidenceGen.generate(history, {
    rng: createRng(`${seed}#1`).fork('gen/EvidenceGen'),
    content,
    logger: silent,
  });
}

test(`${COUNT} seeds: every key event yields a clue and the QR share holds`, () => {
  const { minQrShare } = sanatorium.preset.phone;
  let checked = 0;
  let concealments = 0;
  for (let n = 0; checked < COUNT && n < COUNT * 10; n++) {
    const seed = `evidence-prop-${n}`;
    const world = planned(sanatorium, seed);
    if (!world) continue;
    const history = simulateHistory(world, sanatorium, seed);
    if (history instanceof GenerationRejection) continue;
    const result = evidence(history, sanatorium, seed);
    checked++;

    // Conservation of evidence (ADR 0017): every concealment event leaves a trace and a clue.
    for (const event of history.truth.events()) {
      if (!CONCEALMENT_VERBS.includes(event.verb)) continue;
      expect(
        result.clues.some(({ sourceEventId }) => sourceEventId === event.id),
        `${seed}: concealment ${event.id}`,
      ).toBe(true);
      concealments++;
    }

    for (const id of history.truth.incident.keyEventIds) {
      expect(
        result.clues.some(({ sourceEventId }) => sourceEventId === id),
        `${seed}: ${id}`,
      ).toBe(true);
    }
    const required = new Set(result.requiredClueIds);
    const requiredClues = result.clues.filter(({ id }) => required.has(id));
    expect(requiredClues.length, seed).toBeGreaterThan(0);
    const qr = requiredClues.filter(({ captureMode }) => captureMode === 'qr').length;
    expect(qr / requiredClues.length, seed).toBeGreaterThanOrEqual(minQrShare);
    // Required clues are exactly those of key events; no clue for testimonial traces.
    const keys = new Set(history.truth.incident.keyEventIds);
    expect(
      requiredClues.every(({ sourceEventId }) => keys.has(sourceEventId)),
      seed,
    ).toBe(true);
    const testimonial = new Set(
      result.traces.filter(({ kind }) => kind === 'testimonial').map(({ id }) => id),
    );
    expect(
      result.clues.some(({ traceId }) => testimonial.has(traceId)),
      seed,
    ).toBe(false);
    // Deterministic: the same input gives the same clues.
    expect(evidence(history, sanatorium, seed).clues, seed).toEqual(result.clues);
  }
  // Exactly COUNT inputs that reached the stage were checked, not COUNT raw seeds.
  expect(checked).toBe(COUNT);
  expect(concealments).toBeGreaterThan(0);
}, 600_000);

test('a key event without any clue rejects the attempt', () => {
  const seed = 'evidence-uncovered';
  let history: HistoryWorld | undefined;
  for (let n = 0; n < 50 && !history; n++) {
    const world = planned(sanatorium, `${seed}-${n}`);
    const h = world && simulateHistory(world, sanatorium, `${seed}-${n}`);
    if (h && !(h instanceof GenerationRejection)) history = h;
  }
  expect(history).toBeDefined();
  const keyVerbs = new Set(
    history!.truth
      .events()
      .filter(
        (event) =>
          history!.truth.incident.keyEventIds.includes(event.id) &&
          !CONCEALMENT_VERBS.includes(event.verb),
      )
      .map((event) => event.verb),
  );
  expect(keyVerbs.size).toBeGreaterThan(0);
  const content: ScenarioContent = {
    ...sanatorium,
    // The chosen incident may be a boiler accident rather than a poisoning.
    // Remove the actual key events' rules so the mutation always removes their clues.
    traceRules: sanatorium.traceRules.filter(({ verb }) => !keyVerbs.has(verb)),
  };
  expect(() => evidence(history!, content, seed)).toThrow(GenerationRejection);
});

test('the stage raises the QR share of required clues when the rules give too few', () => {
  const content: ScenarioContent = {
    ...minimal,
    preset: { ...minimal.preset, phone: { minQrShare: 0.6 } },
    traceRules: minimal.traceRules.map((rule) => ({
      ...rule,
      produces: rule.produces.map((spec) => ({ ...spec, captureMode: 'direct' as const })),
    })),
  };
  let checked = 0;
  for (let n = 0; n < 40; n++) {
    const seed = `evidence-qr-${n}`;
    const world = planned(minimal, seed);
    const history = world && simulateHistory(world, minimal, seed);
    if (!history || history instanceof GenerationRejection) continue;
    const result = evidence(history, content, seed);
    const required = new Set(result.requiredClueIds);
    const requiredClues = result.clues.filter(({ id }) => required.has(id));
    const qr = requiredClues.filter(({ captureMode }) => captureMode === 'qr').length;
    expect(qr / requiredClues.length, seed).toBeGreaterThanOrEqual(0.6);
    expect(qr, seed).toBeGreaterThan(0);
    checked++;
  }
  expect(checked).toBeGreaterThan(0);
});
