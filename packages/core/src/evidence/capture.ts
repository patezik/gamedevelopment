import type { GameMinutes } from '../common/index.ts';
import type { Rng } from '../rng/index.ts';
import type { Clue } from './clues.ts';

export interface EvidenceTokenPort {
  issue(clueId: string, expiresAt: GameMinutes): string;
  revoke(tokenId: string): void;
}

export interface PendingCapture {
  readonly tokenId: string;
  readonly clueId: string;
  readonly locationId: string;
  readonly expiresAt: GameMinutes;
}

export function distributeCaptureModes(
  clues: readonly Clue[],
  requiredClueIds: ReadonlySet<string>,
  minQrShare: number,
  rng: Rng,
): Clue[] {
  if (!Number.isFinite(minQrShare) || minQrShare < 0 || minQrShare > 1) {
    throw new RangeError('minQrShare must be between 0 and 1');
  }
  const required = clues.filter(({ id }) => requiredClueIds.has(id));
  if (required.length !== requiredClueIds.size) throw new Error('Unknown mandatory clue ID');
  const qrCount = required.filter(({ captureMode }) => captureMode === 'qr').length;
  const needed = Math.max(0, Math.ceil(required.length * minQrShare) - qrCount);
  if (needed === 0) return [...clues];

  const candidates = required
    .filter(({ captureMode }) => captureMode === 'auto')
    .map(({ id }) => id)
    .sort();
  const selected = new Set(rng.fork('qr-share').shuffle(candidates).slice(0, needed));
  return clues.map((clue) => (selected.has(clue.id) ? { ...clue, captureMode: 'qr' } : clue));
}

export function issueEvidenceCapture(
  clue: Clue,
  minute: GameMinutes,
  port: EvidenceTokenPort,
): PendingCapture {
  const expiresAt = Math.min(minute + 120, clue.discovery.availableUntil ?? Infinity);
  const tokenId = port.issue(clue.id, expiresAt);
  return { tokenId, clueId: clue.id, locationId: clue.discovery.locationId, expiresAt };
}
