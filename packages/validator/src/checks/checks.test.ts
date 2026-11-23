import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@hs/core/common';
import { serializeInvestigation } from '@hs/core/game';
import { LocationGraph } from '@hs/core/world';
import {
  MUTATIONS,
  TINY_MANOR_HISTORY_START,
  addLoneEvent,
  cleanInvestigation,
  replaceBursar,
  roundTripped,
  withCast,
} from '../../test/mutations.ts';
import type { ValidationContext } from '../check.ts';
import { validateInvestigation } from '../validate.ts';
import { DEFAULT_CHECKS } from './index.ts';

const context: ValidationContext = { historyStartMinutes: TINY_MANOR_HISTORY_START };
const validate = (investigation = cleanInvestigation(), ctx: ValidationContext = context) =>
  validateInvestigation(investigation, { checks: DEFAULT_CHECKS, context: ctx });

describe('an unbroken investigation', () => {
  it('passes every check', () => {
    const report = validate();
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map(({ id, passed }) => [id, passed])).toEqual([
      ['V-TRUTH-INV', true],
      ['V-TIMELINE', true],
    ]);
  });

  it('still passes after a save and restore', () => {
    expect(validate(roundTripped(cleanInvestigation())).ok).toBe(true);
  });

  it('is not modified by validation', () => {
    const investigation = cleanInvestigation();
    const before = serializeInvestigation(investigation);
    validate(investigation);
    expect(serializeInvestigation(investigation)).toBe(before);
  });

  it('gives the same report every time, in canonical JSON', () => {
    expect(canonicalJson(validate())).toBe(canonicalJson(validate()));
  });
});

describe('mutations are caught', () => {
  it.each(MUTATIONS.map((mutation) => [mutation.name, mutation] as const))(
    '%s',
    (_name, mutation) => {
      const report = validateInvestigation(mutation.make(cleanInvestigation()), {
        checks: DEFAULT_CHECKS,
        context: mutation.context ?? {},
      });

      expect(report.ok).toBe(false);
      const found = report.findings.filter(
        ({ checkId, code }) => checkId === mutation.check && code === mutation.code,
      );
      expect(found.length, `${mutation.check} ${mutation.code}`).toBeGreaterThan(0);
      for (const finding of found) {
        expect(finding.severity).toBe('error');
        expect(finding.message.length).toBeGreaterThan(10);
        if (mutation.linksEvents) expect(finding.eventIds.length).toBeGreaterThan(0);
      }
      const owner = report.checks.find(({ id }) => id === mutation.check);
      expect(owner?.passed).toBe(false);
    },
  );

  it('each mutation breaks only the check it is meant for', () => {
    for (const mutation of MUTATIONS) {
      const report = validateInvestigation(mutation.make(cleanInvestigation()), {
        checks: DEFAULT_CHECKS,
        context: mutation.context ?? {},
      });
      const others = report.findings.filter(({ checkId }) => checkId !== mutation.check);
      expect(others, mutation.name).toEqual([]);
    }
  });

  it('covers every code the two checks can report', () => {
    const covered = new Set(MUTATIONS.map(({ code }) => code));
    for (const code of [
      'PRESENCE_OVERLAP',
      'TRAVEL_TOO_FAST',
      'CAUSE_NOT_BEFORE_EFFECT',
      'ITEM_HOLDER_OVERLAP',
      'ACTION_AFTER_DEATH',
      'KEY_EVENT_WITHOUT_CULPRIT',
      'TIMELINE_EVENT_AFTER_END',
      'TIMELINE_EVENT_BEFORE_HISTORY',
      'TIMELINE_INCIDENT_WINDOW_AFTER_END',
      'TIMELINE_INCIDENT_WINDOW_BEFORE_HISTORY',
      'CHAR_SCHEDULE_GAP',
      'CHAR_SCHEDULE_OVERLAP',
      'CHAR_INVALID_SCHEDULE',
      'TIMELINE_ROUTINE_UNREACHABLE',
      'TIMELINE_ROUTINE_UNKNOWN_LOCATION',
    ]) {
      expect(covered.has(code), code).toBe(true);
    }
  });
});

describe('V-TRUTH-INV', () => {
  it('names the invariant that was broken', () => {
    const mutation = MUTATIONS.find(({ code }) => code === 'TRAVEL_TOO_FAST');
    const report = validateInvestigation(
      mutation?.make(cleanInvestigation()) ?? cleanInvestigation(),
      {
        checks: DEFAULT_CHECKS,
      },
    );
    expect(report.findings.find(({ code }) => code === 'TRAVEL_TOO_FAST')?.data).toEqual({
      invariant: 2,
    });
  });
});

