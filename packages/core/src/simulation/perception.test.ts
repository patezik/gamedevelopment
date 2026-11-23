import { expect, test } from 'vitest';
import { KnowledgeStore } from '../knowledge/index.ts';
import { createRng } from '../rng/index.ts';
import { attention, recordObservations, type PerceptibleEvent } from './perception.ts';

const event: PerceptibleEvent = {
  id: 'ev_fixture',
  t: -5,
  location: 'room',
  actorIds: ['actor'],
  verb: 'read',
  visibility: 'public',
};

test('attention stays bounded and decreases with darkness and stress', () => {
  const focused = { conscientiousness: 1 };
  expect(attention(focused, 'bright', 0)).toBe(1);
  expect(attention({ conscientiousness: 0 }, 'dark', 1)).toBe(0.03125);
  expect(attention(focused, 'dim', 0)).toBeGreaterThan(attention(focused, 'dark', 0));
  expect(attention(focused, 'bright', 1)).toBeLessThan(attention(focused, 'bright', 0));
  expect(() => attention(focused, 'bright', 1.1)).toThrow(RangeError);
});

test('public presence and covert observation hold across 200 seeds', () => {
  let seenInDark = 0;
  let seenInLight = 0;
  const present = new Set(['actor', 'witness']);
  for (let seed = 0; seed < 200; seed++) {
    const knowledge = new KnowledgeStore();
    const absent = new KnowledgeStore();
    const rng = createRng(String(seed));
    const observer = {
      id: 'witness',
      knowledge,
      rng,
      personality: { conscientiousness: 0.6 },
      stress: 0.2,
    };
    recordObservations(
      event,
      present,
      [observer, { ...observer, id: 'absent', knowledge: absent }],
      'dark',
    );
    expect(absent.serialize()).toBe('[]');
    expect(knowledge.query({ kind: 'did', who: 'actor' })).toMatchObject([
      { confidence: 1, source: 'observed', acquiredAt: -5 },
    ]);
    expect(knowledge.query({ kind: 'at' })).toMatchObject([
      { proposition: { who: 'actor', where: 'room', interval: { from: -5, to: -4 } } },
    ]);

    const covert: PerceptibleEvent = { ...event, visibility: 'covert' };
    const light = new KnowledgeStore();
    const dark = new KnowledgeStore();
    recordObservations(covert, present, [{ ...observer, knowledge: light }], 'bright');
    recordObservations(covert, present, [{ ...observer, knowledge: dark }], 'dark');
    const lightBelief = light.recall({ kind: 'did' }, -5);
    const darkBelief = dark.recall({ kind: 'did' }, -5);
    if (lightBelief) {
      expect(lightBelief.confidence).toBe(
        attention(observer.personality, 'bright', observer.stress),
      );
      seenInLight++;
    }
    if (darkBelief) {
      expect(lightBelief).toBeDefined();
      expect(darkBelief.confidence).toBe(attention(observer.personality, 'dark', observer.stress));
      seenInDark++;
    }
    expect(rng.state).toEqual(createRng(String(seed)).state);
  }
  expect(seenInDark).toBeGreaterThan(0);
  expect(seenInLight).toBeGreaterThan(seenInDark);
  expect(seenInLight).toBeLessThan(200);
});

test('private events provide no observations', () => {
  const knowledge = new KnowledgeStore();
  recordObservations(
    { ...event, visibility: 'private' },
    new Set(['witness']),
    [
      {
        id: 'witness',
        knowledge,
        rng: createRng('private'),
        personality: { conscientiousness: 1 },
        stress: 0,
      },
    ],
    'bright',
  );
  expect(knowledge.serialize()).toBe('[]');
});
