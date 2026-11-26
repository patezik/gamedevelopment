// A real session server for the live accusation tests (tests/unit/test_accusation_live.gd): the
// SessionGateway of apps/server, real GameEngines on tiny-manor with the accusation port of
// ENG-006, and the desktop PlayerView projection. Godot's real Backend connects to it over
// WebSocket.
//
// Protocol on stdio (one JSON object per line):
//   stdout, first line: {"url": "ws://127.0.0.1:<port>/ws", "sessions": {"a": {"id", "token"}, "b": {...}}}
//   stdin commands, each answered by one stdout line:
//     {"cmd": "drop", "type": "action.result" | "view.update", "close": bool}
//        drops the next server message of that type to the desktop; with close, the socket is
//        terminated right after (the client reconnects and resumes)
//     {"cmd": "hold", "type": "action.result"} / {"cmd": "release"}
//        holds the next matching message until released on the same live socket
//     {"cmd": "report"} -> {"a": {...}, "b": {...}}: per session, the accuse requests the engine
//        received ({confirm, caseFile, ok}) and the ending the engine is in
//     {"cmd": "quit"}
// Faults are injected on the server's own sockets; nothing in the game rules is changed.

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { GameEngine } from '@hs/core/game';
import { deriveClues } from '@hs/core/evidence';
import { compileDeductionRules } from '@hs/core/investigation';
import { buildApp } from '../../../server/src/app.ts';
import { readConfig } from '../../../server/src/config/index.ts';
import { SessionGateway } from '../../../server/src/gateway/index.ts';
import { issueToken, PairingService } from '../../../server/src/pairing/index.ts';
import { SessionManager } from '../../../server/src/sessions/index.ts';
import { tinyManor } from '../../../../packages/core/test/fixtures/tiny-manor.ts';

const root = new URL('../../../../', import.meta.url);
const rulesFile = (scenario) =>
  JSON.parse(readFileSync(new URL(`content/scenarios/${scenario}/deduction-rules.json`, root), 'utf8'));
// The rule set of the ENG-006 tests: opportunity and motive of the sanatorium, means of _test_minimal.
const [opportunityRule, , motiveRule] = rulesFile('sanatorium_winter');
const meansRule = rulesFile('_test_minimal').find(({ id }) => id === 'means_from_log');
const rules = compileDeductionRules([opportunityRule, meansRule, motiveRule]);

function engineFor(investigation) {
  const { culpritIds, victimIds, window, keyEventIds } = investigation.truth.incident;
  const culprit = culpritIds[0];
  const victim = victimIds[0];
  const specs = [
    ['doc_ledger', `presence(${culprit},loc_study,${window.from})`],
    ['doc_debt', `knows(${culprit},sec_debt)`, `about(sec_debt,${victim})`],
    ['doc_log', `access_to_record(${culprit})`],
  ];
  const clues = deriveClues(
    specs.map(([template, ...supports]) => ({
      id: `trace_${template}`,
      kind: 'document',
      sourceEventId: keyEventIds[0],
      template,
      supports,
      captureMode: 'auto',
      location: 'loc_study',
      availableFrom: 0,
    })),
    new Map(specs.map(([template]) => [template, { action: { type: 'read', documentId: template } }])),
  );
  const engine = GameEngine.create(investigation, {
    startLocationId: 'loc_study',
    clues,
    accusation: { rules, incident: { location: 'loc_study', window } },
  });
  // The investigator has read every document: the clues are on the case board.
  for (const [template] of specs) engine.dispatch('desktop', { type: 'read', documentId: template });
  return engine;
}

const accusations = new Map();
const engines = new Map();
const sessions = new SessionManager(
  { create: () => ({ investigation: tinyManor('live-seed'), ports: {} }) },
  {
    createEngine: (investigation, _ports, id) => {
      const engine = engineFor(investigation);
      engines.set(id, engine);
      const log = [];
      accusations.set(id, log);
      return {
        dispatch(role, action) {
          const result = engine.dispatch(role, action);
          if (action.type === 'accuse') {
            log.push({ confirm: action.confirm, caseFile: action.caseFile, ok: result.ok });
          }
          return result;
        },
      };
    },
  },
);
const gateway = new SessionGateway({
  serverVersion: '0.0.0',
  sessions,
  snapshot: (session, role) => (role === 'desktop' ? engines.get(session.id)?.playerView() : undefined),
});
const pairing = new PairingService(sessions, { host: () => '127.0.0.1', port: 0 });
const app = buildApp(readConfig({ HS_LOG_LEVEL: 'silent' }), { pairing, gateway });

// Fault injection on the server's sockets.
const faults = [];
const held = [];
const originalSend = WebSocket.prototype.send;
WebSocket.prototype.send = function send(data, ...rest) {
  const text = typeof data === 'string' ? data : data.toString('utf8');
  let type;
  try {
    type = JSON.parse(text).type;
  } catch {
    type = undefined;
  }
  const index = faults.findIndex((fault) => fault.type === type);
  if (index >= 0) {
    const [fault] = faults.splice(index, 1);
    if (fault.hold) held.push(() => originalSend.call(this, data, ...rest));
    if (fault.close) setImmediate(() => this.terminate());
    return undefined;
  }
  return originalSend.call(this, data, ...rest);
};

const created = {};
for (const name of ['a', 'b']) {
  const session = await sessions.create('tiny-manor', `live-${name}`);
  await session.activate();
  created[name] = { id: session.id, token: issueToken(session, 'desktop') };
}
const address = await app.listen({ host: '127.0.0.1', port: 0 });
process.stdout.write(
  JSON.stringify({ url: `${address.replace(/^http:/, 'ws:')}/ws`, sessions: created }) + '\n',
);

function report() {
  const out = {};
  for (const [name, { id }] of Object.entries(created)) {
    const view = engines.get(id)?.playerView();
    out[name] = { accusations: accusations.get(id) ?? [], ending: view?.ending?.endingId ?? null };
  }
  return out;
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const command = JSON.parse(line);
  if (command.cmd === 'drop') {
    faults.push({ type: command.type, close: Boolean(command.close) });
    process.stdout.write(JSON.stringify({ ok: true }) + '\n');
  } else if (command.cmd === 'hold') {
    faults.push({ type: command.type, hold: true });
    process.stdout.write(JSON.stringify({ ok: true }) + '\n');
  } else if (command.cmd === 'release') {
    for (const send of held.splice(0)) send();
    process.stdout.write(JSON.stringify({ ok: true }) + '\n');
  } else if (command.cmd === 'report') {
    process.stdout.write(JSON.stringify(report()) + '\n');
  } else if (command.cmd === 'quit') {
    break;
  }
}
await app.close();
process.exit(0);
