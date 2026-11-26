import {
  FORBIDDEN_VIEW_KEYS,
  PhoneView,
  PlayerView,
  type PlayerAction,
  type ServerMessage,
} from '@hs/protocol';
import { FakeDesktop, FakePhone } from '@hs/fake-client';
import { renderMatrix } from '../../../apps/server/src/qr/index.ts';
import { oracleFor, type Oracle } from './oracle.ts';
import type { BotServer } from './server.ts';

/** Random connection drops at action boundaries and in flight (INT-002 chaos mode). */
export interface BotChaos {
  /** Seed of the bot's own dice; the same seed drops at the same steps. */
  readonly seed: number;
  /** Chance (0..1) per step of cutting a connection; half of the cuts happen while the request is in flight. */
  readonly dropProbability: number;
}

export interface BotOptions {
  readonly scenarioId?: string;
  readonly seed: string;
  readonly chaos?: BotChaos;
  /** Replaces the planner's path, for tests that break it on purpose. */
  readonly path?: (oracle: Oracle) => readonly PlayerAction[];
}

export interface BotResult {
  readonly seed: string;
  readonly endingId: string | undefined;
  /** Steps of the path, QR captures included. */
  readonly steps: number;
  readonly captures: number;
  /** Game minute at the end and the planner's budget. */
  readonly minute: number;
  readonly budget: number;
  readonly drops: number;
  readonly stateHash: string;
}

