import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { checkArt, DEFAULT_ART_ROOT } from './check-art.mjs';
import { decode, encodeIndexed, encodeRgba } from './lib/png.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function artRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hs-art-'));
  roots.push(root);
  mkdirSync(join(root, 'palette'));
  copyFileSync(join(DEFAULT_ART_ROOT, 'palette/hs16.gpl'), join(root, 'palette/hs16.gpl'));
  return root;
}

function put(root: string, path: string, data: Buffer | string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), data);
}

test('the committed reference assets satisfy every rule', () => {
  const { errors, checked } = checkArt();
  expect(errors).toEqual([]);
  expect(checked).toBeGreaterThanOrEqual(10);
});

test('reports naming, size, palette, import, variant and provenance problems', () => {
  const root = artRoot();
  const offPalette = encodeRgba(10, 10, new Uint8Array(400).fill(7));
  put(root, 'scenarios/sanatorium_winter/locations/loc_hall.bright.png', offPalette);
  put(root, 'scenarios/sanatorium_winter/locations/loc_nowhere.dim.png', offPalette);
  put(root, 'misc/thing.png', offPalette);
  put(root, 'provenance.json', JSON.stringify({ assets: [{ path: 'ui/frames/gone.png' }] }));

  const { errors } = checkArt({ artRoot: root });
  const hall = 'scenarios/sanatorium_winter/locations/loc_hall.bright.png';
  expect(errors).toEqual(
    expect.arrayContaining([
      `${hall}: size 10×10, expected 384×216`,
      expect.stringMatching(new RegExp(`^${hall}: 100 pixels outside HS-16`)),
      expect.stringMatching(new RegExp(`^${hall}: missing \\.import`)),
      `${hall}: no provenance.json entry`,
      'scenarios/sanatorium_winter/locations/loc_hall.dim.png: missing lighting variant',
      'scenarios/sanatorium_winter/locations/loc_nowhere.dim.png: unknown location loc_nowhere',
      'misc/thing.png: unknown category or name; see art-direction.md §7.2',
      'provenance.json: ui/frames/gone.png does not exist',
    ]),
  );
});

test('rejects semi-transparency, transparent plates, stale hashes and accent overuse', () => {
  const root = artRoot();
  const path = 'scenarios/sanatorium_winter/portraits/nurse.f1.png';
  const rgba = new Uint8Array(96 * 128 * 4);
  for (let i = 0; i < 96 * 128; i++) rgba.set([111, 33, 29, 255], i * 4); // all A0 «rust»
  rgba[3] = 128;
  rgba[7] = 0;
  put(root, path, encodeRgba(96, 128, rgba));
  put(root, `${path}.import`, 'importer="texture"\ncompress/mode=2\nmipmaps/generate=false\n');
  put(
    root,
    'provenance.json',
    JSON.stringify({
      assets: [
        {
          path,
          kind: 'portrait',
          status: 'final',
          origin: 'stock',
          author: 'x',
          tool: 'x',
          license: 'pending',
          created: '2026-11-24',
          sha256: '0'.repeat(64),
        },
      ],
    }),
  );

  const { errors } = checkArt({ artRoot: root });
  expect(errors).toEqual(
    expect.arrayContaining([
      `${path}: 1 semi-transparent pixels: alpha must be 0 or 255`,
      `${path}: 1 transparent pixels: portrait must be opaque`,
      expect.stringMatching(new RegExp(`^${path}: A0 accent covers 100\\.0%`)),
      `${path}: .import: compress/mode must be 0 (is 2)`,
      `${path}: .import: detect_3d/compress_to must be 0 (is absent)`,
      `${path}: provenance: origin "stock" needs "sources" (url, licence, author)`,
      `${path}: provenance: a final asset cannot have licence "pending"`,
      expect.stringMatching(new RegExp(`^${path}: provenance: sha256 is stale`)),
    ]),
  );
});

test('indexed PNGs round-trip through the codec', () => {
  const palette: [number, number, number][] = [
    [10, 12, 15],
    [236, 231, 218],
  ];
  const indices = new Uint8Array([0, 1, 1, 0, 1, 0]);
  const image = decode(encodeIndexed(3, 2, palette, indices));
  expect([image.width, image.height, image.colorType]).toEqual([3, 2, 3]);
  expect([...image.rgba.subarray(0, 8)]).toEqual([10, 12, 15, 255, 236, 231, 218, 255]);
});
