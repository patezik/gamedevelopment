import type { z } from 'zod';
import type {
  archetypesSchema,
  crimesSchema,
  deductionRulesSchema,
  itemsSchema,
  locationsSchema,
  motivesSchema,
  phoneTemplatesSchema,
  presetSchema,
  relationshipsSchema,
  textTemplatesSchema,
  traceRulesSchema,
} from './schemas.ts';

export interface ScenarioContent {
  preset: z.infer<typeof presetSchema>;
  locations: z.infer<typeof locationsSchema>;
  items: z.infer<typeof itemsSchema>;
  archetypes: z.infer<typeof archetypesSchema>;
  relationships: z.infer<typeof relationshipsSchema>;
  motives: z.infer<typeof motivesSchema>;
  crimes: z.infer<typeof crimesSchema>;
  traceRules: z.infer<typeof traceRulesSchema>;
  deductionRules: z.infer<typeof deductionRulesSchema>;
  text: Record<string, Record<string, z.infer<typeof textTemplatesSchema>>>;
  phone: Record<string, z.infer<typeof phoneTemplatesSchema>>;
}

export interface ScenarioSummary {
  id: string;
  title: ScenarioContent['preset']['title'];
  durationMinutes: number;
}

export interface ContentRepo {
  listScenarios(): ScenarioSummary[];
  load(id: string): ScenarioContent;
}

export interface ContentIssue {
  code: 'CONTENT_SCHEMA_ERROR' | 'CONTENT_DANGLING_REF' | 'CONTENT_MISSING_TRACE_RULE';
  path: string;
  message: string;
}

export class ContentError extends Error {
  readonly issues: readonly ContentIssue[];

  constructor(issues: readonly ContentIssue[]) {
    super(issues.map(({ code, path, message }) => `${code} ${path}: ${message}`).join('\n'));
    this.name = 'ContentError';
    this.issues = issues;
  }
}
