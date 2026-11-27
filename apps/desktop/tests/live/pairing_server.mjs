// A session server for the live NewGame and Pairing tests (tests/unit/test_pairing_live.gd).
//
// Both modes build REST through the production factory `createSessionServices` of SRV-002:
// the shipped scenario catalog, the real generator with the full validation gate, the pairing
// service and its routes. Godot's real Backend talks to it over HTTP and WebSocket.
//
//   --mode=production  exactly the routes `npm start` has today (apps/server/src/server.ts): no
//                      pairing-qr route, and a gateway that does not know the issued tokens.
//   --mode=adapter     a test adapter for what SRV-013 will assemble: the gateway finds the
//                      sessions of the same SessionManager, and the pairing-qr route renders the
//                      session's current code with the server's renderMatrix. It is test code only.
//
// Protocol on stdio (one JSON object per line):
//   stdout, first line: {"origin": "http://127.0.0.1:<port>", "seed": "<a seed the full gate accepts>"}
//   stdin commands, each answered by one stdout line:
//     {"cmd": "pair", "code": "<code shown by the desktop>"}
//        pairs like the phone app (POST /pair) and opens the phone WebSocket (hello{phone});
//        answers {"status": <HTTP status>, "welcome": bool}
//     {"cmd": "phone-close"}  closes the phone socket; answers {"ok": true}
//     {"cmd": "phone-unpair"}  the phone unpairs itself (DELETE /sessions/:id/device with its token);
//        answers {"status": <HTTP status>}
//     {"cmd": "quit"}
//
// Manual check with a physical phone (docs/mobile/qr-mechanics.md, «QR привязки в Godot»):
//   node --import tsx apps/desktop/tests/live/pairing_server.mjs --mode=adapter --manual [--port=7420]
// listens on every interface, puts a real LAN address (or HS_PUBLIC_HOST) into the QR, reports
// /network from this computer and prints each POST /pair answer. Close it with Ctrl+C.

import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import WebSocket from 'ws';
import { loadScenarioFromDir } from '@hs/core/content';
import { generateInvestigation } from '@hs/generator';
import { PROTOCOL_VERSION } from '@hs/protocol';
import { buildApp } from '../../../server/src/app.ts';
import { readConfig } from '../../../server/src/config/index.ts';
import { SessionGateway } from '../../../server/src/gateway/index.ts';
import { createSessionServices, defaultScenariosDir } from '../../../server/src/routes/generation.ts';

const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length) ?? 'production';
if (mode !== 'production' && mode !== 'adapter') throw new Error(`unknown mode ${mode}`);
const manual = process.argv.includes('--manual');
const requestedPort = Number(process.argv.find((arg) => arg.startsWith('--port='))?.slice('--port='.length) ?? 0);

const SCENARIO = 'sanatorium_winter';
// The first seed the full gate accepts today; the generator may change, the test should not.
const content = loadScenarioFromDir(join(defaultScenariosDir(), SCENARIO));
const seed = ['winter-42', '1', '2', '3', '42', '5', '6', '7'].find(
  (candidate) => generateInvestigation({ scenarioId: SCENARIO, seed: candidate }, content).ok,
);
if (seed === undefined) throw new Error('no solvable seed among the candidates');

const port = requestedPort || await new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close(() => resolve(free));
  });
});
const config = readConfig({
  HS_DATA_DIR: mkdtempSync(join(os.tmpdir(), 'hs-data-')),
  HS_LOG_LEVEL: 'silent',
  HS_HOST: manual ? '0.0.0.0' : '127.0.0.1',
  HS_PORT: String(port),
  ...(manual && process.env.HS_PUBLIC_HOST ? { HS_PUBLIC_HOST: process.env.HS_PUBLIC_HOST } : {}),
});
// A fixed interface list keeps GET /network independent of the machine running the test.
const networkInterfaces = manual ? os.networkInterfaces : () => ({
  'Wi-Fi': [
    { address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', mac: '00:11:22:33:44:55', internal: false, cidr: '192.168.1.20/24' },
  ],
  'Ethernet': [
    { address: '10.0.0.7', netmask: '255.255.255.0', family: 'IPv4', mac: '00:11:22:33:44:66', internal: false, cidr: '10.0.0.7/24' },
  ],
});
const services = createSessionServices(config, { networkInterfaces });
const dependencies = { ...services, networkInterfaces };

if (mode === 'adapter') {
  dependencies.gateway = new SessionGateway({ serverVersion: '0.0.0', sessions: services.sessions.sessions });
  // buildApp registers the QR routes of apps/server/src/qr with these dependencies. Only the
  // pairing matrix matters here: evidence tokens are out of these screens.
  dependencies.qr = {
    qr: {
      scan: async () => ({ ok: false, error: 'QR_INVALID' }),
      evidenceMatrix: () => {
        throw Object.assign(new Error('no evidence QR here'), { code: 'QR_INVALID', status: 404 });
      },
    },
    authorizeDesktop: (id, authorization) => services.pairing.authorizeDesktop(id, authorization),
    activePairingCode: (session) => services.pairing.activeCode(session),
  };
}

const app = buildApp(config, dependencies);
if (manual) {
  app.addHook('onResponse', (request, reply, done) => {
    if (request.url === '/api/v1/pair') console.log(`POST /pair -> ${reply.statusCode}`);
    done();
  });
}
await app.listen({ host: config.host, port });
const origin = `http://127.0.0.1:${port}`;
process.stdout.write(JSON.stringify({ origin, seed }) + '\n');

let phone;
let phoneAuth;

async function pair(code) {
  const response = await fetch(`${origin}/api/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'Live test phone', appVersion: '0.0.0', protocolVersion: PROTOCOL_VERSION }),
  });
  const body = await response.json();
  if (response.status !== 200) return { status: response.status, welcome: false };
  phoneAuth = { sessionId: body.sessionId, token: body.deviceToken };
  phone = new WebSocket(`${origin.replace(/^http:/, 'ws:')}${body.wsPath}`);
  const welcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    phone.on('open', () => {
      phone.send(JSON.stringify({
        v: PROTOCOL_VERSION, type: 'hello', id: 'phone-1',
        payload: { role: 'phone', token: body.deviceToken, appVersion: '0.0.0' },
      }));
    });
    phone.on('message', (data) => {
      if (JSON.parse(data.toString('utf8')).type === 'welcome') {
        clearTimeout(timer);
        resolve(true);
      }
    });
    phone.on('error', () => resolve(false));
  });
  return { status: response.status, welcome };
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const command = JSON.parse(line);
  if (command.cmd === 'pair') {
    process.stdout.write(JSON.stringify(await pair(command.code)) + '\n');
  } else if (command.cmd === 'phone-close') {
    phone?.close();
    process.stdout.write(JSON.stringify({ ok: true }) + '\n');
  } else if (command.cmd === 'phone-unpair') {
    // like the phone app's «Отвязать устройство»: DELETE .../device with the device token
    const response = await fetch(`${origin}/api/v1/sessions/${phoneAuth.sessionId}/device`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${phoneAuth.token}` },
    });
    process.stdout.write(JSON.stringify({ status: response.status }) + '\n');
  } else if (command.cmd === 'quit') {
    break;
  }
}
phone?.terminate();
await app.close();
process.exit(0);
