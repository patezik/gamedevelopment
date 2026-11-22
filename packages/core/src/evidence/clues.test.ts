import { expect, test } from 'vitest';
import { tinyManorWithClues } from '../../test/fixtures/tiny-manor.ts';
import { deriveClues, discoverable, validateCluePrerequisites, type Trace } from './index.ts';

const trace: Trace = {
  id: 'trace_test',
  kind: 'document',
  sourceEventId: 'ev_1',
  template: 'note',
  supports: ['means(character)'],
  captureMode: 'qr',
  location: 'hall',
  availableFrom: 5,
  decaysAt: 12,
  destroyedAt: 10,
};
const action = { type: 'examineHotspot', hotspotId: 'desk' } as const;

test('places a clue with source links and honors its action, prerequisites and time window', () => {
  const clues = deriveClues(
    [trace],
    new Map([['note', { action, requires: [{ kind: 'item', id: 'key' }] }]]),
  );
  const clue = clues[0]!;
  const context = { locationId: 'hall', action, minute: 5, has: () => true };

  expect(clue).toMatchObject({
    traceId: trace.id,
    sourceEventId: trace.sourceEventId,
    captureMode: 'qr',
  });
  expect(discoverable(clue, context)).toBe(true);
  expect(discoverable(clue, { ...context, minute: 4 })).toBe(false);
  expect(discoverable(clue, { ...context, minute: 10 })).toBe(false);
  expect(discoverable(clue, { ...context, locationId: 'study' })).toBe(false);
  expect(discoverable(clue, { ...context, action: { ...action, hotspotId: 'shelf' } })).toBe(false);
  expect(discoverable(clue, { ...context, has: () => false })).toBe(false);
});

test('rejects circular and missing clue prerequisites', () => {
  const first = deriveClues([trace], new Map([['note', { action }]]))[0]!;
  const second = {
    ...first,
    id: 'cl_second',
    discovery: { ...first.discovery, requires: [{ kind: 'clue' as const, id: first.id }] },
  };
  const dependent = {
    ...first,
    discovery: { ...first.discovery, requires: [{ kind: 'clue' as const, id: second.id }] },
  };
  expect(() => validateCluePrerequisites([first, second])).not.toThrow();
  expect(() => validateCluePrerequisites([dependent, second])).toThrow(/Circular/);
  expect(() => validateCluePrerequisites([dependent])).toThrow(/Unknown/);
});

test('tiny-manor includes a clue linked to an incident event', () => {
  const { clues, truth } = tinyManorWithClues();
  expect(clues).toHaveLength(1);
  expect(truth.incident.keyEventIds).toContain(clues[0]?.sourceEventId);
});
