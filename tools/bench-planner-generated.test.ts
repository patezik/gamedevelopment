import { expect, test } from 'vitest';
import { examineGeneratedCase, generatedPlannerCase, seeds } from './bench-planner-generated.ts';

test.each(seeds)(
  'sanatorium_winter seed %s passes the default gate but needs a public incident briefing',
  (seed) => {
    const generated = generatedPlannerCase(seed);
    const { createEngine, server } = generated;
    const result = examineGeneratedCase(seed, generated);
    expect(result).toMatchObject({
      seed,
      budget: 3024,
      failure: 'TIME_INCIDENT_CONTEXT_MISSING',
      scheduledPresence: 0,
      requiredWithoutHotspot: 3,
    });
    expect(result.qrWithoutHotspot).toBe(result.qrClues);
    const engine = createEngine();
    expect(engine.playerView().presentCharacters).toEqual([]);
    expect(engine.dispatch('desktop', { type: 'read', documentId: 'duty_log_entry' }).ok).toBe(
      true,
    );
    expect(engine.playerView().caseBoard.clues.length).toBeGreaterThan(0);
    expect(engine.dispatch('desktop', { type: 'move', locationId: 'loc_doctor_office' }).ok).toBe(
      true,
    );
    expect(engine.dispatch('desktop', { type: 'examineLocation' }).ok).toBe(true);
    for (const hotspotId of ['missing_substance', 'residue_in_cup']) {
      expect(
        server.clues.some(
          ({ captureMode, discovery }) =>
            captureMode === 'qr' &&
            discovery.locationId === 'loc_doctor_office' &&
            discovery.action.type === 'examineHotspot' &&
            discovery.action.hotspotId === hotspotId,
        ),
      ).toBe(true);
      expect(engine.dispatch('desktop', { type: 'examineHotspot', hotspotId })).toMatchObject({
        ok: false,
        error: 'ACTION_NOT_AVAILABLE',
      });
      expect(engine.playerView().pendingCapture).toBeUndefined();
    }
  },
  60_000,
);
