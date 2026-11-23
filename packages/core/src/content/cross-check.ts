import type { ContentIssue, ScenarioContent } from './scenario.ts';

export function crossCheck(content: ScenarioContent): ContentIssue[] {
  const issues: ContentIssue[] = [];
  function index(rows: readonly { id: string }[], path: string): Set<string> {
    const ids = new Set<string>();
    rows.forEach(({ id }, row) => {
      if (ids.has(id)) {
        issues.push({
          code: 'CONTENT_SCHEMA_ERROR',
          path: `${path}[${row}].id`,
          message: `Duplicate ID "${id}"`,
        });
      }
      ids.add(id);
    });
    return ids;
  }

  function reference(ids: Set<string>, id: string | undefined, path: string) {
    if (id !== undefined && !ids.has(id)) {
      issues.push({ code: 'CONTENT_DANGLING_REF', path, message: `Unknown ID "${id}"` });
    }
  }

  function references(ids: Set<string>, values: readonly string[] | undefined, path: string) {
    values?.forEach((id, entry) => reference(ids, id, `${path}[${entry}]`));
  }

  const locations = index(content.locations, 'locations');
  const items = index(content.items, 'items');
  const archetypes = index(content.archetypes, 'archetypes');
  const crimes = index(content.crimes, 'crimes');
  index(content.relationships, 'relationships');
  index(content.motives, 'motives');
  index(content.deductionRules, 'deductionRules');
  const endings = new Set(content.preset.endings);
  const traceVerbs = new Set(content.traceRules.map(({ verb }) => verb));

  const world = content.preset.world;
  reference(locations, world?.startLocationId, 'preset.world.startLocationId');
  const variants = world?.variants ?? [];
  index(variants, 'preset.world.variants');
  variants.forEach((variant, row) => {
    const path = `preset.world.variants[${row}]`;
    variant.doors?.forEach(({ from, to, locked }, entry) => {
      const doorPath = `${path}.doors[${entry}]`;
      const destinations = new Set(
        content.locations.find(({ id }) => id === from)?.connections.map(({ to }) => to),
      );
      reference(locations, from, `${doorPath}.from`);
      reference(destinations, to, `${doorPath}.to`);
      reference(items, locked?.itemId, `${doorPath}.locked.itemId`);
    });
    variant.spawns?.forEach(({ itemId, placement }, entry) => {
      const spawnPath = `${path}.spawns[${entry}]`;
      const targets = { location: locations, container: items, archetype: archetypes };
      reference(items, itemId, `${spawnPath}.itemId`);
      reference(targets[placement.kind], placement.id, `${spawnPath}.placement.id`);
    });
  });

  references(crimes, content.preset.incident.templates, 'preset.incident.templates');
  references(
    archetypes,
    content.preset.incident.victimConstraints.excludeArchetypes,
    'preset.incident.victimConstraints.excludeArchetypes',
  );
  content.preset.cast.quotas.forEach(({ archetype }, row) =>
    reference(archetypes, archetype, `preset.cast.quotas[${row}].archetype`),
  );
  content.preset.deadlines.forEach(({ outcome }, row) =>
    reference(endings, outcome, `preset.deadlines[${row}].outcome`),
  );

  content.locations.forEach((location, row) => {
    const path = `locations[${row}]`;
    location.connections.forEach(({ to, locked }, entry) => {
      reference(locations, to, `${path}.connections[${entry}].to`);
      reference(items, locked?.itemId, `${path}.connections[${entry}].locked.itemId`);
    });
    location.access.forEach((rule, entry) => {
      reference(items, rule.itemId, `${path}.access[${entry}].itemId`);
      references(archetypes, rule.archetypes, `${path}.access[${entry}].archetypes`);
    });
    index(location.hotspots, `${path}.hotspots`);
    location.hotspots.forEach(({ itemIds }, entry) =>
      references(items, itemIds, `${path}.hotspots[${entry}].itemIds`),
    );
  });
  content.items.forEach((item, row) => {
    reference(locations, item.locationId, `items[${row}].locationId`);
    reference(items, item.containerId, `items[${row}].containerId`);
    reference(archetypes, item.ownerArchetype, `items[${row}].ownerArchetype`);
  });
  content.archetypes.forEach((archetype, row) => {
    archetype.routine.forEach(({ locationId }, entry) =>
      reference(locations, locationId, `archetypes[${row}].routine[${entry}].locationId`),
    );
    archetype.access.forEach((grant, entry) => {
      reference(locations, grant.locationId, `archetypes[${row}].access[${entry}].locationId`);
      reference(items, grant.itemId, `archetypes[${row}].access[${entry}].itemId`);
    });
  });
  content.relationships.forEach((relationship, row) => {
    references(archetypes, relationship.fromArchetypes, `relationships[${row}].fromArchetypes`);
    references(archetypes, relationship.toArchetypes, `relationships[${row}].toArchetypes`);
  });
  content.crimes.forEach((crime, row) => {
    reference(items, crime.requires.means.itemId, `crimes[${row}].requires.means.itemId`);
    const steps = new Set(crime.plan.map(({ step }) => step));
    crime.plan.forEach(({ verb, before, after }, entry) => {
      const path = `crimes[${row}].plan[${entry}]`;
      reference(steps, before, `${path}.before`);
      reference(steps, after, `${path}.after`);
      if (!traceVerbs.has(verb)) {
        issues.push({
          code: 'CONTENT_MISSING_TRACE_RULE',
          path: `${path}.verb`,
          message: `No trace rule for verb "${verb}"`,
        });
      }
    });
  });
  content.traceRules.forEach((rule, row) => {
    reference(items, rule.when?.itemId, `traceRules[${row}].when.itemId`);
    rule.produces.forEach(({ at, requires }, entry) => {
      const path = `traceRules[${row}].produces[${entry}]`;
      if (!at.startsWith('$')) reference(locations, at, `${path}.at`);
      reference(items, requires?.itemId, `${path}.requires.itemId`);
    });
  });
  return issues;
}
