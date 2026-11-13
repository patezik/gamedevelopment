import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderSchemas } from './schemas.ts';

const dir = join(import.meta.dirname, '..', 'schemas');
const expected = renderSchemas();
const check = process.argv.includes('--check');

const existing = (): string[] => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
};

if (check) {
  const problems: string[] = [];
  for (const [file, text] of Object.entries(expected)) {
    let actual: string | undefined;
    try {
      actual = readFileSync(join(dir, file), 'utf8');
    } catch {
      /* missing */
    }
    if (actual !== text) problems.push(`${file}: out of date`);
  }
  for (const file of existing()) if (!(file in expected)) problems.push(`${file}: stale`);
  if (problems.length > 0) {
    console.error(
      `protocol schemas differ:\n  ${problems.join('\n  ')}\nRun: npm run protocol:gen`,
    );
    process.exit(1);
  }
  console.log('protocol schemas are up to date');
} else {
  mkdirSync(dir, { recursive: true });
  for (const file of existing()) if (!(file in expected)) rmSync(join(dir, file));
  for (const [file, text] of Object.entries(expected)) writeFileSync(join(dir, file), text);
  console.log(`wrote ${Object.keys(expected).length} schemas to ${dir}`);
}
