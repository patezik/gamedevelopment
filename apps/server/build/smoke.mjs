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
const dataDir = mkdtempSync(join(tmpdir(), 'hs-smoke-'));
const server = spawn(binary, [], {
  cwd: dataDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    HS_PORT: String(port),
    HS_PARENT_PID: String(parent.pid),
    HS_DATA_DIR: dataDir,
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

  const base = `http://127.0.0.1:${port}/api/v1`;
  const scenarios = await (await fetch(`${base}/scenarios`)).json();
  if (!scenarios.some((scenario) => scenario.id === 'sanatorium_winter')) {
    throw new Error('Packaged scenario catalog is missing');
  }
  const created = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'sanatorium_winter', seed: '2' }),
  });
  if (!created.ok) throw new Error(`Session creation failed: ${await created.text()}`);
  const session = await created.json();
  const paired = await fetch(`${base}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: session.pairing.code,
      deviceName: 'SEA smoke',
      appVersion: '0.0.0',
      protocolVersion: health.protocolVersion,
    }),
  });
  if (!paired.ok || (await paired.json()).sessionId !== session.sessionId) {
    throw new Error('The packaged server could not pair with its created session');
  }
  console.log('packaged scenario, session creation and pairing ok from a separate cwd');

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
