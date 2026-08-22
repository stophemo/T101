// 服务层纯函数测试：pick/ban v2（对位驱动）+ 位置推断 + 段位映射（不依赖网络）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBanRecommendations } from '../src/services/ban.js';
import { computePickRecommendations, inferLane, normalizeLane } from '../src/services/pick.js';
import { buildAramPool } from '../src/services/champselect.js';
import { tierNameToId, TIER_NAMES, type ChampionBase, type ChampionStat } from '../src/models.js';

// ---------- 测试数据 ----------

function hero(id: number, title: string): ChampionBase {
  return { heroId: id, title, name: `称号${id}`, alias: `Hero${id}`, roles: [] };
}

function stat(id: number, lane: string, winRate: number, pickRate = 5, extra: Partial<ChampionStat> = {}): ChampionStat {
  return {
    rank: id, heroId: id, tier: 'T2', lane: lane as ChampionStat['lane'],
    winRate, pickRate, banRate: 10, counters: [], rankChange: 0, ...extra,
  };
}

const heroes = new Map([
  [1, hero(1, '安妮')], [2, hero(2, '盲僧')], [3, hero(3, '锤石')],
  [4, hero(4, '劫')], [5, hero(5, '亚索')], [6, hero(6, '盖伦')], [7, hero(7, '菲兹')],
]);

// 榜单：多位置数据（用于位置推断与候选补充）
const rankings: ChampionStat[] = [
  stat(4, 'MIDDLE', 51, 8),                              // 劫 中单 登场8%
  stat(6, 'TOP', 49, 6),                                 // 盖伦 上单
  stat(6, 'MIDDLE', 47, 1.5),                            // 盖伦 中单（冷门）
  stat(7, 'MIDDLE', 52, 7, { tier: 'T1' }),              // 菲兹 中单 T1
  stat(2, 'JUNGLE', 48, 9),                              // 盲僧 打野
];

// ---------- 位置推断 / 归一化 ----------

test('inferLane：按登场率最高的位置推断', () => {
  assert.equal(inferLane(rankings, 6), 'TOP');           // 盖伦 TOP 6% > MIDDLE 1.5%
  assert.equal(inferLane(rankings, 2), 'JUNGLE');
  assert.equal(inferLane(rankings, 4), 'MIDDLE');
  assert.equal(inferLane(rankings, 999), 'MIDDLE');      // 不在榜单 -> 兜底
});

test('normalizeLane：LCU/中文/大小写归一化', () => {
  assert.equal(normalizeLane('UTILITY'), 'SUPPORT');
  assert.equal(normalizeLane('BOTTOM'), 'BOTTOM');
  assert.equal(normalizeLane('mid'), 'MIDDLE');
  assert.equal(normalizeLane('中单'), 'MIDDLE');
  assert.equal(normalizeLane('打野'), 'JUNGLE');
});

// ---------- 段位映射 ----------

test('tierNameToId：LCU 段位名 -> itier', () => {
  assert.equal(tierNameToId('CHALLENGER'), 10);
  assert.equal(tierNameToId('GRANDMASTER'), 9);
  assert.equal(tierNameToId('MASTER'), 8);
  assert.equal(tierNameToId('DIAMOND'), 7);
  assert.equal(tierNameToId('EMERALD'), 6);
  assert.equal(tierNameToId('PLATINUM'), 5);
  assert.equal(tierNameToId('GOLD'), 4);
  assert.equal(tierNameToId('SILVER'), 3);
  assert.equal(tierNameToId('BRONZE'), 2);
  assert.equal(tierNameToId('IRON'), 1);
  assert.equal(tierNameToId('NONE'), null);
  assert.equal(tierNameToId('随便'), null);
});

test('TIER_NAMES：段位 id 名称完整', () => {
  assert.equal(TIER_NAMES[255], '全段位');
  assert.equal(TIER_NAMES[7], '钻石');
  assert.equal(TIER_NAMES[1], '黑铁');
});

