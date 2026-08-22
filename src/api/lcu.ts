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
let connCache: { conn: LcuConnection | null; ts: number } | null = null;
const CONN_CACHE_TTL_MS = 5000;

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
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode === 404) {
            reject(new Error(`LCU 接口不存在: ${path}`));
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
    req.on('error', (e) => reject(new Error(`LCU 连接失败: ${e.message}`)));
    req.on('timeout', () => { req.destroy(new Error('LCU 请求超时')); });
  });
}

// ---------- 常用接口 ----------

/** 当前阶段：None / Lobby / ChampSelect / GameStart / InProgress / ... */
export async function getGameflowPhase(): Promise<string> {
  return (await lcuGet<string>('/lol-gameflow/v1/gameflow-phase')).replace(/"/g, '');
}

/** 当前登录的召唤师 */
export async function getCurrentSummoner() {
  return lcuGet<{ displayName: string; gameName?: string; summonerId: number; puuid: string; summonerLevel: number; profileIconId: number }>(
    '/lol-summoner/v1/current-summoner',
  );
}

/** 按 summonerId 查召唤师信息 */
export async function getSummoner(summonerId: number) {
  return lcuGet<{ displayName: string; summonerId: number; puuid: string; summonerLevel: number; profileIconId: number }>(
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
  championId: number;
  assignedPosition: string;
  cellId: number;
  isBot?: boolean;
  /** 可能缺失，缺失时需另行查 summoner */
  summonerName?: string;
}

export interface ChampSelectSession {
  queueId?: number;
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
export const KNOWN_QUEUE_IDS = new Set([420, 440, 450, 430, 400, 490]);

/** 队列 id -> 模式（queueId 常见值：420 单双排 / 440 灵活排位 / 430 匹配 / 400 盲选 / 450 普通大乱斗） */
/** 单场对局简况（从 match-history 解析） */
export interface MatchStat {
  championId: number;
  win: boolean;
  gameCreation: number;
  queueId: number;
  kills: number;
  deaths: number;
  assists: number;
}

/** 召唤师近期战绩（最近最多 10 场，LCU match-history 只读） */
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
 * 查询召唤师近期战绩（最近 10 场）：用于队伍房间队友状态评估。
 * match-history 端点不可用（腾讯阉割/权限）时返回 null。
 */
export async function getPlayerRecentStats(summonerId: number): Promise<PlayerRecentStats | null> {
  try {
    const s = await getSummoner(summonerId);
    const raw = await lcuGet<{
      games?: { games?: {
        gameId?: number; gameCreation?: number; queueId?: number;
        participants?: { championId?: number; stats?: { win?: boolean; kills?: number; deaths?: number; assists?: number } }[];
        participantIdentities?: { player?: { summonerId?: number } }[];
      }[] };
    }>(`/lol-match-history/v1/products/lol/${s.puuid}/matches?begIndex=0&endIndex=10`);
    const games = raw?.games?.games ?? [];
    const recent: MatchStat[] = [];
    for (const g of games) {
      const idx = (g.participantIdentities ?? []).findIndex((p) => p.player?.summonerId === summonerId);
      const p = idx >= 0 ? g.participants?.[idx] : undefined;
      const st = p?.stats;
      if (!g.queueId || !st) continue;
      recent.push({
        championId: p.championId ?? 0,
        win: !!st.win,
        gameCreation: g.gameCreation ?? 0,
        queueId: g.queueId,
        kills: st.kills ?? 0,
        deaths: st.deaths ?? 0,
        assists: st.assists ?? 0,
      });
    }
    if (!recent.length) return null;
    return {
      summonerId,
      name: s.displayName,
      icon: s.profileIconId ?? null,
      totalGames: recent.length,
      wins: recent.filter((r) => r.win).length,
      kda: recent.reduce(
        (acc, r) => ({ kills: acc.kills + r.kills, deaths: acc.deaths + r.deaths, assists: acc.assists + r.assists }),
        { kills: 0, deaths: 0, assists: 0 },
      ),
      recent,
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
    players: GamePlayer[];
  };
  gameClient: { running: boolean; visible: boolean };
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
