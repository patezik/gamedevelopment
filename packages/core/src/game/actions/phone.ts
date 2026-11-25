import type { ErrorCode, PlayerAction } from '@hs/protocol';
import { z } from 'zod';
import type { Clue } from '../../evidence/index.ts';
import {
  createPhoneState,
  reducePhone,
  type PhoneActiveCall,
  type PhoneEvent,
  type PhoneState,
} from '../../phone/index.ts';
import { drainPhone, phoneCall, phoneScan } from '../../survival/index.ts';
import { resolveActionCost, type ActionCostTable, type CostModifier } from '../../time/index.ts';
import { announceContradictions } from './desktop.ts';
import type { GameEvent, PhoneActionType } from './events.ts';
import type { DesktopState } from './state.ts';

export const PHONE_ACTIONS: readonly PhoneActionType[] = [
  'call',
  'answerCall',
  'callChoice',
  'message',
  'browse',
  'openFile',
  'unlockFile',
  'addNote',
  'captureEvidence',
];

export function isPhoneAction(type: string): type is PhoneActionType {
  return (PHONE_ACTIONS as readonly string[]).includes(type);
}

/** Minutes of the small phone actions that have no row in the cost table. */
const QUICK_MINUTES = 1;
const OUTGOING_OPENING = 'Алло?';

type Choice = { readonly id: string; readonly text: string };

/**
 * What the simulation decides about phone conversations. Every method is optional: without one
 * the call goes unanswered, a call line ends the call and a message gets no reply. Answers must
 * be a pure function of the arguments, so a replayed game gets the same ones.
 */
export interface PhonePort {
  /** The starting phone of the hero. */
  readonly initial?: PhoneState;
  /** The contact picks up: their greeting and the topics the player may raise. `undefined`: no answer. */
  callGreeting?(
    contactId: string,
    at: number,
  ): { readonly text: string; readonly choices: readonly Choice[] } | undefined;
  /** The contact's answer to a topic. No choices, or `end`, finishes the call. */
  callReply?(
    contactId: string,
    choiceId: string,
    at: number,
  ): {
    readonly text: string;
    readonly choices?: readonly Choice[];
    readonly minutes?: number;
    readonly end?: boolean;
  };
  /** Plans the reply to a sent template: how many minutes it takes and what it says. */
  messageReply?(
    contactId: string,
    templateId: string,
    at: number,
  ):
    | { readonly delayMinutes: number; readonly text: string; readonly replies?: readonly Choice[] }
    | undefined;
}

export interface PendingReply {
  readonly id: string;
  readonly at: number;
  readonly threadId: string;
  readonly contactId: string;
  readonly text: string;
  readonly replies?: readonly Choice[];
}

const listOf = z.array(z.unknown());
const runtimeSchema = z.strictObject({
  state: z.looseObject({
    contacts: listOf,
    threads: listOf,
    callLog: listOf,
    gallery: listOf,
    files: listOf,
    notes: listOf,
    mapPins: listOf,
    browserPages: listOf,
    notifications: listOf,
    battery: z.int().min(0).max(100),
  }),
  carryMinutes: z.int().min(0).max(9),
  seq: z.int().nonnegative(),
  pendingReplies: z.array(
    z.strictObject({
      id: z.string().min(1),
      at: z.int(),
      threadId: z.string().min(1),
      contactId: z.string().min(1),
      text: z.string(),
      replies: z.array(z.strictObject({ id: z.string(), text: z.string() })).optional(),
    }),
  ),
});
export type PhoneRuntimeSnapshot = z.infer<typeof runtimeSchema>;

/** Server-side phone of the hero: content, battery remainder, id counter and queued replies. */
export class PhoneRuntime {
  state: PhoneState;
  /** Minutes of use not yet turned into a battery percent. */
  carryMinutes = 0;
  seq = 0;
  pendingReplies: PendingReply[] = [];

  constructor(initial: PhoneState = createPhoneState()) {
    this.state = initial;
  }

