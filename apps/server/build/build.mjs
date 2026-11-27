// Builds the Session Server into a single executable (Node SEA): esbuild bundle -> SEA blob -> postject.
// Output: dist/server/hollow-signal-server[.exe]. Signing and notarization are out of scope (OQ-09).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const work = join(root, 'dist', 'sea-work');
const outDir = join(root, 'dist', 'server');
// The SEA host must be an official statically linked Node.js binary. Distribution builds
// (for example Fedora's /usr/bin/node) are thin launchers around libnode.so and cannot carry a blob.
const nodeBinary = process.env.HS_NODE_BIN ?? process.execPath;
if (statSync(nodeBinary).size < 40 * 1024 * 1024) {
  console.error(
    `${nodeBinary} looks like a dynamically linked Node.js. Use an official build from nodejs.org ` +
      '(actions/setup-node, nvm, fnm) or point HS_NODE_BIN at one.',
  );
  process.exit(1);
}
const windows = process.platform === 'win32';
const output = join(outDir, windows ? 'hollow-signal-server.exe' : 'hollow-signal-server');
const bundle = join(work, 'server.cjs');
const blob = join(work, 'server.blob');
const config = join(work, 'sea-config.json');
// Fixed by the Node SEA documentation: postject looks for this fuse string in the node binary.
const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, 'apps/server/src/server.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  legalComments: 'none',
  logLevel: 'warning',
});

writeFileSync(
  config,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }),
);
execFileSync(nodeBinary, ['--experimental-sea-config', config], { stdio: 'inherit' });

rmSync(output, { force: true });
copyFileSync(nodeBinary, output);
if (!windows) chmodSync(output, 0o755);
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--remove-signature', output], { stdio: 'inherit' });
}

const postject = join(root, 'node_modules', 'postject', 'dist', 'cli.js');
const args = [postject, output, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', fuse];
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
execFileSync(process.execPath, args, { stdio: 'inherit' });

if (process.platform === 'darwin') {
  // Apple Silicon refuses to run unsigned binaries; an ad-hoc signature is not a release signature.
  execFileSync('codesign', ['--sign', '-', output], { stdio: 'inherit' });
}

rmSync(work, { recursive: true, force: true });
// Scenario loading must also work without the source checkout and from an arbitrary cwd.
cpSync(join(root, 'content', 'scenarios'), join(outDir, 'content', 'scenarios'), {
  recursive: true,
});
console.log(`Built ${output}`);