// ---------- pick v2：对位驱动 ----------

test('pick：候选=对位克制的并集，按克制数+对位胜率排序', () => {
  // 对面：亚索(5)、盲僧(2)；对位数据：
  // 劫(4) 克亚索 55.5%；菲兹(7) 克亚索 58.1%、克盲僧 57.3%；盖伦(6) 克盲僧 52.1%
  const matchups = [
    { enemyId: 5, heroId: 4, winRate: 55.5 },
    { enemyId: 5, heroId: 7, winRate: 58.1 },
    { enemyId: 2, heroId: 7, winRate: 57.3 },
    { enemyId: 2, heroId: 6, winRate: 52.1 },
  ];
  const recs = computePickRecommendations(heroes, rankings, matchups, new Set(), 'ALL', 10);
  // 菲兹克制 2 个（58.1 + 57.3）排第一；劫只克 1 个排第二
  assert.equal(recs[0].heroId, 7);
  assert.equal(recs[0].counterCount, 2);
  assert.deepEqual(recs[0].matchups.map((m) => m.enemyTitle), ['亚索', '盲僧']);
  assert.ok(recs[0].score > recs[1].score);
  // 候选带榜单数据（T级/胜率来自该段位榜单）
  assert.equal(recs[0].tier, 'T1');
});

test('pick：排除对面/我方已选', () => {
  const matchups = [
    { enemyId: 5, heroId: 4, winRate: 55.5 },
    { enemyId: 5, heroId: 7, winRate: 58.1 },
    { enemyId: 5, heroId: 6, winRate: 53 },
  ];
  const recs = computePickRecommendations(heroes, rankings, matchups, new Set([6]), 'ALL', 10);
  assert.ok(!recs.some((r) => r.heroId === 6));
  assert.equal(recs.length, 2);
});

test('pick：按我方位置过滤（候选需在我方位置有榜单数据）', () => {
  const matchups = [
    { enemyId: 5, heroId: 4, winRate: 55.5 },
    { enemyId: 5, heroId: 7, winRate: 58.1 },
    { enemyId: 2, heroId: 6, winRate: 52 },   // 盖伦在 MIDDLE 有数据（1.5%）→ 保留
    { enemyId: 2, heroId: 2, winRate: 60 },   // 盲僧（自己人+无 MIDDLE 数据）→ 排除
  ];
  const recs = computePickRecommendations(heroes, rankings, matchups, new Set(), 'MIDDLE', 10);
  assert.ok(recs.every((r) => r.lane === 'MIDDLE'));
  assert.ok(recs.some((r) => r.heroId === 4));
  assert.ok(recs.some((r) => r.heroId === 7));
  assert.ok(!recs.some((r) => r.heroId === 2));
});

test('pick：无对位数据时返回空', () => {
  const recs = computePickRecommendations(heroes, rankings, [], new Set(), 'ALL', 10);
  assert.deepEqual(recs, []);
});

test('pick：topN 截断', () => {
  const matchups = [
    { enemyId: 5, heroId: 4, winRate: 55.5 },
    { enemyId: 5, heroId: 7, winRate: 58.1 },
    { enemyId: 5, heroId: 6, winRate: 53 },
  ];
  const recs = computePickRecommendations(heroes, rankings, matchups, new Set(), 'ALL', 2);
  assert.equal(recs.length, 2);
});

// ---------- ban v2 ----------

test('ban 场景 A：版本梯度榜 T0 优先，同英雄多位置去重', () => {
  const r = [
    stat(4, 'MIDDLE', 51, 8, { tier: 'T1', banRate: 30 }),
    stat(7, 'MIDDLE', 52, 7, { tier: 'T0', banRate: 25 }),  // T0 应排最前
    stat(6, 'TOP', 49, 6, { tier: 'T2', banRate: 40 }),
    stat(6, 'MIDDLE', 47, 1.5, { tier: 'T2', banRate: 35 }), // 盖伦重复，取分数高的一条
  ];
  const recs = computeBanRecommendations(heroes, r, null, [], 10);
  assert.equal(recs[0].heroId, 7); // T0 优先
  assert.equal(recs[0].tier, 'T0');
  assert.equal(recs.filter((x) => x.heroId === 6).length, 1); // 去重
  // 全部无威胁字段（场景 A）
  assert.ok(recs.every((x) => x.threatensCount === 0));
});

