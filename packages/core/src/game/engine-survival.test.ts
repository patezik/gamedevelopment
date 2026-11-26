import { describe, expect, test } from 'vitest';
import { tinyManor } from '../../test/fixtures/tiny-manor.ts';
import { fileURLToPath } from 'node:url';
import { loadScenarioFromDir } from '../content/index.ts';
import { compileTraceRules } from '../evidence/index.ts';
import { createPhoneState } from '../phone/index.ts';
import { GameEngine, type DispatchResult, type EnginePorts, type GameSnapshot } from './engine.ts';
import {
  deserializeInvestigation,
  serializeInvestigation,
  type Investigation,
} from './investigation.ts';

const base: EnginePorts = { startLocationId: 'loc_hall' };
const wait = (engine: GameEngine, minutes = 15): DispatchResult =>
  engine.dispatch('desktop', { type: 'wait', minutes });
const waitUntil = (engine: GameEngine, minute: number): DispatchResult[] => {
  const results: DispatchResult[] = [];
  while (engine.snapshot().minute < minute) {
    results.push(wait(engine, 15));
    if (!results.at(-1)?.ok)
      throw new Error(`stopped at ${engine.snapshot().minute}: ${JSON.stringify(results.at(-1))}`);
  }
  return results;
};

describe('phone hallucinations in the engine (ENG-010, SURV-005)', () => {
  const pool = {
    messages: ['It is behind the door.'],
    notifications: ['Do not look.'],
    photos: [{ imageRef: 'img_static_1', title: 'Photo' }],
  };
  const shaken = { health: 10, sanity: 1, fatigue: 0 };
  const ports: EnginePorts = {
    ...base,
    startVitals: shaken,
    phone: { initial: createPhoneState() },
    hallucinations: { pool },
  };
  const items = (engine: GameEngine): string => JSON.stringify(engine.phoneView());
  const ids = (engine: GameEngine): string[] => items(engine).match(/ev_\d+_[0-9a-f]+/g) ?? [];

  test('are rolled by the clock when sanity is low and look like ordinary phone items', () => {
    const engine = GameEngine.create(tinyManor(), ports);
    const events = waitHours(engine, 6);
    expect(ids(engine).length).toBeGreaterThan(0);
    expect(events.some(({ type }) => type === 'CallMissed' || type === 'MessageReceived')).toBe(
      true,
    );
    // No flag or marker in what the client gets.
    expect(items(engine)).not.toMatch(/hallucinat/i);
    expect(JSON.stringify(engine.playerView())).not.toMatch(/hallucinat/i);
  });

  test('are not rolled while the mind is steady, or without the port', () => {
    const steady = GameEngine.create(tinyManor(), {
      ...ports,
      startVitals: { health: 10, sanity: 10, fatigue: 0 },
    });
    waitHours(steady, 6);
    expect(ids(steady)).toEqual([]);
    const off = GameEngine.create(tinyManor(), {
      ...base,
      startVitals: shaken,
      phone: { initial: createPhoneState() },
    });
    waitHours(off, 6);
    expect(ids(off)).toEqual([]);
  });

  test('high Static alone produces them', () => {
    const engine = GameEngine.create(tinyManor(), {
      ...ports,
      startVitals: { health: 10, sanity: 10, fatigue: 0 },
      static: { start: 80 },
    });
    waitHours(engine, 6);
    expect(ids(engine).length).toBeGreaterThan(0);
  });

  test('rest clears them and keeps the real items', () => {
    const engine = GameEngine.create(tinyManor(), {
      ...ports,
      phone: {
        initial: createPhoneState({
          notifications: [
            { id: 'real_1', appId: 'messages', title: 'Real', text: 'Hello', at: 0, read: false },
          ],
        }),
      },
    });
    waitHours(engine, 6);
    expect(ids(engine).length).toBeGreaterThan(0);
    expect(engine.dispatch('desktop', { type: 'rest', minutes: 60 }).ok).toBe(true);
    expect(ids(engine)).toEqual([]);
    expect(items(engine)).toContain('real_1');
  });

  test('the same game gives the same hallucinations, also after a restore', () => {
    const investigation = tinyManor();
    const a = GameEngine.create(investigation, ports);
    waitHours(a, 3);
    const saved = JSON.parse(JSON.stringify(a.snapshot())) as GameSnapshot;
    const b = GameEngine.restore(saved, investigation, ports);
    expect(b.stateHash()).toBe(a.stateHash());
    waitHours(a, 4);
    waitHours(b, 4);
    expect(b.stateHash()).toBe(a.stateHash());
    expect(ids(b)).toEqual(ids(a));
    const twin = GameEngine.create(investigation, ports);
    waitHours(twin, 7);
    expect(twin.stateHash()).toBe(a.stateHash());
  });
});

function waitHours(engine: GameEngine, hours: number) {
  return Array.from({ length: hours * 4 }, () => wait(engine)).flatMap(({ events }) => events);
}

/**
 * The bursar (the culprit) spends the day in the hall; everyone else is in the pantry, so the
 * hero, who starts in the hall, is alone with the culprit once the hall is dark at night.
 */
function manorWithCulpritInHall(witness?: string): Investigation {
  const snapshot = JSON.parse(serializeInvestigation(tinyManor())) as {
    characters: { id: string; routine: unknown }[];
  };
  for (const character of snapshot.characters) {
    const location =
      character.id === 'ch_bursar' || character.id === witness ? 'loc_hall' : 'loc_pantry';
    character.routine = [{ from: 0, to: 1440, location, activity: 'stay', flexibility: 0.2 }];
  }
  return deserializeInvestigation(JSON.stringify(snapshot));
}

