#!/usr/bin/env node
// Validates apps/desktop/assets/art against the asset rules of art-direction.md §7.
// Usage: node tools/art/check-art.mjs   (npm run art:check)
// Exit code 1 with one line per problem; the module also exports checkArt() for tests.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decode } from './lib/png.mjs';
import { ACCENT_INDEX, loadPalette } from './lib/palette.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_ART_ROOT = join(REPO, 'apps/desktop/assets/art');
export const DEFAULT_CONTENT_ROOT = join(REPO, 'content/scenarios');

/** Asset categories: path pattern, exact size (or max), alpha rule (§7.2–§7.4). */
const CATEGORIES = [
  {
    kind: 'location',
    pattern: /^scenarios\/([a-z0-9_]+)\/locations\/(loc_[a-z0-9_]+)\.(bright|dim|dark)\.png$/,
    size: [384, 216],
    opaque: true,
    maxAccent: 0.03,
  },
  {
    kind: 'portrait',
    pattern: /^scenarios\/([a-z0-9_]+)\/portraits\/([a-z0-9_]+)\.([a-z][0-9])\.png$/,
    size: [96, 128],
    opaque: true,
    maxAccent: 0.03,
  },
  {
    kind: 'ui',
    pattern: /^ui\/(frames|icons)\/[a-z0-9_]+\.png$/,
    maxSize: [64, 64],
    opaque: false,
  },
];

const IMPORT_PARAMS = {
  importer: '"texture"',
  'compress/mode': '0',
  'mipmaps/generate': 'false',
  'process/size_limit': '0',
  'detect_3d/compress_to': '0',
};

const STATUSES = new Set(['prototype', 'final']);
const ORIGINS = new Set(['procedural', 'hand', 'commissioned', 'stock', 'generative']);
const REQUIRED_FIELDS = [
  'path',
  'kind',
  'status',
  'origin',
  'author',
  'tool',
  'license',
  'created',
  'sha256',
];

function* pngFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* pngFiles(full);
    else if (entry.endsWith('.png')) yield full;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function scenarioData(contentRoot, scenario, cache) {
  if (!cache.has(scenario)) {
    const dir = join(contentRoot, scenario);
    if (!existsSync(dir)) cache.set(scenario, null);
    else {
      const locations = readJson(join(dir, 'locations.json'));
      const archetypes = readJson(join(dir, 'archetypes.json'));
      cache.set(scenario, {
        locations: new Map(locations.map((l) => [l.id, new Set(Object.values(l.lighting ?? {}))])),
        archetypes: new Set(archetypes.map((a) => a.id)),
      });
    }
  }
  return cache.get(scenario);
}

function checkImport(file, report) {
  const importFile = `${file}.import`;
  if (!existsSync(importFile)) {
    report('missing .import: open the project in Godot or run its --import, then commit the file');
    return;
  }
  const text = readFileSync(importFile, 'utf8');
  for (const [key, value] of Object.entries(IMPORT_PARAMS)) {
    const match = new RegExp(`^${key.replaceAll('/', '\\/')}=(.*)$`, 'm').exec(text);
    if (!match || match[1].trim() !== value)
      report(`.import: ${key} must be ${value} (is ${match?.[1] ?? 'absent'})`);
  }
}

function checkPixels(buffer, category, palette, report) {
  let image;
  try {
    image = decode(buffer);
  } catch (error) {
    report(error.message);
    return;
  }
  const { width, height, rgba } = image;
  if (category.size && (width !== category.size[0] || height !== category.size[1])) {
    report(`size ${width}×${height}, expected ${category.size.join('×')}`);
  }
  if (category.maxSize && (width > category.maxSize[0] || height > category.maxSize[1])) {
    report(`size ${width}×${height} exceeds ${category.maxSize.join('×')}`);
  }
  const lookup = new Map(palette.map((c, i) => [(c.rgb[0] << 16) | (c.rgb[1] << 8) | c.rgb[2], i]));
  let offPalette = 0;
  let translucent = 0;
  let transparent = 0;
  let accent = 0;
  let first = null;
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3];
    if (a === 0) {
      transparent++;
      continue;
    }
    if (a !== 255) translucent++;
    const key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
    const index = lookup.get(key);
    if (index === undefined) {
      offPalette++;
      first ??= `${i % width},${Math.floor(i / width)}`;
    } else if (index === ACCENT_INDEX) accent++;
  }
  if (offPalette)
    report(`${offPalette} pixels outside HS-16 (first at ${first}); run tools/art/quantize.mjs`);
  if (translucent) report(`${translucent} semi-transparent pixels: alpha must be 0 or 255`);
  if (category.opaque && transparent)
    report(`${transparent} transparent pixels: ${category.kind} must be opaque`);
  if (category.maxAccent !== undefined && accent / (width * height) > category.maxAccent) {
    const share = ((accent / (width * height)) * 100).toFixed(1);
    report(`A0 accent covers ${share}% of the image (max ${category.maxAccent * 100}%)`);
  }
}

