// op.gg 数据源（参考：韩服/外服 meta）
// 实测：https://www.op.gg/champions?region=kr&tier=all&hl=en 页面 200、无反爬（无 Cloudflare 挑战），
// 榜单数据内联在 Next.js RSC flight payload（self.__next_f.push）中，解析含 positionWinRate 的段即可。
// 注意：op.gg 无国服数据，这里作为「外服参考」——国服/韩服版本数据一致（游戏数据相同），
// 但玩家行为（ban/pick/胜率）有差异，用于交叉验证和趋势参考。
import { snapshotGet, snapshotSet, snapshotList } from '../utils/snapshot.js';
import type { ChampionBase, Lane } from '../models.js';

/** op.gg key → 国服 hero_list alias 的例外映射（多数可直接按归一化匹配） */
const KEY_OVERRIDES: Record<string, string> = {
  wukong: 'MonkeyKing',
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** op.gg 英雄 key/英文名 → 国服英雄 id（匹配 hero_list alias，失败返回 null） */
export function matchOpggToHero(heroes: Map<number, ChampionBase>, opggKey: string): number | null {
  const target = norm(KEY_OVERRIDES[opggKey] ?? opggKey);
  for (const h of heroes.values()) {
    if (norm(h.alias) === target) return h.heroId;
  }
  return null;
}

/** op.gg 位置名 → 标准 Lane（ADC→BOTTOM、MID→MIDDLE） */
export function normalizeOpggPosition(p: string): Lane {
  const map: Record<string, Lane> = {
    TOP: 'TOP', JUNGLE: 'JUNGLE', MID: 'MIDDLE', MIDDLE: 'MIDDLE',
    ADC: 'BOTTOM', BOTTOM: 'BOTTOM', SUPPORT: 'SUPPORT', ALL: 'ALL',
  };
  return map[p] ?? 'ALL';
}

const PAGE = 'https://www.op.gg/champions?region={region}&tier={tier}&hl=en';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.op.gg/',
};

export type OpggRegion = string; // kr / na / euw / eune / oce / jp / ru / tr / br / las / lan / sg / ph / tw / th / vn
export type OpggTier = 'all' | 'challenger' | 'grandmaster' | 'master' | 'diamond' | 'emerald' | 'platinum' | 'gold' | 'silver' | 'bronze' | 'iron';

/** 单英雄单位置的韩服统计 */
export interface OpggChampionStat {
  /** 英文 key（小写，如 nasus） */
  key: string;
  /** 英文名（Nasus） */
  name: string;
  heroId?: number;
  positionName: string; // TOP/JUNGLE/MIDDLE/BOTTOM/SUPPORT/ALL
  /** 胜率 %（55.26 = 55.26%） */
  winRate: number;
  /** 登场率 % */
  pickRate: number;
  /** 禁用率 % */
  banRate: number;
  /** 该位置占比（0~1） */
  roleRate: number;
  /** T级（0=S 级最高，越大越弱） */
  tier: number;
  /** 该位置内排名 */
  rank: number;
  /** 克制它的英雄（英文名列表） */
  counters: string[];
  /** 版本号（从图片 URL 提取，如 16.16.1） */
  patch: string;
}

/** 反转 JS 字符串字面量转义（RSC payload 是 JS 字符串形式） */
export function unescapeJs(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|n|r|t|"|\\)/g, (_m, p: string) => {
    if (p.startsWith('u')) return String.fromCharCode(parseInt(p.slice(1), 16));
    if (p === 'n') return '\n';
    if (p === 'r') return '\r';
    if (p === 't') return '\t';
    if (p === '"') return '"';
    return '\\';
  });
}

export interface OpggRankOptions {
  region?: OpggRegion;
  tier?: OpggTier;
}

/** 拉取并解析 op.gg 榜单（页面 RSC payload），快照按 region:tier:patch 存储
 * 24h 内有快照则直接返回（参考数据源，无需高频刷新；sync --opgg 强制刷新） */
export async function getOpggChampionRankings(opts: OpggRankOptions = {}, force = false): Promise<OpggChampionStat[]> {
  const region = opts.region ?? 'kr';
  const tier = opts.tier ?? 'all';
  if (!force) {
    const cached = getOpggChampionRankingsCached(region, tier);
    if (cached && Date.now() - cached.fetchedAt < 24 * 3600_000) return cached.data;
  }
  const url = PAGE.replace('{region}', region).replace('{tier}', tier);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`op.gg HTTP ${res.status}: ${url}`);
  const html = await res.text();

  // 提取 RSC flight payload 段，反转转义
  const pushes = [...html.matchAll(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g)].map((m) => unescapeJs(m[1]));
  const flight = pushes.join('');

  // 找到含榜单数据的段（形如 32:["$","$L38",null,{"data":[{...,"positionWinRate":...}]}]）
  let data: unknown = null;
  for (const line of flight.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    let seg: unknown;
    try {
      seg = JSON.parse(line.slice(idx + 1));
    } catch {
      continue;
    }
    const arr = seg as unknown[];
    const props = arr?.[3] as { data?: unknown } | undefined;
    const d = props?.data;
    if (Array.isArray(d) && (d as Record<string, unknown>[]).some((x) => typeof (x as { positionWinRate?: unknown })?.positionWinRate === 'number')) {
      data = d;
      break;
    }
  }
  if (!Array.isArray(data)) throw new Error('op.gg 页面解析失败（RSC 结构可能已变化）');

  const patch = (html.match(/lol\/([\d.]+)\/champion\//)?.[1]) ?? 'unknown';
  const parsed = (data as Record<string, unknown>[]).map((x) => ({
    key: String(x.key),
    name: String(x.name),
    heroId: typeof x.id === 'number' ? x.id : undefined,
    positionName: String(x.positionName ?? 'ALL'),
    winRate: Number(x.positionWinRate),
    pickRate: Number(x.positionPickRate),
    banRate: Number(x.positionBanRate),
    roleRate: Number(x.positionRoleRate ?? 0),
    tier: Number((x.positionTierData as { tier?: number })?.tier ?? x.positionTier ?? 99),
    rank: Number(x.positionRank),
    counters: ((x.positionCounters as { name?: string }[] | undefined) ?? []).map((c) => c.name ?? ''),
    patch,
  }));

  const key = `opgg_ranked:${region}:${tier}:${patch}`;
  snapshotSet(key, parsed, { source: 'op.gg champions page (RSC)', version: patch, count: parsed.length });
  return parsed;
}

/** 从快照读 op.gg 数据（无网络）；返回该 region:tier 最新 patch 的数据 */
export function getOpggChampionRankingsCached(region = 'kr', tier = 'all'): { data: OpggChampionStat[]; fetchedAt: number; patch: string } | null {
  const prefix = `opgg_ranked:${region}:${tier}:`;
  const metas = snapshotList()
    .filter((m) => m.key.startsWith(prefix))
    .sort((a, b) => b.fetchedAt - a.fetchedAt);
  const latest = metas[0];
  if (!latest) return null;
  const hit = snapshotGet<OpggChampionStat[]>(latest.key);
  if (!hit) return null;
  return { data: hit.data, fetchedAt: latest.fetchedAt, patch: latest.version ?? '' };
}
