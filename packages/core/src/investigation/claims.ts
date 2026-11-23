import { deductionRulesSchema } from '../content/index.ts';
import type { GameMinutes } from '../common/index.ts';
import type { PlayerKnowledge } from './player-knowledge.ts';

/** The claim types the player can establish (investigation-model.md section 3). */
export const CLAIM_KINDS = [
  'presence',
  'opportunity',
  'means',
  'motive',
  'alibi',
  'contradiction',
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export class DeductionRulesError extends Error {
  readonly code = 'DEDUCTION_RULES_INVALID';
  readonly path: string;

  constructor(path: string, message: string) {
    super(`DEDUCTION_RULES_INVALID at ${path}: ${message}`);
    this.name = 'DeductionRulesError';
    this.path = path;
  }
}

// --- Terms ---------------------------------------------------------------------------------

type Term =
  | { readonly k: 'var'; readonly name: string }
  | { readonly k: 'path'; readonly name: string }
  | { readonly k: 'lit'; readonly value: string }
  | { readonly k: 'call'; readonly fn: string; readonly args: readonly Term[] };
type Call = Extract<Term, { k: 'call' }>;

const WORD = /[$A-Za-z0-9_.-]/;

function parseAtom(source: string): Call {
  let pos = 0;
  const fail = (message: string): never => {
    throw new Error(`${message} in "${source}"`);
  };
  const term = (): Term => {
    const start = pos;
    while (pos < source.length && WORD.test(source[pos] ?? '')) pos++;
    const word = source.slice(start, pos);
    if (word === '') return fail(`Expected a term at ${pos}`);
    if (source[pos] === '(') {
      if (word.startsWith('$')) fail('A variable cannot be called');
      pos++;
      const args: Term[] = [];
      for (;;) {
        args.push(term());
        if (source[pos] === ',') pos++;
        else break;
      }
      if (source[pos] !== ')') fail(`Expected ")" at ${pos}`);
      pos++;
      return { k: 'call', fn: word, args };
    }
    if (!word.startsWith('$')) return { k: 'lit', value: word };
    return word.includes('.')
      ? { k: 'path', name: word.slice(1) }
      : { k: 'var', name: word.slice(1) };
  };
  const result = term();
  if (pos !== source.length) fail(`Unexpected "${source[pos]}" at ${pos}`);
  if (result.k !== 'call') return fail('An atom must look like name(args)');
  return result;
}

function show(term: Term): string {
  switch (term.k) {
    case 'var':
    case 'path':
      return `$${term.name}`;
    case 'lit':
      return term.value;
    case 'call':
      return `${term.fn}(${term.args.map(show).join(',')})`;
  }
}

function varsOf(term: Term, into = new Set<string>()): Set<string> {
  if (term.k === 'var') into.add(term.name);
  else if (term.k === 'call') term.args.forEach((arg) => varsOf(arg, into));
  return into;
}

function pathsOf(term: Term, into: string[] = []): string[] {
  if (term.k === 'path') into.push(term.name);
  else if (term.k === 'call') term.args.forEach((arg) => pathsOf(arg, into));
  return into;
}

const KNOWN_PATHS = ['incident.location', 'incident.window'];

function isGround(term: Term): boolean {
  return term.k === 'lit' || (term.k === 'call' && term.args.every(isGround));
}

interface Interval {
  readonly from: number;
  readonly to: number;
}

/** `a..b` is the interval [a, b); a bare minute `t` is [t, t + 1). */
function asInterval(value: string): Interval | undefined {
  const range = /^(-?\d+)\.\.(-?\d+)$/.exec(value);
  if (range) return { from: Number(range[1]), to: Number(range[2]) };
  return /^-?\d+$/.test(value) ? { from: Number(value), to: Number(value) + 1 } : undefined;
}

const overlaps = (a: Interval, b: Interval) => a.from < b.to && b.from < a.to;
const covers = (outer: Interval, inner: Interval) =>
  outer.from <= inner.from && inner.to <= outer.to;

// --- Rules ---------------------------------------------------------------------------------

/** Builtin condition: holds when both (bound) arguments differ. */
const NEQ = 'neq';

interface CompiledRule {
  readonly id: string;
  readonly establishes: Call;
  readonly requires: readonly Call[];
  readonly excludes: readonly Call[];
  readonly stratum: number;
}

/** Compiled `deduction-rules.json`: data, not code. Build it with `compileDeductionRules`. */
export interface DeductionRules {
  readonly rules: readonly CompiledRule[];
}

/**
 * Validates and compiles deduction rules. Atoms are `name(term,...)` where `$x` is a variable and
 * `$incident.location` / `$incident.window` read the incident known to the player. `neq($a,$b)` is
 * the only builtin. A rule must bind every variable it establishes, may only establish a claim
 * kind, and may not exclude (through other rules) a claim it depends on.
 */
export function compileDeductionRules(input: unknown): DeductionRules {
  const parsed = deductionRulesSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DeductionRulesError(
      issue?.path.join('.') || '$',
      issue?.message ?? 'Not deduction rules',
    );
  }
  const seen = new Set<string>();
  const rules = parsed.data.map((raw, index) => {
    const at = `[${index}]`;
    if (seen.has(raw.id)) throw new DeductionRulesError(`${at}.id`, `Duplicate rule ${raw.id}`);
    seen.add(raw.id);
    const atom = (text: string, where: string) => {
      try {
        return parseAtom(text);
      } catch (error) {
        throw new DeductionRulesError(`${at}.${where}`, (error as Error).message);
      }
    };
    const establishes = atom(raw.establishes, 'establishes');
    if (!(CLAIM_KINDS as readonly string[]).includes(establishes.fn))
      throw new DeductionRulesError(
        `${at}.establishes`,
        `Unknown claim kind ${establishes.fn}; expected one of ${CLAIM_KINDS.join(', ')}`,
      );
    const requires = raw.requires.map((text, i) => atom(text, `requires[${i}]`));
    const excludes = (raw.excludes ?? []).map((text, i) => atom(text, `excludes[${i}]`));
    for (const [where, atoms] of [
      ['establishes', [establishes]],
      ['requires', requires],
      ['excludes', excludes],
    ] as const)
      for (const path of atoms.flatMap((a) => pathsOf(a)))
        if (!KNOWN_PATHS.includes(path))
          throw new DeductionRulesError(
            `${at}.${where}`,
            `Unknown path $${path}; expected one of ${KNOWN_PATHS.map((p) => `$${p}`).join(', ')}`,
          );
    const premises = requires.filter(({ fn }) => fn !== NEQ);
    if (premises.length === 0)
      throw new DeductionRulesError(`${at}.requires`, 'A rule needs a non-builtin premise');
    const bound = new Set<string>();
    premises.forEach((a) => varsOf(a, bound));
    for (const name of varsOf(establishes))
      if (!bound.has(name))
        throw new DeductionRulesError(`${at}.establishes`, `Variable $${name} is never bound`);
    for (const a of requires.filter(({ fn }) => fn === NEQ))
      for (const name of varsOf(a))
        if (!bound.has(name))
          throw new DeductionRulesError(`${at}.requires`, `neq uses unbound variable $${name}`);
    return { id: raw.id, establishes, requires, excludes };
  });

  // Stratify: a rule runs after every rule that establishes what it reads, and strictly after
  // the ones that establish what it excludes. A negative cycle has no valid order.
  const stratum = new Map(rules.map((rule) => [rule.id, 0]));
  const producers = (fn: string) => rules.filter(({ establishes }) => establishes.fn === fn);
  for (let round = 0; ; round++) {
    let changed = false;
    for (const rule of rules) {
      let next = stratum.get(rule.id) ?? 0;
      for (const a of rule.requires)
        for (const p of producers(a.fn)) next = Math.max(next, stratum.get(p.id) ?? 0);
      for (const a of rule.excludes)
        for (const p of producers(a.fn)) next = Math.max(next, (stratum.get(p.id) ?? 0) + 1);
      if (next !== stratum.get(rule.id)) {
        stratum.set(rule.id, next);
        changed = true;
      }
    }
    if (!changed) break;
    if (round > rules.length)
      throw new DeductionRulesError('$', 'Rules exclude a claim they depend on (negative cycle)');
  }
  return Object.freeze({
    rules: Object.freeze(
      rules.map((rule) => Object.freeze({ ...rule, stratum: stratum.get(rule.id) ?? 0 })),
    ),
  });
}

