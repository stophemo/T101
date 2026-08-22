// 数据模型：所有 API 数据源统一返回这里的类型

/** 位置 */
export type Lane = 'TOP' | 'JUNGLE' | 'MIDDLE' | 'BOTTOM' | 'SUPPORT' | 'ALL';

/** 英雄静态信息（来自 hero_list.js） */
export interface ChampionBase {
  heroId: number;
  /** 称号，如「黑暗之女」 */
  name: string;
  /** 常用名，如「安妮」 */
  title: string;
  /** 英文名，如「Annie」 */
  alias: string;
  roles: string[];
}

/** 展示用英雄名：国服 hero_list 的 title 即常用名（劫/安妮/亚索），name 是称号 */
export function heroDisplayName(h: { title: string } | undefined, heroId: number): string {
  return h?.title ?? String(heroId);
}

/** 榜单中单个英雄的统计（lol_101strategy） */
export interface ChampionStat {
  /** 该位置内排名 */
  rank: number;
  heroId: number;
  /** 强度等级 T0~T4 */
  tier: string;
  lane: Lane;
  /** 胜率 % */
  winRate: number;
  /** 登场率 % */
  pickRate: number;
  /** 禁用率 % */
  banRate: number;
  /** 克制它的英雄 id 列表（counter_champions） */
  counters: number[];
  /** 排名变化（负数为上升） */
  rankChange: number;
}

/** 对位克制（lol_101strategy_confront） */
export interface ConfrontStats {
  /** 克制该英雄的（对面选它时，我们应该选这些） */
  high: { heroId: number; winRate: number }[];
  /** 被该英雄克制的 */
  low: { heroId: number; winRate: number }[];
}

/** pick 推荐结果 */
export interface PickRecommendation {
  heroId: number;
  title: string;
  winRate: number;
  tier: string;
  lane: Lane;
  /** 它能克制的对面英雄（中文名） */
  counters: string[];
  /** 克制了几个对面英雄 */
  counterCount: number;
  /** 综合分（克制数 * 权重 + 胜率） */
  score: number;
}

/** ban 推荐结果 */
export interface BanRecommendation {
  heroId: number;
  title: string;
  winRate: number;
  pickRate: number;
  banRate: number;
  tier: string;
  /** 它克制了我方几个英雄 */
  threatensCount: number;
  /** 被它克制的我方英雄 */
  threatens: string[];
  /** 综合分 */
  score: number;
}

// ---------- 海克斯大乱斗 / 大乱斗 ----------

/** 海克斯牌信息（kiwi_augments.json） */
export interface AugmentInfo {
  augmentID: number;
  name_cn: string;
  name_en: string;
  /** kSilver / kGold / kPrismatic */
  level: string;
  tooltip: string;
  small_Icon: string;
  large_Icon: string;
}

/** 海克斯大乱斗英雄榜（fuwen_aram_hero_rank_v2） */
export interface HextechHeroStat {
  heroId: number;
  rank: number;
  rankChangeDesc: string;
  /** 胜率 0.5773 = 57.73% */
  winRate: number;
  /** 登场率 0.1305 = 13.05% */
  pickRate: number;
  /** 最佳搭档英雄（英雄id/搭档登场率/搭档胜率/排名） */
  bestPartners: { heroId: number; pickRate: number; winRate: number; rank: number }[];
  avgDeathTime: number;
  avgParticipationRate: number;
  avgDamageRatio: number;
  avgTankRatio: number;
  /** 推荐海克斯牌 id（lowest_rank_runes） */
  bestAugments: number[];
}

/** 海克斯牌榜（fuwen_aram_rune_rank_v2） */
export interface HextechRuneStat {
  augmentId: number;
  /** 出场率（被选择比例） */
  pickRate: number;
  pickRank: number;
  pickRankChange: number;
  /** 持有胜率 */
  winRate: number;
  winRank: number;
  winRankChange: number;
  /** 最适合的英雄 id */
  bestHeroes: number[];
}

/** 对局模式 */
export type GameMode = 'ranked_solo' | 'ranked_flex' | 'aram' | 'hextech_aram' | 'normal' | 'other';
