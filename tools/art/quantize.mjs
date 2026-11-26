#!/usr/bin/env node
// Converts an artist's master (8-bit RGB/RGBA PNG at native size) into a pipeline asset:
// HS-16 palette, Bayer 4×4 two-colour dithering, indexed PNG (art-direction.md §7.3).
// Usage: node tools/art/quantize.mjs <in.png> <out.png> [--dither bayer4|none] [--accent-mask <mask.png>]
//   --accent-mask: white pixels of an extra PNG (same size) may use the reserved A0 accent.
//   Without it A0 is never produced; transparent input pixels are rejected (plates are opaque).

import { readFileSync, writeFileSync } from 'node:fs';
import { decode, encodeIndexed } from './lib/png.mjs';
import { loadPalette, quantize, RESERVED } from './lib/palette.mjs';

function option(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}

function quantizeFile(input, output, { dither = 'bayer4', accentMask = null } = {}) {
  const image = decode(readFileSync(input));
  const { width, height, rgba } = image;
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    if (rgba[i * 4 + 3] !== 255)
      throw new Error(`${input}: transparent pixel at ${i % width},${Math.floor(i / width)}`);
    for (let k = 0; k < 3; k++) rgb[i * 3 + k] = rgba[i * 4 + k] / 255;
  }
  let accent = null;
  if (accentMask) {
    const mask = decode(readFileSync(accentMask));
    if (mask.width !== width || mask.height !== height)
      throw new Error('accent mask size differs from the image');
    accent = new Uint8Array(width * height).map((_, i) => (mask.rgba[i * 4] > 127 ? 1 : 0));
  }
  const palette = loadPalette();
  const indices = quantize(rgb, width, height, palette, { dither, reserved: RESERVED, accent });
  writeFileSync(
    output,
    encodeIndexed(
      width,
      height,
      palette.map((c) => c.rgb),
      indices,
    ),
  );
  return { width, height };
}

const [input, output] = process.argv
  .slice(2)
  .filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
if (!input || !output) {
  console.error(
    'Usage: node tools/art/quantize.mjs <in.png> <out.png> [--dither bayer4|none] [--accent-mask <mask.png>]',
  );
  process.exit(2);
}
const argv = process.argv.slice(2);
const { width, height } = quantizeFile(input, output, {
  dither: option(argv, '--dither', 'bayer4'),
  accentMask: option(argv, '--accent-mask', null),
});
console.log(`${output}: ${width}×${height}, HS-16 indexed`);