// --- Evaluation ----------------------------------------------------------------------------

/** What `evaluateClaims` knows besides the player's own knowledge. Nothing here is truth. */
export interface ClaimContext {
  /** The claim references each clue supports (`Clue.supports`), by clue id. */
  readonly clues: ReadonlyMap<string, { readonly supports: readonly string[] }>;
  /** The incident as the player has worked it out (body examination, testimony); not the true one. */
  readonly incident?: {
    readonly location: string;
    readonly window: { readonly from: GameMinutes; readonly to: GameMinutes };
  };
}

/** The evidence a claim stands on, followed all the way down to what the player found or heard. */
export interface ClaimSupport {
  readonly clueIds: readonly string[];
  readonly statementIds: readonly string[];
  /** Claims (as `name(args)`) established earlier that this one was derived from. */
  readonly claims: readonly string[];
}

export interface EstablishedClaim {
  readonly ruleId: string;
  readonly kind: ClaimKind;
  readonly subject: string;
  /** The ground claim, for example `opportunity(ch_bursar)`. */
  readonly claim: string;
  readonly support: ClaimSupport;
}

interface Fact {
  readonly term: Call;
  readonly text: string;
  readonly clueIds: Set<string>;
  readonly statementIds: Set<string>;
  readonly claims: Set<string>;
}

