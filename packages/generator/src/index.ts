export { worldGen, type GeneratedWorld } from './stages/world-gen.ts';
export const GENERATOR_PACKAGE_NAME = '@hs/generator';
export * from './pipeline/index.ts';
export { castGen } from './stages/cast-gen.ts';
export {
  ADULT_AGE,
  MAX_PARENT_AGE_GAP,
  MAX_SIBLING_AGE_GAP,
  MIN_PARENT_AGE_GAP,
  MIN_RELATIONSHIP_PARTNERS,
  MIN_SECRETS_PER_CHARACTER,
  RELATIONSHIP_EVENT_VERB,
  SECRET_EVENT_VERB,
  SIGNIFICANT_INTENSITY,
  socialGen,
  type SecretOrigin,
  type SocialSecret,
  type SocialWorld,
} from './stages/social-gen.ts';
export {
  conflictGen,
  MOTIVE_EVENT_VERB,
  MOTIVE_HISTOGRAM_BINS,
  motiveFact,
  type ConflictWorld,
  type MotiveCandidate,
  type MotiveReport,
  type MotiveTypeStats,
} from './stages/conflict-gen.ts';
export {
  assessIncidents,
  DEFAULT_CULPRIT_GAMMA,
  FEASIBILITY_CRITERIA,
  INCIDENT_NO_FEASIBLE_CULPRIT,
  incidentSelection,
  OPPORTUNITY_SATURATION_MINUTES,
  SCORE_WEIGHTS,
  selectIncident,
  WORLD_OWNER_ABSENT,
  type Acquisition,
  type FeasibilityCriterion,
  type FeasibleCulprit,
  type IncidentAssessment,
  type IncidentOption,
  type IncidentPlan,
  type IncidentReport,
  type IncidentSelectionInput,
  type IncidentTemplateStats,
  type IncidentWorld,
  type Opportunity,
} from './stages/incident-selection.ts';