test('ban 场景 B：威胁数+对位胜率排序，自己人排除', () => {
  // 我方：亚索(5)、盲僧(2)
  // 威胁数据（low_op）：亚索被劫(4)克 58%、被菲兹(7)克 55%；盲僧被菲兹(7)克 54%
  const threats = [
    { myId: 5, heroId: 4, winRate: 58 },
    { myId: 5, heroId: 7, winRate: 55 },
    { myId: 2, heroId: 7, winRate: 54 },
    { myId: 5, heroId: 5, winRate: 60 }, // 自己人亚索威胁亚索？-> 排除
  ];
  const recs = computeBanRecommendations(heroes, rankings, new Set([5, 2]), threats, 10);
  // 菲兹威胁 2 个排第一
  assert.equal(recs[0].heroId, 7);
  assert.equal(recs[0].threatensCount, 2);
  assert.deepEqual(recs[0].matchups?.map((m) => m.myTitle).sort(), ['亚索', '盲僧'].sort());
  // 自己人不在候选
  assert.ok(!recs.some((r) => r.heroId === 5 || r.heroId === 2));
});

test('ban 场景 B：无威胁数据时降级为版本梯度榜', () => {
  const recs = computeBanRecommendations(heroes, rankings, new Set([5]), [], 10);
  assert.ok(recs.length > 0);
  assert.ok(recs.every((r) => r.threatensCount === 0)); // 是场景 A 的输出
});

// ---------- 海克斯大乱斗共享池 ----------

test('buildAramPool：翻开的英雄进池去重、按胜率排序、标注自己翻的', () => {
  const myTeam = [
    { cellId: 1, championId: 7 },   // 我：菲兹
    { cellId: 2, championId: 6 },   // 队友：盖伦
    { cellId: 3, championId: 7 },   // 队友也翻到菲兹 -> 去重
    { cellId: 4, championId: 0 },   // 还没翻
    { cellId: 5, championId: 0 },   // 还没翻
  ];
  const aramHeroes = [
    { heroId: 6, title: '盖伦', alias: 'Garen', winRate: 49.2, pickRate: 10, rank: 2, bestAugments: [], bestPartners: [] },
    { heroId: 7, title: '菲兹', alias: 'Fizz', winRate: 52.8, pickRate: 8, rank: 1, bestAugments: [], bestPartners: [] },
  ];
  const pool = buildAramPool(myTeam, 1, heroes, aramHeroes);
  assert.equal(pool.length, 2);                    // 去重后 2 个
  assert.equal(pool[0].heroId, 7);                 // 菲兹胜率更高排第一
  assert.equal(pool[0].isMine, true);              // 我翻的
  assert.equal(pool[1].isMine, false);
  assert.equal(pool[1].heroId, 6);
});

test('buildAramPool：榜外英雄补空胜率，未翻牌为空池', () => {
  const poolEmpty = buildAramPool(
    [{ cellId: 1, championId: 0 }, { cellId: 2, championId: 0 }],
    1, heroes, [],
  );
  assert.deepEqual(poolEmpty, []);
  const pool = buildAramPool(
    [{ cellId: 1, championId: 1 }, { cellId: 2, championId: 0 }],
    1, heroes, [], // 安妮不在榜内
  );
  assert.equal(pool.length, 1);
  assert.equal(pool[0].title, '安妮');
  assert.equal(pool[0].winRate, null);             // 无榜数据
  assert.deepEqual(pool[0].bestAugments, []);
});
