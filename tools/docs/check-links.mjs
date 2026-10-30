#!/usr/bin/env node
// Checks that relative links in Markdown files point to existing files (and headings for #anchors are ignored).
// Usage: node tools/docs/check-links.mjs

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.godot', 'dist', 'build', '.expo']);
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function* markdownFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* markdownFiles(full);
    else if (entry.endsWith('.md')) yield full;
  }
}

let broken = 0;
let checked = 0;
for (const file of markdownFiles(ROOT)) {
  // Strip fenced code blocks: links inside them are examples, not navigation.
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const [, target] of text.matchAll(LINK_RE)) {
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = decodeURIComponent(target.split('#')[0]);
    if (!path) continue;
    checked++;
    if (!existsSync(join(dirname(file), path))) {
      broken++;
      console.error(`${relative(ROOT, file)}: broken link → ${target}`);
    }
  }
}
console.log(`${checked} relative links checked, ${broken} broken`);
if (broken) process.exitCode = 1;
