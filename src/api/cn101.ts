// 101.qq.com 官方数据接口客户端（国服）
// 已实测验证：https://mlol.qt.qq.com 免 Key 免鉴权
import { cacheGet, cacheSet } from '../utils/cache.js';
import type { AugmentInfo, ChampionBase, ChampionStat, ConfrontStats, HextechHeroStat, HextechRuneStat, Lane, PartnerInfo, SegmentStat, TierId } from '../models.js';

export type { TierId } from '../models.js';

const BASE = 'https://mlol.qt.qq.com';
const HERO_LIST_URL = 'https://game.gtimg.cn/images/lol/act/img/js/heroList/hero_list.js';
const HEADERS = {
  'Referer': 'https://101.qq.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
};

/** 段位 id：255 全段位 / 10 王者 / 9 宗师 / 8 大师 / 7 钻石 / 6 翡翠 / 5 铂金 / 4 黄金 / 3 白银 / 2 青铜 / 1 黑铁 */

export interface VersionInfo {
  id: string;
  name: string; // 如 "16.16"
  title: string;
  public_date: string;
}

async function get<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const res = await fetch(`${BASE}${path}?${qs}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${path}`);
  const body = (await res.json()) as { code: number; msg?: string; data?: { result?: string | null; _fieldValues?: Record<string, string> } };
  if (body.code !== 0) throw new Error(`接口错误 ${path}: ${body.msg ?? body.code}`);
  const raw = body.data?.result || Object.values(body.data?._fieldValues ?? {})[0] || '';
  return raw as T;
}

// ---------- 版本 ----------

export async function getVersions(force = false): Promise<VersionInfo[]> {
  const key = 'versions';
  if (!force) {
    const hit = cacheGet<VersionInfo[]>(key, 24);
    if (hit) return hit;
  }
  const res = await fetch(`${BASE}/go/database/versionlist?zone=lol&from=h5`, { headers: HEADERS });
  const body = (await res.json()) as { code: number; data: VersionInfo[] };
  if (body.code !== 0) throw new Error(`versionlist 失败: code=${body.code}`);
  cacheSet(key, body.data);
  return body.data;
}

export async function getLatestVersion(force = false): Promise<VersionInfo> {
  const versions = await getVersions(force);
  return versions[0];
}

// ---------- 英雄榜单 ----------

/** 解析 strategy 接口的管道分隔字符串 */
function parseDatadetails(raw: string): ChampionStat[] {
  return raw.split('#').filter(Boolean).map((line) => {
    const [rank, heroId, tier, lane, winRate, pickRate, banRate, countersRaw, rankChange] = line.split('_');
    return {
      rank: parseInt(rank, 10),
      heroId: parseInt(heroId, 10),
      tier,
      lane: lane as Lane,
      winRate: parseFloat(winRate),
      pickRate: parseFloat(pickRate),
      banRate: parseFloat(banRate),
      counters: countersRaw.split(',').filter((s) => s && s !== 'NC').map((s) => parseInt(s, 10)),
      rankChange: rankChange === 'NC' ? 0 : parseInt(rankChange, 10),
    };
  });
}

export interface RankOptions {
  tier?: TierId;
  lane?: Lane;
  version?: string; // 版本名，如 "16.16"；缺省用最新
}

/** 全英雄榜单：胜率/登场率/禁用率/T级/克制列表 */
export async function getChampionRankings(opts: RankOptions = {}, force = false): Promise<ChampionStat[]> {
  const version = opts.version ?? (await getLatestVersion()).name;
  const tier = opts.tier ?? 255;
  const lane = opts.lane ?? 'ALL';
  const key = `rankings:${tier}:${lane}:${version}`;
  if (!force) {
    const hit = cacheGet<ChampionStat[]>(key, 6);
    if (hit) return hit;
  }
  const raw = await get<string>('/go/battle_info/odp_proxy/lol_101strategy', {
    itier: tier, version_id: version, lane, sort_metric: 1, sort_order: 2, zone: 'lol', from: 'h5',
  });
  if (!raw) throw new Error('榜单数据为空（接口可能需要重试）');
  let parsed: ChampionStat[] = [];
  try {
    const obj = JSON.parse(raw);
    parsed = parseDatadetails(obj.datadetails ?? '');
  } catch {
    parsed = parseDatadetails(raw);
  }
  if (parsed.length === 0) throw new Error('榜单数据解析失败');
  cacheSet(key, parsed);
  return parsed;
}

