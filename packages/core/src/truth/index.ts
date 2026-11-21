export {
  entityRefSchema,
  factId,
  factIdSchema,
  factSchema,
  matchProposition,
  verbSchema,
  type EntityRef,
  type Fact,
  type FactId,
  type Proposition,
  type PropositionPattern,
  type Verb,
} from './facts.ts';

export {
  assertInvariants,
  checkTruthInvariants,
  TruthInvariantError,
  withInvariantChecks,
  type InvariantCheckOptions,
  type InvariantDebugOptions,
  type InvariantNumber,
  type InvariantViolation,
  type InvariantViolationCode,
  type InvariantWorld,
  type TruthWriter,
} from './invariants.ts';

export {
  TruthError,
  TruthLog,
  TruthModel,
  type EventId,
  type FactFilter,
  type IncidentRecord,
  type TruthEvent,
  type TruthEventInput,
} from './truth-model.ts';
