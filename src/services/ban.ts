// Ban 建议（v2）：
// 场景 A（无我方阵容）：版本梯度榜 —— 按段位拉全位置榜单，T0/T1 梯度优先，组内按禁用率+胜率排序（方便 ban 版本强势）
// 场景 B（有我方阵容）：对位威胁分析 —— 查每个我方英雄的优势对线（confront low_op = 被谁克制），
//   候选 = 威胁并集，按（威胁数、对位胜率、版本禁用率）综合排序
import { getChampionRankings, getConfront, getHeroList, resolveHeroes, type RankOptions } from '../api/cn101.js';
import { heroDisplayName, type BanRecommendation, type ChampionBase, type ChampionStat, type Lane } from '../models.js';
import { inferLane } from './pick.js';

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
    getChampionRankings({ ...input.opts, lane: 'ALL' }),
  ]);
  const myIds = input.myHeroIds
    ? new Set(input.myHeroIds)
    : input.myHeroes?.length
      ? new Set((await resolveHeroes(input.myHeroes)).map((r) => r.heroId))
      : null;

  // 场景 B：对每个我方英雄查对位（被谁克制 = 威胁）；查询失败/无数据时降级为场景 A
  let myThreats: { myId: number; heroId: number; winRate: number }[] = [];
  if (myIds && myIds.size > 0) {
    const lanes = new Map<number, Lane>();
    for (const id of myIds) lanes.set(id, inferLane(rankings, id));
    const results = await Promise.allSettled([...myIds].map((id) =>
      getConfront(id, { ...input.opts, lane: lanes.get(id) ?? 'MIDDLE' }),
    ));
    [...myIds].forEach((myId, i) => {
      const r = results[i];
      if (r.status !== 'fulfilled') return;
      for (const h of r.value.low) myThreats.push({ myId, heroId: h.heroId, winRate: h.winRate });
    });
  }

  return computeBanRecommendations(heroes, rankings, myIds, myThreats, topN);
}

/** 纯计算：不依赖网络，便于单测 */
export function computeBanRecommendations(
  heroes: Map<number, ChampionBase>,
  rankings: ChampionStat[],
  myIds: Set<number> | null,
  myThreats: { myId: number; heroId: number; winRate: number }[],
  topN: number,
): BanRecommendation[] {
  const tierOrder: Record<string, number> = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 4 };

  // 有阵容但无威胁数据（对位查询失败/全空）：降级为版本梯度榜
  if (myIds && myIds.size > 0 && myThreats.length === 0) myIds = null;

  // 场景 A：版本梯度榜（T0 > T1 > T2 优先，组内按 禁用率*1 + 胜率*0.5 + 登场率*0.2）
  if (!myIds || myIds.size === 0) {
    const best = new Map<number, BanRecommendation>(); // 同英雄多位置时保留分数最高的一条
    for (const r of rankings) {
      const tier = tierOrder[r.tier] ?? 4;
      const rec: BanRecommendation = {
        heroId: r.heroId,
        title: heroDisplayName(heroes.get(r.heroId), r.heroId),
        winRate: r.winRate,
        pickRate: r.pickRate,
        banRate: r.banRate,
        tier: r.tier,
        lane: r.lane,
        threatensCount: 0,
        threatens: [],
        score: -tier * 1000 + r.banRate + r.winRate * 0.5 + r.pickRate * 0.2,
      };
      const prev = best.get(r.heroId);
      if (!prev || rec.score > prev.score) best.set(r.heroId, rec);
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, topN);
  }

  // 场景 B：威胁并集（candidate -> 它威胁的我方英雄及对位胜率）
  const candidates = new Map<number, { myId: number; winRate: number }[]>();
  for (const t of myThreats) {
    if (myIds.has(t.heroId)) continue; // 自己人不用 ban
    if (!candidates.has(t.heroId)) candidates.set(t.heroId, []);
    candidates.get(t.heroId)!.push({ myId: t.myId, winRate: t.winRate });
  }

  const byId = new Map(rankings.map((r) => [r.heroId, r]));
  const myTitles = new Map([...myIds].map((id) => [id, heroDisplayName(heroes.get(id), id)]));
  const recs: BanRecommendation[] = [];
  for (const [heroId, threats] of candidates) {
    const stat = byId.get(heroId);
    if (!stat) continue;
    const avgWin = threats.reduce((s, t) => s + t.winRate, 0) / threats.length;
    // 版本强势加权：ban 率高的优先（ban 掉一石二鸟：既反制我方被克，又拆版本毒瘤）
    const score = threats.length * 10 + (avgWin - 50) * 0.8 + stat.banRate * 0.3 + stat.winRate * 0.2;
    recs.push({
      heroId,
      title: heroDisplayName(heroes.get(heroId), heroId),
      winRate: stat.winRate,
      pickRate: stat.pickRate,
      banRate: stat.banRate,
      tier: stat.tier,
      lane: stat.lane,
      threatensCount: threats.length,
      threatens: threats.map((t) => myTitles.get(t.myId) ?? String(t.myId)),
      matchups: threats.map((t) => ({
        myTitle: myTitles.get(t.myId) ?? String(t.myId),
        winRate: t.winRate,
      })),
      score,
    });
  }

  recs.sort((a, b) => b.score - a.score);
  return recs.slice(0, topN);
}
