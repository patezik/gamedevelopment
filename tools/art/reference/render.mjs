#!/usr/bin/env node
// Regenerates the reference prototype assets of CNT-010 (art-direction.md §8) byte for byte.
// Usage: node tools/art/reference/render.mjs [--only <name>] [--preview <dir>]
//   --preview also writes ×3 nearest-neighbour copies for review outside the repository.
// The sha256 of every rendered file is written back to assets/art/provenance.json.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeIndexed, encodeRgba } from '../lib/png.mjs';
import { loadPalette, quantize, RESERVED } from '../lib/palette.mjs';
import * as hall from './scenes/hall.mjs';
import * as lake from './scenes/lake.mjs';
import * as frame from './scenes/photo_frame.mjs';
import * as portraits from './scenes/portraits.mjs';
import * as treatment from './scenes/treatment.mjs';

const ART = fileURLToPath(new URL('../../../apps/desktop/assets/art/', import.meta.url));
const SANATORIUM = 'scenarios/sanatorium_winter';
const PLATE = [384, 216];

const plates = (id, scene, levels) =>
  levels.map((l) => ({
    name: `${id}.${l}`,
    path: `${SANATORIUM}/locations/${id}.${l}.png`,
    size: PLATE,
    paint: () => scene.render(l),
  }));

/** Every reference asset: published path under assets/art, size and painter. */
export const ENTRIES = [
  ...plates('loc_hall', hall, ['bright', 'dim']),
  ...plates('loc_treatment', treatment, ['bright', 'dim', 'dark']),
  ...plates('loc_lake_path', lake, ['dim', 'dark']),
  {
    name: 'head_doctor.m1',
    path: `${SANATORIUM}/portraits/head_doctor.m1.png`,
    size: portraits.SIZE,
    paint: portraits.headDoctorM1,
    quantize: portraits.QUANTIZE,
  },
  {
    name: 'nurse.f1',
    path: `${SANATORIUM}/portraits/nurse.f1.png`,
    size: portraits.SIZE,
    paint: portraits.nurseF1,
    quantize: portraits.QUANTIZE,
  },
  // Painted directly in palette indices (−1 = transparent), so it skips the quantiser.
  {
    name: 'photo_frame',
    path: 'ui/frames/photo_frame.png',
    size: frame.SIZE,
    indices: frame.paint,
  },
];

function toRgba(indices, palette) {
  const out = Buffer.alloc(indices.length * 4);
  indices.forEach((index, i) =>
    out.set(index < 0 ? [0, 0, 0, 0] : [...palette[index].rgb, 255], i * 4),
  );
  return out;
}

function upscale(rgba, width, height, scale) {
  const out = Buffer.alloc(width * scale * height * scale * 4);
  for (let y = 0; y < height * scale; y++) {
    for (let x = 0; x < width * scale; x++) {
      const s = (Math.floor(y / scale) * width + Math.floor(x / scale)) * 4;
      rgba.copy(out, (y * width * scale + x) * 4, s, s + 4);
    }
  }
  return encodeRgba(width * scale, height * scale, out);
}

function main(argv) {
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  const preview = argv.includes('--preview') ? argv[argv.indexOf('--preview') + 1] : null;
  const palette = loadPalette();
  const hashes = new Map();
  for (const entry of ENTRIES) {
    if (only && !entry.name.includes(only)) continue;
    const [w, h] = entry.size;
    const target = join(ART, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    let indices;
    if (entry.indices) {
      indices = entry.indices();
      writeFileSync(target, encodeRgba(w, h, toRgba(indices, palette)));
    } else {
      const frame = entry.paint();
      indices = quantize(frame.color, w, h, palette, {
        ...entry.quantize,
        reserved: RESERVED,
        accent: frame.accent,
      });
      writeFileSync(
        target,
        encodeIndexed(
          w,
          h,
          palette.map((c) => c.rgb),
          indices,
        ),
      );
    }
    hashes.set(entry.path, createHash('sha256').update(readFileSync(target)).digest('hex'));
    if (preview) {
      mkdirSync(preview, { recursive: true });
      writeFileSync(
        join(preview, `${entry.name}.x3.png`),
        upscale(toRgba(Array.from(indices), palette), w, h, 3),
      );
    }
    console.log(`${entry.path} (${w}×${h})`);
  }
  const registryPath = join(ART, 'provenance.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  for (const asset of registry.assets)
    if (hashes.has(asset.path)) asset.sha256 = hashes.get(asset.path);
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

main(process.argv.slice(2));
