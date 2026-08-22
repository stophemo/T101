// Pick 推荐：对面已选英雄 -> 推荐克制他们的高胜率英雄
import { getChampionRankings, getHeroList, resolveHeroes, type RankOptions } from '../api/cn101.js';
import { heroDisplayName, type ChampionBase, type ChampionStat, type PickRecommendation } from '../models.js';

export interface PickInput {
  /** 对面已选英雄（中文/英文/id），二选一 */
  enemyHeroes?: string[];
  /** 对面已选英雄 id（LCU 场景直接传 id） */
  enemyHeroIds?: number[];
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
    getChampionRankings(input.opts),
  ]);
  return computePickRecommendations(rankings, heroes, enemyIds, excluded, input.myLane, topN);
}

/**
 * 纯计算：不依赖网络，便于单测。
 * 算法：
 * 1. 对面英雄 -> 各自被哪些英雄克制（榜单接口自带 counters 列表，无需逐个请求）
 * 2. 候选 = 所有 counters 的并集，统计每个候选克制了几个对面英雄
 * 3. 按 (克制数, 自身胜率) 综合排序
 * 4. 过滤：对面已选、我方已选、按位置过滤
 */
export function computePickRecommendations(
  rankings: ChampionStat[],
  heroes: Map<number, ChampionBase>,
  enemyIds: number[],
  excluded: Set<number>,
  myLane: string | undefined,
  topN: number,
): PickRecommendation[] {
  // 候选池：{ heroId: 它克制的对面英雄 id 集合 }
  const candidates = new Map<number, Set<number>>();
  for (const stat of rankings) {
    if (!stat.counters.length) continue;
    for (const c of stat.counters) {
      if (!enemyIds.includes(c)) continue; // 只统计克制"对面已选"的
      if (!candidates.has(stat.heroId)) candidates.set(stat.heroId, new Set());
      candidates.get(stat.heroId)!.add(c);
    }
  }

  const byId = new Map(rankings.map((r) => [r.heroId, r]));
  const enemyTitles = enemyIds.map((id) => heroDisplayName(heroes.get(id), id));

  const recs: PickRecommendation[] = [];
  for (const [heroId, countered] of candidates) {
    if (excluded.has(heroId)) continue;
    const stat = byId.get(heroId);
    if (!stat) continue;
    if (myLane && myLane !== 'ALL' && stat.lane !== myLane) continue;
    recs.push({
      heroId,
      title: heroDisplayName(heroes.get(heroId), heroId),
      winRate: stat.winRate,
      tier: stat.tier,
      lane: stat.lane,
      counters: [...countered].map((id) => enemyTitles[enemyIds.indexOf(id)] ?? String(id)),
      counterCount: countered.size,
      score: countered.size * 10 + stat.winRate, // 克制数优先，其次胜率
    });
  }

  recs.sort((a, b) => b.score - a.score);
  return recs.slice(0, topN);
}