  /** Applies a phone event and returns it, to be put into the dispatch result. */
  emit(event: PhoneEvent): PhoneEvent {
    this.state = reducePhone(this.state, event);
    return event;
  }

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  #setPercent(percent: number, carryMinutes: number): PhoneEvent[] {
    this.carryMinutes = carryMinutes;
    return percent === this.state.battery
      ? []
      : [this.emit({ type: 'BatteryChanged', battery: percent })];
  }

  /** -1 % per 10 minutes of game time; the remainder carries over. */
  drain(minutes: number): PhoneEvent[] {
    const next = drainPhone(
      { percent: this.state.battery, carryMinutes: this.carryMinutes },
      minutes,
    );
    return this.#setPercent(next.percent, next.carryMinutes);
  }

  /** A call (-2 %) or a scan (-1 %). */
  spend(kind: 'call' | 'scan'): PhoneEvent[] {
    const next = (kind === 'call' ? phoneCall : phoneScan)({
      percent: this.state.battery,
      carryMinutes: this.carryMinutes,
    });
    return this.#setPercent(next.percent, next.carryMinutes);
  }

  /** Delivers the replies due by `now`, in the order of their time. */
  deliverDue(now: number): PhoneEvent[] {
    const due = this.pendingReplies
      .filter(({ at }) => at <= now)
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    if (due.length === 0) return [];
    this.pendingReplies = this.pendingReplies.filter(({ at }) => at > now);
    const events: PhoneEvent[] = [];
    for (const reply of due) {
      const name = this.state.contacts.find(({ id }) => id === reply.contactId)?.name ?? '';
      events.push(
        this.emit({ type: 'TypingChanged', threadId: reply.threadId, typing: false }),
        this.emit({
          type: 'MessageReceived',
          thread: {
            id: reply.threadId,
            contactId: reply.contactId,
            ...(reply.replies && { availableReplies: reply.replies }),
          },
          message: { id: reply.id, text: reply.text, at: reply.at },
        }),
        this.emit({
          type: 'NotificationPosted',
          notification: {
            id: `ntf_${reply.id}`,
            appId: 'messages',
            title: name,
            text: reply.text,
            at: reply.at,
            read: false,
          },
        }),
      );
    }
    return events;
  }

  serialize(): PhoneRuntimeSnapshot {
    return structuredClone({
      state: this.state,
      carryMinutes: this.carryMinutes,
      seq: this.seq,
      pendingReplies: this.pendingReplies,
    }) as unknown as PhoneRuntimeSnapshot;
  }

  static restore(saved: unknown): PhoneRuntime {
    const data = runtimeSchema.parse(saved);
    const runtime = new PhoneRuntime(structuredClone(data.state) as unknown as PhoneState);
    runtime.carryMinutes = data.carryMinutes;
    runtime.seq = data.seq;
    runtime.pendingReplies = structuredClone(data.pendingReplies) as PendingReply[];
    return runtime;
  }
}

export interface PhoneActionEnv {
  readonly runtime: PhoneRuntime;
  readonly desktop: DesktopState;
  readonly clues: readonly Clue[];
  readonly now: number;
  readonly costs: ActionCostTable;
  readonly modifiers: readonly CostModifier[];
  readonly port?: PhonePort;
  /** The capture the player can fix right now (engine `pendingEvidenceCapture`). */
  readonly pendingCapture?: { readonly tokenId: string; readonly clueId: string };
}

export interface PhonePlan {
  readonly type: PhoneActionType;
  readonly minutes: number;
  readonly interruptible: false;
  readonly verb: string;
  /** Applies the effect after time has passed; `completed` is false if time ran out first. */
  resolve(done: { readonly at: number; readonly completed: boolean }): GameEvent[];
}

type Phone = Extract<PlayerAction, { type: PhoneActionType }>;

const NOT_AVAILABLE: ErrorCode = 'ACTION_NOT_AVAILABLE';

/**
 * Plans a phone action: validates it against the phone and returns the time it takes and its
 * effect, or the error code. Nothing changes until `resolve`. A phone at 0 % is off.
 */
