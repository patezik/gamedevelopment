const U32_RANGE = 2 ** 32;
const U64_RANGE = 1n << 64n;
const WARMUP_DRAWS = 12;

type Words = [number, number, number, number];

export interface RngState {
  readonly seed: string;
  readonly path: readonly string[];
  readonly words: Readonly<Words>;
}

export interface Rng {
  nextU32(): number;
  float(): number;
  int(minIncl: number, maxIncl: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  weighted<T>(items: readonly { value: T; weight: number }[]): T;
  shuffle<T>(items: readonly T[]): T[];
  fork(label: string): Rng;
  readonly state: RngState;
}

// cyrb128 seed hash by bryc.
function cyrb128(seed: string): Words {
  let a = 1779033703;
  let b = 3144134277;
  let c = 1013904242;
  let d = 2773480762;

  for (let index = 0; index < seed.length; index++) {
    const code = seed.charCodeAt(index);
    a = b ^ Math.imul(a ^ code, 597399067);
    b = c ^ Math.imul(b ^ code, 2869860233);
    c = d ^ Math.imul(c ^ code, 951274213);
    d = a ^ Math.imul(d ^ code, 2716044179);
  }

  a = Math.imul(c ^ (a >>> 18), 597399067);
  b = Math.imul(d ^ (b >>> 22), 2869860233);
  c = Math.imul(a ^ (c >>> 17), 951274213);
  d = Math.imul(b ^ (d >>> 19), 2716044179);
  const first = a ^ b ^ c ^ d;
  return [first >>> 0, (b ^ first) >>> 0, (c ^ first) >>> 0, (d ^ first) >>> 0];
}

class SfcRng implements Rng {
  private readonly words: Words;
  private readonly path: readonly string[];
  private readonly seed: string;

  constructor(seed: string, path: readonly string[], words: Readonly<Words>) {
    this.seed = seed;
    this.path = [...path];
    this.words = [...words];
  }

  get state(): RngState {
    return { seed: this.seed, path: [...this.path], words: [...this.words] };
  }

  nextU32(): number {
    const [a, b, c, counter] = this.words;
    const result = (a + b + counter) >>> 0;
    this.words[0] = (b ^ (b >>> 9)) >>> 0;
    this.words[1] = (c + (c << 3)) >>> 0;
    this.words[2] = (((c << 21) | (c >>> 11)) + result) >>> 0;
    this.words[3] = (counter + 1) >>> 0;
    return result;
  }

  float(): number {
    return this.nextU32() / U32_RANGE;
  }

  int(minIncl: number, maxIncl: number): number {
    if (!Number.isSafeInteger(minIncl) || !Number.isSafeInteger(maxIncl) || minIncl > maxIncl) {
      throw new RangeError('Expected ordered safe integer bounds');
    }

    // Reject the incomplete bucket at the top of the sample space to avoid modulo bias.
    const width = maxIncl - minIncl + 1;
    if (width <= U32_RANGE) {
      const limit = U32_RANGE - (U32_RANGE % width);
      let sample: number;
      do {
        sample = this.nextU32();
      } while (sample >= limit);
      return minIncl + (sample % width);
    }

    const min = BigInt(minIncl);
    const wideWidth = BigInt(maxIncl) - min + 1n;
    const limit = U64_RANGE - (U64_RANGE % wideWidth);
    let sample: bigint;
    do {
      sample = (BigInt(this.nextU32()) << 32n) | BigInt(this.nextU32());
    } while (sample >= limit);
    return Number(min + (sample % wideWidth));
  }

  chance(p: number): boolean {
    if (!Number.isFinite(p) || p < 0 || p > 1) {
      throw new RangeError('Expected a probability from 0 to 1');
    }
    return this.float() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('Cannot pick from an empty list');
    return items[this.int(0, items.length - 1)]!;
  }

  weighted<T>(items: readonly { value: T; weight: number }[]): T {
    if (items.length === 0) throw new RangeError('Cannot pick from an empty weighted list');
    let maxWeight = 0;
    for (const { weight } of items) {
      if (!Number.isFinite(weight) || weight <= 0) {
        throw new RangeError('Expected positive finite weights');
      }
      maxWeight = Math.max(maxWeight, weight);
    }

    // Scale before summing so large finite weights cannot overflow the total.
    const total = items.reduce((sum, { weight }) => sum + weight / maxWeight, 0);
    const threshold = this.float() * total;
    let cumulative = 0;
    for (const { value, weight } of items) {
      cumulative += weight / maxWeight;
      if (threshold < cumulative) return value;
    }
    return items[items.length - 1]!.value;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index--) {
      const swap = this.int(0, index);
      [result[index], result[swap]] = [result[swap]!, result[index]!];
    }
    return result;
  }

  fork(label: string): Rng {
    return createStream(this.seed, [...this.path, label]);
  }
}

function createStream(seed: string, path: readonly string[]): Rng {
  // Encoding the seed and labels as a tuple preserves label boundaries at every depth.
  const rng = new SfcRng(seed, path, cyrb128(JSON.stringify([seed, ...path])));
  for (let index = 0; index < WARMUP_DRAWS; index++) rng.nextU32();
  return rng;
}

export function createRng(seed: string): Rng {
  return createStream(seed, []);
}

export function restoreRng(state: RngState): Rng {
  if (
    typeof state.seed !== 'string' ||
    !Array.isArray(state.path) ||
    Array.from<unknown>(state.path).some((label) => typeof label !== 'string') ||
    !Array.isArray(state.words) ||
    state.words.length !== 4 ||
    [...state.words].some((word) => !Number.isInteger(word) || word < 0 || word >= U32_RANGE)
  ) {
    throw new RangeError('Invalid RNG state');
  }
  return new SfcRng(state.seed, state.path, state.words);
}
