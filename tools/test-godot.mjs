import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const executable = process.env.GODOT_BIN;
if (!executable) {
  console.error('Set GODOT_BIN to the Godot executable (use the console build on Windows).');
  process.exit(1);
}

const project = fileURLToPath(new URL('../apps/desktop/', import.meta.url));
const headless = ['--headless', '--path', project, '--audio-driver', 'Dummy'];
const directory = mkdtempSync(join(tmpdir(), 'hs-gut-'));
const report = join(directory, 'results.xml').replaceAll('\\', '/');
const importLog = join(directory, 'import.log');
const testLog = join(directory, 'tests.log');

function runGodot(log, args) {
  const result = spawnSync(executable, [...headless, '--log-file', log, ...args], {
    stdio: 'inherit',
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) return result.status ?? 1;

  if (!existsSync(log)) {
    console.error('Godot did not write its log.');
    return 1;
  }
  const output = stripVTControlCharacters(readFileSync(log, 'utf8'));
  if (/^(?:SCRIPT ERROR: (?:Parse|Compile) Error:|ERROR: Failed to load script\b)/m.test(output)) {
    console.error('Godot could not compile or load a script.');
    return 1;
  }
  return 0;
}

function runTests() {
  const importStatus = runGodot(importLog, ['--import']);
  if (importStatus !== 0) return importStatus;
  const testStatus = runGodot(testLog, [
    '--script',
    'res://addons/gut/gut_cmdln.gd',
    '-gexit',
    '-gdisable_colors',
    `-gjunit_xml_file=${report}`,
  ]);
  // GUT can exit with 0 before starting the suite when its imported classes are missing.
  if (testStatus !== 0) return testStatus;
  if (!existsSync(report) || !/<testcase\b/.test(readFileSync(report, 'utf8'))) {
    console.error('GUT did not report any test results.');
    return 1;
  }
  return 0;
}

try {
  process.exitCode = runTests();
} finally {
  for (const file of [importLog, testLog, report]) {
    if (existsSync(file)) unlinkSync(file);
  }
  rmdirSync(directory);
}
