import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderSchemas } from '../scripts/schemas.ts';

const dir = new URL('../schemas/', import.meta.url);

describe('JSON Schema export', () => {
  it('is stable across repeated generation', () => {
    expect(renderSchemas()).toEqual(renderSchemas());
  });

  it('matches the committed files exactly', () => {
    const expected = renderSchemas();
    expect(readdirSync(dir).sort()).toEqual(Object.keys(expected).sort());
    for (const [file, text] of Object.entries(expected)) {
      expect(readFileSync(new URL(file, dir), 'utf8')).toBe(text);
    }
  });
});
