// Pick 推荐：对面已选英雄 -> 推荐克制他们的高胜率英雄
// v2 算法（对位驱动）：不再依赖榜单 counters 字段（实测不可靠），
// 而是对每个对面英雄查官方对位接口（lol_101strategy_confront high_op = 该英雄的劣势对线），
// 候选 = 所有"克制对面英雄"的并集，按（克制数、对位胜率、段位榜单胜率/T级）综合排序。
import { getChampionRankings, getConfront, getHeroList, resolveHeroes, type RankOptions } from '../api/cn101.js';
import { heroDisplayName, type ChampionBase, type ChampionStat, type Lane, type PickRecommendation } from '../models.js';

export interface PickInput {
  /** 对面已选英雄（中文/英文/id），二选一 */
  enemyHeroes?: string[];
  /** 对面已选英雄 id（LCU 场景直接传 id） */
  enemyHeroIds?: number[];
  /** 对面英雄各自的位置（LCU 的 assignedPosition）；缺失时按榜单登场率推断主位置 */
  enemyLanes?: Record<number, string>;
  myLane?: string;            // 我方要选的位置过滤
  exclude?: string[];         // 我方已选（不推荐重复）
  excludeIds?: number[];
  topN?: number;
  opts?: RankOptions;
}

export async function recommendPick(input: PickInput): Promise<PickRecommendation[]> {
  const topN = input.topN ?? 8;
  const enemyIds = input.enemyHeroIds
    ?? (await resolveHeroes(input.enemyHeroes ?? [])).map((r) => r.heroId);
  const excluded = new Set([
    ...enemyIds,
    ...(input.excludeIds ?? []),
    ...(input.exclude ? (await resolveHeroes(input.exclude)).map((r) => r.heroId) : []),
  ]);
  const [heroes, rankings] = await Promise.all([
    getHeroList(),
    getChampionRankings({ ...input.opts, lane: 'ALL' }),
  ]);

  // 1. 每个对面英雄的位置：LCU 给了直接用；否则按该英雄在榜单中登场率最高的位置
  const enemyLanes = new Map<number, Lane>();
  for (const id of enemyIds) {
    enemyLanes.set(id, input.enemyLanes?.[id] ? normalizeLane(input.enemyLanes[id]) : inferLane(rankings, id));
  }

  // 2. 并行查对位（单个失败不阻塞整体，跳过该英雄）
  const confronts = await Promise.allSettled(enemyIds.map((id) =>
    getConfront(id, { ...input.opts, lane: enemyLanes.get(id) ?? 'MIDDLE' }),
  ));

  // 3. 展开为 (enemyId, candidateId, winRate) 列表
  const enemyMatchups: { enemyId: number; heroId: number; winRate: number }[] = [];
  enemyIds.forEach((enemyId, i) => {
    const r = confronts[i];
    if (r.status !== 'fulfilled') return;
    for (const h of r.value.high) enemyMatchups.push({ enemyId, heroId: h.heroId, winRate: h.winRate });
  });

  return computePickRecommendations(heroes, rankings, enemyMatchups, excluded, input.myLane, topN);
}

/** 纯计算：不依赖网络，便于单测 */
export function computePickRecommendations(
  heroes: Map<number, ChampionBase>,
  rankings: ChampionStat[],
  enemyMatchups: { enemyId: number; heroId: number; winRate: number }[],
  excluded: Set<number>,
  myLane: string | undefined,
  topN: number,
): PickRecommendation[] {
  // 候选池：candidate -> 它克制的对面英雄及对位胜率
  const candidates = new Map<number, { enemyId: number; winRate: number }[]>();
  for (const m of enemyMatchups) {
    if (!candidates.has(m.heroId)) candidates.set(m.heroId, []);
    candidates.get(m.heroId)!.push({ enemyId: m.enemyId, winRate: m.winRate });
  }
  return buildRecommendations(heroes, rankings, candidates, excluded, myLane, topN);
}

