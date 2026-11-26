// HS-16 palette loading and ordered dithering (art-direction.md §3–§4).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PALETTE_PATH = fileURLToPath(
  new URL('../../../apps/desktop/assets/art/palette/hs16.gpl', import.meta.url),
);

/** Index of A0 «rust»: the narrative accent, produced only where a mask allows it (§3). */
export const ACCENT_INDEX = 14;
export const RESERVED = [ACCENT_INDEX];

/** Parses a GIMP .gpl palette into [{ rgb: [r, g, b], name }] in file order. */
export function parseGpl(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== 'GIMP Palette') throw new Error('not a GIMP palette');
  const colors = [];
  for (const line of lines.slice(1)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const rgb = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (rgb.some((v) => v > 255)) throw new Error(`bad colour: ${line}`);
    colors.push({ rgb, name: match[4].trim() });
  }
  return colors;
}

export function loadPalette(path = PALETTE_PATH) {
  return parseGpl(readFileSync(path, 'utf8'));
}

/** 4×4 Bayer matrix, thresholds in (0, 1). */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

export function bayer4(x, y) {
  return BAYER4[(y & 3) * 4 + (x & 3)];
}

// Distances are weighted by luma so that dithering keeps value structure first (§4).
const W = [0.299, 0.587, 0.114];
function dist2(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return W[0] * dr * dr + W[1] * dg * dg + W[2] * db * db;
}

/**
 * Two-colour ordered dithering: picks the palette pair whose mix best matches the colour, then
 * a Bayer 4×4 threshold chooses between them. Stable (no error diffusion), so the same pixel of
 * two lighting variants never "crawls". `rgb` is Float32Array (0–1, 3 per pixel).
 * Options: `dither: 'bayer4' | 'none'`, `pairPenalty` discourages mixing distant colours,
 * `reserved` lists palette indices used only where `accent` (one byte per pixel) is 1 (§3).
 */
export function quantize(
  rgb,
  width,
  height,
  palette,
  { dither = 'bayer4', pairPenalty = 0.35, reserved = [], accent = null } = {},
) {
  const colors = palette.map(({ rgb: c }) => c.map((v) => v / 255));
  const all = colors.map((_, j) => j);
  const common = all.filter((j) => !reserved.includes(j));
  const out = new Uint8Array(width * height);
  const c = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      for (let k = 0; k < 3; k++) c[k] = Math.min(1, Math.max(0, rgb[i * 3 + k]));
      const allowed = accent && accent[i] ? all : common;
      let a = 0;
      let best = Infinity;
      allowed.forEach((j) => {
        const d = dist2(c, colors[j]);
        if (d < best) [best, a] = [d, j];
      });
      if (dither === 'none') {
        out[i] = a;
        continue;
      }
      const A = colors[a];
      let b = a;
      let t = 0;
      let bestPair = best;
      allowed.forEach((j) => {
        const P = colors[j];
        if (j === a) return;
        const span = dist2(P, A);
        if (span === 0) return;
        const dot =
          W[0] * (c[0] - A[0]) * (P[0] - A[0]) +
          W[1] * (c[1] - A[1]) * (P[1] - A[1]) +
          W[2] * (c[2] - A[2]) * (P[2] - A[2]);
        const s = Math.min(1, Math.max(0, dot / span));
        if (s <= 0) return;
        const mix = [A[0] + s * (P[0] - A[0]), A[1] + s * (P[1] - A[1]), A[2] + s * (P[2] - A[2])];
        const err = dist2(c, mix) + pairPenalty * span * s * (1 - s);
        if (err < bestPair) [bestPair, b, t] = [err, j, s];
      });
      out[i] = bayer4(x, y) < t ? b : a;
    }
  }
  return out;
}
