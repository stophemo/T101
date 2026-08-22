// 服务层纯函数测试：computeBanRecommendations / computePickRecommendations（不依赖网络）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBanRecommendations } from '../src/services/ban.js';
import { computePickRecommendations } from '../src/services/pick.js';
import type { ChampionBase, ChampionStat } from '../src/models.js';

// ---------- 测试数据 ----------

function hero(id: number, title: string): ChampionBase {
  return { heroId: id, title, name: `称号${id}`, alias: `Hero${id}`, roles: [] };
}

function stat(id: number, lane: string, winRate: number, counters: number[], extra: Partial<ChampionStat> = {}): ChampionStat {
  return {
    rank: id, heroId: id, tier: 'T2', lane: lane as ChampionStat['lane'],
    winRate, pickRate: 5, banRate: 10, counters, rankChange: 0, ...extra,
  };
}

const heroes = new Map([
  [1, hero(1, '安妮')], [2, hero(2, '盲僧')], [3, hero(3, '锤石')],
  [4, hero(4, '劫')], [5, hero(5, '亚索')], [6, hero(6, '盖伦')], [7, hero(7, '菲兹')],
]);

// 榜单：4号劫克制 5（亚索）；6号盖伦克制 5、2（盲僧）；7号菲兹克制 5、2、1（安妮）；1号安妮克制 4（劫）
const rankings: ChampionStat[] = [
  stat(1, 'MIDDLE', 50, [4]),       // 安妮克制劫
  stat(4, 'MIDDLE', 51, [5]),       // 劫克制亚索
  stat(6, 'TOP', 49, [5, 2]),       // 盖伦克制亚索、盲僧
  stat(7, 'MIDDLE', 52, [5, 2, 1]), // 菲兹克制亚索、盲僧、安妮
  stat(2, 'JUNGLE', 48, [1]),       // 盲僧克制安妮
];

// ---------- ban：场景 A（版本强势榜） ----------

test('recommendBan 场景 A：无我方阵容时按 ban 率+胜率+登场率排序', () => {
  const recs = computeBanRecommendations(rankings, heroes, null, 10);
  assert.equal(recs.length, 5);
  // 全部是版本榜：threatens 为空
  for (const r of recs) assert.equal(r.threatensCount, 0);
  // 排序按 score 降序
  for (let i = 1; i < recs.length; i++) assert.ok(recs[i - 1].score >= recs[i].score);
  // 同一英雄多位置只保留一条（构造重复数据验证）
  const dup: ChampionStat[] = [...rankings, stat(1, 'TOP', 55, [])];
  const deduped = computeBanRecommendations(dup, heroes, null, 10);
  assert.equal(deduped.filter((r) => r.heroId === 1).length, 1);
});

// ---------- ban：场景 B（克制我方） ----------

test('recommendBan 场景 B：按克制我方数量优先排序（回归：myHeroIds 应生效）', () => {
  // 我方：亚索(5)、盲僧(2) -> 菲兹(7) 克制 2 个、盖伦(6) 克制 2 个、劫(4) 克制 1 个、安妮(1) 0 个
  const recs = computeBanRecommendations(rankings, heroes, new Set([5, 2]), 10);
  const top = recs[0];
  // 菲兹 winRate 52 > 盖伦 49，同克制数时胜率高者优先
  assert.equal(top.heroId, 7);
  assert.equal(top.threatensCount, 2);
  assert.deepEqual(top.threatens.sort(), ['亚索', '盲僧'].sort());
  // 不推荐自己人（我方选的亚索/盲僧不应出现在候选里）
  assert.ok(!recs.some((r) => r.heroId === 5 || r.heroId === 2));
  // 克制数少的排在后面：劫(4) 只克制 1 个，排最后（威胁 0 的安妮不会出现在候选里）
  assert.equal(recs[recs.length - 1].heroId, 4);
  assert.equal(recs[recs.length - 1].threatensCount, 1);
});

test('recommendBan 场景 B：空数组 myIds 等价于场景 A（版本榜）', () => {
  const empty = computeBanRecommendations(rankings, heroes, new Set<number>(), 10);
  const a = computeBanRecommendations(rankings, heroes, null, 10);
  assert.deepEqual(empty, a);
});

// ---------- pick ----------

test('recommendPick：统计克制对面数量、排除、位置过滤、排序', () => {
  // 对面：亚索(5)、盲僧(2)
  // 候选：菲兹(7) 克制 2 个；盖伦(6) 克制 2 个；劫(4) 克制 1 个
  const recs = computePickRecommendations(rankings, heroes, [5, 2], new Set([6]), 'ALL', 10);
  // 盖伦被排除
  assert.ok(!recs.some((r) => r.heroId === 6));
  const top = recs[0];
  assert.equal(top.heroId, 7);
  assert.equal(top.counterCount, 2);
  assert.deepEqual(top.counters, ['亚索', '盲僧']);
  // 对面自己(5/2)不出现在推荐里
  assert.ok(!recs.some((r) => r.heroId === 5 || r.heroId === 2));
});

test('recommendPick：按位置过滤（只推 MIDDLE）', () => {
  const recs = computePickRecommendations(rankings, heroes, [5], new Set(), 'MIDDLE', 10);
  // 对面亚索：劫(4, MIDDLE)、菲兹(7, MIDDLE) 克制；盖伦(6, TOP) 应被过滤
  assert.ok(recs.every((r) => r.lane === 'MIDDLE'));
  assert.ok(recs.some((r) => r.heroId === 4));
  assert.ok(recs.some((r) => r.heroId === 7));
});

test('recommendPick：topN 截断', () => {
  const recs = computePickRecommendations(rankings, heroes, [5, 2], new Set(), 'ALL', 2);
  assert.equal(recs.length, 2);
});

test('recommendPick：无克制关系时返回空', () => {
  const recs = computePickRecommendations(rankings, heroes, [3], new Set(), 'ALL', 10); // 锤石无人克制
  assert.deepEqual(recs, []);
});