/**
 * Checks every PNG under `artRoot` and the provenance registry. Returns { errors, checked }.
 */
export function checkArt({ artRoot = DEFAULT_ART_ROOT, contentRoot = DEFAULT_CONTENT_ROOT } = {}) {
  const errors = [];
  const palette = loadPalette(join(artRoot, 'palette/hs16.gpl'));
  if (palette.length !== 16)
    errors.push(`palette/hs16.gpl: expected 16 colours, found ${palette.length}`);

  const registryPath = join(artRoot, 'provenance.json');
  const registry = existsSync(registryPath) ? readJson(registryPath) : { assets: [] };
  if (!existsSync(registryPath)) errors.push('provenance.json is missing');
  const entries = new Map();
  for (const entry of registry.assets ?? []) {
    if (entries.has(entry.path)) errors.push(`provenance.json: duplicate entry ${entry.path}`);
    entries.set(entry.path, entry);
  }

  const cache = new Map();
  const variants = new Map(); // scenario/location → Set(lighting)
  const files = [...pngFiles(artRoot)].map((f) => relative(artRoot, f).split(sep).join('/')).sort();
  for (const path of files) {
    const report = (message) => errors.push(`${path}: ${message}`);
    const category = CATEGORIES.find((c) => c.pattern.test(path));
    if (!category) {
      report('unknown category or name; see art-direction.md §7.2');
      continue;
    }
    const match = category.pattern.exec(path);
    if (category.kind !== 'ui') {
      const data = scenarioData(contentRoot, match[1], cache);
      if (!data) report(`unknown scenario ${match[1]}`);
      else if (category.kind === 'location') {
        const levels = data.locations.get(match[2]);
        if (!levels) report(`unknown location ${match[2]}`);
        else if (!levels.has(match[3])) report(`${match[2]} never has lighting "${match[3]}"`);
        const key = `${match[1]}/${match[2]}`;
        if (!variants.has(key)) variants.set(key, new Set());
        variants.get(key).add(match[3]);
      } else if (!data.archetypes.has(match[2])) report(`unknown archetype ${match[2]}`);
    }

    const buffer = readFileSync(join(artRoot, path));
    checkPixels(buffer, category, palette, report);
    checkImport(join(artRoot, path), report);

    const entry = entries.get(path);
    if (!entry) {
      report('no provenance.json entry');
      continue;
    }
    for (const field of REQUIRED_FIELDS)
      if (!entry[field]) report(`provenance: missing "${field}"`);
    if (entry.kind && entry.kind !== category.kind)
      report(`provenance: kind "${entry.kind}", expected "${category.kind}"`);
    if (entry.status && !STATUSES.has(entry.status))
      report(`provenance: unknown status "${entry.status}"`);
    if (entry.origin && !ORIGINS.has(entry.origin))
      report(`provenance: unknown origin "${entry.origin}"`);
    if (
      (entry.origin === 'stock' || entry.origin === 'commissioned') &&
      !(entry.sources ?? []).length
    ) {
      report(`provenance: origin "${entry.origin}" needs "sources" (url, licence, author)`);
    }
    if (entry.status === 'final' && entry.license === 'pending')
      report('provenance: a final asset cannot have licence "pending"');
    const sha = createHash('sha256').update(buffer).digest('hex');
    if (entry.sha256 && entry.sha256 !== sha)
      report(`provenance: sha256 is stale (file is ${sha})`);
  }
  for (const path of entries.keys()) {
    if (!files.includes(path)) errors.push(`provenance.json: ${path} does not exist`);
  }
  // A location with art needs a plate for every lighting level it can have (§7.2).
  for (const [key, have] of variants) {
    const [scenario, id] = key.split('/');
    const levels = scenarioData(contentRoot, scenario, cache)?.locations.get(id);
    for (const level of levels ?? []) {
      if (!have.has(level))
        errors.push(`scenarios/${scenario}/locations/${id}.${level}.png: missing lighting variant`);
    }
  }
  return { errors, checked: files.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { errors, checked } = checkArt();
  for (const error of errors) console.error(error);
  console.log(`${checked} art assets checked, ${errors.length} problems`);
  if (errors.length) process.exitCode = 1;
}
