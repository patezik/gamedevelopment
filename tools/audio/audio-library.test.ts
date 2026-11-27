import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const MAX_TOTAL_BYTES = 6 * 1024 * 1024;

interface Entry {
  path: string;
  role: 'loop' | 'stinger' | 'os';
  origin: string;
  license: string;
  bytes: number;
  sha256: string;
}

const registry = JSON.parse(readFileSync(join(ROOT, 'tools/audio/provenance.json'), 'utf8')) as {
  assets: Entry[];
};

function samples(file: Buffer): Int16Array {
  const data = file.subarray(44);
  return new Int16Array(data.buffer, data.byteOffset, data.length / 2);
}

test('every library file is a mono 16-bit 22 kHz WAV listed in the provenance registry', () => {
  expect(registry.assets.length).toBeGreaterThanOrEqual(15);
  for (const entry of registry.assets) {
    const file = readFileSync(join(ROOT, entry.path));
    expect(file.toString('ascii', 0, 4), entry.path).toBe('RIFF');
    expect(file.toString('ascii', 8, 12), entry.path).toBe('WAVE');
    expect(file.readUInt16LE(22), `${entry.path} channels`).toBe(1);
    expect(file.readUInt32LE(24), `${entry.path} rate`).toBe(22050);
    expect(file.readUInt16LE(34), `${entry.path} bits`).toBe(16);
    expect(entry.origin).toBe('procedural');
    expect(entry.license).toBe('CC0-1.0');
    expect(createHash('sha256').update(file).digest('hex'), `${entry.path} changed`).toBe(
      entry.sha256,
    );
  }
});

test('peaks are below clipping, loops are long and join without a jump', () => {
  for (const entry of registry.assets) {
    const s = samples(readFileSync(join(ROOT, entry.path)));
    let top = 0;
    for (const v of s) top = Math.max(top, Math.abs(v));
    const peak = top / 32768;
    expect(peak, `${entry.path} peak`).toBeLessThan(0.8);
    if (entry.role === 'loop') {
      expect(s.length / 22050, `${entry.path} length`).toBeGreaterThanOrEqual(12);
      expect(peak, `${entry.path} beds are quieter`).toBeLessThan(0.4);
      const jump = Math.abs(s[0]! - s[s.length - 1]!) / 32768;
      expect(jump, `${entry.path} seam`).toBeLessThan(0.02);
    }
  }
});

test('the library stays within the 6 MB budget', () => {
  const total = registry.assets.reduce((sum, e) => sum + statSync(join(ROOT, e.path)).size, 0);
  expect(total).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
});
