import { PlayerAction, PROTOCOL_VERSION } from '@hs/protocol';
import { z } from 'zod';
import { stateHash } from '../common/index.ts';
import { GameEngine, type DispatchResult, type EnginePorts } from './engine.ts';
import type { Investigation } from './investigation.ts';

export const CHECKPOINT_INTERVAL = 50;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const actionSource = z.enum(['desktop', 'phone']);
export type ActionSource = z.infer<typeof actionSource>;
const entrySchema = z.strictObject({
  seq: z.int().positive(),
  source: actionSource,
  action: PlayerAction,
  stateHash: hash,
  journalHash: hash,
});
const metadataSchema = z.strictObject({
  scenarioId: z.string().min(1),
  seed: z.string(),
  generatorVersion: z.string().min(1),
  createdAt: z.iso.datetime(),
});

export const SaveFile = metadataSchema.extend({
  formatVersion: z.literal(1),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  initialStateHash: hash,
  actions: z.array(entrySchema),
  checkpoint: z
    .strictObject({
      atAction: z.int().nonnegative(),
      stateHash: hash,
      snapshot: z.json(),
    })
    .optional(),
  finalStateHash: hash,
});
export type SaveFile = z.infer<typeof SaveFile>;
export type SaveMetadata = z.infer<typeof metadataSchema>;
type Entry = z.infer<typeof entrySchema>;

export interface ReplayEngine {
  dispatch(source: ActionSource, action: PlayerAction): DispatchResult;
  snapshot(): unknown;
  stateHash(): string;
}

export interface ReplayRuntime<Engine extends ReplayEngine> {
  /** Version used to generate this engine, independent of the save header. */
  readonly generatorVersion: string;
  readonly engine: Engine;
  restore(snapshot: unknown): Engine;
}

export type Regenerate<Engine extends ReplayEngine> = (
  identity: Pick<SaveMetadata, 'scenarioId' | 'seed' | 'generatorVersion'>,
) => ReplayRuntime<Engine>;

export class SaveDesyncError extends Error {
  readonly code = 'SAVE_DESYNC';

  /** Sequence of the first affected action. Zero identifies the initial state. */
  constructor(
    readonly atAction: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`SAVE_DESYNC at action ${atAction}: ${message}`, options);
    this.name = 'SaveDesyncError';
  }
}

function entryHash(previous: string, entry: Omit<Entry, 'journalHash'>): string {
  return stateHash([previous, entry.seq, entry.source, entry.action, entry.stateHash]);
}

export function createSave(metadata: SaveMetadata, engine: ReplayEngine): SaveFile {
  const initialStateHash = hash.parse(engine.stateHash());
  return {
    ...metadataSchema.parse(metadata),
    formatVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    initialStateHash,
    finalStateHash: initialStateHash,
    actions: [],
  };
}

export function createCheckpoint(save: SaveFile, engine: ReplayEngine): void {
  const atAction = save.actions.length;
  const stateHash = engine.stateHash();
  if (stateHash !== save.finalStateHash) {
    throw new SaveDesyncError(atAction, 'Engine does not match the journal');
  }
  save.checkpoint = { atAction, stateHash, snapshot: z.json().parse(engine.snapshot()) };
}

/** Dispatch and record at a completed action boundary. Do not dispatch separately. */
export function recordAction(
  save: SaveFile,
  engine: ReplayEngine,
  source: ActionSource,
  input: PlayerAction,
): DispatchResult {
  const seq = save.actions.length + 1;
  const action = PlayerAction.parse(input);
  const role = actionSource.parse(source);
  if (engine.stateHash() !== save.finalStateHash) {
    throw new SaveDesyncError(seq - 1, 'Engine does not match the journal');
  }
  const result = engine.dispatch(role, action);
  const entry = { seq, source: role, action, stateHash: hash.parse(engine.stateHash()) };
  const previous = save.actions.at(-1)?.journalHash ?? save.initialStateHash;
  save.actions.push({ ...entry, journalHash: entryHash(previous, entry) });
  save.finalStateHash = entry.stateHash;
  if (seq % CHECKPOINT_INTERVAL === 0) createCheckpoint(save, engine);
  return result;
}

