// Web UI 服务器：零依赖（node:http + 原生前端），复用现有 services
import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChampionRankings, getHeroList, getVersions, resolveHeroes, getConfront, type TierId } from '../api/cn101.js';
import { recommendPick, inferLane } from '../services/pick.js';
import { recommendBan } from '../services/ban.js';
import { analyzeChampSelect } from '../services/champselect.js';
import { recommendAugments, recommendHextechHeroes } from '../services/hextech.js';
import { findLcuConnectionCached, getGameflowPhase, getGameflowSession, getRankedStats, getCurrentSummoner, lcuGet, queueToMode, getPlayerRecentStats, getSummoner, summonerDisplayName, type PlayerRecentStats } from '../api/lcu.js';
import { heroDisplayName } from '../models.js';
import { evaluateRecentStats, evaluateTeam } from '../services/player.js';

/** 近期战绩缓存：房间 3s 轮询防抖（60s TTL） */
const recentStatsCache = new Map<number, { data: PlayerRecentStats | null; ts: number }>();
const RECENT_TTL_MS = 60_000;
async function getCachedRecentStats(summonerId: number): Promise<PlayerRecentStats | null> {
  const hit = recentStatsCache.get(summonerId);
  if (hit && Date.now() - hit.ts < RECENT_TTL_MS) return hit.data;
  const data = await getPlayerRecentStats(summonerId);
  recentStatsCache.set(summonerId, { data, ts: Date.now() });
  return data;
}

