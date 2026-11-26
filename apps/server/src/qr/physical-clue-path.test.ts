import { loadScenarioFromDir } from '@hs/core/content';
import { GameEngine } from '@hs/core/game';
import { generateInvestigation } from '@hs/generator';
import { describe, expect, it } from 'vitest';
import { defaultScenariosDir } from '../routes/generation.ts';
import { scenarioEnginePorts } from '../sessions/scenario-ports.ts';
import { Session } from '../sessions/index.ts';
import { QrService } from './service.ts';

// CNT-013 (transferred from SRV-012): on a really generated sanatorium the player finds the
// physical trace by examining its hotspot and fixes the QR clue through the real token store.

const content = loadScenarioFromDir(`${defaultScenariosDir()}sanatorium_winter`);

describe.each(['1', '2', '3', '6'])('sanatorium_winter seed %s', (seed) => {
  async function play() {
    const result = generateInvestigation({ scenarioId: 'sanatorium_winter', seed }, content);
    if (!result.ok) throw new Error('the seed is expected to pass the gate');
    const qr = new QrService({ gameMinute: () => engine.playerView().clock.t });
    const store = qr.createStore({ secret: Buffer.alloc(32, 7) });
    const ports = {
      ...scenarioEnginePorts(content, result.investigation, result.server),
      evidenceTokens: store,
    };
    const engine = GameEngine.create(result.investigation, ports);
    const session = new Session(`session-${seed}`, engine, () => 0);
    await session.activate();
    qr.attach(session, store);
    const required = new Set(result.server.requiredClueIds);
    const target = result.server.clues.find(
      (clue) =>
        required.has(clue.id) &&
        clue.captureMode === 'qr' &&
        clue.discovery.action.type === 'examineHotspot' &&
        clue.discovery.action.hotspotId === 'missing_substance',
    );
    if (!target || target.discovery.action.type !== 'examineHotspot') throw new Error('no clue');
    return { engine, session, qr, store, target, hotspotId: target.discovery.action.hotspotId };
  }

  it('examining the hotspot of a required physical clue reveals the trace and issues a QR', async () => {
    const { engine, target, hotspotId } = await play();
    expect(
      engine.dispatch('desktop', { type: 'move', locationId: target.discovery.locationId }),
    ).toMatchObject({ ok: true });
    expect(engine.dispatch('desktop', { type: 'examineLocation' })).toMatchObject({ ok: true });
    const view = engine.playerView();
    expect(view.location.id).toBe(target.discovery.locationId);
    expect(view.location.hotspots.map(({ id }) => id)).toContain(hotspotId);
    expect(view.pendingCapture).toBeUndefined();

    expect(engine.dispatch('desktop', { type: 'examineHotspot', hotspotId })).toMatchObject({
      ok: true,
    });
    const after = engine.playerView();
    expect(after.pendingCapture?.tokenId).toBeTruthy();
    // A QR clue joins the case board only once the phone has captured it.
    expect(after.caseBoard.clues.map(({ id }) => id)).not.toContain(target.id);
  });

  it('the QR goes from pendingCapture to a successful capture and a second scan is refused', async () => {
    const { engine, session, qr, store, target, hotspotId } = await play();
    await session.dispatch('desktop', { type: 'move', locationId: target.discovery.locationId });
    await session.dispatch('desktop', { type: 'examineLocation' });
    await session.dispatch('desktop', { type: 'examineHotspot', hotspotId });
    const pending = engine.playerView().pendingCapture;
    expect(pending).toBeDefined();
    const raw = store.payload(pending!.tokenId);

    expect(await qr.scan(session, raw)).toEqual({ ok: true, clueRef: target.id });
    expect(engine.playerView().pendingCapture).toBeUndefined();
    expect(engine.playerView().caseBoard.clues).toContainEqual(
      expect.objectContaining({ id: target.id, captured: true }),
    );
    expect(await qr.scan(session, raw)).toEqual({
      ok: false,
      error: 'QR_ALREADY_USED',
      clueRef: target.id,
    });
  });
});