type Bindings = ReadonlyMap<string, string>;
type Mode = 'requires' | 'excludes';
type Paths = ReadonlyMap<string, string>;

function groundOf(term: Term, bindings: Bindings, paths: Paths = new Map()): string | undefined {
  if (term.k === 'var') return bindings.get(term.name);
  if (term.k === 'lit') return term.value;
  if (term.k === 'path') return paths.get(term.name);
  const args = term.args.map((arg) => groundOf(arg, bindings, paths));
  return args.includes(undefined) ? undefined : `${term.fn}(${args.join(',')})`;
}

/**
 * Matches a rule pattern against a ground fact term. A variable binds on first use; reuse needs
 * the same value, or overlapping intervals. A `$incident.*` path that is an interval needs the
 * fact interval to overlap it in a premise and to cover it in an exclusion.
 */
function unify(
  pattern: Term,
  fact: Term,
  bindings: Bindings,
  mode: Mode,
  paths: Paths,
): Bindings | null {
  if (pattern.k === 'call') {
    if (fact.k !== 'call' || fact.fn !== pattern.fn || fact.args.length !== pattern.args.length)
      return null;
    let current: Bindings | null = bindings;
    for (const [i, arg] of pattern.args.entries()) {
      current = unify(arg, fact.args[i] as Term, current, mode, paths);
      if (!current) return null;
    }
    return current;
  }
  const value = show(fact);
  if (pattern.k === 'var') {
    const bound = bindings.get(pattern.name);
    if (bound === undefined) return new Map(bindings).set(pattern.name, value);
    if (bound === value) return bindings;
    const [a, b] = [asInterval(bound), asInterval(value)];
    return a && b && overlaps(a, b) ? bindings : null;
  }
  const expected = pattern.k === 'path' ? paths.get(pattern.name) : pattern.value;
  if (expected === undefined) return null;
  if (expected === value) return bindings;
  if (pattern.k === 'lit') return null;
  const [want, have] = [asInterval(expected), asInterval(value)];
  if (!want || !have) return null;
  return (mode === 'requires' ? overlaps(want, have) : covers(have, want)) ? bindings : null;
}

function factOf(text: string): Fact | undefined {
  let term: Call;
  try {
    term = parseAtom(text);
  } catch {
    return undefined;
  }
  if (!isGround(term)) return undefined;
  return {
    term,
    text: show(term),
    clueIds: new Set(),
    statementIds: new Set(),
    claims: new Set(),
  };
}

/** Facts a heard statement gives: `statement(speaker, p)` always, `testimony` unless it is self-report. */
function statementFacts(statement: PlayerKnowledge['statements'][number]): string[] {
  const p = statement.proposition as Record<string, unknown>;
  const str = (key: string) => (typeof p[key] === 'string' ? p[key] : undefined);
  const subject = str('who');
  let claim: string | undefined;
  if (p.kind === 'at') {
    const interval = p.interval as Partial<Interval> | undefined;
    const where = str('where');
    if (
      subject &&
      where &&
      Number.isSafeInteger(interval?.from) &&
      Number.isSafeInteger(interval?.to)
    )
      claim = `presence(${subject},${where},${interval?.from}..${interval?.to})`;
  } else if (p.kind === 'motive') {
    const against = str('against');
    if (subject && against) claim = `motive(${subject},${against})`;
  }
  if (!subject || !claim) return [];
  const facts = [`statement(${statement.speakerId},${claim})`];
  if (statement.speakerId !== subject) facts.push(`testimony(${statement.speakerId},${claim})`);
  return facts;
}

