// 数据模型：所有 API 数据源统一返回这里的类型

/** 段位 id：255 全段位 / 10 王者 / 9 宗师 / 8 大师 / 7 钻石 / 6 翡翠 / 5 铂金 / 4 黄金 / 3 白银 / 2 青铜 / 1 黑铁 */
export type TierId = 255 | 10 | 9 | 8 | 7 | 6 | 5 | 4 | 3 | 2 | 1;

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

/** 对位克制（lol_101strategy_confront）
 * high = 克制该英雄的（对面选它时，我们应该选这些）—— 该英雄的劣势对线
 * low  = 被该英雄克制的 —— 该英雄的优势对线
 * winRate 为对位胜率（%），如 58.91 */
export interface ConfrontStats {
  high: { heroId: number; winRate: number; rank: number }[];
  low: { heroId: number; winRate: number; rank: number }[];
}

/** 最佳拍档（lol_101strategy_partner）：与该英雄同队的组合胜率 */
export interface PartnerInfo {
  heroId: number;
  /** 组合胜率 % */
  winRate: number;
  /** 组合出场数 */
  games: number;
  /** 组合胜场数 */
  wins: number;
}

/** 单英雄分段强度（lol_101strategy_segment）：itier_胜率_登场率_禁用率 */
export interface SegmentStat {
  tier: TierId;
  winRate: number;
  pickRate: number;
  banRate: number;
}

/** 段位 id -> 名称 */
export const TIER_NAMES: Record<number, string> = {
  255: '全段位', 10: '王者', 9: '宗师', 8: '大师', 7: '钻石', 6: '翡翠',
  5: '铂金', 4: '黄金', 3: '白银', 2: '青铜', 1: '黑铁',
};

/** LCU 段位名 -> itier（CHALLENGER=王者 10 ... IRON=黑铁 1） */
export function tierNameToId(name: string): number | null {
  const map: Record<string, number> = {
    CHALLENGER: 10, GRANDMASTER: 9, MASTER: 8, DIAMOND: 7, EMERALD: 6,
    PLATINUM: 5, GOLD: 4, SILVER: 3, BRONZE: 2, IRON: 1,
  };
  return map[name.toUpperCase()] ?? null;
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
  /** 对位详情：它 vs 每个对面英雄的对位胜率（来自 confront high_op） */
  matchups: { enemyTitle: string; winRate: number }[];
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
  /** 主位置（场景 A 梯度榜按位置展示） */
  lane?: Lane;
  /** 它克制了我方几个英雄 */
  threatensCount: number;
  /** 被它克制的我方英雄 */
  threatens: string[];
  /** 威胁对位详情（场景 B）：它 vs 我方英雄的对位胜率 */
  matchups?: { myTitle: string; winRate: number }[];
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