describe('V-TIMELINE', () => {
  it('skips the prehistory bound when the caller does not say where the prehistory starts', () => {
    const mutation = MUTATIONS.find(({ code }) => code === 'TIMELINE_EVENT_BEFORE_HISTORY');
    const broken = mutation?.make(cleanInvestigation()) ?? cleanInvestigation();
    expect(validate(broken, {}).ok).toBe(true);
    expect(validate(broken, context).ok).toBe(false);
  });

  it.each<[string, number, number, string[]]>([
    ['ends exactly when the scenario does', 1435, 5, []],
    ['ends one minute after the scenario', 1435, 6, ['TIMELINE_EVENT_AFTER_END']],
    ['an instant event at the very end', 1440, 0, []],
    ['an instant event after the end', 1441, 0, ['TIMELINE_EVENT_AFTER_END']],
    ['starts exactly where the prehistory starts', -60, 1, []],
    ['starts one minute before the prehistory', -61, 1, ['TIMELINE_EVENT_BEFORE_HISTORY']],
  ])('an event that %s', (_name, t, duration, codes) => {
    const report = validate(addLoneEvent(cleanInvestigation(), t, duration));
    expect(report.findings.map(({ code }) => code)).toEqual(codes);
  });

  it('links the finding to the event and gives its minute', () => {
    const report = validate(addLoneEvent(cleanInvestigation(), 1439, 5));
    expect(report.findings[0]).toMatchObject({ eventIds: ['ev_9'], minute: 1439 });
  });

  it("does not repeat invariant 2: a too-fast move is only V-TRUTH-INV's finding", () => {
    const fast = MUTATIONS.find(({ code }) => code === 'TRAVEL_TOO_FAST');
    const report = validate(fast?.make(cleanInvestigation()));
    expect(report.findings.every(({ checkId }) => checkId === 'V-TRUTH-INV')).toBe(true);
  });

  describe('routines', () => {
    const home = 'loc_pantry';
    const bursarRoutines = (routine: Parameters<typeof replaceBursar>[1]) =>
      validate(withCast(cleanInvestigation(), replaceBursar(cleanInvestigation(), routine)));

    it('accepts an overnight block that wraps around midnight', () => {
      const report = bursarRoutines([
        { from: 1380, to: 300, location: home, activity: 'rest', flexibility: 0.2 },
        { from: 300, to: 1380, location: 'loc_hall', activity: 'bursar', flexibility: 0.4 },
      ]);
      expect(report.findings).toEqual([]);
    });

    it('accepts a route through a locked door, because the character may hold its key', () => {
      const report = bursarRoutines([
        { from: 0, to: 720, location: 'loc_hall', activity: 'rest', flexibility: 0.2 },
        { from: 720, to: 1440, location: 'loc_archive', activity: 'bursar', flexibility: 0.4 },
      ]);
      expect(report.findings).toEqual([]);
    });

    it('rejects a route behind a door that no key opens, once per direction', () => {
      const base = cleanInvestigation();
      const { locations, startDateTime } = base.world.locations.snapshot();
      const sealed = locations.map((location) =>
        location.id === 'loc_pantry'
          ? { ...location, connections: [{ to: 'loc_hall', minutes: 2, locked: {} }] }
          : location,
      );
      const world = {
        ...base.world,
        locations: new LocationGraph({ locations: sealed, preset: { time: { startDateTime } } }),
      };
      const routine = [
        { from: 0, to: 360, location: 'loc_hall', activity: 'rest', flexibility: 0.2 },
        { from: 360, to: 720, location: 'loc_pantry', activity: 'bursar', flexibility: 0.4 },
        { from: 720, to: 1080, location: 'loc_hall', activity: 'bursar', flexibility: 0.4 },
        { from: 1080, to: 1440, location: 'loc_pantry', activity: 'bursar', flexibility: 0.4 },
      ];
      const report = validate(withCast(base, replaceBursar(base, routine), world));
      // pantry -> hall is sealed; hall -> pantry is fine. The pair repeats but is reported once.
      expect(report.findings.map(({ code }) => code)).toEqual(['TIMELINE_ROUTINE_UNREACHABLE']);
    });

    it('checks the move from the last block back to the first, across midnight', () => {
      const base = cleanInvestigation();
      const { locations, startDateTime } = base.world.locations.snapshot();
      const sealed = locations.map((location) =>
        location.id === 'loc_pantry'
          ? { ...location, connections: [{ to: 'loc_hall', minutes: 2, locked: {} }] }
          : location,
      );
      const world = {
        ...base.world,
        locations: new LocationGraph({ locations: sealed, preset: { time: { startDateTime } } }),
      };
      // hall -> pantry is open, but the day ends in the pantry and starts again in the hall.
      const routine = [
        { from: 0, to: 720, location: 'loc_hall', activity: 'rest', flexibility: 0.2 },
        { from: 720, to: 1440, location: 'loc_pantry', activity: 'bursar', flexibility: 0.4 },
      ];
      const report = validate(withCast(base, replaceBursar(base, routine), world));
      expect(report.findings.map(({ code }) => code)).toEqual(['TIMELINE_ROUTINE_UNREACHABLE']);
      expect(report.findings[0]?.data).toEqual({ minuteOfDay: 0 });
    });

    it('a character who stays put never needs a route', () => {
      const report = bursarRoutines([
        { from: 0, to: 600, location: 'loc_hall', activity: 'rest', flexibility: 0.2 },
        { from: 600, to: 1440, location: 'loc_hall', activity: 'bursar', flexibility: 0.4 },
      ]);
      expect(report.findings).toEqual([]);
    });

    it('names the character and the minute of the day', () => {
      const gap = MUTATIONS.find(({ code }) => code === 'CHAR_SCHEDULE_GAP');
      const finding = validate(gap?.make(cleanInvestigation())).findings[0];
      expect(finding).toMatchObject({
        subject: { kind: 'character', id: 'ch_bursar' },
        data: { minuteOfDay: 420 },
      });
    });
  });

  it('reports a broken routine once and does not also check its moves', () => {
    const gap = MUTATIONS.find(({ code }) => code === 'CHAR_SCHEDULE_GAP');
    const report = validate(gap?.make(cleanInvestigation()));
    expect(report.findings.filter(({ checkId }) => checkId === 'V-TIMELINE')).toHaveLength(1);
  });
});