// ---------- 对位克制 ----------

const CONFRONT_LANES: Lane[] = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'SUPPORT'];

/** 单英雄对位克制：high=克制它的（劣势对线），low=被它克制的（优势对线）
 * 注意：lane 必须为具体位置（实测 lane=ALL 返回空） */
export async function getConfront(heroId: number, opts: RankOptions = {}, force = false): Promise<ConfrontStats> {
  const version = opts.version ?? (await getLatestVersion()).name;
  const tier = opts.tier ?? 255;
  const lane = opts.lane ?? 'MIDDLE';
  if (lane === 'ALL') throw new Error('对位数据必须指定具体位置（TOP/JUNGLE/MIDDLE/BOTTOM/SUPPORT）');
  const key = `confront:${heroId}:${tier}:${lane}:${version}`;
  if (!force) {
    const hit = cacheGet<ConfrontStats>(key, 24);
    if (hit) return hit;
  }
  const raw = await get<string>('/go/battle_info/odp_proxy/lol_101strategy_confront', {
    itier: tier, championid: heroId, lane, version_id: version, zone: 'lol', from: 'h5',
  });
  let high: ConfrontStats['high'] = [];
  let low: ConfrontStats['low'] = [];
  if (raw) {
    const obj = JSON.parse(raw) as { high_op_details?: string; low_op_details?: string };
    const parse = (s: string) => s.split('#').filter(Boolean).map((line) => {
      const [rank, heroId2, winRate] = line.split('_');
      return { heroId: parseInt(heroId2, 10), winRate: parseFloat(winRate), rank: parseInt(rank, 10) };
    });
    high = parse(obj.high_op_details ?? '');
    low = parse(obj.low_op_details ?? '');
  }
  const result = { high, low };
  cacheSet(key, result);
  return result;
}

/** 最佳拍档（lol_101strategy_partner）：与该英雄同队时的组合胜率；lane 必须为具体位置 */
export async function getPartner(heroId: number, opts: RankOptions = {}, force = false): Promise<PartnerInfo[]> {
  const version = opts.version ?? (await getLatestVersion()).name;
  const tier = opts.tier ?? 255;
  const lane = opts.lane ?? 'MIDDLE';
  if (lane === 'ALL') throw new Error('拍档数据必须指定具体位置（TOP/JUNGLE/MIDDLE/BOTTOM/SUPPORT）');
  const key = `partner:${heroId}:${tier}:${lane}:${version}`;
  if (!force) {
    const hit = cacheGet<PartnerInfo[]>(key, 24);
    if (hit) return hit;
  }
  const raw = await get<string>('/go/battle_info/odp_proxy/lol_101strategy_partner', {
    itier: tier, championid: heroId, lane, version_id: version, zone: 'lol', from: 'h5',
  });
  // data_details 格式：rank_heroId_组合胜率_出场数_胜场数#...
  const obj = raw ? (JSON.parse(raw) as { data_details?: string }) : null;
  const result = (obj?.data_details ?? '').split('#').filter(Boolean).map((line) => {
    const [rank, heroId2, winRate, games, wins] = line.split('_');
    return {
      heroId: parseInt(heroId2, 10),
      winRate: parseFloat(winRate),
      games: parseInt(games ?? '0', 10),
      wins: parseInt(wins ?? '0', 10),
    };
  });
  cacheSet(key, result);
  return result;
}

/** 单英雄分段强度（lol_101strategy_segment）：各段位胜率/登场率/禁用率；lane 必须为具体位置 */
export async function getSegment(heroId: number, opts: RankOptions = {}, force = false): Promise<SegmentStat[]> {
  const version = opts.version ?? (await getLatestVersion()).name;
  const lane = opts.lane ?? 'MIDDLE';
  if (lane === 'ALL') throw new Error('分段数据必须指定具体位置（TOP/JUNGLE/MIDDLE/BOTTOM/SUPPORT）');
  const key = `segment:${heroId}:${lane}:${version}`;
  if (!force) {
    const hit = cacheGet<SegmentStat[]>(key, 24);
    if (hit) return hit;
  }
  const raw = await get<string>('/go/battle_info/odp_proxy/lol_101strategy_segment', {
    itier: 255, championid: heroId, lane, version_id: version, zone: 'lol', from: 'h5',
  });
  // datadetails 格式：itier_胜率_登场率_禁用率#...
  const obj = raw ? (JSON.parse(raw) as { datadetails?: string }) : null;
  const result = (obj?.datadetails ?? '').split('#').filter(Boolean).map((line) => {
    const [tier, winRate, pickRate, banRate] = line.split('_');
    return {
      tier: parseInt(tier, 10) as TierId,
      winRate: parseFloat(winRate),
      pickRate: parseFloat(pickRate),
      banRate: parseFloat(banRate),
    };
  });
  cacheSet(key, result);
  return result;
}