/** mulberry32: a tiny seeded generator for the bot's dice (the bot is a tool, not game code). */
function dice(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Asserts nothing of the truth reached the client (§3.1 of AGENTS.md). */
function assertNoTruth(messages: readonly ServerMessage[], who: string): void {
  const json = JSON.stringify(messages);
  for (const key of [...FORBIDDEN_VIEW_KEYS, 'liePolicies', 'requiredClueIds', 'sourceEventId']) {
    if (json.includes(`"${key}":`)) throw new Error(`${who} received the forbidden key ${key}`);
  }
}

/**
 * Plays one investigation from session creation to an ending on a real server: creates the
 * session over REST, pairs the phone, then walks the `SolutionPath` of the planner. Desktop steps
 * go through the desktop WebSocket; a `captureEvidence` step reads the QR the desktop shows (REST
 * matrix, checked against the text of the token) and scans it on the phone. At the end the bot
 * accuses the culprit with the claims the planner proved. It sees the game only through
 * `PlayerView` and `PhoneView`.
 */
export async function runBot(server: BotServer, options: BotOptions): Promise<BotResult> {
  const { seed, scenarioId = 'sanatorium_winter', chaos } = options;
  const oracle = oracleFor(seed);
  const path = options.path ? options.path(oracle) : oracle.path;
  const roll = chaos ? dice(chaos.seed) : () => 1;
  const p = chaos?.dropProbability ?? 0;

  const created = await server.createSession(scenarioId, seed);
  const desktop = new FakeDesktop({
    baseUrl: server.baseUrl,
    token: created.desktopToken,
    sessionId: created.sessionId,
    timeoutMs: 10_000,
  });
  await desktop.connect();
  const phone = await FakePhone.pair({
    baseUrl: server.baseUrl,
    code: created.pairing.code,
    deviceName: 'E2E bot phone',
    timeoutMs: 10_000,
  });
  await phone.connect();
  await desktop.waitForPeers((s) => s.phone === 'online');
  let captures = 0;
  let drops = 0;

  const until = async (condition: () => boolean, what: string) => {
    for (let i = 0; i < 1000 && !condition(); i++) await sleep(5);
    if (!condition()) throw new Error(`Timed out waiting for ${what}`);
  };
  const reconnect = async (client: FakeDesktop | FakePhone) => {
    drops++;
    client.drop();
    await sleep(30);
    await client.reconnect();
  };

  /** A desktop request that survives cuts: after one, the state version tells if it was applied. */
  const send = async (action: PlayerAction, label: string) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = desktop.stateVersion;
      const inFlight = roll() < p / 2;
      const request = desktop.sendAction(action);
      request.catch(() => undefined);
      if (inFlight) await reconnect(desktop);
      try {
        const result = await request;
        if (!result.ok) throw new Error(`${label} was refused: ${result.error ?? 'no error code'}`);
        return;
      } catch (error) {
        if (!inFlight) throw error;
        if (error instanceof Error && error.message.includes('was refused')) throw error;
        await sleep(30);
        if (desktop.stateVersion > before) return;
      }
    }
    throw new Error(`${label} was not delivered`);
  };

  const step = async (action: PlayerAction, index: number) => {
    const label = `step ${index} (${action.type})`;
    if (roll() < p / 2) await reconnect(roll() < 0.5 ? desktop : phone);
    const before = desktop.stateVersion;
    if (action.type === 'captureEvidence') {
      // The token is the server's: the planner's own differs, the desktop shows what is pending.
      const pending = desktop.view && PlayerView.parse(desktop.view).pendingCapture;
      if (!pending) throw new Error(`${label}: the desktop shows no pending QR`);
      const matrix = await desktop.evidenceQr(pending.tokenId);
      const raw = server.qrText(created.sessionId, pending.tokenId);
      if (JSON.stringify(matrix) !== JSON.stringify(renderMatrix(raw))) {
        throw new Error(`${label}: the QR matrix does not carry the token`);
      }
      for (let attempt = 0; ; attempt++) {
        const request = phone.scanQr(raw);
        request.catch(() => undefined);
        const inFlight = roll() < p / 2;
        if (inFlight) await reconnect(phone);
        try {
          const result = await request;
          if (!result.ok) throw new Error(`${label}: scan failed (${result.error})`);
          break;
        } catch (error) {
          if (!inFlight || attempt > 4) throw error;
          if (error instanceof Error && error.message.includes('scan failed')) throw error;
          await sleep(30);
          if (desktop.stateVersion > before) break;
        }
      }
      captures++;
    } else {
      await send(action, label);
    }
    await until(() => desktop.stateVersion > before, `the desktop view after ${label}`);
  };

  let index = 0;
  for (const action of path) await step(action, index++);

  // The accusation: the claims were proven by the planner's knowledge, the evidence is what the
  // server shows on the case board.
  const board = PlayerView.parse(desktop.view).caseBoard;
  const evidence = board.clues.map(({ id }) => id);
  const missing = oracle.clueIds.filter((id) => !evidence.includes(id));
  if (path === oracle.path && missing.length > 0) {
    throw new Error(`The server lacks clues the planner found: ${missing.join(', ')}`);
  }
  const caseFile = {
    accusedIds: [...oracle.accusedIds],
    motive: oracle.claims.motive,
    means: oracle.claims.means,
    opportunity: oracle.claims.opportunity,
    evidence,
  };
  await send({ type: 'accuse', caseFile, confirm: false }, 'accusation request');
  await send(
    { type: 'accuse', caseFile, confirm: true, operationId: `e2e-${seed}-accuse` },
    'accusation',
  );
  await until(() => PlayerView.parse(desktop.view).ending !== undefined, 'the ending');

  const view = PlayerView.parse(desktop.view);
  const phoneView = phone.view && PhoneView.parse(phone.view);
  if (!phoneView) throw new Error('The phone never received a view');
  assertNoTruth(desktop.messages, 'desktop');
  assertNoTruth(phone.messages, 'phone');
  if (desktop.violations.length > 0 || phone.violations.length > 0) {
    throw new Error(
      `Protocol violations: ${[...desktop.violations, ...phone.violations].join('; ')}`,
    );
  }
  const result: BotResult = {
    seed,
    endingId: view.ending?.endingId,
    steps: path.length,
    captures,
    minute: view.clock.t,
    budget: oracle.budget,
    drops,
    stateHash: server.stateHash(created.sessionId),
  };
  await Promise.all([desktop.close(), phone.close()]);
  return result;
}
