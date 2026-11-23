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
