import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = process.env.GODOT_BIN;
if (!executable) {
  console.error('Set GODOT_BIN to the Godot executable (use the console build on Windows).');
  process.exit(1);
}

const project = fileURLToPath(new URL('../apps/desktop/', import.meta.url));
const headless = ['--headless', '--path', project, '--audio-driver', 'Dummy'];

function runGodot(args) {
  const result = spawnSync(executable, [...headless, ...args], { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  return result.status ?? 1;
}

const importStatus = runGodot(['--import']);
if (importStatus !== 0) process.exit(importStatus);

const directory = mkdtempSync(join(tmpdir(), 'hs-gut-'));
const report = join(directory, 'results.xml').replaceAll('\\', '/');
try {
  process.exitCode = runGodot([
    '--script',
    'res://addons/gut/gut_cmdln.gd',
    '-gexit',
    '-gdisable_colors',
    `-gjunit_xml_file=${report}`,
  ]);
  // GUT can exit with 0 before starting the suite when its imported classes are missing.
  if (
    process.exitCode === 0 &&
    (!existsSync(report) || !/<testcase\b/.test(readFileSync(report, 'utf8')))
  ) {
    console.error('GUT did not report any test results.');
    process.exitCode = 1;
  }
} finally {
  if (existsSync(report)) unlinkSync(report);
  rmdirSync(directory);
}