/** 由候选池构建推荐（候选池结构：candidate -> 对位列表） */
export function buildRecommendations(
  heroes: Map<number, ChampionBase>,
  rankings: ChampionStat[],
  candidates: Map<number, { enemyId: number; winRate: number }[]>,
  excluded: Set<number>,
  myLane: string | undefined,
  topN: number,
): PickRecommendation[] {
  const enemyName = new Map<number, string>();
  for (const list of candidates.values()) {
    for (const m of list) {
      if (!enemyName.has(m.enemyId)) enemyName.set(m.enemyId, heroDisplayName(heroes.get(m.enemyId), m.enemyId));
    }
  }

  const recs: PickRecommendation[] = [];
  for (const [heroId, matchups] of candidates) {
    if (excluded.has(heroId)) continue;
    const rows = rankings.filter((r) => r.heroId === heroId);
    if (!rows.length) continue; // 候选必须在该段位榜单里有数据（有登场才可信）
    // 我方位置过滤：候选需在我方要选的位置有榜单数据
    if (myLane && myLane !== 'ALL' && !rows.some((r) => r.lane === myLane)) continue;
    const main = [...rows].sort((a, b) => b.pickRate - a.pickRate)[0];
    // 展示我方目标位置的数据（未指定位置时用主位置）
    const laneRow = myLane && myLane !== 'ALL' ? rows.find((r) => r.lane === myLane) : undefined;
    const row = laneRow ?? main;
    const avgMatchupWin = matchups.reduce((s, m) => s + m.winRate, 0) / matchups.length;
    // 综合分：克制数优先；其次平均对位胜率（高于 50 加分）；最后榜单胜率
    const score = matchups.length * 10 + (avgMatchupWin - 50) * 0.8 + row.winRate * 0.2;
    recs.push({
      heroId,
      title: heroDisplayName(heroes.get(heroId), heroId),
      winRate: row.winRate,
      tier: row.tier,
      lane: row.lane,
      counters: matchups.map((m) => enemyName.get(m.enemyId) ?? String(m.enemyId)),
      counterCount: matchups.length,
      matchups: matchups.map((m) => ({
        enemyTitle: enemyName.get(m.enemyId) ?? String(m.enemyId),
        winRate: m.winRate,
      })),
      score,
    });
  }

  recs.sort((a, b) => b.score - a.score);
  return recs.slice(0, topN);
}

/** 榜单位置推断：该英雄登场率最高的位置 */
export function inferLane(rankings: ChampionStat[], heroId: number): Lane {
  const rows = rankings.filter((r) => r.heroId === heroId);
  if (!rows.length) return 'MIDDLE';
  return [...rows].sort((a, b) => b.pickRate - a.pickRate)[0].lane;
}

/** 位置名归一化（LCU 的 UTILITY/BOTTOM -> SUPPORT/BOTTOM；中文/小写兼容） */
export function normalizeLane(lane: string): Lane {
  const map: Record<string, Lane> = {
    TOP: 'TOP', top: 'TOP', 上单: 'TOP', 上路: 'TOP',
    JUNGLE: 'JUNGLE', jungle: 'JUNGLE', 打野: 'JUNGLE',
    MIDDLE: 'MIDDLE', MID: 'MIDDLE', middle: 'MIDDLE', mid: 'MIDDLE', 中单: 'MIDDLE', 中路: 'MIDDLE',
    BOTTOM: 'BOTTOM', BOT: 'BOTTOM', bottom: 'BOTTOM', ADC: 'BOTTOM', adc: 'BOTTOM', 下路: 'BOTTOM',
    SUPPORT: 'SUPPORT', SUP: 'SUPPORT', support: 'SUPPORT', UTILITY: 'SUPPORT', 辅助: 'SUPPORT',
  };
  return map[lane.toUpperCase()] ?? map[lane] ?? 'ALL';
}
