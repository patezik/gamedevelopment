import { Scheduler, TickPhase, type ScheduledEvent } from '@hs/core/time';
import fc from 'fast-check';
import { expect, test } from 'vitest';

const phase = fc.constantFrom(...Object.values(TickPhase));
const spec = fc.record({
  at: fc.integer({ min: 0, max: 40 }),
  phase,
  priority: fc.integer({ min: -2, max: 2 }),
});
const toEvent = (s: { at: number; phase: TickPhase; priority: number }, kind = 'e') => ({
  ...s,
  kind,
  payload: null,
});

type Op =
  | { op: 'schedule'; spec: { at: number; phase: TickPhase; priority: number } }
  | { op: 'cancel'; pick: number }
  | { op: 'pop'; until: number };
const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: spec.map((s): Op => ({ op: 'schedule', spec: s })) },
  { weight: 2, arbitrary: fc.nat(50).map((pick): Op => ({ op: 'cancel', pick })) },
  {
    weight: 2,
    arbitrary: fc.integer({ min: 0, max: 40 }).map((until): Op => ({ op: 'pop', until })),
  },
);

/** Slow but obviously correct: a flat list, minimum found by scanning. */
class Model {
  pending: { id: string; seq: number; at: number; phase: number; priority: number }[] = [];
  seq = 0;
  schedule(s: { at: number; phase: number; priority: number }): string {
    const seq = this.seq++;
    const id = `evt_${seq}`;
    this.pending.push({ id, seq, ...s });
    return id;
  }
  cancel(id: string): boolean {
    const before = this.pending.length;
    this.pending = this.pending.filter((e) => e.id !== id);
    return this.pending.length < before;
  }
  popNext(until: number): string | undefined {
    const best = [...this.pending].sort(
      (a, b) => a.at - b.at || a.phase - b.phase || a.priority - b.priority || a.seq - b.seq,
    )[0];
    if (!best || best.at > until) return undefined;
    this.cancel(best.id);
    return best.id;
  }
}

test('behaves like a naive sorted list under any mix of schedule, cancel and pop', () => {
  fc.assert(
    fc.property(fc.array(op, { maxLength: 80 }), (ops) => {
      const scheduler = new Scheduler();
      const model = new Model();
      const ids: string[] = [];
      let now = 0;

      for (const step of ops) {
        if (step.op === 'schedule') {
          const s = { ...step.spec, at: Math.max(step.spec.at, now) }; // never in the past
          const id = scheduler.schedule(toEvent(s));
          expect(id).toBe(model.schedule(s));
          ids.push(id);
        } else if (step.op === 'cancel') {
          const id = ids[step.pick % Math.max(ids.length, 1)] ?? 'evt_none';
          expect(scheduler.cancel(id)).toBe(model.cancel(id));
        } else {
          const got = scheduler.popNext(step.until)?.id;
          expect(got).toBe(model.popNext(step.until));
          if (got !== undefined) now = scheduler.now;
        }
        expect(scheduler.size).toBe(model.pending.length);
      }
    }),
    { seed: 42, numRuns: 300 },
  );
});

test('popDue returns exactly the due events in non-decreasing key order', () => {
  fc.assert(
    fc.property(fc.array(spec, { maxLength: 60 }), fc.integer({ min: 0, max: 40 }), (specs, t) => {
      const scheduler = new Scheduler();
      const ids = specs.map((s) => scheduler.schedule(toEvent(s)));

      const due = scheduler.popDue(t);

      // The key is unique (seq), so consecutive events must be strictly increasing.
      const key = (e: ScheduledEvent): number[] => [
        e.at,
        e.phase,
        e.priority,
        Number(e.id.slice(4)),
      ];
      const before = (x: number[], y: number[]): boolean => {
        const i = x.findIndex((value, k) => value !== y[k]);
        return i !== -1 && (x[i] as number) < (y[i] as number);
      };
      for (let i = 1; i < due.length; i++) {
        expect(before(key(due[i - 1] as ScheduledEvent), key(due[i] as ScheduledEvent))).toBe(true);
      }
      const expectedIds = ids.filter((_, i) => (specs[i] as { at: number }).at <= t);
      expect([...due.map((e) => e.id)].sort()).toEqual([...expectedIds].sort());
      expect(scheduler.size).toBe(specs.length - expectedIds.length);
    }),
    { seed: 42 },
  );
});

test('a snapshot taken at any point replays the same remaining order', () => {
  fc.assert(
    fc.property(
      fc.array(spec, { maxLength: 60 }),
      fc.integer({ min: 0, max: 40 }),
      fc.array(spec, { maxLength: 10 }),
      (specs, cut, extra) => {
        const original = new Scheduler();
        for (const s of specs) original.schedule(toEvent(s));
        original.popDue(cut);

        const restored = Scheduler.restore(original.serialize());
        for (const s of extra) {
          const at = Math.max(s.at, cut);
          expect(restored.schedule(toEvent({ ...s, at }))).toBe(
            original.schedule(toEvent({ ...s, at })),
          );
        }
        expect(restored.popDue(1000)).toEqual(original.popDue(1000));
      },
    ),
    { seed: 42 },
  );
});
