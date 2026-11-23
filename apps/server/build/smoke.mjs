// Smoke test of the built executable: /health answers, and the server exits when HS_PARENT_PID dies.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const binary =
  process.argv[2] ??
  join(
    root,
    'dist',
    'server',
    process.platform === 'win32' ? 'hollow-signal-server.exe' : 'hollow-signal-server',
  );

async function freePort() {
  const probe = createServer();
  probe.listen(0);
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');
  return port;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      const body = await response.json();
      if (response.ok && body.status === 'ok') return body;
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error('The server did not answer /health in time');
}

const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
const port = await freePort();
const server = spawn(binary, [], {
  stdio: 'inherit',
  env: {
    ...process.env,
    HS_PORT: String(port),
    HS_PARENT_PID: String(parent.pid),
    HS_DATA_DIR: mkdtempSync(join(tmpdir(), 'hs-smoke-')),
    HS_LOG_LEVEL: 'warn',
  },
});
let exited = false;
const exit = once(server, 'exit').then(() => {
  exited = true;
});

try {
  const health = await waitForHealth(port, Date.now() + 20000);
  console.log(`health ok on port ${port}:`, JSON.stringify(health));
  if (exited) throw new Error('The server exited early');

  parent.kill();
  await Promise.race([exit, sleep(10000)]);
  if (!exited) throw new Error('The server did not exit after its parent died');
  console.log('server exited after the parent process died');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  parent.kill();
  server.kill();
}