// ---------- 大乱斗 / 海克斯大乱斗 ----------

/** 当天日期 YYYYMMDD（接口的 dtstatdate 参数） */
export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 往前推 n 天的日期 */
export function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86400_000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 海克斯/大乱斗数据当天可能未生成（延迟一天），自动回退到最近有数据的日期 */
async function resolveDate(fetchFn: (date: string) => Promise<boolean>): Promise<string> {
  for (let i = 0; i < 4; i++) {
    const date = daysAgo(i);
    try {
      if (await fetchFn(date)) return date;
    } catch { /* 继续回退 */ }
  }
  throw new Error('数据源暂时不可用（近 4 天无数据）');
}

function parseAramHeroList(raw: string): HextechHeroStat[] {
  return raw.split('#').filter(Boolean).map((line) => {
    const s = line.split('_');
    // 官方字段顺序：heroId, rank, rank_change_desc, win_rate, pick_rate,
    //   best_partner(用&分隔，每组 partner, 逗号分隔), avg_death_time, avg_participation,
    //   avg_damage, avg_tank, lowest_rank_runes(逗号分隔)
    return {
      heroId: Number(s[0]),
      rank: Number(s[1]),
      rankChangeDesc: s[2] ?? '',
      winRate: Number(s[3]),
      pickRate: Number(s[4]),
      bestPartners: (s[5] ?? '').split('&').filter(Boolean).map((c) => {
        const f = c.split(',');
        return { heroId: Number(f[0]), pickRate: Number(f[1]), winRate: Number(f[2]), rank: Number(f[3]) };
      }),
      avgDeathTime: Number(s[6]),
      avgParticipationRate: Number(s[7]),
      avgDamageRatio: Number(s[8]),
      avgTankRatio: Number(s[9]),
      bestAugments: (s[10] ?? '').split(',').map(Number).filter((n) => n > 0),
    };
  });
}

/** 海克斯大乱斗英雄榜 */
export async function getHextechHeroRank(dtstatdate?: string, force = false): Promise<HextechHeroStat[]> {
  const fetchRaw = async (date: string) => {
    const key = `hex_hero:${date}`;
    if (!force) {
      const hit = cacheGet<HextechHeroStat[]>(key, 12);
      if (hit) return hit;
    }
    const raw = await get<string>('/go/battle_info/odp_proxy/fuwen_aram_hero_rank_v2', { dtstatdate: date });
    if (!raw) return null;
    const obj = JSON.parse(raw) as { listcollect?: string };
    const parsed = parseAramHeroList(obj.listcollect ?? '');
    if (parsed.length === 0) return null;
    cacheSet(key, parsed);
    return parsed;
  };
  const date = dtstatdate ?? await resolveDate(async (d) => !!(await fetchRaw(d)));
  const hit = await fetchRaw(date);
  if (!hit) throw new Error('海克斯大乱斗英雄数据为空');
  return hit;
}

/** 海克斯牌榜：按胜率排序（选牌推荐） */
export async function getHextechRuneRank(dtstatdate?: string, force = false): Promise<HextechRuneStat[]> {
  const fetchRaw = async (date: string) => {
    const key = `hex_rune:${date}`;
    if (!force) {
      const hit = cacheGet<HextechRuneStat[]>(key, 12);
      if (hit) return hit;
    }
    const raw = await get<string>('/go/battle_info/odp_proxy/fuwen_aram_rune_rank_v2', { dtstatdate: date, augmentid_level: 255 });
    if (!raw) return null;
    const obj = JSON.parse(raw) as { augmentlist?: string };
    const parsed = (obj.augmentlist ?? '').split('#').filter(Boolean).map((line) => {
      const s = line.split('_');
      return {
        augmentId: Number(s[0]),
        pickRate: Number(s[2]),
        pickRank: Number(s[3]),
        pickRankChange: Number(s[4]),
        winRate: Number(s[5]),
        winRank: Number(s[6]),
        winRankChange: Number(s[7]),
        bestHeroes: (s[8] || '').split(',').map(Number).filter((n) => n > 0),
      };
    });
    if (parsed.length === 0) return null;
    cacheSet(key, parsed);
    return parsed;
  };
  const date = dtstatdate ?? await resolveDate(async (d) => !!(await fetchRaw(d)));
  const hit = await fetchRaw(date);
  if (!hit) throw new Error('海克斯牌数据为空');
  return hit;
}

