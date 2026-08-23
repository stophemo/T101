// LCU (League Client Update) API 客户端 — 只读使用
// 原理：英雄联盟客户端启动后在 127.0.0.1 开放 HTTPS 端口，凭据在 lockfile 或进程命令行中
// 合规：仅 GET 只读查询（与 Porofessor/Blitz/U.GG 等主流工具一致），不做任何自动操作
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import https from 'node:https';
import { tierNameToId } from '../models.js';

interface LcuConnection {
  port: number;
  password: string; // remoting auth token
  protocol: string;
}

// ---------- 连接探测 ----------

/** 常见 lockfile 路径（Riot 版 + 腾讯国服版） */
function candidateLockfiles(): string[] {
  const drives = ['C:', 'D:', 'E:', 'F:'];
  const paths: string[] = [];
  for (const d of drives) {
    paths.push(
      join(`${d}\\`, 'Riot Games', 'League of Legends', 'lockfile'),
      join(`${d}\\`, 'Riot Games', 'LeagueClient', 'lockfile'),
      join(`${d}\\`, '腾讯游戏', '英雄联盟', 'lockfile'),
      join(`${d}\\`, '英雄联盟', 'lockfile'),
    );
  }
  return paths;
}

/** 通过进程命令行拿 --app-port 和 --remoting-auth-token（比 lockfile 更稳，国服适用） */
function probeProcessCommandLine(): LcuConnection | null {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='LeagueClientUx.exe'\\" -ErrorAction SilentlyContinue).CommandLine"`,
      { encoding: 'utf8', windowsHide: true, timeout: 8000 },
    );
    const m = out.match(/--app-port=(\d+)/);
    const t = out.match(/--remoting-auth-token=([^\s"]+)/);
    if (m && t) return { port: Number(m[1]), password: t[1], protocol: 'https' };
  } catch { /* ignore */ }
  return null;
}

function parseLockfile(content: string): LcuConnection {
  // 格式: name:pid:port:password:protocol
  const parts = content.trim().split(':');
  if (parts.length < 5) throw new Error('lockfile 格式异常');
  return { port: Number(parts[2]), password: parts[3], protocol: parts[4] };
}

/** 查找 LCU 连接信息；客户端未运行返回 null */
export function findLcuConnection(): LcuConnection | null {
  const env = process.env.T101_LOCKFILE;
  if (env && existsSync(env)) {
    try { return parseLockfile(readFileSync(env, 'utf-8')); } catch { /* fallthrough */ }
  }
  for (const lf of candidateLockfiles()) {
    if (existsSync(lf)) {
      try { return parseLockfile(readFileSync(lf, 'utf-8')); } catch { /* fallthrough */ }
    }
  }
  // 进程命令行（LeagueClientUx.exe 一定存在，且每次启动都会更新 token）
  const viaProcess = probeProcessCommandLine();
  if (viaProcess) return viaProcess;
  // 兜底：常见安装目录下的 lockfile（进程探测可能因权限失败）
  for (const lf of candidateLockfiles()) {
    const dir = dirname(lf);
    if (existsSync(join(dir, 'LeagueClientUx.exe'))) {
      try { return parseLockfile(readFileSync(lf, 'utf-8')); } catch { /* ignore */ }
    }
  }
  return null;
}

// 探测结果短缓存：Web 端每 3 秒轮询 lcu/status，避免每次都 spawn PowerShell 进程
// token 在客户端启动时固定、重开客户端才变 → 30s 缓存足够；连接失败时立即失效缓存快速重探测
let connCache: { conn: LcuConnection | null; ts: number } | null = null;
const CONN_CACHE_TTL_MS = 30000;

/** 带缓存的连接探测（客户端退出/重开后最多 5 秒内重新探测到新 token） */
export function findLcuConnectionCached(): LcuConnection | null {
  if (connCache && Date.now() - connCache.ts < CONN_CACHE_TTL_MS) return connCache.conn;
  const conn = findLcuConnection();
  connCache = { conn, ts: Date.now() };
  return conn;
}

// ---------- 请求 ----------

/** LCU GET 请求（自签证书，仅对本机端口生效） */
export function lcuGet<T = unknown>(path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const conn = findLcuConnectionCached();
    if (!conn) {
      reject(new Error('未检测到英雄联盟客户端（需要先启动游戏客户端）'));
      return;
    }
    const req = https.get(
      {
        host: '127.0.0.1',
        port: conn.port,
        path,
        auth: `riot:${conn.password}`,
        rejectUnauthorized: false,
        headers: { Accept: 'application/json' },
        timeout: 3000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode === 404) {
            // 404 可能是「接口不存在」，也可能是 RPC 业务错误（如 ready-check 不在队列中）——带上响应体便于区分
            reject(new Error(`LCU 接口不存在: ${path}${data.trim() ? ` — ${data.trim().slice(0, 150)}` : ''}`));
            return;
          }
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`LCU HTTP ${res.statusCode}: ${path} ${data.slice(0, 200)}`));
            return;
          }
          if (!data.trim()) { resolve(undefined as T); return; }
          try { resolve(JSON.parse(data) as T); } catch { resolve(data as T); }
        });
      },
    );
    req.on('error', (e) => {
      // 连接被拒/中断：客户端可能已重启（token 变化）→ 立即使缓存失效，下次重新探测
      connCache = null;
      reject(new Error(`LCU 连接失败: ${e.message}`));
    });
    req.on('timeout', () => { req.destroy(new Error('LCU 请求超时')); });
  });
}

// ---------- 常用接口 ----------

/** 当前阶段：None / Lobby / ChampSelect / GameStart / InProgress / ... */
export async function getGameflowPhase(): Promise<string> {
  return (await lcuGet<string>('/lol-gameflow/v1/gameflow-phase')).replace(/"/g, '');
}

/** 当前登录的召唤师 */
/** 召唤师信息（国服 displayName 为空，昵称在 gameName） */
export interface SummonerInfo {
  displayName: string;
  gameName?: string;
  summonerId: number;
  puuid: string;
  summonerLevel: number;
  profileIconId: number;
}

/** 展示名：displayName 优先，国服退回 gameName */
export const summonerDisplayName = (s: Pick<SummonerInfo, 'displayName' | 'gameName'> | null | undefined): string =>
  s?.displayName || s?.gameName || '';

export async function getCurrentSummoner(): Promise<SummonerInfo> {
  return lcuGet<SummonerInfo>(
    '/lol-summoner/v1/current-summoner',
  );
}

/** 按 summonerId 查召唤师信息 */
export async function getSummoner(summonerId: number): Promise<SummonerInfo> {
  return lcuGet<SummonerInfo>(
    `/lol-summoner/v1/summoners/${summonerId}`,
  );
}

// ---------- 选人阶段 ----------

/** 当前登录召唤师的段位 -> itier（无排位/查询失败返回 null）；用于 BP 按分段推荐 */
export async function getMyTierId(): Promise<number | null> {
  try {
    const me = await getCurrentSummoner();
    const stats = await getRankedStats(me.summonerId);
    if (!stats) return null;
    const solo = stats.find((q) => q.queue.includes('RANKED_SOLO')) ?? stats[0];
    return tierNameToId(solo.tier);
  } catch {
    return null;
  }
}

export interface ChampSelectPlayer {
  summonerId: number;
  /** 当前玩家选定/锁定的英雄；不代表共享英雄池 */
  championId: number;
  assignedPosition: string;
  cellId: number;
  isBot?: boolean;
  /** 可能缺失，缺失时需另行查 summoner */
  summonerName?: string;
}

export interface ChampSelectBenchChampion {
  /** 海克斯大乱斗共享英雄池中的英雄 */
  championId: number;
  /** 客户端标记的优先候选 */
  isPriority?: boolean;
}

export interface ChampSelectSession {
  queueId?: number;
  /** LCU session 的共享候选池；team championId 仅表示玩家当前选择 */
  benchChampions?: ChampSelectBenchChampion[];
  actions: { actorCellId: number; championId: number; completed: boolean; type: string; isAllyAction: boolean }[][];
  bans: { myTeamBans: number[]; theirTeamBans: number[]; numBans: number };
  myTeam: ChampSelectPlayer[];
  theirTeam: ChampSelectPlayer[];
  localPlayerCellId: number;
  timer: { phase: string; adjustedTimeLeftInPhase: number; totalTimePhaseInSec: number };
  /** 仅测试模式存在 */
  localPlayerTeam?: string;
}

/** 队列 id -> 模式（queueId 常见值：420 单双排 / 440 灵活排位 / 430 匹配 / 400 盲选 / 450 普通大乱斗） */
export const KNOWN_QUEUE_IDS = new Set([420, 440, 450, 430, 400, 490, 2400]);

/** 队列模式族：同族合并统计/过滤（420+440 排位、2400+2410 海克斯等） */
export function queueFamily(queueId: number | undefined): string {
  switch (queueId) {
    case 420: case 440: return 'ranked';
    case 2400: case 2410: return 'hextech_aram';
    case 450: return 'aram';
    case 430: case 400: case 490: return 'normal';
    default: return String(queueId ?? '');
  }
}

/** 队列 id → 模式（2400 = 海克斯大乱斗，实战确认 gameMode=KIWI） */
/** 未知 queueId：视为海克斯大乱斗（海克斯大乱斗无 ban 阶段、独立 queue；待实战确认具体 id） */
/** 误判风险：若普通大乱斗/新模式改用了新 id 会被当成海克斯。CLI/Web 会显示 queueId 便于反馈 */

/** 队列 id -> 模式（queueId 常见值：420 单双排 / 440 灵活排位 / 430 匹配 / 400 盲选 / 450 普通大乱斗） */
/** 单场对局中的一名玩家（完整 10 人对局详情用） */
export interface MatchPlayer {
  /** 100=我方 200=对方 */
  teamId: number;
  championId: number;
  summonerName: string;
  kills: number;
  deaths: number;
  assists: number;
  dmg: number;
  items: number[];
  /** 海克斯牌 id 列表（海斗 KIWI 对局 3-4 个；其他模式为空） */
  augments: number[];
  win: boolean;
  /** 是否是当前召唤师本人（前端高亮） */
  isSelf?: boolean;
}

/** 单场对局简况（从 match-history 解析） */
export interface MatchStat {
  gameId: number;
  championId: number;
  win: boolean;
  gameCreation: number;
  queueId: number;
  kills: number;
  deaths: number;
  assists: number;
  /** 对局时长（秒） */
  duration: number;
  /** 补刀数（小兵+野怪） */
  cs: number;
  /** 获得金币 */
  gold: number;
  /** 视野分 */
  vision: number;
  /** 对局结束时英雄等级 */
  level: number;
  /** 对英雄总伤害 */
  dmg: number;
  /** 承受总伤害 */
  taken: number;
  /** 出装（item id，0 表示空槽已过滤） */
  items: number[];
  /** 海克斯牌 id 列表（海斗 KIWI 对局 3-4 个；其他模式为空） */
  augments: number[];
  /** 完整 10 人对局详情（仅当前召唤师参与过的对局可查；好友场次为 null/缺省） */
  players?: MatchPlayer[] | null;
}

/** 召唤师近期战绩（LCU match-history 只读；好友数据受客户端可见范围限制） */
export interface PlayerRecentStats {
  summonerId: number;
  name: string;
  icon: number | null;
  totalGames: number;
  wins: number;
  kda: { kills: number; deaths: number; assists: number };
  recent: MatchStat[];
}

/**
 * 查询召唤师近期战绩：房间/好友通用，统一按类型取样。
 * 限制：仅返回最近 maxDays（默认 15）天内、排位（420/440）与海克斯大乱斗（2400/2410）各最多 limit（默认 20）场。
 * 支持 summonerId（自动补名字/头像）。fullGame=false 时跳过完整 10 人对局详情补拉（加载画面 10 人批量查询用，省请求）。
 * 不可用时返回 null。
 */
export async function getPlayerRecentStats(summonerId: number, opts: { queueId?: number; nameHint?: string; limit?: number; maxDays?: number; mode?: string; fullGame?: boolean } = {}): Promise<PlayerRecentStats | null> {
  try {
    const s = await getSummoner(summonerId);
    return fetchMatchHistory(s.puuid, summonerId, opts.nameHint ?? summonerDisplayName(s), s.profileIconId ?? null, opts.queueId, opts.limit ?? 20, opts.maxDays ?? 15, 100, opts.mode, opts.fullGame ?? true);
  } catch {
    return null;
  }
}

/** 好友场景：pid（UUID@pvp.net）去后缀即 puuid，直接查客户端可见战绩（只拉最近 rawLimit 条原始对局，默认 50；15 天内排位/海斗各最多 20 场） */
export async function getPlayerRecentStatsByPuuid(puuid: string, opts: { queueId?: number; nameHint?: string; limit?: number; maxDays?: number; rawLimit?: number; mode?: string } = {}): Promise<PlayerRecentStats | null> {
  return fetchMatchHistory(puuid.replace(/@pvp\.net$/, ''), 0, opts.nameHint ?? '', null, opts.queueId, opts.limit ?? 20, opts.maxDays ?? 15, opts.rawLimit ?? 50, opts.mode);
}

/**
 * 完整对局详情（10 人）：/lol-match-history/v1/games/{gameId}
 * LCU 仅本地存储当前召唤师参与过的对局；好友场次返回 errorCode（HTTP 200），此函数返回 null
 */
async function fetchFullGame(gameId: number, selfPuuid?: string | null): Promise<MatchPlayer[] | null> {
  const g = await lcuGet<{
    errorCode?: string;
    participants?: {
      participantId?: number; championId?: number; teamId?: number;
      stats?: { win?: boolean; kills?: number; deaths?: number; assists?: number;
        totalDamageDealtToChampions?: number;
        item0?: number; item1?: number; item2?: number; item3?: number;
        item4?: number; item5?: number; item6?: number;
        playerAugment1?: number; playerAugment2?: number; playerAugment3?: number;
        playerAugment4?: number; playerAugment5?: number; playerAugment6?: number };
    }[];
    participantIdentities?: { participantId?: number; player?: { summonerName?: string; gameName?: string; puuid?: string } }[];
  }>(`/lol-match-history/v1/games/${gameId}`);
  const ps = g?.participants ?? [];
  if (!ps.length || g.errorCode) return null;
  const ids = g?.participantIdentities ?? [];
  return ps.map((p) => {
    const st = p.stats ?? {};
    const pl = ids.find((i) => i.participantId === p.participantId)?.player;
    return {
      teamId: p.teamId ?? 100,
      championId: p.championId ?? 0,
      summonerName: pl?.gameName || pl?.summonerName || '未知',
      kills: st.kills ?? 0,
      deaths: st.deaths ?? 0,
      assists: st.assists ?? 0,
      dmg: st.totalDamageDealtToChampions ?? 0,
      items: [st.item0, st.item1, st.item2, st.item3, st.item4, st.item5, st.item6]
        .filter((x): x is number => typeof x === 'number' && x > 0),
      augments: [st.playerAugment1, st.playerAugment2, st.playerAugment3, st.playerAugment4, st.playerAugment5, st.playerAugment6]
        .filter((x): x is number => typeof x === 'number' && x > 0),
      win: !!st.win,
      isSelf: !!selfPuuid && pl?.puuid === selfPuuid,
    };
  });
}

async function fetchMatchHistory(puuid: string, summonerId: number, name: string, icon: number | null, _queueId?: number, limit = 20, maxDays = 15, rawLimit = 100, mode?: string, fetchFull = true): Promise<PlayerRecentStats | null> {
  try {
    // 是否查询当前召唤师自己：自己的对局才能通过 v1/games/{gameId} 拿到完整 10 人详情
    let isSelf = false;
    try {
      const me = await lcuGet<{ puuid?: string }>('/lol-summoner/v1/current-summoner').catch(() => null);
      isSelf = !!me?.puuid && me.puuid === puuid;
    } catch { /* 客户端不可用 */ }
    const raw = await lcuGet<{
      games?: { games?: {
        gameId?: number; gameCreation?: number; queueId?: number; gameDuration?: number;
        participants?: { championId?: number; stats?: {
          win?: boolean; kills?: number; deaths?: number; assists?: number;
          minionsKilled?: number; neutralMinionsKilled?: number; goldEarned?: number;
          visionScore?: number; champLevel?: number; totalDamageDealtToChampions?: number;
          totalDamageTaken?: number;
          item0?: number; item1?: number; item2?: number; item3?: number;
          item4?: number; item5?: number; item6?: number;
          playerAugment1?: number; playerAugment2?: number; playerAugment3?: number;
          playerAugment4?: number; playerAugment5?: number; playerAugment6?: number;
        } }[];
        participantIdentities?: { player?: { summonerId?: number; puuid?: string; profileIcon?: number } }[];
      }[] };
    // LCU match-history：不支持 queue 参数（400）；endIndex 为拉取上限（好友只查最近 50 条，房间保留 100 以保证排位/海斗各 20 场）
    }>(`/lol-match-history/v1/products/lol/${puuid}/matches?begIndex=0&endIndex=${rawLimit}`);
    // 时间窗口：默认 15 天内
    const cutoff = Date.now() - maxDays * 86400_000;
    const games = (raw?.games?.games ?? []).filter((g) => (g.gameCreation ?? 0) >= cutoff);
    const recent: MatchStat[] = [];
    let iconFromGames: number | null = icon;
    for (const g of games) {
      const idx = (g.participantIdentities ?? []).findIndex((p) => p.player?.summonerId === summonerId || (!summonerId && p.player?.puuid === puuid));
      const pi = g.participantIdentities?.[idx];
      if (iconFromGames === null && pi?.player?.profileIcon) iconFromGames = pi.player.profileIcon;
      const p = idx >= 0 ? g.participants?.[idx] : undefined;
      const st = p?.stats;
      if (!g.queueId || !st) continue;
      recent.push({
        gameId: g.gameId ?? 0,
        championId: p.championId ?? 0,
        win: !!st.win,
        gameCreation: g.gameCreation ?? 0,
        queueId: g.queueId,
        kills: st.kills ?? 0,
        deaths: st.deaths ?? 0,
        assists: st.assists ?? 0,
        duration: g.gameDuration ?? 0,
        cs: (st.minionsKilled ?? 0) + (st.neutralMinionsKilled ?? 0),
        gold: st.goldEarned ?? 0,
        vision: st.visionScore ?? 0,
        level: st.champLevel ?? 0,
        dmg: st.totalDamageDealtToChampions ?? 0,
        taken: st.totalDamageTaken ?? 0,
        items: [st.item0, st.item1, st.item2, st.item3, st.item4, st.item5, st.item6]
          .filter((x): x is number => typeof x === 'number' && x > 0),
        augments: [st.playerAugment1, st.playerAugment2, st.playerAugment3, st.playerAugment4, st.playerAugment5, st.playerAugment6]
          .filter((x): x is number => typeof x === 'number' && x > 0),
      });
    }
    if (!recent.length) return null;
    // 统一口径：排位（420/440）与海克斯大乱斗（2400/2410）各取最近 limit（默认 20）场，合并后按时间倒序；
    // mode 指定时（好友按页签只查单模式）：仅保留该模式族的最近 limit 场
    const ranked = recent.filter((r) => queueFamily(r.queueId) === 'ranked');
    const hextech = recent.filter((r) => queueFamily(r.queueId) === 'hextech_aram');
    const kept = (mode === 'ranked' ? ranked.slice(0, limit)
      : mode === 'hextech' ? hextech.slice(0, limit)
      : [...ranked.slice(0, limit), ...hextech.slice(0, limit)])
      .sort((a, b) => b.gameCreation - a.gameCreation);
    if (!kept.length) return null;
    // 自己的对局：并发补拉完整 10 人详情（LCU 仅本地存储自己参与过的对局；好友场次 v1/games 返回错误，保持 null）
    // fetchFull=false（加载画面批量查询）跳过：只评估战绩不需要逐场 10 人详情
    if (isSelf && fetchFull) {
      const withPlayers = await Promise.all(kept.map(async (g) => {
        const players = await fetchFullGame(g.gameId, puuid).catch(() => null);
        return players ? { ...g, players } : g;
      }));
      kept.splice(0, kept.length, ...withPlayers);
    }
    return {
      summonerId,
      name: name || `召唤师${summonerId || puuid.slice(0, 6)}`,
      icon: iconFromGames,
      totalGames: kept.length,
      wins: kept.filter((r) => r.win).length,
      kda: kept.reduce(
        (acc, r) => ({ kills: acc.kills + r.kills, deaths: acc.deaths + r.deaths, assists: acc.assists + r.assists }),
        { kills: 0, deaths: 0, assists: 0 },
      ),
      recent: kept,
    };
  } catch {
    return null;
  }
}

/** 队列 id → 模式/中文名（未知 id 视为海克斯大乱斗，CLI/Web 展示 queueId 便于反馈） */
export function queueToMode(queueId: number | undefined): {
  mode: import('../models.js').GameMode;
  label: string;
} {
  switch (queueId) {
    case 420: return { mode: 'ranked_solo', label: '单双排' };
    case 440: return { mode: 'ranked_flex', label: '灵活排位' };
    case 450: return { mode: 'aram', label: '普通大乱斗' };
    case 430: case 400: case 490: return { mode: 'normal', label: '匹配' };
    case 2400: return { mode: 'hextech_aram', label: '海克斯大乱斗' };
    // 未知 queueId：视为海克斯大乱斗（海克斯大乱斗无 ban 阶段、独立 queue；待实战确认具体 id）
    // 误判风险：若普通大乱斗/新模式改用了新 id 会被当成海克斯。CLI/Web 会显示 queueId 便于反馈
    default: return { mode: 'hextech_aram', label: '海克斯大乱斗' };
  }
}

/** 是否峡谷排位（BP 推荐支持的模式之一） */
export function isRankedMode(mode: string): boolean {
  return mode === 'ranked_solo' || mode === 'ranked_flex';
}

/** 是否海克斯大乱斗 */
export function isHextechMode(mode: string): boolean {
  return mode === 'hextech_aram';
}

export async function getChampSelectSession(): Promise<ChampSelectSession> {
  return lcuGet<ChampSelectSession>('/lol-champ-select/v1/session');
}

// ---------- 加载画面（游戏开始） ----------

export interface GamePlayer {
  summonerId: number;
  summonerName: string;
  puuid: string;
  championId: number;
  teamId: number;
  position: string;
  isBot: boolean;
  profileIconId: number;
  summonerLevel: number;
}

export interface GameflowSession {
  phase: string;
  gameData: {
    gameId: number;
    gameMode: string;
    gameType: string;
    mapId: number;
    /** 对局开始时间戳（毫秒）；LCU 返回 gameStartTime，客户端版本较旧时可能缺失 */
    gameStartTime?: number;
    /** 普通模式：10 人玩家列表 */
    players: GamePlayer[];
    /** KIWI（海克斯大乱斗）：无 players 字段，10 人分在 teamOne/teamTwo（各 5 人） */
    teamOne?: KiwiTeamPlayer[];
    teamTwo?: KiwiTeamPlayer[];
    /** KIWI：10 人英雄选择（按 puuid 对应） */
    playerChampionSelections?: { championId: number; puuid: string; selectedSkinIndex?: number; spell1Id?: number; spell2Id?: number }[];
    queue?: { id?: number; gameMode?: string; name?: string };
  };
  gameClient: { running: boolean; visible: boolean };
}

/** KIWI（海克斯大乱斗）teamOne/teamTwo 中的玩家 */
export interface KiwiTeamPlayer {
  championId: number;
  profileIconId: number;
  puuid: string;
  summonerId: number;
  /** 国服为空，需补查 */
  summonerName: string;
  selectedPosition: string;
  teamParticipantId: number;
}

export async function getGameflowSession(): Promise<GameflowSession> {
  return lcuGet<GameflowSession>('/lol-gameflow/v1/session');
}

/** 段位查询（接口存在性依客户端版本而定；失败返回 null）
 * 实测国服结构：{ highestRankedEntrySR: {tier, division, queueType, leaguePoints, wins, losses} } */
export async function getRankedStats(summonerId: number): Promise<{ queue: string; tier: string; division: string; lp: number; wins: number; losses: number }[] | null> {
  try {
    const data = await lcuGet<Record<string, unknown>>(`/lol-ranked/v1/ranked-stats/${summonerId}`);
    if (!data) return null;
    const pick = (e: unknown): { queue: string; tier: string; division: string; lp: number; wins: number; losses: number } | null => {
      const x = e as { tier?: string; division?: string; queueType?: string; leaguePoints?: number; wins?: number; losses?: number } | undefined;
      if (!x || !x.tier || x.tier === 'NONE' || !x.division || x.division === 'NA') return null;
      return {
        queue: x.queueType ?? '',
        tier: x.tier,
        division: x.division,
        lp: x.leaguePoints ?? 0,
        wins: x.wins ?? 0,
        losses: x.losses ?? 0,
      };
    };
    const result = [
      pick(data.highestRankedEntrySR),
      pick(data.highestRankedEntry),
    ].filter((x): x is NonNullable<typeof x> => !!x);
    return result.length ? result : null;
  } catch {
    return null;
  }
}
