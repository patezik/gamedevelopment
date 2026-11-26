import { expect, test } from 'vitest';
import type { Personality } from '../characters/index.ts';
import { PERSONALITY_TRAITS } from '../common/index.ts';
import { KnowledgeStore } from '../knowledge/index.ts';
import { scoreConcealEvidence, type NpcContext, type NpcState } from './goals/index.ts';
import { CONCEAL_WARINESS_THRESHOLD } from './goals/npc-goals.ts';
import {
  avoidPlayer,
  PlayerReactions,
  refuseWhenAccused,
  scoreAvoidPlayer,
  AVOID_WARINESS_THRESHOLD,
  BYSTANDER_FACTOR,
  type ReactionPorts,
  type ReactionsSnapshot,
} from './index.ts';

const personality = (value: number): Personality =>
  Object.fromEntries(PERSONALITY_TRAITS.map((name) => [name, value])) as unknown as Personality;
const state = (overrides: Partial<NpcState> = {}): NpcState => ({
  personality: personality(0.5),
  stress: 0.1,
  wariness: 0.1,
  knowledge: new KnowledgeStore(),
  ...overrides,
});
const ctx = (s: NpcState): NpcContext => ({ agentId: 'ch_b', state: s, now: 10, endAt: 1000 });

const woken: string[] = [];
const ports: ReactionPorts = {
  // Only the bursar conceals the "where" topic; the cook has nothing to hide there.
  topicSensitivity: (id, topic) => (id === 'ch_bursar' && topic.startsWith('where') ? 0.4 : 0),
  closeTo: (id) =>
    id === 'ch_bursar'
      ? ['ch_wife', 'ch_son']
      : id === 'ch_victim'
        ? ['ch_wife']
        : id === 'ch_missing'
          ? ['ch_friend']
          : [],
  wake: (id) => woken.push(id),
};
const base = { witnessIds: [] as string[], heardByIds: [] as string[] };

test('a question raises wariness only for characters the topic touches', () => {
  const reactions = new PlayerReactions(ports);
  reactions.onPlayerAction({
    ...base,
    witnessIds: ['ch_cook', 'ch_bursar'],
    characterId: 'ch_cook',
    topicId: 'where:0:60',
  });
  expect(reactions.wariness('ch_cook')).toBe(0);
  expect(reactions.wariness('ch_bursar')).toBeCloseTo(0.4 * BYSTANDER_FACTOR);

  reactions.onPlayerAction({ ...base, characterId: 'ch_bursar', topicId: 'where:0:60' });
  expect(reactions.wariness('ch_bursar')).toBeCloseTo(0.4 * BYSTANDER_FACTOR + 0.4);
  expect(reactions.wariness('ch_cook')).toBe(0);
  expect(woken).toContain('ch_bursar');
  expect(woken).not.toContain('ch_cook');
});

test('actions without a topic and unrelated topics change nothing', () => {
  const reactions = new PlayerReactions(ports);
  reactions.onPlayerAction({ ...base, characterId: 'ch_bursar' });
  reactions.onPlayerAction({ ...base, characterId: 'ch_bursar', topicId: 'self' });
  expect(reactions.wariness('ch_bursar')).toBe(0);
});

test('wariness saturates at 1 and applyTo adds it to the baseline', () => {
  const reactions = new PlayerReactions(ports);
  for (let i = 0; i < 5; i++) {
    reactions.onPlayerAction({ ...base, characterId: 'ch_bursar', topicId: 'where:0:60' });
  }
  expect(reactions.wariness('ch_bursar')).toBe(1);
  const wary = reactions.applyTo('ch_bursar', state({ wariness: 0.1 }));
  expect(wary.wariness).toBe(1);
  expect(reactions.applyTo('ch_cook', state({ wariness: 0.1 })).wariness).toBe(0.1);
  expect(scoreConcealEvidence(wary, 1)).toBeGreaterThan(0);
});

