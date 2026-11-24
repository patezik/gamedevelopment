import { createRng } from '@hs/core/rng';
import { describe, expect, test } from 'vitest';
import {
  GenerationRejection,
  plotPlanning,
  verifyPlot,
  type IncidentWorld,
  type PlotPlan,
} from '../index.ts';
import {
  incidentInput,
  minimal,
  sanatorium,
  select,
  silent,
  trySelect,
} from '../../test/support/incident.ts';

function plan(world: IncidentWorld, content = sanatorium, seed = 'plot') {
  return plotPlanning.generate(world, {
    rng: createRng(`${seed}#1`).fork('gen/PlotPlanning'),
    content,
    logger: silent,
  });
}

const sanatoriumWorld = select(incidentInput(sanatorium, 'plot-unit'), sanatorium, 'plot-unit');
const crime = sanatorium.crimes.find(({ id }) => id === sanatoriumWorld.incident.templateId)!;

describe('plotPlanning', () => {
  test('lays template steps out in order inside the verified window', () => {
    const { plot } = plan(sanatoriumWorld);
    const { from, to } = plot.opportunity;
    expect(plot.incident.window).toEqual({ from, to });
    expect(verifyPlot(sanatoriumWorld, plot)).toEqual([]);
    const onScene = plot.steps.filter(({ acquire }) => !acquire);
    expect(onScene.map(({ id }) => id)).toEqual(
      crime.plan.filter(({ step }) => step !== 'acquire').map(({ step }) => step),
    );
    for (const { window } of onScene) {
      expect(window.from).toBeGreaterThanOrEqual(from);
      expect(window.to).toBeLessThanOrEqual(to);
    }
    expect(plot.incident.culpritIds).toEqual([sanatoriumWorld.incident.culpritId]);
    expect(plot.incident.victimIds).toEqual([sanatoriumWorld.incident.victimId]);
  });

  test('a schedule bend has one reason fact, at most two overrides and a covering interval', () => {
    for (let n = 0; n < 12; n++) {
      const world = trySelect(incidentInput(sanatorium, `bend-${n}`), sanatorium, `bend-${n}`);
      if (world instanceof GenerationRejection) continue;
      const { plot } = plan(world, sanatorium, `bend-${n}`);
      if (!plot.deviation) {
        expect(plot.overrides).toEqual([]);
        continue;
      }
      expect(plot.deviation.fact).toMatchObject({
        kind: 'state',
        property: 'schedule_deviation',
        value: plot.deviation.reason,
      });
      expect(plot.overrides.length).toBeLessThanOrEqual(2);
      expect(plot.deviation.interval.to).toBe(plot.opportunity.to);
    }
  });

  test('the planned alibi names another place than the scene', () => {
    const { plot } = plan(sanatoriumWorld);
    expect(plot.alibi.claimedLocationId).not.toBe(plot.opportunity.locationId);
    expect(plot.alibi.interval).toEqual(plot.incident.window);
  });

  test('is deterministic', () => {
    expect(plan(sanatoriumWorld).plot).toEqual(plan(sanatoriumWorld).plot);
  });

  test('verifyPlot reports an unreachable acquisition and an overlong step', () => {
    const { plot } = plan(sanatoriumWorld);
    const [first, ...rest] = plot.steps;
    const broken: PlotPlan = {
      ...plot,
      steps: [
        {
          ...first!,
          window: { from: first!.window.from, to: first!.window.from + 1 },
          duration: 5,
        },
        ...rest,
      ],
    };
    expect(verifyPlot(sanatoriumWorld, broken).length).toBeGreaterThan(0);
  });

  describe('verifyPlot rejects each kind of broken plan', () => {
    // A plan with an acquisition step and a schedule bend, so every check can be exercised.
    function fullPlan() {
      for (let n = 0; n < 60; n++) {
        const world = trySelect(incidentInput(sanatorium, `full-${n}`), sanatorium, `full-${n}`);
        if (world instanceof GenerationRejection) continue;
        const { plot } = plan(world, sanatorium, `full-${n}`);
        if (plot.opportunity.acquisition && plot.deviation && plot.steps.length >= 3) {
          return { world, plot };
        }
      }
      throw new Error('no seed with an acquisition, a bend and three steps');
    }
    const { world, plot } = fullPlan();
    const cases: Record<string, [RegExp, (p: PlotPlan) => PlotPlan]> = {
      'unknown location': [
        /unknown location/,
        (p) => ({
          ...p,
          steps: p.steps.map((s, i) => (i === 0 ? { ...s, locationId: 'nowhere' } : s)),
        }),
      ],
      'duration does not fit': [
        /does not fit/,
        (p) => ({
          ...p,
          steps: p.steps.map((s, i) =>
            i === 0
              ? { ...s, window: { from: s.window.from, to: s.window.from + 1 }, duration: 5 }
              : s,
          ),
        }),
      ],
      'step starts before the previous can end': [
        /starts before/,
        (p) => ({
          ...p,
          steps: p.steps.map((s, i) =>
            i === 1 ? { ...s, window: { from: p.steps[0]!.window.from, to: s.window.to } } : s,
          ),
        }),
      ],
      'scene step leaves the opportunity window': [
        /leaves the opportunity window/,
        (p) => ({
          ...p,
          steps: p.steps.map((s, i, all) =>
            i === all.length - 1
              ? { ...s, window: { from: s.window.from, to: p.opportunity.to + 10 } }
              : s,
          ),
        }),
      ],
      'acquisition is not a step': [
        /acquisition is not a step/,
        (p) => ({
          ...p,
          steps: p.steps.map((s) =>
            s.acquire ? { ...s, window: { from: s.window.from + 1, to: s.window.to + 1 } } : s,
          ),
        }),
      ],
      'incident window differs': [
        /incident window differs/,
        (p) => ({
          ...p,
          incident: {
            ...p.incident,
            window: { from: p.opportunity.from + 1, to: p.opportunity.to },
          },
        }),
      ],
      'bend does not cover the window': [
        /does not cover/,
        (p) => ({
          ...p,
          deviation: {
            ...p.deviation!,
            interval: { from: p.opportunity.from + 1, to: p.opportunity.to },
          },
        }),
      ],
      'arrives after the window start': [
        /after the window start/,
        (p) => ({
          ...p,
          opportunity: { ...p.opportunity, from: p.opportunity.acquisition!.at },
        }),
      ],
      'bend without overrides': [/needs 1 or 2 overrides/, (p) => ({ ...p, overrides: [] })],
      'override leaves the bend': [
        /override leaves/,
        (p) => ({
          ...p,
          overrides: p.overrides.map((o) => ({ ...o, characterId: 'someone_else' })),
        }),
      ],
      'overrides without a bend': [
        /overrides without a schedule bend/,
        (p) => ({ ...p, deviation: undefined }),
      ],
    };

    test('the unbroken plan has no problems', () => {
      expect(verifyPlot(world, plot)).toEqual([]);
    });
    test.each(Object.entries(cases))('%s', (_name, [message, break_]) => {
      const problems = verifyPlot(world, break_(plot));
      expect(problems.some((problem) => message.test(problem))).toBe(true);
    });
  });

  test('rejects the attempt when the opportunity is too short for the steps', () => {
    const { plot } = plan(sanatoriumWorld);
    const shortened = {
      ...sanatoriumWorld,
      incident: {
        ...sanatoriumWorld.incident,
        opportunities: sanatoriumWorld.incident.opportunities.map((o) => ({
          ...o,
          to: o.from + 1,
        })),
      },
    };
    expect(plot.steps.length).toBeGreaterThan(0);
    expect(() => plan(shortened)).toThrow(RangeError);
  });

  test('works on the minimal scenario', () => {
    const world = select(incidentInput(minimal, 'plot-min'), minimal, 'plot-min');
    const { plot } = plan(world, minimal, 'plot-min');
    expect(verifyPlot(world, plot)).toEqual([]);
  });
});
