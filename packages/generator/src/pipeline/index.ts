import type { ScenarioContent } from '@hs/core/content';
import { createRng, type Rng } from '@hs/core/rng';

export const GENERATOR_VERSION = '0.1.0';
const DEFAULT_MAX_ATTEMPTS = 8;

export interface GenerationLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface GenerationContext {
  readonly rng: Rng;
  readonly content: ScenarioContent;
  readonly logger: GenerationLogger;
}

export interface Stage<Input, Output> {
  readonly name: string;
  generate(input: Input, context: GenerationContext): Output;
}

type AnyStage = Stage<never, unknown>;
type StageInput<S> = S extends Stage<infer Input, unknown> ? Input : never;
type StageOutput<S> = S extends Stage<never, infer Output> ? Output : never;
type Pipeline = readonly [AnyStage, ...AnyStage[]];
type PipelineOutput<Stages extends Pipeline> = Stages extends readonly [...AnyStage[], infer Last]
  ? StageOutput<Last>
  : never;
type Compatible<Stages extends readonly AnyStage[]> = Stages extends readonly [
  infer First extends AnyStage,
  infer Second extends AnyStage,
  ...infer Rest extends AnyStage[],
]
  ? StageOutput<First> extends StageInput<Second>
    ? Compatible<readonly [Second, ...Rest]>
    : never
  : unknown;

export interface AttemptReport {
  readonly number: number;
  readonly seed: string;
  readonly timingsMs: Readonly<Record<string, number>>;
  readonly accepted: boolean;
}

/** Server diagnostics. Keep this out of player and phone views. */
export interface GenerationReport {
  readonly seed: string;
  readonly generatorVersion: typeof GENERATOR_VERSION;
  readonly attempts: readonly AttemptReport[];
}

export interface PipelineOptions<Output> {
  readonly seed: string;
  readonly content: ScenarioContent;
  readonly logger?: GenerationLogger;
  readonly maxAttempts?: number;
  readonly accepts?: (output: Output) => boolean;
  readonly now: () => number;
}

export type PipelineResult<Output> =
  | { readonly ok: true; readonly output: Output; readonly report: GenerationReport }
  | {
      readonly ok: false;
      readonly error: 'GENERATION_UNSOLVABLE';
      readonly report: GenerationReport;
    };

const silentLogger: GenerationLogger = { debug() {} };

export function runPipeline<const Stages extends Pipeline>(
  stages: Stages & Compatible<Stages>,
  input: StageInput<Stages[0]>,
  options: PipelineOptions<PipelineOutput<Stages>>,
): PipelineResult<PipelineOutput<Stages>> {
  const {
    seed,
    content,
    logger = silentLogger,
    accepts = () => true,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    now,
  } = options;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive safe integer');
  }
  const names = stages.map(({ name }) => name);
  if (names.some((name) => !name.trim()) || new Set(names).size !== names.length) {
    throw new Error('Generation stages must have unique nonempty names');
  }

  const attempts: AttemptReport[] = [];
  const report: GenerationReport = { seed, generatorVersion: GENERATOR_VERSION, attempts };
  for (let number = 1; number <= maxAttempts; number++) {
    const attemptSeed = `${seed}#${number}`;
    const root = createRng(attemptSeed);
    const timings = new Map<string, number>();
    let value: unknown = input;
    for (const stage of stages) {
      const started = now();
      // Compatible checks the input/output chain at the public boundary.
      value = (stage as Stage<unknown, unknown>).generate(value, {
        rng: root.fork(`gen/${stage.name}`),
        content,
        logger,
      });
      timings.set(stage.name, now() - started);
    }
    const output = value as PipelineOutput<Stages>;
    const accepted = accepts(output);
    attempts.push({ number, seed: attemptSeed, timingsMs: Object.fromEntries(timings), accepted });
    if (accepted) return { ok: true, output, report };
  }
  return { ok: false, error: 'GENERATION_UNSOLVABLE', report };
}
