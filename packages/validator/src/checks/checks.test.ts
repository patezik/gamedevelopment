import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@hs/core/common';
import { serializeInvestigation } from '@hs/core/game';
import { LocationGraph } from '@hs/core/world';
import {
  CLEAN_CLUES,
  MUTATIONS,
  addLoneEvent,
  cleanContext,
  cleanInvestigation,
  clue,
  replaceBursar,
  roundTripped,
  withCast,
} from '../../test/mutations.ts';
import type { ValidationContext } from '../check.ts';
import { validateInvestigation } from '../validate.ts';
import { DEFAULT_CHECKS, investigationHash } from './index.ts';

const context: ValidationContext = cleanContext();
/** By default the "second generation" is the very investigation under test. */
const validate = (investigation = cleanInvestigation(), ctx: ValidationContext = context) =>
  validateInvestigation(investigation, {
    checks: DEFAULT_CHECKS,
    context: { regenerate: () => investigation, ...ctx },
  });

describe('an unbroken investigation', () => {
  it('passes every check', () => {
    const report = validate();
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map(({ id, passed }) => [id, passed])).toEqual([
      ['V-TRUTH-INV', true],
      ['V-TIMELINE', true],
      ['V-PHONE-REQUIRED', true],
      ['V-DETERMINISM', true],
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
      const report = validate(mutation.make(cleanInvestigation()), {
        ...context,
        ...mutation.context,
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
      const report = validate(mutation.make(cleanInvestigation()), {
        ...context,
        ...mutation.context,
      });
      const others = report.findings.filter(({ checkId }) => checkId !== mutation.check);
      expect(others, mutation.name).toEqual([]);
    }
  });

  it('covers every code the checks can report', () => {
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
      'PHONE_QR_SHARE_TOO_LOW',
      'PHONE_UNKNOWN_REQUIRED_CLUE',
      'PHONE_NO_REQUIRED_CLUES',
      'PHONE_INVALID_MIN_SHARE',
      'DETERMINISM_HASH_MISMATCH',
      'DETERMINISM_REGENERATION_FAILED',
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
    const noHistory: ValidationContext = Object.fromEntries(
      Object.entries(context).filter(([key]) => key !== 'historyStartMinutes'),
    );
    expect(validate(broken, noHistory).ok).toBe(true);
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

    it('rejects an unknown location even when the character stays there all day', () => {
      const report = bursarRoutines([
        { from: 0, to: 1440, location: 'loc_missing', activity: 'wait', flexibility: 0 },
      ]);
      expect(report.findings).toContainEqual(
        expect.objectContaining({ code: 'TIMELINE_ROUTINE_UNKNOWN_LOCATION' }),
      );
    });

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

describe('V-PHONE-REQUIRED', () => {
  const phone = (ctx: ValidationContext) =>
    validate(cleanInvestigation(), { ...context, ...ctx }).findings.map(({ code }) => code);
  const withQr = (total: number, qr: number) =>
    Array.from({ length: total }, (_, i) => clue(`c${i}`, i < qr ? 'qr' : 'auto'));
  const share = (total: number, qr: number, minQrShare = 0.3) => {
    const clues = withQr(total, qr);
    return phone({ clues, requiredClueIds: clues.map(({ id }) => id), minQrShare });
  };

  it.each<[string, number, number, string[]]>([
    ['exactly 30 %: 3 of 10', 10, 3, []],
    ['just below 30 %: 2 of 7', 7, 2, ['PHONE_QR_SHARE_TOO_LOW']],
    ['just above 30 %: 3 of 9', 9, 3, []],
    ['none by QR', 4, 0, ['PHONE_QR_SHARE_TOO_LOW']],
    ['all by QR', 4, 4, []],
    ['one clue by QR', 1, 1, []],
    ['one clue not by QR', 1, 0, ['PHONE_QR_SHARE_TOO_LOW']],
  ])('%s', (_name, total, qr, codes) => {
    expect(share(total, qr)).toEqual(codes);
  });

  it('counts only mandatory clues: QR clues that are optional do not help', () => {
    const clues = [...withQr(5, 0), clue('optional', 'qr')];
    expect(phone({ clues, requiredClueIds: ['c0', 'c1', 'c2', 'c3', 'c4'] })).toEqual([
      'PHONE_QR_SHARE_TOO_LOW',
    ]);
  });

  it('counts a repeated id once', () => {
    const clues = withQr(2, 1);
    const requiredClueIds = ['c0', 'c0', 'c0', 'c1'];
    expect(phone({ clues, requiredClueIds, minQrShare: 0.5 })).toEqual([]);
    expect(phone({ clues, requiredClueIds, minQrShare: 0.6 })).toEqual(['PHONE_QR_SHARE_TOO_LOW']);
  });

  it('with no mandatory clues passes only when no share is demanded', () => {
    expect(phone({ requiredClueIds: [], minQrShare: 0 })).toEqual([]);
    expect(phone({ requiredClueIds: [], minQrShare: 0.3 })).toEqual(['PHONE_NO_REQUIRED_CLUES']);
    expect(phone({ clues: [], requiredClueIds: [], minQrShare: 0.3 })).toEqual([
      'PHONE_NO_REQUIRED_CLUES',
    ]);
  });

  it('accepts the limits of minQrShare and rejects values outside them', () => {
    expect(share(4, 0, 0)).toEqual([]);
    expect(share(4, 4, 1)).toEqual([]);
    expect(share(4, 3, 1)).toEqual(['PHONE_QR_SHARE_TOO_LOW']);
    for (const bad of [-0.1, 1.01, Number.NaN, Infinity]) {
      expect(share(4, 4, bad), String(bad)).toEqual(['PHONE_INVALID_MIN_SHARE']);
    }
  });

  it('reports every unknown mandatory clue', () => {
    expect(phone({ requiredClueIds: ['x', 'y', 'cl_1'] })).toEqual([
      'PHONE_UNKNOWN_REQUIRED_CLUE',
      'PHONE_UNKNOWN_REQUIRED_CLUE',
    ]);
  });

  it('fails, rather than passes, when the context lacks its inputs', () => {
    for (const missing of ['clues', 'requiredClueIds', 'minQrShare'] as const) {
      const report = validate(cleanInvestigation(), { ...context, [missing]: undefined });
      expect(
        report.findings.map(({ code }) => code),
        missing,
      ).toEqual(['PHONE_INPUT_MISSING']);
    }
  });

  it('reports the numbers and links the event of a mandatory clue', () => {
    const clues = withQr(5, 1);
    const report = validate(cleanInvestigation(), {
      ...context,
      clues,
      requiredClueIds: clues.map(({ id }) => id),
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      severity: 'error',
      code: 'PHONE_QR_SHARE_TOO_LOW',
      eventIds: ['ev_1'],
      data: { qr: 1, required: 5, minQrShare: 0.3 },
    });
  });

  it('does not depend on the order of the mandatory ids', () => {
    const ids = CLEAN_CLUES.map(({ id }) => id).reverse();
    expect(phone({ requiredClueIds: ids })).toEqual([]);
  });
});

describe('V-DETERMINISM', () => {
  const determinism = (regenerate?: () => ReturnType<typeof cleanInvestigation>) =>
    validateInvestigation(cleanInvestigation(), {
      checks: DEFAULT_CHECKS,
      context: regenerate ? { ...context, regenerate } : context,
    });

  it('passes when the second generation is a save/restore copy', () => {
    expect(determinism(() => roundTripped(cleanInvestigation())).findings).toEqual([]);
  });

  it('fails on the smallest difference, and names both hashes', () => {
    const report = determinism(() => addLoneEvent(cleanInvestigation(), 100, 0));
    expect(report.findings).toHaveLength(1);
    const [finding] = report.findings;
    expect(finding).toMatchObject({ code: 'DETERMINISM_HASH_MISMATCH', severity: 'error' });
    expect(finding?.data?.first).toBe(investigationHash(cleanInvestigation()));
    expect(finding?.data?.second).not.toBe(finding?.data?.first);
  });

  it('fails when the second generation throws, with the reason', () => {
    const report = determinism(() => {
      throw new Error('boom');
    });
    expect(report.findings.map(({ code }) => code)).toEqual(['DETERMINISM_REGENERATION_FAILED']);
    expect(report.findings[0]?.message).toContain('boom');
  });

  it('fails, rather than passes, without regenerate', () => {
    expect(determinism(undefined).findings.map(({ code }) => code)).toEqual([
      'DETERMINISM_INPUT_MISSING',
    ]);
  });

  it('calls regenerate once and does not modify the investigation', () => {
    let calls = 0;
    const investigation = cleanInvestigation();
    const before = serializeInvestigation(investigation);
    validate(investigation, {
      ...context,
      regenerate: () => (calls++, cleanInvestigation()),
    });
    expect(calls).toBe(1);
    expect(serializeInvestigation(investigation)).toBe(before);
  });

  it('hashes equal investigations equally, as 64 hex characters', () => {
    expect(investigationHash(cleanInvestigation())).toMatch(/^[0-9a-f]{64}$/);
    expect(investigationHash(cleanInvestigation())).toBe(investigationHash(cleanInvestigation()));
  });
});
