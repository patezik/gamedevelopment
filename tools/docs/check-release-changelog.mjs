import { execFileSync } from 'node:child_process';

const [base, head] = process.argv.slice(2);
if (!base || !head || !/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) {
  throw new Error('Pass the base and head commit SHAs');
}

const diff = execFileSync(
  'git',
  ['diff', '--no-ext-diff', '--no-color', '--unified=0', `${base}...${head}`, '--', 'CHANGELOG.md'],
  { encoding: 'utf8' },
);
const version = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const releaseHeading = /^(?:## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2}))$/;
const removed = new Set();
const added = [];
for (const line of diff.split(/\r?\n/)) {
  const match = releaseHeading.exec(line.slice(1));
  if (!match) continue;
  const [, release, date] = match;
  if (line.startsWith('-')) removed.add(release);
  if (line.startsWith('+') && version.test(release)) {
    const timestamp = Date.parse(`${date}T00:00:00Z`);
    if (Number.isFinite(timestamp) && new Date(timestamp).toISOString().startsWith(date)) {
      added.push(release);
    }
  }
}

const release = added.find((candidate) => !removed.has(candidate));
if (!release) {
  console.error('Release PR must add a dated version heading to CHANGELOG.md');
  process.exitCode = 1;
} else {
  console.log(`CHANGELOG.md adds release ${release}`);
}
