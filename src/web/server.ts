// Web UI 服务器：零依赖（node:http + 原生前端），复用现有 services
import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChampionRankings, getHeroList, getVersions, resolveHeroes, getConfront, type TierId } from '../api/cn101.js';
import { recommendPick } from '../services/pick.js';
import { recommendBan } from '../services/ban.js';
import { analyzeChampSelect } from '../services/champselect.js';
import { recommendAugments, recommendHextechHeroes } from '../services/hextech.js';
import { findLcuConnectionCached, getGameflowPhase, getGameflowSession, getRankedStats, getCurrentSummoner } from '../api/lcu.js';
import { heroDisplayName } from '../models.js';

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
      const [{ heroId }, heroes, confront] = await Promise.all([
        (await resolveHeroes([name]))[0],
        getHeroList(),
        import('../api/cn101.js').then((m) => m.getConfront),
      ]);
      const stats = await confront(heroId, { tier: tier(), lane: lane() });
      ok(res, {
        heroId,
        title: heroDisplayName(heroes.get(heroId), heroId),
        alias: heroes.get(heroId)?.alias ?? '',
        high: await withAlias(stats.high),
        low: await withAlias(stats.low),
      });
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
