// 海克斯大乱斗推荐：选英雄推荐 + 选海克斯牌推荐
import { getHextechHeroRank, getHextechRuneRank, getAugmentList, getHeroList } from '../api/cn101.js';
import { heroDisplayName, type AugmentInfo, type HextechHeroStat, type HextechRuneStat } from '../models.js';

export interface AugmentPick {
  augment: AugmentInfo;
  winRate: number;       // 持有胜率（百分比显示用 *100）
  pickRate: number;      // 出场率
  winRank: number;
  pickRank: number;
  bestHeroes: string[];  // 最适合英雄（中文名）
}

export interface HeroAugmentSuggestion {
  heroId: number;
  title: string;
  alias: string;
  winRate: number;       // 百分比
  pickRate: number;
  rank: number;
  bestAugments: (AugmentInfo & { winRate: number; pickRate: number; winRank: number })[];
  bestPartners: { heroId: number; title: string; alias: string; winRate: number }[];
}

/** 展示用胜率：接口返回 0.5773 表示 57.73% */
export const toPct = (v: number) => +(v * 100).toFixed(2);

/** 选牌推荐：全牌榜按胜率/出场率排序（带品质、适用英雄） */
export async function recommendAugments(topN = 20): Promise<AugmentPick[]> {
  const [runes, augments, heroes] = await Promise.all([getHextechRuneRank(), getAugmentList(), getHeroList()]);
  return runes
    .slice()
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, topN)
    .map((r: HextechRuneStat) => ({
      augment: augments.get(r.augmentId) ?? {
        augmentID: r.augmentId, name_cn: `牌#${r.augmentId}`, name_en: '', level: '',
        tooltip: '', small_Icon: '', large_Icon: '',
      },
      winRate: toPct(r.winRate),
      pickRate: toPct(r.pickRate),
      winRank: r.winRank,
      pickRank: r.pickRank,
      bestHeroes: r.bestHeroes.slice(0, 4).map((id) => heroDisplayName(heroes.get(id), id)),
    }));
}

/** 选英雄推荐：海克斯大乱斗英雄榜（胜率排序），附推荐海克斯牌与搭档 */
export async function recommendHextechHeroes(topN = 20): Promise<HeroAugmentSuggestion[]> {
  const [heroes, augments, list] = await Promise.all([
    getHeroList(),
    getAugmentList(),
    getHextechHeroRank(),
  ]);
  // 牌榜胜率映射（用于展示英雄推荐牌的胜率）
  const runes = await getHextechRuneRank().catch(() => []);
  const runeWin = new Map(runes.map((r) => [r.augmentId, toPct(r.winRate)]));
  const runePick = new Map(runes.map((r) => [r.augmentId, toPct(r.pickRate)]));
  const runeRank = new Map(runes.map((r) => [r.augmentId, r.winRank]));

  return list
    .slice()
    .sort((a: HextechHeroStat, b: HextechHeroStat) => b.winRate - a.winRate)
    .slice(0, topN)
    .map((h: HextechHeroStat) => ({
      heroId: h.heroId,
      title: heroDisplayName(heroes.get(h.heroId), h.heroId),
      alias: heroes.get(h.heroId)?.alias ?? '',
      winRate: toPct(h.winRate),
      pickRate: toPct(h.pickRate),
      rank: h.rank,
      bestAugments: h.bestAugments.slice(0, 3).map((id) => ({
        ...(augments.get(id) ?? { augmentID: id, name_cn: `牌#${id}`, name_en: '', level: '', tooltip: '', small_Icon: '', large_Icon: '' }),
        winRate: runeWin.get(id) ?? 0,
        pickRate: runePick.get(id) ?? 0,
        winRank: runeRank.get(id) ?? 0,
      })),
      // 最佳拍档：按组合胜率降序取前 3（官方字段按综合 rank 排序，与胜率顺序不一致）
      bestPartners: h.bestPartners
        .slice()
        .sort((a, b) => b.winRate - a.winRate)
        .slice(0, 3)
        .map((p) => ({
          heroId: p.heroId,
          title: heroDisplayName(heroes.get(p.heroId), p.heroId),
          alias: heroes.get(p.heroId)?.alias ?? '',
          winRate: toPct(p.winRate),
        })),
    }));
}

/** 最佳拍档榜：聚合官方英雄榜的搭档数据，按组合胜率排序（101 页面第三个内页签） */
export async function recommendHextechPartners(topN = 20): Promise<{
  heroId: number; heroTitle: string; heroAlias: string;
  partnerId: number; partnerTitle: string; partnerAlias: string;
  winRate: number; pickRate: number;
}[]> {
  const [heroes, list] = await Promise.all([getHeroList(), getHextechHeroRank()]);
  const rows: {
    heroId: number; heroTitle: string; heroAlias: string;
    partnerId: number; partnerTitle: string; partnerAlias: string;
    winRate: number; pickRate: number;
  }[] = [];
  for (const h of list) {
    for (const p of h.bestPartners) {
      rows.push({
        heroId: h.heroId,
        heroTitle: heroDisplayName(heroes.get(h.heroId), h.heroId),
        heroAlias: heroes.get(h.heroId)?.alias ?? '',
        partnerId: p.heroId,
        partnerTitle: heroDisplayName(heroes.get(p.heroId), p.heroId),
        partnerAlias: heroes.get(p.heroId)?.alias ?? '',
        winRate: toPct(p.winRate),
        pickRate: toPct(p.pickRate),
      });
    }
  }
  return rows.sort((a, b) => b.winRate - a.winRate).slice(0, topN);
}

/** 品质显示名 */
export const augmentLevelName = (l: string) =>
  ({ kSilver: '白银', kGold: '黄金', kPrismatic: '棱彩' }[l] ?? l);
