import type { GameMinutes } from '../../common/index.ts';
import type { ContradictionFound } from '../../investigation/index.ts';
import type { PlayerAttacked, StaticEvent, SurvivalEvent } from '../../survival/index.ts';
import type { PhoneEvent } from '../../phone/index.ts';
import type { ClockEvent } from '../../time/index.ts';

/** The desktop action types that ENG-003 resolves (move and wait stay in ENG-001). */
export type DesktopActionType =
  | 'examineLocation'
  | 'examineHotspot'
  | 'talk'
  | 'interrogate'
  | 'read'
  | 'useItem'
  | 'pickLock'
  | 'rest';

/** The phone action types that ENG-004 resolves. */
export type PhoneActionType =
  | 'call'
  | 'answerCall'
  | 'callChoice'
  | 'message'
  | 'browse'
  | 'openFile'
  | 'unlockFile'
  | 'addNote'
  | 'captureEvidence';

/**
 * What characters could notice of a player action (SIM-006 turns it into wariness). Carries only
 * what the player did and who was there to see or hear it, never what is true.
 */
export interface PlayerActionObserved {
  readonly type: 'PlayerActionObserved';
  readonly at: GameMinutes;
  readonly action: DesktopActionType | 'move' | 'wait';
  readonly locationId: string;
  /** Characters in the player's location when the action started. */
  readonly witnessIds: readonly string[];
  /** Characters who heard a noisy action (`pickLock`): here and in adjacent locations. */
  readonly heardByIds: readonly string[];
  readonly characterId?: string;
  readonly topicId?: string;
  readonly clueId?: string;
  readonly contradictionId?: string;
}

/** PlayerKnowledge changes, in the vocabulary of modules.md section 9. */
export type KnowledgeEvent =
  | {
      readonly type: 'ClueDiscovered';
      readonly clueId: string;
      readonly locationId: string;
      readonly at: GameMinutes;
      readonly captureRequested: boolean;
    }
  | {
      readonly type: 'StatementHeard';
      readonly statementId: string;
      readonly characterId: string;
      readonly topicId: string;
      readonly at: GameMinutes;
    }
  | ContradictionFound;

export type ActionEvent =
  | {
      readonly type: 'InterrogationReaction';
      readonly characterId: string;
      readonly reaction: 'admit' | 'change' | 'refuse';
      readonly at: GameMinutes;
    }
  | {
      readonly type: 'LockPicked';
      readonly targetId: string;
      readonly success: boolean;
      readonly at: GameMinutes;
    }
  | { readonly type: 'PageViewed'; readonly pageId: string; readonly at: GameMinutes }
  | { readonly type: 'FileOpened'; readonly fileId: string; readonly at: GameMinutes }
  | {
      readonly type: 'FileUnlockAttempted';
      readonly fileId: string;
      readonly success: boolean;
      readonly at: GameMinutes;
    }
  | {
      readonly type: 'EvidenceCaptured';
      readonly clueId: string;
      readonly tokenId: string;
      readonly at: GameMinutes;
    }
  | { readonly type: 'ItemUsed'; readonly itemId: string; readonly at: GameMinutes }
  | { readonly type: 'ActionInterrupted'; readonly at: GameMinutes; readonly reason: string }
  | { readonly type: 'InteractionEnded'; readonly characterId: string; readonly at: GameMinutes }
  | { readonly type: 'AccusationConfirmationRequired'; readonly at: GameMinutes }
  /** What the player learns of a verdict: never who the culprits are (the ending recap does that). */
  | {
      readonly type: 'AccusationMade';
      readonly at: GameMinutes;
      readonly result: 'solved' | 'partial' | 'wrong_accusation';
      readonly proven: {
        readonly motive: boolean;
        readonly means: boolean;
        readonly opportunity: boolean;
      };
      /** `false`: a wrong accusation with time left; the investigation goes on. */
      readonly final: boolean;
    };

export type GameEvent =
  | ClockEvent
  | SurvivalEvent
  | StaticEvent
  | PlayerAttacked
  | KnowledgeEvent
  | ActionEvent
  | PlayerActionObserved
  | PhoneEvent;
