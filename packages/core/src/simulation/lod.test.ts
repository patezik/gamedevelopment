import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkTruthInvariants } from '../truth/index.ts';
import { createSimWorld, roomIds } from '../../test/fixtures/sim-world.ts';
import { FOCUS_STEP_MINUTES, SimulationLod } from './index.ts';

const day = 1440;

function lodFor(options: ConstructorParameters<typeof SimulationLod>[1] = {}) {
  const { world } = createSimWorld({ endAt: day });
  return new SimulationLod(world, options);
}

describe('SimulationLod', () => {
  it('is background until a focus is set, then focus in and next to the focus location', () => {
    const lod = lodFor();
    expect(lod.level('ch_0', roomIds[0]!, 0)).toBe('background');
    lod.setFocus(roomIds[0]!);
    expect(lod.level('ch_0', roomIds[0]!, 0)).toBe('focus');
    expect(lod.level('ch_0', roomIds[1]!, 0)).toBe('focus');
    expect(lod.level('ch_0', roomIds[7]!, 0)).toBe('focus');
    expect(lod.level('ch_0', roomIds[4]!, 0)).toBe('background');
    expect(() => lod.setFocus('loc_nowhere')).toThrow(RangeError);
  });

  it('keeps story-active agents in focus anywhere', () => {
    const lod = lodFor({ storyActive: (id, minute) => id === 'ch_1' && minute >= 100 });
    lod.setFocus(roomIds[0]!);
    expect(lod.level('ch_1', roomIds[4]!, 99)).toBe('background');
    expect(lod.level('ch_1', roomIds[4]!, 100)).toBe('focus');
    const levels = lod.classify(
      [
        { id: 'ch_2', location: roomIds[4]! },
        { id: 'ch_1', location: roomIds[4]! },
      ],
      100,
    );
    expect([...levels]).toEqual([
      ['ch_1', 'focus'],
      ['ch_2', 'background'],
    ]);
  });
});

function run(lodSetup: (lod: SimulationLod) => void, segments: number[]) {
  const lod = lodFor();
  const sim = createSimWorld({ endAt: day, lod });
  const world = sim;
  const startFocus = lodSetup;
  startFocus(lod);
  let at = 0;
  for (const [index, length] of segments.entries()) {
    at = Math.min(day, at + length);
    sim.time.advance(at - sim.time.now());
    lod.setFocus(roomIds[(index * 3) % roomIds.length]!);
  }
  sim.time.advance(day - sim.time.now());
  return world;
}

describe('runner with LOD', () => {
  it('splits a focus agent into steps of at most 5 minutes and leaves background agents whole', () => {
    const lod = lodFor();
    lod.setFocus(roomIds[0]!);
    const { time, truth, characters } = createSimWorld({ endAt: day, lod });
    time.advance(day);
    const stays = (id: string) =>
      truth
        .facts({ kind: 'at' })
        .flatMap((fact) => (fact.kind === 'at' && fact.who === id ? [fact.interval] : []));
    // ch_0 sleeps in room 0 (the focus): short steps. ch_4 starts in room 4: one block.
    const near = stays(characters[0]!.id).filter(({ from }) => from < 100);
    expect(near.length).toBeGreaterThan(10);
    for (const { from, to } of near) expect(to - from).toBeLessThanOrEqual(FOCUS_STEP_MINUTES);
    const far = stays(characters[4]!.id).filter(({ from }) => from === 0);
    expect(far).toEqual([{ from: 0, to: 360 }]);
  });

  it('records the same positions as a run without LOD', () => {
    const plain = createSimWorld({ endAt: day });
    plain.time.advance(day);
    const detailed = run((lod) => lod.setFocus(roomIds[0]!), [200, 300, 400]);
    for (const { id } of detailed.characters) {
      for (let t = 0; t < day; t += 7) {
        expect(detailed.truth.whereWas(id, t)).toBe(plain.truth.whereWas(id, t));
      }
    }
  });

  it('keeps truth invariants for any sequence of focus changes (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 400 }), { maxLength: 8 }),
        fc.integer({ min: 0, max: roomIds.length - 1 }),
        (segments, first) => {
          const sim = run((lod) => lod.setFocus(roomIds[first]!), segments);
          expect(sim.truth.events().length).toBeGreaterThan(0);
          expect(
            checkTruthInvariants(sim.truth, { locations: sim.world, items: sim.items }),
          ).toEqual([]);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('is deterministic for the same focus sequence', () => {
    const a = run((lod) => lod.setFocus(roomIds[2]!), [90, 250, 10]);
    const b = run((lod) => lod.setFocus(roomIds[2]!), [90, 250, 10]);
    expect(JSON.stringify(a.truth.events())).toBe(JSON.stringify(b.truth.events()));
  });
});