/** 普通大乱斗英雄榜 */
export async function getAramHeroRank(dtstatdate?: string, force = false): Promise<HextechHeroStat[]> {
  const fetchRaw = async (date: string) => {
    const key = `aram_hero:${date}`;
    if (!force) {
      const hit = cacheGet<HextechHeroStat[]>(key, 12);
      if (hit) return hit;
    }
    const raw = await get<string>('/go/battle_info/odp_proxy/aram_hero_overview', { dtstatdate: date });
    if (!raw) return null;
    const obj = JSON.parse(raw) as { listcollect?: string };
    const parsed = parseAramHeroList(obj.listcollect ?? '');
    if (parsed.length === 0) return null;
    cacheSet(key, parsed);
    return parsed;
  };
  const date = dtstatdate ?? await resolveDate(async (d) => !!(await fetchRaw(d)));
  const hit = await fetchRaw(date);
  if (!hit) throw new Error('大乱斗英雄数据为空');
  return hit;
}

let augmentCache: Map<number, AugmentInfo> | null = null;

/** 海克斯牌静态映射（kiwi_augments.json，含中文名/品质/图标） */
export async function getAugmentList(force = false): Promise<Map<number, AugmentInfo>> {
  if (augmentCache && !force) return augmentCache;
  const key = 'augment_list';
  if (!force) {
    const hit = cacheGet<AugmentInfo[]>(key, 720);
    if (hit) {
      augmentCache = new Map(hit.map((a) => [a.augmentID, a]));
      return augmentCache;
    }
  }
  const res = await fetch('https://game.gtimg.cn/images/lol/act/img/js/kiwi/kiwi_augments.json', { headers: HEADERS });
  if (!res.ok) throw new Error(`kiwi_augments HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, AugmentInfo>;
  const list = Object.values(body);
  cacheSet(key, list);
  augmentCache = new Map(list.map((a) => [a.augmentID, a]));
  return augmentCache;
}

// ---------- 英雄静态映射 ----------

let heroListCache: Map<number, ChampionBase> | null = null;

export async function getHeroList(force = false): Promise<Map<number, ChampionBase>> {
  if (heroListCache && !force) return heroListCache;
  const key = 'hero_list';
  if (!force) {
    const hit = cacheGet<ChampionBase[]>(key, 720);
    if (hit) {
      heroListCache = new Map(hit.map((h) => [h.heroId, h]));
      return heroListCache;
    }
  }
  const res = await fetch(HERO_LIST_URL, { headers: HEADERS });
  if (!res.ok) throw new Error(`hero_list HTTP ${res.status}`);
  const text = await res.text();
  const body = JSON.parse(text) as { hero: ChampionBase[] };
  const list = body.hero.map((h) => ({ ...h, heroId: Number(h.heroId) }));
  cacheSet(key, list);
  heroListCache = new Map(list.map((h) => [h.heroId, h]));
  return heroListCache;
}

/** 英雄名 -> id：支持中文常用名（安妮）、称号（黑暗之女）、英文（Annie）、数字 id */
export async function resolveHeroes(names: string[]): Promise<{ heroId: number; input: string }[]> {
  const heroes = await getHeroList();
  const result: { heroId: number; input: string }[] = [];
  const errors: string[] = [];
  for (const raw of names) {
    const input = raw.trim();
    if (!input) continue;
    const num = Number(input);
    const hit = heroes.get(num) // id
      ?? [...heroes.values()].find((h) =>
          h.title === input || h.name === input || h.alias.toLowerCase() === input.toLowerCase());
    if (hit) result.push({ heroId: hit.heroId, input });
    else errors.push(input);
  }
  if (errors.length > 0) throw new Error(`无法识别的英雄: ${errors.join(', ')}（支持中文名/称号/英文名/ID）`);
  return result;
}
