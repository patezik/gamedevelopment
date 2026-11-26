import { describe, expect, test } from 'vitest';
import { tinyManor } from '../../test/fixtures/tiny-manor.ts';
import { GameEngine, type EnginePorts } from './engine.ts';
import { BODY_HOTSPOT_ID } from './body.ts';

const DEATH_AT = 30;
const plain: EnginePorts = { startLocationId: 'loc_hall' };
const withStatic: EnginePorts = { ...plain, static: {} };
const body = { type: 'examineHotspot', hotspotId: BODY_HOTSPOT_ID } as const;
const hasBody = (engine: GameEngine) =>
  engine.playerView().location.hotspots.some(({ id }) => id === BODY_HOTSPOT_ID);
const setUp = (ports: EnginePorts = withStatic, deathAt?: number) => {
  const investigation = tinyManor('tiny-manor-fixture', [], deathAt);
  const engine = GameEngine.create(investigation, ports);
  expect(engine.dispatch('desktop', { type: 'examineLocation' }).ok).toBe(true);
  return { engine, investigation };
};
const waitUntil = (engine: GameEngine, minute: number) =>
  engine.dispatch('desktop', { type: 'wait', minutes: minute - engine.playerView().clock.t });
const types = (result: ReturnType<GameEngine['dispatch']>) =>
  result.ok ? result.events.map(({ type }) => type) : [];

describe('finding the body (ENG-010, OQ-28 option B)', () => {
  test('the body point appears only after the death minute and leaks nothing', () => {
    const { engine } = setUp(withStatic, DEATH_AT);
    expect(hasBody(engine)).toBe(false);
    expect(engine.dispatch('desktop', body)).toMatchObject({ ok: false });
    waitUntil(engine, DEATH_AT);
    expect(hasBody(engine)).toBe(true);
    const view = JSON.stringify(engine.playerView());
    for (const word of ['culprit', 'veracity', 'hallucination', 'truth']) {
      expect(view).not.toContain(word);
    }
  });

  test('inspecting it gives Static +5 and sanity -2 in the same minute, once', () => {
    const { engine } = setUp(withStatic, DEATH_AT);
    waitUntil(engine, DEATH_AT);
    const sanity = engine.playerView().vitals.sanity;
    const before = engine.staticLevel();
    const result = engine.dispatch('desktop', body);
    if (!result.ok) throw new Error(result.error);
    const at = engine.playerView().clock.t;
    expect(result.events).toContainEqual({ type: 'BodyFound', locationId: 'loc_hall', at });
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'StaticChanged', cause: 'gruesomeFind', at }),
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'VitalsChanged', cause: 'gruesomeFind', at }),
    );
    expect(engine.staticLevel()).toBe(before + 5);
    expect(engine.playerView().vitals.sanity).toBe(sanity - 2);
    expect(types(engine.dispatch('desktop', body))).not.toContain('BodyFound');
    expect(engine.staticLevel()).toBe(before + 5);
    expect(engine.playerView().vitals.sanity).toBe(sanity - 2);
  });

  test('being in the location does not trigger it; a game without a death has no body', () => {
    const { engine } = setUp(withStatic, DEATH_AT);
    waitUntil(engine, DEATH_AT + 5);
    expect(engine.staticLevel()).toBe(0);
    expect(engine.playerView().vitals.sanity).toBe(10);
    expect(hasBody(setUp(withStatic).engine)).toBe(false);
  });

  test('without ports.static only the sanity cost applies; a restore keeps it once', () => {
    const { engine, investigation } = setUp(plain, DEATH_AT);
    waitUntil(engine, DEATH_AT);
    engine.dispatch('desktop', body);
    expect(engine.playerView().vitals.sanity).toBe(8);
    const restored = GameEngine.restore(engine.snapshot(), investigation, plain);
    expect(restored.stateHash()).toBe(engine.stateHash());
    expect(types(restored.dispatch('desktop', body))).not.toContain('BodyFound');
    expect(restored.playerView().vitals.sanity).toBe(8);
  });
});
