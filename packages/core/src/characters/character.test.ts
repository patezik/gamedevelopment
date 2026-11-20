import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PERSONALITY_TRAITS } from '../common/index.ts';
import {
  characterSchema,
  deserializeCharacter,
  serializeCharacter,
  type Character,
} from './index.ts';

const character: Character = {
  id: 'ch_alina',
  name: 'Алина',
  archetypeId: 'doctor',
  age: 38,
  socialStatus: 'staff',
  personality: {
    openness: 0,
    conscientiousness: 1,
    extraversion: 0.5,
    agreeableness: 0.4,
    neuroticism: 0.6,
    honesty: 0.7,
    courage: 0.8,
    impulsivity: 0.2,
  },
  biography: [{ text: 'Работала в городской больнице', tags: ['medical'] }],
  goals: [{ kind: 'follow_routine', weight: 0.8 }],
  fears: ['Темнота'],
  habits: [{ activity: 'read' }],
  desires: ['Вернуться в город'],
  secrets: ['secret_transfer'],
  access: [
    { locationId: 'loc_office' },
    { itemId: 'it_key' },
    { locationId: 'loc_ward', itemId: 'it_pass' },
  ],
  routine: [{ from: 1320, to: 360, location: 'loc_room', activity: 'sleep', flexibility: 0.2 }],
};

describe('Character', () => {
  it('preserves all data after a JSON round trip, including a routine crossing midnight', () => {
    const json = serializeCharacter(character);
    expect(deserializeCharacter(json)).toEqual(character);
    expect(serializeCharacter(deserializeCharacter(json))).toBe(json);
  });

  it.each(PERSONALITY_TRAITS)('requires %s in the inclusive range 0..1', (trait) => {
    for (const value of [-0.01, 1.01, '0.5', undefined]) {
      const personality = { ...character.personality, [trait]: value };
      expect(characterSchema.safeParse({ ...character, personality }).success).toBe(false);
    }
  });

  it('keeps crime roles out of the schema and rejects them in serialized input', () => {
    const schemaJson = JSON.stringify(z.toJSONSchema(characterSchema));
    expect(schemaJson).not.toMatch(/"[^"]*(?:suspect|culprit|crimeRole)[^"]*"\s*:/i);

    const unknownFields = [
      { suspect: true },
      { culpritId: 'ch_alina' },
      { crimeRole: 'witness' },
      { biography: [{ ...character.biography[0], suspect: true }] },
      { personality: { ...character.personality, culprit: 1 } },
    ];
    for (const fields of unknownFields) {
      expect(() => deserializeCharacter(JSON.stringify({ ...character, ...fields }))).toThrow(
        z.ZodError,
      );
    }
  });

  it('checks access references and the shape of routine blocks', () => {
    expect(characterSchema.safeParse({ ...character, access: [{}] }).success).toBe(false);
    expect(
      characterSchema.safeParse({
        ...character,
        routine: [{ ...character.routine[0], from: 1440 }],
      }).success,
    ).toBe(false);
  });
});
