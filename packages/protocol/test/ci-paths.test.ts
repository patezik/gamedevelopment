import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GODOT_CONSTANTS_PATH } from '../scripts/godot.ts';
import { renderSchemas } from '../scripts/schemas.ts';

/**
 * The CI `changes` job routes a PR to the Node and Godot jobs with `grep -E` over changed paths.
 * The Node job runs the tests that compare generated protocol files, so every generated file must
 * select it, even when it is the only file a PR changes.
 */
const workflow = readFileSync(
  new URL('../../../.github/workflows/ci.yml', import.meta.url),
  'utf8',
);

function filter(name: string): RegExp {
  const pattern = new RegExp(`^\\s*${name}: '([^']+)'$`, 'm').exec(workflow)?.[1];
  if (pattern === undefined) throw new Error(`${name} not found in ci.yml`);
  return new RegExp(pattern);
}

const nodePaths = filter('NODE_PATHS');
const godotPaths = filter('GODOT_PATHS');
const generated = [
  ...Object.keys(renderSchemas()).map((file) => `packages/protocol/schemas/${file}`),
  GODOT_CONSTANTS_PATH,
];

describe('CI path filters', () => {
  it.each(generated)('%s selects the Node job', (path) => {
    expect(nodePaths.test(path)).toBe(true);
  });

  it('selects the Godot job for the generated constants and protocol fixtures', () => {
    expect(godotPaths.test(GODOT_CONSTANTS_PATH)).toBe(true);
    expect(godotPaths.test('packages/protocol/fixtures/views/player-view.start.json')).toBe(true);
  });

  it('does not route the rest of apps/desktop to the Node job', () => {
    for (const path of [
      'apps/desktop/src/net/envelope.gd',
      'apps/desktop/src/net/protocol_constants.gd.uid',
      'apps/desktop/src/net/protocol_constants_gd',
      'apps/desktop/tests/contract/test_protocol_fixtures.gd',
      'apps/desktop/project.godot',
    ]) {
      expect(nodePaths.test(path), path).toBe(false);
    }
  });
});
