import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONCEALMENT_VERBS, compileTraceRules } from '../evidence/index.ts';
import {
  PlayerKnowledge,
  compileDeductionRules,
  evaluateClaims,
  type ClaimContext,
  type HeardStatement,
} from '../investigation/index.ts';
import { loadScenarioFromDir } from './index.ts';

/*
 * CNT-004: the trace rules and deduction rules of sanatorium_winter fit together. Generated cases
 * (verb coverage over real truth logs, claims checked against the truth) are tested in
 * packages/generator/src/sanatorium-rules.test.ts.
 */

const root = fileURLToPath(new URL('../../../../content/scenarios/', import.meta.url));
const content = loadScenarioFromDir(join(root, 'sanatorium_winter'));
const rules = compileDeductionRules(content.deductionRules);

const predicate = (atom: string) => atom.slice(0, atom.indexOf('('));

describe('sanatorium_winter trace rules', () => {
  it('compile with the conservation law', () => {
    expect(() => compileTraceRules(content.traceRules)).not.toThrow();
  });

  it('every concealment verb leaves an unconditional secondary trace that places the actor', () => {
    for (const verb of CONCEALMENT_VERBS) {
      const secondary = content.traceRules
        .filter((rule) => rule.verb === verb && rule.when === undefined)
        .flatMap(({ produces }) => produces)
        .filter(
          ({ requires, kind, at }) =>
            requires === undefined && kind !== 'testimonial' && at === '$location',
        );
      expect(secondary.length, verb).toBeGreaterThan(0);
    }
  });

  it('hiding and destroying can be found in every location, where NPCs may conceal anything', () => {
    for (const verb of ['hide', 'destroy']) {
      const templates = content.traceRules
        .filter((rule) => rule.verb === verb && rule.when === undefined)
        .flatMap(({ produces }) => produces)
        .filter(({ kind }) => kind === 'physical')
        .map(({ template }) => template);
      expect(templates.length, verb).toBeGreaterThan(0);
      for (const template of templates) {
        for (const location of content.locations) {
          expect(
            location.hotspots.some(({ id }) => id === template),
            `${template}@${location.id}`,
          ).toBe(true);
        }
      }
    }
  });

  it('every claim a trace supports is read by a deduction rule, except the known opportunity references', () => {
    const read = new Set(rules.rules.flatMap(({ requires }) => requires.map(({ fn }) => fn)));
    const supported = new Set(
      content.traceRules.flatMap(({ produces }) =>
        produces.flatMap(({ supports }) => supports.map(predicate)),
      ),
    );
    expect([...supported].sort()).toEqual(['means', 'opportunity', 'presence']);
    // `opportunity($actor)` of `stage` and `tamper` is unread: a rule reading it would prove
    // opportunity without the incident briefing and without QR captures, a change of the game
    // rules left to the owner (CNT-004 PR). Drop the exception together with such a rule.
    const unread = [...supported].filter((name) => !read.has(name));
    expect(unread).toEqual(['opportunity']);
  });
});

describe('sanatorium_winter deduction rules', () => {
  const culprit = 'ch_a';
  const other = 'ch_b';
  const witness = 'ch_w';
  const victim = 'ch_v';
  const incident = { location: 'loc_room_1', window: { from: -100, to: -80 } };

  const solve = (clues: Record<string, string[]>, statements: HeardStatement[] = []): string[] => {
    const knowledge = new PlayerKnowledge();
    Object.keys(clues).forEach((clueId, i) =>
      knowledge.addClue({ clueId, discoveredAt: i, location: 'loc_hall' }),
    );
    statements.forEach((statement) => knowledge.addStatement(statement));
    const context: ClaimContext = {
      clues: new Map(Object.entries(clues).map(([id, supports]) => [id, { supports }])),
      incident,
    };
    return evaluateClaims(knowledge, rules, context).map(({ claim }) => claim);
  };
  const at = (
    id: string,
    speakerId: string,
    who: string,
    where: string,
    from: number,
    to: number,
  ): HeardStatement => ({
    id,
    speakerId,
    proposition: { kind: 'at', who, where, interval: { from, to } },
    topic: 'whereWereYou',
    at: 1,
    templateKey: 't',
  });
  const motive = (id: string, speakerId: string, who: string): HeardStatement => ({
    id,
    speakerId,
    proposition: { kind: 'motive', who, against: victim, motiveType: 'debt', basis: [] },
    topic: 'whatDoYouKnowAbout',
    at: 1,
    templateKey: 't',
  });

  it('establish every claim kind the validator needs', () => {
    const established = new Set(rules.rules.map(({ establishes }) => establishes.fn));
    for (const kind of ['motive', 'means', 'opportunity', 'alibi', 'no_access'])
      expect(established.has(kind), kind).toBe(true);
  });

  it('prove motive, means and opportunity of a culprit from the crime traces and a witness', () => {
    const claims = solve(
      {
        cl_residue: [`means(${culprit})`, `presence(${culprit},loc_room_1,-95)`],
      },
      [motive('st_m', witness, culprit)],
    );
    expect(claims).toEqual(
      expect.arrayContaining([
        `means(${culprit})`,
        `opportunity(${culprit})`,
        `motive(${culprit},${victim})`,
      ]),
    );
  });

  it('take a motive only from someone else, not from self-report', () => {
    expect(solve({}, [motive('st_self', culprit, culprit)])).not.toContain(
      `motive(${culprit},${victim})`,
    );
  });

  it('do not take opportunity from a bare opportunity reference (see the trace rule test)', () => {
    expect(solve({ cl_staging: [`opportunity(${culprit})`] })).not.toContain(
      `opportunity(${culprit})`,
    );
  });

  it('do not give opportunity to someone a record places elsewhere for the whole window', () => {
    const claims = solve({
      cl_scene: [`presence(${other},loc_room_1,-90)`],
      cl_log: [`presence(${other},loc_kitchen,-120..-60)`],
    });
    expect(claims).toContain(`no_access(${other},-120..-60)`);
    expect(claims).not.toContain(`opportunity(${other})`);
  });

  it('do not exonerate from a record at the scene', () => {
    const claims = solve({ cl_log: [`presence(${other},loc_room_1,-120..-60)`] });
    expect(claims).toContain(`opportunity(${other})`);
    expect(claims.filter((claim) => claim.startsWith('no_access'))).toEqual([]);
  });

  it('back an alibi with a witness only when a record agrees', () => {
    const heard = [at('st_w', witness, other, 'loc_kitchen', -120, -60)];
    expect(solve({}, heard).filter((claim) => claim.startsWith('alibi'))).toEqual([]);
    expect(solve({ cl_log: [`presence(${other},loc_kitchen,-120..-60)`] }, heard)).toContain(
      `alibi(${other},-120..-60)`,
    );
  });

  it('find a contradiction only when the record puts the speaker somewhere else', () => {
    const said = [at('st_self', other, other, 'loc_kitchen', -120, -60)];
    expect(solve({ cl_log: [`presence(${other},loc_kitchen,-90)`] }, said)).not.toContain(
      `contradiction(${other})`,
    );
    expect(solve({ cl_log: [`presence(${other},loc_hall,-90)`] }, said)).toContain(
      `contradiction(${other})`,
    );
  });
});
