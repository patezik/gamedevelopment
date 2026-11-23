import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { renderMatrix } from './matrix.ts';

const EVIDENCE = `hs1:ev:${'0'.repeat(8)}:${'A'.repeat(16)}:${'B'.repeat(22)}`;
const cell = (matrix: ReturnType<typeof renderMatrix>, row: number, column: number): string =>
  matrix.modules.charAt(row * matrix.size + column);
const rows = (
  matrix: ReturnType<typeof renderMatrix>,
  top: number,
  left: number,
  n = 7,
): string[] =>
  Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (_, c) => cell(matrix, top + r, left + c)).join(''),
  );

const FINDER = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];

describe('renderMatrix', () => {
  const matrix = renderMatrix(EVIDENCE);

  it('is a square of 0 and 1 in the size of a real QR version', () => {
    expect(matrix.modules).toMatch(/^[01]+$/);
    expect(matrix.modules).toHaveLength(matrix.size * matrix.size);
    expect((matrix.size - 17) % 4).toBe(0); // 17 + 4 * version
    expect(matrix.size).toBeGreaterThanOrEqual(21);
  });

  it('has the three finder patterns a phone camera locks on to', () => {
    expect(rows(matrix, 0, 0)).toEqual(FINDER);
    expect(rows(matrix, 0, matrix.size - 7)).toEqual(FINDER);
    expect(rows(matrix, matrix.size - 7, 0)).toEqual(FINDER);
  });

  it('has the alternating timing pattern between the finders', () => {
    for (let i = 8; i < matrix.size - 8; i++) {
      expect(cell(matrix, 6, i)).toBe(i % 2 === 0 ? '1' : '0');
      expect(cell(matrix, i, 6)).toBe(i % 2 === 0 ? '1' : '0');
    }
  });

  it('carries no quiet zone: Godot draws that margin itself', () => {
    expect(matrix.modules.slice(0, 7)).toBe('1111111');
  });

  it('is the same every time for the same text and different for different text', () => {
    expect(renderMatrix(EVIDENCE)).toEqual(matrix);
    expect(renderMatrix(EVIDENCE.replace('B', 'C')).modules).not.toBe(matrix.modules);
  });

  it('uses error correction level M (not the library default)', () => {
    const level = (errorCorrectionLevel: 'L' | 'M' | 'H') =>
      QRCode.create(EVIDENCE, { errorCorrectionLevel }).modules;
    const asString = (m: { size: number; data: Uint8Array }) =>
      Array.from(m.data, (d) => (d ? '1' : '0')).join('');
    expect(matrix.modules).toBe(asString(level('M')));
    expect(matrix.modules).not.toBe(asString(level('L')));
    expect(matrix.modules).not.toBe(asString(level('H')));
  });

  it('fits a pairing QR with a long host name', () => {
    const long = renderMatrix(`hs1:pair:${'host-'.repeat(12)}.example.local:7420:ABC123`);
    expect(long.modules).toHaveLength(long.size * long.size);
    expect(rows(long, 0, 0)).toEqual(FINDER);
  });

  it('gets bigger as the text gets longer', () => {
    expect(renderMatrix('x'.repeat(200)).size).toBeGreaterThan(matrix.size);
  });
});
