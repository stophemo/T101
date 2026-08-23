// 队伍房间：召唤师近期状态评估（胜率 + KDA + 对应模式表现，0-100 分 + 中文结论）
import type { PlayerRecentStats } from '../api/lcu.js';
import { queueFamily } from '../api/lcu.js';

export interface PlayerVerdict {
  /** 0-100 状态分 */
  score: number;
  /** 中文结论 */
  verdict: string;
  /** 统计场次 */
  totalGames: number;
  /** 统计胜率 % */
  winRate: number;
  /** 统计中当前模式的胜率 %（样本不足为 null） */
  modeWinRate: number | null;
  /** 统计 KDA */
  kda: number;
  /** 统计中当前模式场次 */
  modeGames: number;
}

/** 纯函数：按近期战绩评估状态 */
export function evaluateRecentStats(
  stats: Pick<PlayerRecentStats, 'totalGames' | 'wins' | 'kda' | 'recent'>,
  queueId?: number,
): PlayerVerdict {
  const total = Math.max(1, stats.totalGames);
  const winRate = (stats.wins / total) * 100;
  const kda = (stats.kda.kills + stats.kda.assists) / Math.max(1, stats.kda.deaths);
  // 对应模式族（recent 已按排位/海斗各最多 20 场取样；此处统计与当前 queueId 同族的场次，如 420/440 都算排位）
  let modeWinRate: number | null = null;
  let modeGames = 0;
  if (queueId) {
    const family = queueFamily(queueId);
    const ms = stats.recent.filter((r) => queueFamily(r.queueId) === family);
    modeGames = ms.length;
    if (ms.length >= 2) modeWinRate = (ms.filter((r) => r.win).length / ms.length) * 100;
  }
  // 状态分：胜率 70% + KDA 30%（KDA 封顶 8:1 记满分）
  const score = Math.round(winRate * 0.7 + Math.min(kda / 8, 1) * 100 * 0.3);
  let verdict: string;
  if (stats.totalGames < 3) verdict = '📊 样本不足';
  else if (score >= 65) verdict = '🔥 状态火热';
  else if (score >= 55) verdict = '👍 状态不错';
  else if (score >= 45) verdict = '😐 状态一般';
  else verdict = '📉 状态低迷';
  return { score, verdict, totalGames: stats.totalGames, winRate: +winRate.toFixed(1), modeWinRate: modeWinRate !== null ? +modeWinRate.toFixed(1) : null, kda: +kda.toFixed(2), modeGames };
}

export interface ByTypeVerdict {
  /** 近 15 天排位（420/440）评估；窗口内无场次为 null */
  ranked: PlayerVerdict | null;
  /** 近 15 天海克斯大乱斗（2400/2410）评估；窗口内无场次为 null */
  hextech: PlayerVerdict | null;
  /** 最近一场排位对局距今天数（查询窗口内无记录为 null） */
  rankedLastDays: number | null;
  /** 最近一场海斗对局距今天数（查询窗口内无记录为 null） */
  hextechLastDays: number | null;
  /** 最近一场任意对局距今天数 */
  overallLastDays: number | null;
}

/**
 * 按类型分别评估近期状态（房间/好友通用）：排位（420/440）与海克斯大乱斗（2400/2410）各出一份评估。
 * 评估统计近 days（默认 15）天窗口内的场次（查询层已各取最多 20 场）；某类型窗口内无场次时为 null。
 * 并给出该类型最近一次对局距今天数（供"上次对局 N 天前"展示）。
 */
export function evaluateByType(stats: Pick<PlayerRecentStats, 'recent'>, days = 15): ByTypeVerdict {
  const now = Date.now();
  const cutoff = now - days * 86400_000;
  const recent = stats.recent.filter((r) => r.gameCreation >= cutoff);
  const rankedAll = recent.filter((r) => queueFamily(r.queueId) === 'ranked');
  const hextechAll = recent.filter((r) => queueFamily(r.queueId) === 'hextech_aram');
  const evalSet = (games: PlayerRecentStats['recent']) => (games.length
    ? evaluateRecentStats({
      totalGames: games.length,
      wins: games.filter((g) => g.win).length,
      kda: games.reduce(
        (acc, g) => ({ kills: acc.kills + g.kills, deaths: acc.deaths + g.deaths, assists: acc.assists + g.assists }),
        { kills: 0, deaths: 0, assists: 0 },
      ),
      recent: games,
    })
    : null);
  const daysAgo = (games: PlayerRecentStats['recent']): number | null =>
    games.length ? Math.max(0, Math.floor((now - Math.max(...games.map((g) => g.gameCreation))) / 86400_000)) : null;
  return {
    ranked: evalSet(rankedAll),
    hextech: evalSet(hextechAll),
    rankedLastDays: daysAgo(rankedAll),
    hextechLastDays: daysAgo(hextechAll),
    overallLastDays: daysAgo(recent),
  };
}

/** 按当前队列选择对应类型的评估（房间视图用）：排位合并单双/灵活，海斗合并 2400/2410；其他模式回退到整体样本 */
export function evaluateModeStats(
  stats: Pick<PlayerRecentStats, 'totalGames' | 'wins' | 'kda' | 'recent'>,
  queueId?: number,
): PlayerVerdict | null {
  const family = queueFamily(queueId);
  if (family === 'ranked') return evaluateByType(stats).ranked;
  if (family === 'hextech_aram') return evaluateByType(stats).hextech;
  return evaluateRecentStats(stats, queueId);
}

/** 队伍整体评估（纯函数，供房间视图展示） */
export function evaluateTeam(
  members: { name: string; isMe: boolean; stats: Pick<PlayerRecentStats, 'totalGames' | 'wins' | 'kda' | 'recent'> | null }[],
  queueId?: number,
): { avgScore: number; verdict: string; best: string | null; worst: string | null; hasData: boolean } {
  const evals = members
    .map((m) => ({ name: m.name, isMe: m.isMe, v: m.stats ? evaluateModeStats(m.stats, queueId) : null }))
    .filter((m) => m.v !== null);
  if (!evals.length) return { avgScore: 0, verdict: '暂无近期战绩数据（客户端不可用或战绩接口受限）', best: null, worst: null, hasData: false };
  const avg = evals.reduce((a, m) => a + (m.v?.score ?? 0), 0) / evals.length;
  const best = evals.reduce((a, b) => ((a.v?.score ?? 0) >= (b.v?.score ?? 0) ? a : b));
  const worst = evals.reduce((a, b) => ((a.v?.score ?? 0) <= (b.v?.score ?? 0) ? a : b));
  let verdict: string;
  if (avg >= 60) verdict = '🟢 队伍整体状态不错，可放心开局';
  else if (avg >= 50) verdict = '🟡 队伍状态一般，稳扎稳打';
  else verdict = '🔴 队伍近期状态偏弱，谨慎运营';
  return { avgScore: Math.round(avg), verdict, best: best.name, worst: worst.name, hasData: true };
}