export function loadSave<Engine extends ReplayEngine>(
  input: unknown,
  regenerate: Regenerate<Engine>,
): Engine {
  const parsed = SaveFile.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues
      .filter(({ path }) => path[0] === 'actions' && typeof path[1] === 'number')
      .reduce((min, { path }) => Math.min(min, Number(path[1]) + 1), Infinity);
    throw new SaveDesyncError(Number.isFinite(first) ? first : 0, 'Invalid save file');
  }
  const {
    scenarioId,
    seed,
    generatorVersion,
    initialStateHash,
    actions,
    checkpoint,
    finalStateHash,
  } = parsed.data;
  let previous = initialStateHash;
  for (const [index, entry] of actions.entries()) {
    if (entry.seq !== index + 1 || entry.journalHash !== entryHash(previous, entry)) {
      throw new SaveDesyncError(index + 1, 'Journal integrity check failed');
    }
    previous = entry.journalHash;
  }
  const runtime = regenerate({ scenarioId, seed, generatorVersion });
  if (runtime.generatorVersion !== generatorVersion) {
    throw new SaveDesyncError(
      0,
      `Unsupported generator version "${generatorVersion}". This runtime supports "${runtime.generatorVersion}".`,
    );
  }
  let engine = runtime.engine;
  if (engine.stateHash() !== initialStateHash) {
    throw new SaveDesyncError(0, 'Regenerated state does not match');
  }
  if (checkpoint) {
    const { atAction } = checkpoint;
    const expected = atAction === 0 ? initialStateHash : actions[atAction - 1]?.stateHash;
    if (checkpoint.stateHash !== expected) {
      throw new SaveDesyncError(atAction, 'Checkpoint does not match the journal');
    }
    try {
      engine = runtime.restore(checkpoint.snapshot);
    } catch (cause) {
      throw new SaveDesyncError(atAction, 'Invalid checkpoint snapshot', { cause });
    }
    if (engine.stateHash() !== expected) {
      throw new SaveDesyncError(atAction, 'Restored checkpoint does not match');
    }
  }
  for (const entry of actions.slice(checkpoint?.atAction ?? 0)) {
    try {
      engine.dispatch(entry.source, entry.action);
    } catch (cause) {
      throw new SaveDesyncError(entry.seq, 'Action replay failed', { cause });
    }
    if (engine.stateHash() !== entry.stateHash) {
      throw new SaveDesyncError(entry.seq, 'Replayed state does not match');
    }
  }
  if (engine.stateHash() !== finalStateHash) {
    throw new SaveDesyncError(actions.length, 'Final state does not match');
  }
  return engine;
}

const gameSnapshot = z.strictObject({
  investigation: z.string(),
  initialInvestigationHash: hash,
  minute: z.int(),
  locationId: z.string().min(1),
  visitedLocationIds: z.array(z.string().min(1)).optional(),
  pendingCapture: z
    .strictObject({
      tokenId: z.string().min(1),
      clueId: z.string().min(1),
      locationId: z.string().min(1),
      expiresAt: z.int(),
    })
    .optional(),
});

export function gameReplayRuntime(
  investigation: Investigation,
  ports: EnginePorts,
): ReplayRuntime<GameEngine> {
  return {
    generatorVersion: investigation.generatorVersion,
    engine: GameEngine.create(investigation, ports),
    restore: (snapshot) => {
      const { pendingCapture, visitedLocationIds, ...state } = gameSnapshot.parse(snapshot);
      return GameEngine.restore(
        {
          ...state,
          ...(visitedLocationIds && { visitedLocationIds }),
          ...(pendingCapture && { pendingCapture }),
        },
        investigation,
        ports,
      );
    },
  };
}
