// 海克斯大乱斗：游戏内海克斯牌选择推荐（3/7/11/15 级选牌（泉水复活后出现选牌界面））
// 评分 = 牌榜胜率 + 阵容适配加分（牌榜 bestHeroes 命中我方英雄数），输出 S/A/B/C/D 等级
import { getAugmentList, getHextechRuneRank, getHeroList } from '../api/cn101.js';
import { heroDisplayName, type AugmentInfo, type HextechRuneStat } from '../models.js';
import { augmentLevelName } from './hextech.js';

export type AugmentGrade = 'S' | 'A' | 'B' | 'C' | 'D';

export const GRADE_NAMES: Record<AugmentGrade, string> = {
  S: 'S · 无脑选',
  A: 'A · 强烈推荐',
  B: 'B · 不错',
  C: 'C · 一般',
  D: 'D · 尽量避免',
};

export interface AugmentChoice {
  augmentId: number;
  name: string;
  /** 品质中文（白银/黄金/棱彩） */
  level: string;
  /** 胜率（百分比） */
  winRate: number;
  /** 出场率（百分比） */
  pickRate: number;
  /** 牌榜最适合英雄（前4） */
  bestHeroes: string[];
  /** 命中我方阵容的英雄 */
  matchedHeroes: string[];
  /** 综合分 = 胜率 + 命中数×加成 */
  score: number;
  grade: AugmentGrade;
}

/** 每个命中我方阵容的英雄加分（牌榜 top4 适配） */
export const MATCH_BONUS = 1.2;

export function gradeOf(score: number): AugmentGrade {
  if (score >= 56) return 'S';
  if (score >= 53) return 'A';
  if (score >= 50.5) return 'B';
  if (score >= 48.5) return 'C';
  return 'D';
}

/** 纯函数：给定可选牌 + 我方阵容，输出分级推荐（按综合分降序） */
export function gradeAugmentChoices(
  optionIds: number[],
  myHeroIds: number[],
  stats: HextechRuneStat[],
  augments: ReadonlyMap<number, AugmentInfo>,
  heroTitles: ReadonlyMap<number, string>,
): AugmentChoice[] {
  const my = new Set(myHeroIds);
  const statMap = new Map(stats.map((s) => [s.augmentId, s]));
  const list = [...new Set(optionIds)].map((id) => {
    const s = statMap.get(id);
    const a = augments.get(id);
    const winRate = s ? +((s.winRate * 100).toFixed(2)) : NaN;
    const best = s?.bestHeroes ?? [];
    const matched = best.filter((h) => my.has(h));
    const score = (Number.isFinite(winRate) ? winRate : 0) + matched.length * MATCH_BONUS;
    return {
      augmentId: id,
      name: a?.name_cn ?? `牌#${id}`,
      level: augmentLevelName(a?.level ?? ''),
      winRate,
      pickRate: s ? +((s.pickRate * 100).toFixed(2)) : NaN,
      bestHeroes: best.map((h) => heroDisplayName(heroTitles.get(h) ? { title: heroTitles.get(h)! } : undefined, h)),
      matchedHeroes: matched.map((h) => heroTitles.get(h) ?? `#${h}`),
      score: +score.toFixed(2),
      grade: gradeOf(score),
    };
  });
  return list.sort((a, b) => b.score - a.score);
}

/** 网络版：拉取牌榜/牌表/英雄表后评分 */
export async function recommendAugmentChoices(optionIds: number[], myHeroIds: number[]): Promise<AugmentChoice[]> {
  const [stats, augments, heroes] = await Promise.all([getHextechRuneRank(), getAugmentList(), getHeroList()]);
  const heroTitles = new Map([...heroes].map(([id, h]) => [id, h.title]));
  return gradeAugmentChoices(optionIds, myHeroIds, stats, augments, heroTitles);
}

/** 按名称关键词模糊匹配牌（中文/英文） */
export async function searchAugments(q: string): Promise<AugmentInfo[]> {
  const augments = await getAugmentList();
  const key = q.trim().toLowerCase();
  if (!key) return [];
  return [...augments.values()].filter(
    (a) => a.name_cn.includes(key) || a.name_en.toLowerCase().includes(key),
  );
}