/** 召唤师信息缓存（国服 lobby members 无昵称字段，需补查；60s TTL） */
const summonerCache = new Map<number, { name: string; icon: number | null; level: number | null; ts: number }>();
async function getCachedSummonerInfo(summonerId: number): Promise<{ name: string; icon: number | null; level: number | null }> {
  const hit = summonerCache.get(summonerId);
  if (hit && Date.now() - hit.ts < RECENT_TTL_MS) return hit;
  const fallback = { name: `召唤师${summonerId}`, icon: null, level: null };
  const s = await getSummoner(summonerId).catch(() => null);
  const info = s ? { name: summonerDisplayName(s) || fallback.name, icon: s.profileIconId ?? null, level: s.summonerLevel ?? null } : fallback;
  summonerCache.set(summonerId, { ...info, ts: Date.now() });
  return info;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 每次请求读取 HTML：前端文件改动后刷新浏览器即生效，无需重启服务 */
function getHtml(): string {
  return readFileSync(join(__dirname, 'index.html'), 'utf-8');
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function ok(res: ServerResponse, data: unknown) {
  json(res, 200, { ok: true, data });
}
function fail(res: ServerResponse, error: string) {
  json(res, 200, { ok: false, error });
}

/** 附加英雄 alias（前端拼头像 URL） */
async function withAlias<T extends { heroId: number }>(items: T[]): Promise<(T & { alias: string })[]> {
  const heroes = await getHeroList();
  return items.map((it) => ({ ...it, alias: heroes.get(it.heroId)?.alias ?? '' }));
}

async function handleApi(route: string, params: URLSearchParams, res: ServerResponse) {
  const p = (k: string) => params.get(k) ?? undefined;
  const tier = (): TierId => {
    const n = Number(p('tier') ?? 255);
    return (Number.isInteger(n) && n >= 1 && n <= 255 ? n : 255) as TierId;
  };
  const lane = (d = 'ALL'): import('../models.js').Lane => (p('lane') ?? d).toUpperCase() as import('../models.js').Lane;

  switch (route) {
    case 'versions': {
      ok(res, await getVersions());
      return;
    }
    case 'rank': {
      const [rankings, heroes] = await Promise.all([
        getChampionRankings({ tier: tier(), lane: lane() }),
        getHeroList(),
      ]);
      const top = Number(p('top') ?? 50);
      ok(res, rankings.slice(0, top).map((r) => ({
        ...r,
        title: heroDisplayName(heroes.get(r.heroId), r.heroId),
        alias: heroes.get(r.heroId)?.alias ?? '',
      })));
      return;
    }
    case 'pick': {
      const enemy = p('enemy') ?? '';
      if (!enemy.trim()) { fail(res, '请输入对面英雄'); return; }
      const recs = await recommendPick({
        enemyHeroes: enemy.split(/[,，]/),
        myLane: lane('ALL'),
        exclude: p('exclude')?.split(/[,，]/),
        topN: Number(p('top') ?? 12),
        opts: { tier: tier() },
      });
      ok(res, await withAlias(recs));
      return;
    }
    case 'ban': {
      const my = p('my');
      const recs = await recommendBan({
        myHeroes: my ? my.split(/[,，]/) : [],
        topN: Number(p('top') ?? 12),
        opts: { tier: tier() },
      });
      ok(res, await withAlias(recs));
      return;
    }
    case 'hero': {
      const name = p('name') ?? '';
      if (!name) { fail(res, '请输入英雄名'); return; }
      const [{ heroId }, heroes, rankings] = await Promise.all([
        (await resolveHeroes([name]))[0],
        getHeroList(),
        getChampionRankings({ tier: tier(), lane: 'ALL' }),
      ]);
      // 对位数据必须指定具体位置：ALL 时按榜单登场率推断主位置
      const reqLane = lane();
      const finalLane = reqLane === 'ALL' ? inferLane(rankings, heroId) : reqLane;
      const stats = await getConfront(heroId, { tier: tier(), lane: finalLane });
      ok(res, {
        heroId,
        title: heroDisplayName(heroes.get(heroId), heroId),
        alias: heroes.get(heroId)?.alias ?? '',
        high: await withAlias(stats.high),
        low: await withAlias(stats.low),
      });
      return;
    }
    case 'lobby': {
      // 队伍聊天房间：接受对局后展示队友 + 每人近期战绩状态（lol-lobby/v2/lobby + match-history 只读）
      try {
        const lobby = await lcuGet<{
          localMember?: { summonerId: number; gameName?: string; displayName?: string; summonerLevel?: number; profileIconId?: number };
          members?: { summonerId: number; gameName?: string; displayName?: string; summonerLevel?: number; profileIconId?: number; summonerIconId?: number }[];
          gameConfig?: { queueId?: number };
        }>('/lol-lobby/v2/lobby');
        const queueId = lobby.gameConfig?.queueId;
        const members = (lobby.members ?? []).map((m) => ({
          summonerId: m.summonerId,
          name: m.displayName || m.gameName || '',
          level: m.summonerLevel,
          icon: m.profileIconId ?? m.summonerIconId,
          isMe: m.summonerId === lobby.localMember?.summonerId,
        }));
        // 国服 lobby 无昵称字段：缺名成员补查召唤师信息（缓存 60s）
        const missing = members.filter((m) => !m.name);
        const infos = await Promise.all(missing.map((m) => getCachedSummonerInfo(m.summonerId)));
        const nameMap = new Map(missing.map((m, i) => [m.summonerId, infos[i]]));
        const members2 = members.map((m) => {
          const info = nameMap.get(m.summonerId);
          return {
            ...m,
            name: m.name || info?.name || `召唤师${m.summonerId}`,
            level: m.level ?? info?.level,
            icon: m.icon ?? info?.icon,
          };
        });
        // 近期战绩（60s 缓存：房间 3s 轮询，不能每轮都打 match-history）
        const [stats, heroes] = await Promise.all([
          Promise.all(members2.map((m) => getCachedRecentStats(m.summonerId))),
          getHeroList(),
        ]);
        const enriched = members2.map((m, i) => {
          const s = stats[i];
          return {
            ...m,
            stats: s ? evaluateRecentStats(s, queueId) : null,
            // 逐场明细：英雄名/模式/时间/时长（前端直接展示）
            recent: s?.recent.map((r) => ({
              ...r,
              title: heroDisplayName(heroes.get(r.championId), r.championId),
              alias: heroes.get(r.championId)?.alias ?? '',
              modeLabel: queueToMode(r.queueId).label,
            })) ?? [],
          };
        });
        const team = evaluateTeam(enriched.map((m) => ({ name: m.name, isMe: m.isMe, stats: stats[enriched.indexOf(m)] })), queueId);
        ok(res, { queueId, mode: queueToMode(queueId).mode, modeLabel: queueToMode(queueId).label, localSummonerId: lobby.localMember?.summonerId, members: enriched, team });
      } catch (e) {
        fail(res, (e as Error).message);
      }
      return;
    }
    case 'lcu/status': {
      const conn = findLcuConnectionCached();
      if (!conn) { ok(res, { connected: false }); return; }
      try {
        const [phase, summoner] = await Promise.all([
          getGameflowPhase(),
          getCurrentSummoner().catch(() => null),
        ]);
        ok(res, { connected: true, port: conn.port, phase, summoner: summoner?.displayName || summoner?.gameName || null, level: summoner?.summonerLevel });
      } catch (e) {
        ok(res, { connected: false, error: (e as Error).message });
      }
      return;
    }
    case 'champselect': {
      try {
        const analysis = await analyzeChampSelect();
        const heroes = await getHeroList();
        // JSON 无法序列化函数：把 heroName/heroAlias 换成 id -> 名字/别名映射（前端 chip 头像用 alias）
        const ids = new Set([...analysis.myPicks, ...analysis.enemyPicks, ...analysis.myBans, ...analysis.enemyBans]);
        const heroNames: Record<number, string> = {};
        const heroAliases: Record<number, string> = {};
        for (const id of ids) {
          const h = heroes.get(id);
          heroNames[id] = h ? heroDisplayName(h, id) : String(id);
          heroAliases[id] = h?.alias ?? '';
        }
        ok(res, {
          ...analysis,
          picks: await withAlias(analysis.picks),
          bans: await withAlias(analysis.bans),
          heroNames,
          heroAliases,
        });
      } catch (e) {
        const msg = (e as Error).message;
        fail(res, msg.includes('不存在') ? 'NOT_IN_CHAMPSELECT' : msg);
      }
      return;
    }
    case 'loading': {
      try {
        const session = await getGameflowSession();
        const heroes = await getHeroList();
        const players = session.gameData.players;
        const ranked = new Map<number, string>();
        const results = await Promise.allSettled(players.filter((pl) => !pl.isBot).map((pl) => getRankedStats(pl.summonerId)));
        players.filter((pl) => !pl.isBot).forEach((pl, i) => {
          const r = results[i];
          if (r.status === 'fulfilled' && r.value && r.value.length) {
            const solo = r.value.find((q) => q.queue.includes('RANKED_SOLO')) ?? r.value[0];
            ranked.set(pl.summonerId, `${solo.tier} ${solo.division} ${solo.lp}LP`);
          }
        });
        ok(res, {
          gameMode: session.gameData.gameMode,
          players: players.map((pl) => ({
            ...pl,
            title: pl.isBot ? '人机' : heroDisplayName(heroes.get(pl.championId), pl.championId),
            alias: pl.isBot ? '' : heroes.get(pl.championId)?.alias ?? '',
            rank: ranked.get(pl.summonerId) ?? '',
          })),
        });
      } catch (e) {
        const msg = (e as Error).message;
        fail(res, msg.includes('不存在') ? 'NOT_IN_GAME' : msg);
      }
      return;
    }
    case 'hex/heroes': {
      ok(res, await recommendHextechHeroes(Number(p('top') ?? 20)));
      return;
    }
    case 'hex/augments': {
      ok(res, await recommendAugments(Number(p('top') ?? 20)));
      return;
    }
    case 'friends': {
      // 在线好友：近期战绩 + 组队建议（lol-chat 只读；战绩走 match-history + 60s 缓存）
      try {
        const friends = await lcuGet<{
          pid?: string | number; name?: string; gameName?: string; availability?: string;
          lol?: { level?: number; rankedLeagueTier?: string; rankedLeagueDivision?: string };
        }[]>('/lol-chat/v1/friends');
        const me = await getCurrentSummoner().catch(() => null);
        const online = (friends ?? []).filter(
          (f) => f.availability && f.availability !== 'offline' && String(f.pid) !== String(me?.summonerId ?? -1),
        );
        const results = await Promise.allSettled(online.map(async (f) => {
          const summonerId = Number(f.pid);
          if (!Number.isInteger(summonerId) || summonerId <= 0) return null;
          const stats = await getCachedRecentStats(summonerId);
          const v = stats ? evaluateRecentStats(stats) : null;
          return {
            summonerId,
            name: f.gameName || f.name || `好友${summonerId}`,
            status: f.availability ?? 'unknown',
            level: f.lol?.level ?? null,
            tier: f.lol?.rankedLeagueTier ? `${f.lol.rankedLeagueTier} ${f.lol.rankedLeagueDivision ?? ''}`.trim() : '',
            icon: stats?.icon ?? null,
            stats: v,
          };
        }));
        const list = results
          .filter((r): r is PromiseFulfilledResult<{
            summonerId: number; name: string; status: string; level: number | null;
            tier: string; icon: number | null; stats: ReturnType<typeof evaluateRecentStats> | null;
          } | null> => r.status === 'fulfilled')
          .map((r) => r.value)
          .filter((x): x is NonNullable<typeof x> => x !== null)
          .sort((a, b) => (b.stats?.score ?? -1) - (a.stats?.score ?? -1));
        ok(res, { count: list.length, friends: list });
      } catch (e) {
        fail(res, (e as Error).message);
      }
      return;
    }
    case 'augment/search': {
      const { searchAugments } = await import('../services/augments.js');
      ok(res, await searchAugments(p('q') ?? ''));
      return;
    }
    case 'augment/reco': {
      // 可选牌 id（逗号分隔）+ 自动读游戏内我方阵容；无 ids 时返回当前游戏信息
      const { recommendAugmentChoices } = await import('../services/augments.js');
      const ids = (p('ids') ?? '').split(',').map(Number).filter((n) => n > 0);
      // 我方英雄：游戏内自动读（InProgress/GameStart），否则空
      let myHeroIds: number[] = [];
      let phase = 'unknown';
      let mode = '未知';
      try {
        phase = await getGameflowPhase();
        if (phase === 'InProgress' || phase === 'GameStart') {
          const g = await getGameflowSession();
          const gm = g?.gameData?.gameMode ?? '';
          mode = ({ ARAM: '海克斯大乱斗', ARAM_GAME: '海克斯大乱斗', CLASSIC: '峡谷', DEFAULT: '峡谷' })[gm] ?? (gm || '未知');
          myHeroIds = [...new Set((g?.gameData?.players ?? []).filter((pl) => pl.teamId === 100 && pl.championId > 0).map((pl) => pl.championId))];
        }
      } catch { /* 客户端不可用 */ }
      ok(res, {
        phase,
        mode,
        myHeroIds,
        heroNames: (await (async () => {
          try {
            const heroes = await getHeroList();
            return Object.fromEntries(myHeroIds.map((id) => [id, heroes.get(id)?.title ?? `#${id}`]));
          } catch { return {}; }
        })()),
        choices: ids.length ? await recommendAugmentChoices(ids, myHeroIds) : [],
      });
      return;
    }
    default:
      fail(res, `未知接口: ${route}`);
  }
}

export function startWebServer(port: number, onListening?: (url: string) => void): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getHtml());
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        await handleApi(url.pathname.slice(5), url.searchParams, res);
        return;
      }
      json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      fail(res, (e as Error).message);
    }
  });
  // 仅本机可访问：LCU 代理工具读取的是本机游戏数据，不应暴露到局域网
  server.listen(port, '127.0.0.1', () => onListening?.(`http://127.0.0.1:${port}`));
  return server;
}
