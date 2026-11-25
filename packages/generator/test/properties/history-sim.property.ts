import type { ScenarioContent } from '@hs/core/content';
import { checkTruthInvariants, factId } from '@hs/core/truth';
import { expect, test } from 'vitest';
import { DEATH_VERB, GenerationRejection, LETHAL_INCIDENT_TYPES } from '../../src/index.ts';
import { planned, simulateHistory } from '../support/history.ts';

/** Acceptance (GEN-008): the incident is executed in at least 95 % of first attempts. */
const MIN_FIRST_ATTEMPT_SUCCESS = 0.95;

/** Registers the GEN-008 property test of HistorySimulation for `count` seeds of a scenario. */
export function historyProperty(name: string, content: ScenarioContent, count: number): void {
  test(`${count} seeds: the truth holds its invariants and the plan is executed`, () => {
    let planned_ = 0;
    const rejected: string[] = [];
    let delayed = 0;
    for (let n = 0; n < count; n++) {
      const seed = `history-prop-${n}`;
      const world = planned(content, seed);
      if (!world) continue;
      planned_++;
      const history = simulateHistory(world, content, seed);
      if (history instanceof GenerationRejection) {
        rejected.push(`${seed}: ${history.message}`);
        continue;
      }
      const { truth, incident, plot, historyReport } = history;
      if (historyReport.attempts.length > 1) delayed++;
      expect(checkTruthInvariants(truth, history.worldState), seed).toEqual([]);

      // Key events are the executed steps, all of them, each by the culprit.
      const { keyEventIds, culpritIds, motive, window } = truth.incident;
      expect(keyEventIds.toSorted(), seed).toEqual(
        historyReport.steps.map(({ eventId }) => eventId).toSorted(),
      );
      expect(historyReport.steps.map(({ id }) => id).toSorted(), seed).toEqual(
        plot.steps.map(({ id }) => id).toSorted(),
      );
      const events = new Map(truth.events().map((event) => [event.id, event]));
      for (const id of keyEventIds) {
        expect(events.get(id)!.actorIds, seed).toEqual(culpritIds);
      }
      expect(window, seed).toEqual(plot.incident.window);
      // The motive is a fact ConflictGen recorded in the backstory.
      expect(
        truth.facts({ kind: 'motive' }).map((fact) => factId(fact)),
        seed,
      ).toContain(motive);

      const deaths = truth.events().filter(({ verb }) => verb === DEATH_VERB);
      if (LETHAL_INCIDENT_TYPES.includes(incident.type)) {
        expect(
          deaths.map(({ actorIds, t }) => [actorIds, t]),
          seed,
        ).toEqual([[[incident.victimId], historyReport.deathAt]]);
      } else {
        expect(deaths, seed).toEqual([]);
      }
      expect(history.locationsAtStart.size, seed).toBe(world.characters.length);
    }
    const success = (planned_ - rejected.length) / planned_;
    // Reported for the sweep record in the task; the bound is the acceptance criterion.
    console.info(
      `${name}: ${planned_} plans, ${delayed} delayed, ${rejected.length} rejected`,
      rejected.slice(0, 10),
    );
    expect(planned_).toBeGreaterThan(0);
    expect(success).toBeGreaterThanOrEqual(MIN_FIRST_ATTEMPT_SUCCESS);
  }, 600_000);
}
