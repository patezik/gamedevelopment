import { buildApp } from '../../../apps/server/src/app.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../../../apps/server/src/config/index.ts';
import { asDebugSource } from '../../../apps/server/src/diagnostics/debug.ts';
import { createSessionServices } from '../../../apps/server/src/routes/generation.ts';
import { CreateSessionResponse } from '../../../apps/server/src/routes/sessions.ts';
import type { EvidenceTokenStore } from '../../../apps/server/src/qr/index.ts';
import type { InvestigationProvider } from '../../../apps/server/src/sessions/index.ts';

export interface BotServerOptions {
  /**
   * Turn the NPC simulation port (ENG-014) on for the sessions of this server. Test configuration
   * only: the server default stays off (OQ-27). The planner (VAL-003) searches with it on, so the
   * path it builds is valid only for an engine that has it too.
   */
  readonly npcSimulation?: boolean;
}

/**
 * The production assembly of the Session Server (`createSessionServices` + `buildApp`, SRV-013) on
 * a random local port. Nothing is stubbed. It runs in this process so the bot can stand in for the
 * phone camera (the raw text of a QR) and read the state hash; everything else goes over HTTP/WS.
 */
export async function startBotServer({ npcSimulation = true }: BotServerOptions = {}) {
  const config = readConfig({
    HS_DATA_DIR: mkdtempSync(join(tmpdir(), 'hs-data-')),
    HS_LOG_LEVEL: 'silent',
    HS_HOST: '127.0.0.1',
  });
  const services = createSessionServices(config);
  if (npcSimulation) {
    // `generation` is the real provider; the route typing only shows its `onGenerated`.
    const provider = services.sessions.generation as unknown as InvestigationProvider;
    const create = provider.create.bind(provider);
    provider.create = async (...args) => {
      const created = await create(...args);
      return { ...created, ports: { ...created.ports, npcSimulation: true } };
    };
  }
  // Remember each session's token store: it holds the text that the desktop draws as a QR.
  const stores = new Map<string, EvidenceTokenStore>();
  const qr = services.qr.qr;
  const attach = qr.attach.bind(qr);
  qr.attach = (session, store) => {
    stores.set(session.id, store);
    attach(session, store);
  };
  const app = buildApp(config, services);
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });

  return {
    baseUrl,
    /** `POST /api/v1/sessions`. */
    async createSession(scenarioId: string, seed: string) {
      const response = await fetch(`${baseUrl}/api/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioId, seed }),
      });
      if (response.status !== 201) {
        throw new Error(`Session was not created: ${response.status} ${await response.text()}`);
      }
      return CreateSessionResponse.parse(await response.json());
    },
    /** What the camera reads off the screen: the text under the QR the desktop shows. */
    qrText(sessionId: string, tokenId: string): string {
      const store = stores.get(sessionId);
      if (!store) throw new Error('Unknown session');
      return store.payload(tokenId);
    },
    /** `GameEngine.stateHash()` of a session (the value the debug export reports). */
    stateHash(sessionId: string): string {
      const session = services.sessions.sessions.get(sessionId);
      const source = session && asDebugSource(session.engine);
      if (!source) throw new Error('The session engine has no state hash');
      return source.stateHash();
    },
    close: () => app.close(),
  };
}
export type BotServer = Awaited<ReturnType<typeof startBotServer>>;
