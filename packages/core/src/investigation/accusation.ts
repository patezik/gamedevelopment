import type { IncidentRecord } from '../truth/index.ts';
import {
  evaluateClaims,
  type ClaimContext,
  type ClaimKind,
  type DeductionRules,
} from './claims.ts';
import { PlayerKnowledge } from './player-knowledge.ts';

/** An established claim as `evaluateClaims` names it, for example `means(ch_bursar)`. */
export type ClaimRef = string;

/** The player's case: whom they accuse, what they say proves it, and the clues they attach. */
export interface CaseFile {
  readonly accusedIds: readonly string[];
  readonly motive?: ClaimRef;
  readonly means?: ClaimRef;
  readonly opportunity?: ClaimRef;
  readonly evidence: readonly string[];
}

export type AccusationEndingId = 'solved' | 'partial' | 'wrong_accusation';

/** What the world does next (investigation-model.md section 6); SIM-006 carries it out. */
export type ConsequenceRef =
  | { readonly kind: 'refuses_to_talk'; readonly characterId: string }
  | { readonly kind: 'trust_falls' }
  | { readonly kind: 'culprit_freed'; readonly characterId: string }
  | { readonly kind: 'culprit_destroys_evidence'; readonly characterId: string };

export interface AccusationOutcome {
  /** The accused are exactly the culprits. */
  readonly correct: boolean;
  /** Each part is proven by the attached clues for the accused. */
  readonly proven: {
    readonly motive: boolean;
    readonly means: boolean;
    readonly opportunity: boolean;
  };
  readonly endingId: AccusationEndingId;
  readonly consequences: readonly ConsequenceRef[];
}

export type AccusationErrorCode = 'CASEFILE_INCOMPLETE' | 'CASEFILE_UNKNOWN_EVIDENCE';

export class AccusationError extends Error {
  readonly code: AccusationErrorCode;
  /** The evidence ids that were refused (`CASEFILE_UNKNOWN_EVIDENCE`). */
  readonly evidenceIds: readonly string[];

  constructor(code: AccusationErrorCode, message: string, evidenceIds: readonly string[] = []) {
    super(message);
    this.name = 'AccusationError';
    this.code = code;
    this.evidenceIds = evidenceIds;
  }
}

export interface AccusationContext extends ClaimContext {
  readonly rules: DeductionRules;
  /** Clues that are hallucinations (server side); a case file naming one is refused. */
  readonly hallucinatedClueIds?: ReadonlySet<string>;
}

const PARTS = ['motive', 'means', 'opportunity'] as const satisfies readonly ClaimKind[];

/**
 * Judges an accusation. This is the one function of the Investigation Engine that reads the
 * truth, and it reads only who the culprits are.
 *
 * A case file must accuse someone (`CASEFILE_INCOMPLETE`) and attach only clues the player has
 * found and that are not hallucinations (`CASEFILE_UNKNOWN_EVIDENCE`). A claimed part is proven
 * when the deduction rules establish that exact claim for an accused person from the attached
 * clues (and the statements the player has heard). The ending is `solved` when the accused are
 * the culprits and all three parts are proven, `partial` when they are right but not fully
 * proven, and `wrong_accusation` otherwise.
 */
export function evaluateAccusation(
  caseFile: CaseFile,
  incident: Pick<IncidentRecord, 'culpritIds'>,
  knowledge: PlayerKnowledge,
  context: AccusationContext,
): AccusationOutcome {
  const accused = new Set(caseFile.accusedIds);
  if (accused.size === 0)
    throw new AccusationError('CASEFILE_INCOMPLETE', 'The case file accuses nobody');

  const attached = [...new Set(caseFile.evidence)];
  const refused = attached.filter(
    (id) => !knowledge.clues.has(id) || context.hallucinatedClueIds?.has(id),
  );
  if (refused.length > 0)
    throw new AccusationError(
      'CASEFILE_UNKNOWN_EVIDENCE',
      `The case file names clues the player does not hold: ${refused.join(', ')}`,
      refused,
    );

  const attachedKnowledge = new PlayerKnowledge();
  for (const id of attached) {
    const clue = knowledge.clues.get(id);
    if (clue) attachedKnowledge.addClue(clue);
  }
  for (const statement of knowledge.statements) attachedKnowledge.addStatement(statement);
  const claims = evaluateClaims(attachedKnowledge, context.rules, context);

  const proven = Object.fromEntries(
    PARTS.map((part) => {
      const ref = caseFile[part];
      return [
        part,
        ref !== undefined &&
          claims.some(
            (claim) => claim.kind === part && claim.claim === ref && accused.has(claim.subject),
          ),
      ];
    }),
  ) as AccusationOutcome['proven'];

  const culprits = new Set(incident.culpritIds);
  const correct = accused.size === culprits.size && [...accused].every((id) => culprits.has(id));
  const fullyProven = PARTS.every((part) => proven[part]);
  const endingId: AccusationEndingId = !correct
    ? 'wrong_accusation'
    : fullyProven
      ? 'solved'
      : 'partial';

  const consequences: ConsequenceRef[] =
    endingId === 'wrong_accusation'
      ? [
          ...[...accused]
            .sort()
            .map((characterId) => ({ kind: 'refuses_to_talk', characterId }) as const),
          { kind: 'trust_falls' },
          ...[...culprits]
            .sort()
            .map((characterId) => ({ kind: 'culprit_freed', characterId }) as const),
        ]
      : endingId === 'partial'
        ? [...culprits]
            .sort()
            .map((characterId) => ({ kind: 'culprit_destroys_evidence', characterId }) as const)
        : [];
  return { correct, proven, endingId, consequences };
}
