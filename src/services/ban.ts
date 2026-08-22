// Ban 建议：无参数时按 ban 率/胜率推荐版本强势英雄；有我方阵容时推荐克制我方最多的
import { getChampionRankings, getHeroList, resolveHeroes, type RankOptions } from '../api/cn101.js';
import { heroDisplayName, type BanRecommendation, type ChampionBase, type ChampionStat } from '../models.js';

export interface BanInput {
  /** 我方已选英雄（可选），二选一 */
  myHeroes?: string[];
  myHeroIds?: number[];
  topN?: number;
  opts?: RankOptions;
}

export async function recommendBan(input: BanInput = {}): Promise<BanRecommendation[]> {
  const topN = input.topN ?? 10;
  const [heroes, rankings] = await Promise.all([
    getHeroList(),
    getChampionRankings(input.opts),
  ]);
  const myIds = input.myHeroIds
    ? new Set(input.myHeroIds)
    : input.myHeroes?.length
      ? new Set((await resolveHeroes(input.myHeroes)).map((r) => r.heroId))
      : null;
  return computeBanRecommendations(rankings, heroes, myIds, topN);
}

/**
 * 纯计算：不依赖网络，便于单测。
 * myIds 为 null/空 → 场景 A（版本强势榜）；否则 → 场景 B（克制我方最多的）。
 */
export function computeBanRecommendations(
  rankings: ChampionStat[],
  heroes: Map<number, ChampionBase>,
  myIds: Set<number> | null,
  topN: number,
): BanRecommendation[] {
  const byId = new Map(rankings.map((r) => [r.heroId, r]));

  // 场景 A：无我方阵容 —— 综合 ban 率 + 胜率 + 登场率（版本毒瘤榜）
  if (!myIds || myIds.size === 0) {
    const best = new Map<number, BanRecommendation>(); // 同一英雄多位置时保留分数最高的一条
    for (const r of rankings) {
      const rec: BanRecommendation = {
        heroId: r.heroId,
        title: heroDisplayName(heroes.get(r.heroId), r.heroId),
        winRate: r.winRate,
        pickRate: r.pickRate,
        banRate: r.banRate,
        tier: r.tier,
        threatensCount: 0,
        threatens: [],
        score: r.banRate * 1.0 + r.winRate * 0.5 + r.pickRate * 0.2,
      };
      const prev = best.get(r.heroId);
      if (!prev || rec.score > prev.score) best.set(r.heroId, rec);
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, topN);
  }

  // 场景 B：有我方阵容 —— 找克制我方最多的英雄
  const myTitles = new Map([...myIds].map((id) => [id, heroDisplayName(heroes.get(id), id)]));
  const threatens = new Map<number, Set<number>>(); // 候选英雄 -> 被它克制(威胁)的我方英雄
  for (const stat of rankings) {
    if (myIds.has(stat.heroId)) continue; // 自己人不用 ban
    for (const c of stat.counters) {
      if (!myIds.has(c)) continue;
      if (!threatens.has(stat.heroId)) threatens.set(stat.heroId, new Set());
      threatens.get(stat.heroId)!.add(c);
    }
  }

  const recs: BanRecommendation[] = [];
  for (const [heroId, myCountered] of threatens) {
    const stat = byId.get(heroId);
    if (!stat) continue;
    recs.push({
      heroId,
      title: heroDisplayName(heroes.get(heroId), heroId),
      winRate: stat.winRate,
      pickRate: stat.pickRate,
      banRate: stat.banRate,
      tier: stat.tier,
      threatensCount: myCountered.size,
      threatens: [...myCountered].map((id) => myTitles.get(id) ?? String(id)),
      score: myCountered.size * 10 + stat.winRate + stat.banRate * 0.3,
    });
  }

  recs.sort((a, b) => b.score - a.score);
  return recs.slice(0, topN);
}
