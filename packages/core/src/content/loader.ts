import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { z } from 'zod';
import { crossCheck } from './cross-check.ts';
import { ContentError, type ContentRepo, type ScenarioContent } from './scenario.ts';
import {
  archetypesSchema,
  crimesSchema,
  deductionRulesSchema,
  itemsSchema,
  locationsSchema,
  motivesSchema,
  phoneTemplatesSchema,
  presetSchema,
  relationshipsSchema,
  scenarioIdSchema,
  textTemplatesSchema,
  traceRulesSchema,
} from './schemas.ts';

function schemaError(path: string, message: string): never {
  throw new ContentError([{ code: 'CONTENT_SCHEMA_ERROR', path, message }]);
}

function appendPath(path: string, key: PropertyKey): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  const name = String(key);
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)
    ? `${path}.${name}`
    : `${path}[${JSON.stringify(name)}]`;
}

function readJson<T>(file: string, path: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    schemaError(path, `${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ContentError(
      result.error.issues.map((issue) => ({
        code: 'CONTENT_SCHEMA_ERROR',
        path: issue.path.reduce(appendPath, path),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

function listEntries(folder: string, kind: 'directory' | 'json', optional = false): string[] {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) =>
        kind === 'directory' ? entry.isDirectory() : entry.isFile() && entry.name.endsWith('.json'),
      )
      .map(({ name }) => name)
      .sort();
  } catch (error) {
    if (optional && error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    schemaError(folder, error instanceof Error ? error.message : String(error));
  }
}

function readTemplates<T>(folder: string, path: string, schema: z.ZodType<T>): Record<string, T> {
  return Object.fromEntries(
    listEntries(folder, 'json', true).map((name) => {
      const key = basename(name, '.json');
      return [key, readJson(join(folder, name), appendPath(path, key), schema)];
    }),
  );
}

export function loadScenarioFromDir(dir: string): ScenarioContent {
  const textDir = join(dir, 'text');
  const content: ScenarioContent = {
    preset: readJson(join(dir, 'preset.json'), 'preset', presetSchema),
    locations: readJson(join(dir, 'locations.json'), 'locations', locationsSchema),
    items: readJson(join(dir, 'items.json'), 'items', itemsSchema),
    archetypes: readJson(join(dir, 'archetypes.json'), 'archetypes', archetypesSchema),
    relationships: readJson(join(dir, 'relationships.json'), 'relationships', relationshipsSchema),
    motives: readJson(join(dir, 'motives.json'), 'motives', motivesSchema),
    crimes: readJson(join(dir, 'crimes.json'), 'crimes', crimesSchema),
    traceRules: readJson(join(dir, 'trace-rules.json'), 'traceRules', traceRulesSchema),
    deductionRules: readJson(
      join(dir, 'deduction-rules.json'),
      'deductionRules',
      deductionRulesSchema,
    ),
    text: Object.fromEntries(
      listEntries(textDir, 'directory', true).map((locale) => [
        locale,
        readTemplates(join(textDir, locale), appendPath('text', locale), textTemplatesSchema),
      ]),
    ),
    phone: readTemplates(join(dir, 'phone'), 'phone', phoneTemplatesSchema),
  };
  const issues = crossCheck(content);
  if (issues.length > 0) throw new ContentError(issues);
  return content;
}

function checkDirectoryId(directory: string, id: string): void {
  if (directory !== id) schemaError('preset.id', `Expected "${directory}", got "${id}"`);
}

export function createContentRepo(root: string): ContentRepo {
  return {
    listScenarios() {
      return listEntries(root, 'directory').map((directory) => {
        const preset = readJson(join(root, directory, 'preset.json'), 'preset', presetSchema);
        checkDirectoryId(directory, preset.id);
        return { id: preset.id, title: preset.title, durationMinutes: preset.time.durationMinutes };
      });
    },
    load(id) {
      if (!scenarioIdSchema.safeParse(id).success) schemaError('preset.id', 'Invalid scenario ID');
      const content = loadScenarioFromDir(join(root, id));
      checkDirectoryId(id, content.preset.id);
      return content;
    },
  };
}