const minimal = loadScenarioFromDir(
  fileURLToPath(new URL('../../../../content/scenarios/_test_minimal', import.meta.url)),
);
const attackRules = compileTraceRules([
  ...minimal.traceRules,
  {
    verb: 'attack',
    produces: [
      {
        kind: 'physical',
        at: '$location',
        template: 'struggle_marks',
        supports: ['presence($actor,$location,$t)'],
      },
    ],
  },
]);

const NIGHT = 22 * 60 - 8 * 60;

describe('reactions and the culprit in the engine (ENG-010, SIM-006, SURV-003)', () => {
  const traces: unknown[] = [];
  const reactions = {
    topicSensitivity: (id: string) => (id === 'ch_bursar' ? 1 : 0),
    closeTo: () => [],
  };
  const ports: EnginePorts = {
    ...base,
    npcSimulation: true,
    reactions,
    threats: { traceRules: attackRules, onTraces: (found) => traces.push(...found) },
  };
  const askCulprit = (engine: GameEngine) => {
    // The culprit walks into the hall from where the truth left them.
    waitUntil(engine, Math.max(engine.snapshot().minute, 30));
    return engine.dispatch('desktop', { type: 'talk', characterId: 'ch_bursar', topicId: 'self' });
  };
  const attacks = (engine: GameEngine): number =>
    deserializeInvestigation(engine.snapshot().investigation)
      .truth.events()
      .filter(({ verb }) => verb === 'attack').length;

  test('everything is off by default: no state in the snapshot', () => {
    const engine = GameEngine.create(manorWithCulpritInHall(), { ...base, npcSimulation: true });
    askCulprit(engine);
    waitUntil(engine, NIGHT + 60);
    expect(engine.snapshot()).not.toHaveProperty('reactions');
    expect(attacks(engine)).toBe(0);
  });

  test('questions raise the culprit wariness and it is saved and restored', () => {
    const investigation = manorWithCulpritInHall();
    const engine = GameEngine.create(investigation, ports);
    expect(askCulprit(engine).ok).toBe(true);
    const { reactions: saved } = engine.snapshot();
    expect(saved?.wariness).toEqual([['ch_bursar', 1]]);
    const restored = GameEngine.restore(
      JSON.parse(JSON.stringify(engine.snapshot())) as GameSnapshot,
      investigation,
      ports,
    );
    expect(restored.snapshot().reactions).toEqual(saved);
    expect(restored.stateHash()).toBe(engine.stateHash());
  });

  test('a wary culprit attacks a lone hero in the dark; the views show no attacker', () => {
    const engine = GameEngine.create(manorWithCulpritInHall(), ports);
    askCulprit(engine);
    const events = waitUntil(engine, NIGHT + 15).flatMap((result) => result.events);
    expect(attacks(engine)).toBe(1);
    const notice = events.find(({ type }) => type === 'PlayerAttacked');
    expect(notice).toMatchObject({ type: 'PlayerAttacked', location: 'loc_hall' });
    expect(JSON.stringify(notice)).not.toMatch(/bursar|attacker|culprit/i);
    expect(traces.length).toBeGreaterThan(0);
    const views = JSON.stringify([engine.playerView(), engine.phoneView()]);
    expect(views).not.toMatch(/ch_bursar.*attack|culprit|attacker/i);
    // One attack, then the pause: the culprit does not strike every ten minutes.
    waitUntil(engine, NIGHT + 45);
    expect(attacks(engine)).toBe(1);
    waitUntil(engine, NIGHT + 60);
    expect(attacks(engine)).toBe(2);
  });

  test('a resting hero is woken by the attack', () => {
    const engine = GameEngine.create(manorWithCulpritInHall(), ports);
    askCulprit(engine);
    waitUntil(engine, NIGHT);
    const result = engine.dispatch('desktop', { type: 'rest', minutes: 120 });
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'PlayerAttacked' }));
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'ActionInterrupted' }));
    expect(result.minutesSpent).toBeLessThan(120);
  });

  test('no attack without wariness, by day, with a light, or when not alone', () => {
    const calm = GameEngine.create(manorWithCulpritInHall(), ports);
    waitUntil(calm, NIGHT + 120);
    expect(attacks(calm)).toBe(0);

    const day = GameEngine.create(manorWithCulpritInHall(), ports);
    askCulprit(day);
    waitUntil(day, NIGHT - 60);
    expect(attacks(day)).toBe(0);

    const crowd = GameEngine.create(manorWithCulpritInHall('ch_owner'), ports);
    askCulprit(crowd);
    waitUntil(crowd, NIGHT + 120);
    expect(attacks(crowd)).toBe(0);

    const lit = GameEngine.create(manorWithCulpritInHall(), {
      ...ports,
      inventory: [{ id: 'flashlight', kind: 'flashlight', chargeMinutes: 10_000 }],
    });
    askCulprit(lit);
    expect(lit.dispatch('desktop', { type: 'useItem', itemId: 'flashlight' }).ok).toBe(true);
    waitUntil(lit, NIGHT + 120);
    expect(attacks(lit)).toBe(0);
  });

  test('a restored game attacks exactly when the original does', () => {
    const investigation = manorWithCulpritInHall();
    const engine = GameEngine.create(investigation, ports);
    askCulprit(engine);
    waitUntil(engine, NIGHT - 15);
    const saved = JSON.parse(JSON.stringify(engine.snapshot())) as GameSnapshot;
    const restored = GameEngine.restore(saved, investigation, ports);
    waitUntil(engine, NIGHT + 120);
    waitUntil(restored, NIGHT + 120);
    expect(attacks(restored)).toBe(attacks(engine));
    expect(attacks(engine)).toBeGreaterThan(0);
    expect(restored.stateHash()).toBe(engine.stateHash());
  });
});