test('a false accusation makes the accused and their close ones refuse to talk', () => {
  const reactions = new PlayerReactions(ports);
  reactions.applyConsequences([
    { kind: 'refuses_to_talk', characterId: 'ch_bursar' },
    { kind: 'trust_falls' },
    { kind: 'culprit_freed', characterId: 'ch_culprit' },
  ]);
  expect(['ch_bursar', 'ch_wife', 'ch_son'].map((id) => reactions.refuses(id))).toEqual([
    true,
    true,
    true,
  ]);
  expect(reactions.refuses('ch_cook')).toBe(false);
  expect(reactions.trust).toBeCloseTo(0.8);
  expect(reactions.isFreed('ch_culprit')).toBe(true);
  expect(reactions.applyTo('ch_culprit', state({ wariness: 0 })).wariness).toBeGreaterThan(
    CONCEAL_WARINESS_THRESHOLD,
  );

  const witness = { witness: (id: string) => ({ id }) };
  const gated = refuseWhenAccused(witness, reactions);
  expect(gated.witness('ch_bursar')).toBeUndefined();
  expect(gated.witness('ch_cook')).toEqual({ id: 'ch_cook' });
});

test('a correct accusation without proof sends the culprit to destroy evidence', () => {
  const reactions = new PlayerReactions(ports);
  reactions.applyConsequences([{ kind: 'culprit_destroys_evidence', characterId: 'ch_culprit' }]);
  expect(reactions.applyTo('ch_culprit', state({ wariness: 0 })).wariness).toBe(1);
  expect(reactions.refuses('ch_culprit')).toBe(false);
  expect(reactions.trust).toBe(1);
});

test('a death or disappearance stresses acquaintances and becomes a seek topic', () => {
  const reactions = new PlayerReactions(ports);
  reactions.onCharacterGone('ch_victim', 'death');
  reactions.onCharacterGone('ch_missing', 'disappearance');
  expect(reactions.stress('ch_wife')).toBeCloseTo(0.2);
  expect(reactions.stress('ch_friend')).toBeCloseTo(0.15);
  expect(reactions.stress('ch_cook')).toBe(0);
  expect(reactions.missingTopics()).toEqual([
    { subjectId: 'ch_missing', trigger: 'disappearance' },
    { subjectId: 'ch_victim', trigger: 'death' },
  ]);
});

test('AvoidPlayer: only wary characters near the player retreat', () => {
  const calls: string[] = [];
  const goal = avoidPlayer({
    playerNearby: () => true,
    refuge: () => 'loc_cellar',
    retreat: (_c, to) => calls.push(to),
  });
  const wary = ctx(state({ wariness: AVOID_WARINESS_THRESHOLD + 0.1 }));
  expect(goal.score(wary)).toBeGreaterThan(0);
  expect(goal.score(ctx(state({ wariness: AVOID_WARINESS_THRESHOLD })))).toBe(-Infinity);
  expect(scoreAvoidPlayer(wary.state, false)).toBe(-Infinity);
  goal.plan(wary, undefined as never)?.start();
  expect(calls).toEqual(['loc_cellar']);
  const stranded = avoidPlayer({
    playerNearby: () => true,
    refuge: () => undefined,
    retreat: () => calls.push('x'),
  });
  expect(stranded.plan(wary, undefined as never)).toBeNull();
});

test('timid characters flee more eagerly than brave ones', () => {
  const timid = state({ wariness: 0.8, personality: { ...personality(0.5), courage: 0 } });
  const brave = state({ wariness: 0.8, personality: { ...personality(0.5), courage: 1 } });
  expect(scoreAvoidPlayer(timid, true)).toBeGreaterThan(scoreAvoidPlayer(brave, true));
});

test('snapshot and restore carry the whole memory of the player', () => {
  const source = new PlayerReactions({
    topicSensitivity: () => 0.8,
    closeTo: (id) => (id === 'ch_a' ? ['ch_c'] : []),
  });
  source.onPlayerAction({
    witnessIds: ['ch_b'],
    heardByIds: [],
    characterId: 'ch_b',
    topicId: 't',
  });
  source.applyConsequences([
    { kind: 'refuses_to_talk', characterId: 'ch_a' },
    { kind: 'trust_falls' },
    { kind: 'culprit_freed', characterId: 'ch_b' },
  ]);
  source.onCharacterGone('ch_a', 'death');
  const saved = JSON.parse(JSON.stringify(source.snapshot())) as ReactionsSnapshot;
  const copy = new PlayerReactions({ topicSensitivity: () => 0, closeTo: () => [] });
  copy.restore(saved);
  expect(copy.snapshot()).toEqual(source.snapshot());
  expect(copy.wariness('ch_b')).toBe(source.wariness('ch_b'));
  expect(copy.refuses('ch_c')).toBe(true);
  expect(copy.isFreed('ch_b')).toBe(true);
  expect(copy.trust).toBe(source.trust);
  expect(copy.missingTopics()).toEqual(source.missingTopics());
});
