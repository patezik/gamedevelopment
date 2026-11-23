import { expect, test } from 'vitest';
import { tinyManorWithClues } from '../../test/fixtures/tiny-manor.ts';
import { GameEngine } from '../game/index.ts';
import { createRng } from '../rng/index.ts';
import { distributeCaptureModes, type EvidenceTokenPort } from './index.ts';

function fakeTokens() {
  let next = 0;
  const active = new Map<string, { clueId: string; expiresAt: number }>();
  const port: EvidenceTokenPort = {
    issue(clueId, expiresAt) {
      const id = `token_${++next}`;
      active.set(id, { clueId, expiresAt });
      return id;
    },
    revoke(id) {
      active.delete(id);
    },
  };
  return { port, active };
}

test('satisfies the minimum mandatory QR share reproducibly and preserves authored modes', () => {
  const [template] = tinyManorWithClues().clues;
  const clues = [0, 1, 2, 3, 4].map((index) => ({
    ...template!,
    id: `cl_${index}`,
    captureMode: index === 0 ? ('qr' as const) : ('auto' as const),
  }));
  const required = new Set(['cl_0', 'cl_1', 'cl_2', 'cl_3']);
  const first = distributeCaptureModes(clues, required, 0.6, createRng('winter'));
  expect(first.filter((clue) => required.has(clue.id) && clue.captureMode === 'qr')).toHaveLength(
    3,
  );
  expect(first[0]?.captureMode).toBe('qr');
  expect(first[4]?.captureMode).toBe('auto');
  expect(distributeCaptureModes(clues, required, 0.6, createRng('winter'))).toEqual(first);
});

test('issues an eligible clue once, restores the request, and replaces its expired token', () => {
  const { port, active } = fakeTokens();
  const investigation = tinyManorWithClues();
  const clue = investigation.clues[0]!;
  const ports = { startLocationId: clue.discovery.locationId, evidenceTokens: port };
  const engine = GameEngine.create(investigation, ports);
  const context = { action: clue.discovery.action, has: () => true };
  expect(
    engine.requestEvidenceCapture(clue, {
      ...context,
      action: { type: 'read', documentId: 'other' },
    }),
  ).toBeUndefined();
  expect(engine.requestEvidenceCapture(clue, context)).toMatchObject({
    tokenId: 'token_1',
    expiresAt: 120,
  });
  expect(engine.requestEvidenceCapture(clue, context)?.tokenId).toBe('token_1');
  const restored = GameEngine.restore(engine.snapshot(), investigation, ports);
  expect(restored.stateHash()).toBe(engine.stateHash());
  expect(restored.pendingEvidenceCapture()?.tokenId).toBe('token_1');
  expect(restored.dispatch('desktop', { type: 'wait', minutes: 120 }).ok).toBe(true);
  expect(restored.pendingEvidenceCapture()).toBeUndefined();
  expect(restored.requestEvidenceCapture(clue, context)?.tokenId).toBe('token_2');
  expect([...active.keys()]).toEqual(['token_2']);
});
