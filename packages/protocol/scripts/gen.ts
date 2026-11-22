import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { GODOT_CONSTANTS_PATH, renderGodotConstants } from './godot.ts';
import { renderSchemas } from './schemas.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const schemaDir = join(import.meta.dirname, '..', 'schemas');
const check = process.argv.includes('--check');

/** Absolute path -> expected text of every generated file. */
const expected = new Map<string, string>([
  ...Object.entries(renderSchemas()).map(([file, text]): [string, string] => [
    join(schemaDir, file),
    text,
  ]),
  [join(root, GODOT_CONSTANTS_PATH), renderGodotConstants()],
]);

/** Schema files on disk that the generator no longer produces. */
const staleSchemas = (): string[] => {
  let files: string[];
  try {
    files = readdirSync(schemaDir);
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith('.json'))
    .map((file) => join(schemaDir, file))
    .filter((path) => !expected.has(path));
};

const display = (path: string): string => relative(root, path).replaceAll('\\', '/');

if (check) {
  const problems: string[] = [];
  for (const [path, text] of expected) {
    let actual: string | undefined;
    try {
      actual = readFileSync(path, 'utf8');
    } catch {
      /* missing */
    }
    if (actual === undefined) problems.push(`${display(path)}: missing`);
    else if (actual !== text) problems.push(`${display(path)}: out of date`);
  }
  for (const path of staleSchemas()) problems.push(`${display(path)}: stale`);
  if (problems.length > 0) {
    console.error(
      `generated protocol files differ:\n  ${problems.join('\n  ')}\nRun: npm run protocol:gen`,
    );
    process.exit(1);
  }
  console.log(`${String(expected.size)} generated protocol files are up to date`);
} else {
  for (const path of staleSchemas()) rmSync(path);
  for (const [path, text] of expected) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  console.log(`wrote ${String(expected.size)} generated protocol files`);
}