export function planPhoneAction(action: Phone, env: PhoneActionEnv): PhonePlan | ErrorCode {
  const { runtime, now } = env;
  const phone = runtime.state;
  if (phone.battery === 0) return NOT_AVAILABLE;
  const cost = (kind: 'call' | 'message' | 'captureEvidence'): number =>
    resolveActionCost(kind, { modifiers: env.modifiers }, env.costs).expected;
  const plan = (minutes: number, resolve: PhonePlan['resolve']): PhonePlan => ({
    type: action.type,
    minutes,
    interruptible: false,
    verb: action.type,
    resolve,
  });

  switch (action.type) {
    case 'call': {
      const contact = phone.contacts.find(({ id }) => id === action.contactId);
      if (!contact || phone.activeCall) return NOT_AVAILABLE;
      return plan(cost('call'), ({ at, completed }) => {
        if (!completed) return [];
        const greeting = env.port?.callGreeting?.(contact.id, at);
        if (!greeting) {
          return [
            runtime.emit({
              type: 'CallMissed',
              entry: { id: runtime.nextId('call'), contactId: contact.id, at, durationMinutes: 0 },
            }),
          ];
        }
        const call: PhoneActiveCall = {
          callId: runtime.nextId('call'),
          contactId: contact.id,
          state: 'active',
          startedAt: at,
          lines: [
            { speaker: 'player', text: OUTGOING_OPENING },
            { speaker: 'other', text: greeting.text },
          ],
          choices: greeting.choices,
        };
        return [runtime.emit({ type: 'CallStarted', call }), ...runtime.spend('call')];
      });
    }
    case 'answerCall': {
      const call = phone.activeCall;
      if (call?.callId !== action.callId || call.state !== 'ringing') return NOT_AVAILABLE;
      return plan(QUICK_MINUTES, ({ completed }) =>
        completed
          ? [runtime.emit({ type: 'CallAnswered', callId: call.callId }), ...runtime.spend('call')]
          : [],
      );
    }
    case 'callChoice': {
      const call = phone.activeCall;
      const choice = call?.choices.find(({ id }) => id === action.choiceId);
      if (call?.state !== 'active' || !choice) return NOT_AVAILABLE;
      const reply = env.port?.callReply?.(call.contactId, choice.id, now);
      const minutes = Math.max(QUICK_MINUTES, Math.round(reply?.minutes ?? QUICK_MINUTES));
      return plan(minutes, ({ at, completed }) => {
        if (!completed) return [];
        const choices = reply?.choices ?? [];
        const events: PhoneEvent[] = [
          runtime.emit({
            type: 'CallLineAdded',
            callId: call.callId,
            speaker: 'player',
            text: choice.text,
            choices: [],
          }),
        ];
        if (reply) {
          events.push(
            runtime.emit({
              type: 'CallLineAdded',
              callId: call.callId,
              speaker: 'other',
              text: reply.text,
              choices,
            }),
          );
        }
        if (!reply || reply.end === true || choices.length === 0) {
          events.push(runtime.emit({ type: 'CallEnded', callId: call.callId, at }));
        }
        return events;
      });
    }
    case 'message': {
      const thread = phone.threads.find(({ contactId }) => contactId === action.contactId);
      const template = thread?.availableReplies.find(({ id }) => id === action.templateId);
      if (!thread || !template || !phone.contacts.some(({ id }) => id === thread.contactId)) {
        return NOT_AVAILABLE;
      }
      return plan(cost('message'), ({ at, completed }) => {
        if (!completed) return [];
        const events: PhoneEvent[] = [
          runtime.emit({
            type: 'MessageSent',
            threadId: thread.id,
            message: { id: runtime.nextId('msg'), text: template.text, at },
          }),
        ];
        const reply = env.port?.messageReply?.(thread.contactId, template.id, at);
        if (reply) {
          runtime.pendingReplies.push({
            id: runtime.nextId('msg'),
            at: at + Math.max(0, Math.round(reply.delayMinutes)),
            threadId: thread.id,
            contactId: thread.contactId,
            text: reply.text,
            ...(reply.replies && { replies: reply.replies }),
          });
          events.push(runtime.emit({ type: 'TypingChanged', threadId: thread.id, typing: true }));
        }
        return events;
      });
    }
    case 'browse': {
      const page = phone.browserPages.find(({ id }) => id === action.pageId);
      if (!page) return NOT_AVAILABLE;
      return plan(QUICK_MINUTES, ({ at, completed }) =>
        completed ? [{ type: 'PageViewed', pageId: page.id, at }] : [],
      );
    }
    case 'openFile': {
      const file = phone.files.find(({ id }) => id === action.fileId);
      if (!file || file.hidden || file.locked) return NOT_AVAILABLE;
      return plan(QUICK_MINUTES, ({ at, completed }) =>
        completed ? [{ type: 'FileOpened', fileId: file.id, at }] : [],
      );
    }
    case 'unlockFile': {
      const file = phone.files.find(({ id }) => id === action.fileId);
      if (!file || file.hidden || !file.locked || file.password === undefined) return NOT_AVAILABLE;
      return plan(QUICK_MINUTES, ({ at, completed }) => {
        if (!completed) return [];
        const success = action.password === file.password;
        return [
          ...(success ? [runtime.emit({ type: 'FileUnlocked', fileId: file.id })] : []),
          { type: 'FileUnlockAttempted', fileId: file.id, success, at },
        ];
      });
    }
    case 'addNote':
      return plan(QUICK_MINUTES, ({ at, completed }) =>
        completed
          ? [
              runtime.emit({
                type: 'NoteAdded',
                note: { id: runtime.nextId('note'), source: 'player', text: action.text, at },
              }),
            ]
          : [],
      );
    case 'captureEvidence': {
      const pending = env.pendingCapture;
      const clue = env.clues.find(({ id }) => id === pending?.clueId);
      if (!pending || pending.tokenId !== action.tokenId || !clue) return NOT_AVAILABLE;
      if (env.desktop.knowledge.clues.get(clue.id)?.captured === true) return NOT_AVAILABLE;
      return plan(cost('captureEvidence'), ({ at, completed }) => {
        if (!completed) return [];
        const { knowledge } = env.desktop;
        if (knowledge.clues.has(clue.id)) knowledge.markCaptured(clue.id, at);
        else {
          knowledge.addClue({
            clueId: clue.id,
            discoveredAt: at,
            location: clue.discovery.locationId,
            captured: true,
          });
        }
        return [
          { type: 'EvidenceCaptured', clueId: clue.id, tokenId: pending.tokenId, at },
          runtime.emit({
            type: 'PhotoAdded',
            photo: {
              id: runtime.nextId('photo'),
              title: 'Снимок',
              imageRef: `capture_${clue.id}`,
              takenAt: at,
            },
          }),
          ...runtime.spend('scan'),
          ...announceContradictions(env.desktop, env.clues, at),
        ];
      });
    }
  }
}