/**
 * Everything the player can claim to have established, each with the clues and statements it
 * stands on. Reads `PlayerKnowledge`, the clue references and the incident the player knows;
 * never the truth. Deterministic: clues and statements in the order the player got them, rules
 * in file order within their stratum.
 *
 * Facts: each discovered clue contributes the references it supports. A heard statement gives
 * `statement(speaker, presence(who,where,from..to))`, and, when the speaker is not the subject,
 * `testimony(speaker, ...)`; motive statements are treated alike.
 */
export function evaluateClaims(
  knowledge: PlayerKnowledge,
  rules: DeductionRules,
  context: ClaimContext = { clues: new Map() },
): EstablishedClaim[] {
  const facts = new Map<string, Fact>();
  const add = (text: string, source: { clueId?: string; statementId?: string }) => {
    const fact = factOf(text);
    if (!fact) return;
    const known = facts.get(fact.text) ?? fact;
    facts.set(known.text, known);
    // The same reference from another clue or statement is more support, not a new fact.
    if (source.clueId) known.clueIds.add(source.clueId);
    if (source.statementId) known.statementIds.add(source.statementId);
  };
  for (const clueId of knowledge.clues.keys())
    for (const text of context.clues.get(clueId)?.supports ?? []) add(text, { clueId });
  for (const statement of knowledge.statements)
    for (const text of statementFacts(statement)) add(text, { statementId: statement.id });

  const paths = new Map<string, string>();
  if (context.incident) {
    const { location, window } = context.incident;
    paths.set('incident.location', location);
    paths.set('incident.window', `${window.from}..${window.to}`);
  }
  const established: EstablishedClaim[] = [];
  const derived = new Set<string>();

  type Solution = { bindings: Bindings; used: readonly Fact[] };
  const solve = (
    atoms: readonly Call[],
    bindings: Bindings,
    used: readonly Fact[],
    out: Solution[],
  ): void => {
    const [atom, ...rest] = atoms;
    if (!atom) {
      out.push({ bindings, used });
      return;
    }
    if (atom.fn === NEQ) {
      const [a, b] = atom.args.map((arg) => groundOf(arg, bindings, paths));
      if (a !== undefined && b !== undefined && a !== b) solve(rest, bindings, used, out);
      return;
    }
    for (const fact of [...facts.values()]) {
      const next = unify(atom, fact.term, bindings, 'requires', paths);
      if (next) solve(rest, next, [...used, fact], out);
    }
  };

  const strata = [...new Set(rules.rules.map(({ stratum }) => stratum))].sort((a, b) => a - b);
  for (const stratum of strata) {
    const layer = rules.rules.filter((rule) => rule.stratum === stratum);
    for (let changed = true; changed;) {
      changed = false;
      for (const rule of layer) {
        // Real premises first, so that neq sees its variables bound.
        const ordered = [
          ...rule.requires.filter(({ fn }) => fn !== NEQ),
          ...rule.requires.filter(({ fn }) => fn === NEQ),
        ];
        const solutions: Solution[] = [];
        solve(ordered, new Map(), [], solutions);
        for (const { bindings, used } of solutions) {
          const text = groundOf(rule.establishes, bindings);
          if (text === undefined || facts.has(text)) continue;
          const blocked = rule.excludes.some((atom) =>
            [...facts.values()].some((fact) => unify(atom, fact.term, bindings, 'excludes', paths)),
          );
          if (blocked) continue;
          const fact = factOf(text);
          if (!fact) continue;

          for (const used1 of used) {
            used1.clueIds.forEach((id) => fact.clueIds.add(id));
            used1.statementIds.forEach((id) => fact.statementIds.add(id));
            used1.claims.forEach((claim) => fact.claims.add(claim));
            if (derived.has(used1.text)) fact.claims.add(used1.text);
          }
          facts.set(text, fact);
          derived.add(text);
          established.push({
            ruleId: rule.id,
            kind: rule.establishes.fn as ClaimKind,
            subject: groundOf(rule.establishes.args[0] as Term, bindings) ?? '',
            claim: text,
            support: {
              clueIds: [...fact.clueIds].sort(),
              statementIds: [...fact.statementIds].sort(),
              claims: [...fact.claims].sort(),
            },
          });
          changed = true;
        }
      }
    }
  }
  return established;
}
