import type { GameSnapshot } from '@hs/core/game';
import type { SessionStatus } from '../sessions/index.ts';

export const REPRO_FORMAT = 'hollow-signal-repro';

/**
 * Everything a developer needs to reproduce a session's state elsewhere: the engine snapshot (the
 * serialized investigation, truth included, plus the minute and location) and its hash. It holds
 * the solution, so it exists only behind the debug flag.
 */
export interface ReproBundle {
  readonly format: typeof REPRO_FORMAT;
  readonly version: 1;
  readonly exportedAt: string;
  readonly server: { readonly version: string; readonly protocolVersion: number };
  readonly session: {
    readonly id: string;
    readonly status: SessionStatus;
    readonly stateVersion: number;
  };
  readonly scenarioId: string;
  readonly seed: string;
  readonly generatorVersion: string;
  readonly stateHash: string;
  readonly snapshot: GameSnapshot;
}
