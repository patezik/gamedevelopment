import type { Investigation } from './investigation.ts';

/** Id of the inspection point where a body lies (OQ-28: finding the body is only this inspection). */
export const BODY_HOTSPOT_ID = 'hs_body';

/** Shown to the player like any other hotspot; it says nothing about the cause of death. */
export const BODY_HOTSPOT_NAME = 'Тело';

/**
 * Whether a body lies in the room at `minute`: a character died there (truth log: state
 * `alive = false`) at or before this minute. Deaths are irreversible, the body stays in place.
 */
export function bodyLiesAt(
  investigation: Investigation,
  locationId: string,
  minute: number,
): boolean {
  return investigation.truth
    .events()
    .some(
      (event) =>
        event.location === locationId &&
        event.facts.some(
          (fact) =>
            fact.kind === 'state' &&
            fact.entity.kind === 'character' &&
            fact.property === 'alive' &&
            fact.value === false &&
            fact.interval.from <= minute,
        ),
    );
}

/** The room's hotspots as the player sees them: those of the content plus the body, if any. */
export function visibleHotspots(
  investigation: Investigation,
  locationId: string,
  minute: number,
): readonly { readonly id: string; readonly name: string }[] {
  const { hotspots } = investigation.world.locations.describe(locationId);
  return bodyLiesAt(investigation, locationId, minute)
    ? [...hotspots, { id: BODY_HOTSPOT_ID, name: BODY_HOTSPOT_NAME }]
    : hotspots;
}
