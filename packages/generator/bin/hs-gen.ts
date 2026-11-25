#!/usr/bin/env -S node --experimental-transform-types
import { runCli } from '../src/cli.ts';

const started = process.hrtime.bigint();
const { code, stdout, stderr } = runCli(process.argv.slice(2), {
  now: () => Number(process.hrtime.bigint() - started) / 1e6,
});
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = code;
