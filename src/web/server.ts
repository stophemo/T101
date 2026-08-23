// Web UI 服务器：零依赖（node:http + 原生前端），复用现有 services
import { createServer, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChampionRankings, getHeroList, getVersions, resolveHeroes, getConfront, getAugmentList, type TierId } from '../api/cn101.js';
import { recommendPick, inferLane } from '../services/pick.js';
import { recommendBan } from '../services/ban.js';
import { analyzeChampSelect } from '../services/champselect.js';
import { recommendAugments, recommendHextechHeroes } from '../services/hextech.js';
import { findLcuConnectionCached, getGameflowPhase, getGameflowSession, getRankedStats, getCurrentSummoner, lcuGet, queueToMode, getPlayerRecentStats, getPlayerRecentStatsByPuuid, getSummoner, summonerDisplayName, type PlayerRecentStats } from '../api/lcu.js';
import { heroDisplayName } from '../models.js';
import { evaluateTeam, evaluateByType, evaluateModeStats } from '../services/player.js';

/**
 * 战绩查询不做缓存：LCU match-history 对好友是"按需同步"，首次/数据未同步时可能只返回少量场次；
 * 每次实时直查才能拿到客户端当前的全部近期战绩（实测好友 51 场、自己 22 场）。
 */
/** 逐场明细 enrich：英雄名/别名/模式名（前端直接展示）+ 完整对局玩家的头像别名 + 海克斯牌名 */
async function enrichRecent(recent: PlayerRecentStats['recent']) {
  const [heroes, augments] = await Promise.all([getHeroList(), getAugmentList()]);
  const augName = (id: number) => augments.get(id)?.name_cn ?? `#${id}`;
  return recent.map((r) => ({
    ...r,
    title: heroDisplayName(heroes.get(r.championId), r.championId),
    alias: heroes.get(r.championId)?.alias ?? '',
    modeLabel: queueToMode(r.queueId).label,
    augNames: (r.augments ?? []).map(augName),
    players: r.players ? r.players.map((p) => ({ ...p, alias: heroes.get(p.championId)?.alias ?? '', augNames: (p.augments ?? []).map(augName) })) : r.players,
  }));
}

/** 召唤师信息缓存（国服 lobby members 无昵称字段，需补查；60s TTL） */
const summonerCache = new Map<number, { name: string; icon: number | null; level: number | null; ts: number }>();
const SUMMONER_TTL_MS = 60_000;
async function getCachedSummonerInfo(summonerId: number): Promise<{ name: string; icon: number | null; level: number | null }> {
  const hit = summonerCache.get(summonerId);
  if (hit && Date.now() - hit.ts < SUMMONER_TTL_MS) return hit;
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

/**
 * 好友状态：LCU 中好友游戏中 availability 自动为 dnd（勿扰），
 * 需以 lol.gameStatus 为准区分：inGame=游戏中、inQueue/inChampSelect/inLobby=排队/选人/房间
 */
function friendStatus(f: {
  availability?: string;
  lol?: { gameStatus?: string; gameMode?: string; gameQueueType?: string };
}): { status: string; gameLabel: string } {
  const gs = f.lol?.gameStatus;
  const gm = f.lol?.gameMode ?? '';
  const qt = f.lol?.gameQueueType ?? '';
  const modeLabel = (): string => {
    if (gm === 'KIWI') return '海克斯大乱斗';
    if (gm === 'ARAM' || gm === 'ARAM_GAME') return '大乱斗';
    if (qt === 'RANKED_SOLO_5x5') return '排位单双';
    if (qt === 'RANKED_FLEX_SR') return '排位灵活';
    if (qt === 'NORMAL') return '匹配';
    return gm || qt || '';
  };
  if (gs === 'inGame') return { status: 'in_game', gameLabel: modeLabel() };
  if (gs === 'inQueue') return { status: 'in_queue', gameLabel: modeLabel() };
  if (gs === 'inChampSelect') return { status: 'in_queue', gameLabel: '选人中' };
  if (gs === 'inLobby') return { status: 'in_queue', gameLabel: '房间中' };
  return { status: f.availability ?? 'unknown', gameLabel: '' };
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
        // 统一查询：近 15 天排位/海斗各最多 20 场，再按类型分别评估（查询阶段不按 queueId 过滤）
        const stats = await Promise.all(members2.map((m) => getPlayerRecentStats(m.summonerId, { limit: 20, maxDays: 15 })));
        const enriched = members2.map((m, i) => {
          const s = stats[i];
          return {
            ...m,
            stats: s ? evaluateModeStats(s, queueId) : null,
            byType: s ? evaluateByType(s) : null,
          };
        });
        const team = evaluateTeam(enriched.map((m, i) => ({ name: m.name, isMe: m.isMe, stats: stats[i] })), queueId);
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
    case 'readycheck': {
      // 接受确认：状态/倒计时（Matchmaking→ReadyCheck 阶段显示用）
      try {
        const rc = await lcuGet<{ state?: string; playerResponse?: string; timer?: number; dodWarning?: boolean }>('/lol-matchmaking/v1/ready-check');
        ok(res, rc ?? {});
      } catch (e) {
        const msg = (e as Error).message;
        // 不在匹配队列/无匹配搜索：视为无接受确认（前端显示兜底文案，不报错）
        if (/Not attached to a matchmaking queue|No matchmaking search/i.test(msg)) ok(res, { state: 'none' });
        else fail(res, msg);
      }
      return;
    }
    case 'champselect': {
      try {
        const analysis = await analyzeChampSelect();
        const heroes = await getHeroList();
        // 自己的英雄海斗榜推荐（pick 阶段顶部显眼展示）
        const myHeroStat = analysis.myHeroId > 0
          ? (await recommendHextechHeroes(300).catch(() => [])).find((h) => h.heroId === analysis.myHeroId) ?? null
          : null;
        // JSON 无法序列化函数：把 heroName/heroAlias 换成 id -> 名字/别名映射（前端 chip 头像用 alias）
        // 海斗：共享池（含对面翻开的卡）与翻牌区（championIds 数组）的英雄也要有别名
        const ids = new Set([
          ...analysis.myPicks, ...analysis.enemyPicks, ...analysis.myBans, ...analysis.enemyBans,
          ...(analysis.aramPool ?? []).map((h) => h.heroId),
          ...analysis.myTeamBoard.flatMap((p) => [p.championId, ...(p.championIds ?? [])]),
          ...analysis.enemyTeamBoard.flatMap((p) => [p.championId, ...(p.championIds ?? [])]),
        ]);
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
          myHeroStat: myHeroStat ? {
            title: myHeroStat.title,
            alias: myHeroStat.alias,
            winRate: myHeroStat.winRate,
            pickRate: myHeroStat.pickRate,
            rank: myHeroStat.rank,
            bestAugments: myHeroStat.bestAugments.slice(0, 5).map((a) => ({ name_cn: a.name_cn, winRate: a.winRate, pickRate: a.pickRate })),
            bestPartners: myHeroStat.bestPartners.slice(0, 3).map((p) => ({ title: p.title, winRate: p.winRate })),
          } : null,
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
        const gd = session.gameData ?? ({} as typeof session.gameData);
        // 普通模式：gameData.players；KIWI（海克斯大乱斗）：无 players，用 teamOne/teamTwo（各 5 人）
        const gm = gd.queue?.gameMode ?? gd.gameMode ?? '';
        const classic = (gd.players ?? []) as import('../api/lcu.js').GamePlayer[];
        let players: import('../api/lcu.js').GamePlayer[] = [];
        // 敌我归一化：用当前召唤师 puuid 定位自己所在队伍，自己队 → teamId 100（我方），对面 → 200
        const me = await getCurrentSummoner().catch(() => null);
        if (classic.length) {
          const myTid = classic.find((p) => p.puuid === me?.puuid)?.teamId ?? 100;
          players = classic.map((p) => ({ ...p, teamId: p.teamId === myTid ? 100 : 200 }));
        } else if (Array.isArray(gd.teamOne) && gd.teamOne.length) {
          // KIWI：teamOne/teamTwo 哪队是自己是随机的，先按 puuid 定位，再映射 100=我方 / 200=对面
          const inOne = (gd.teamOne ?? []).some((p) => p.puuid === me?.puuid);
          const mySide = inOne ? (gd.teamOne ?? []) : (gd.teamTwo ?? []);
          const theirSide = inOne ? (gd.teamTwo ?? []) : (gd.teamOne ?? []);
          // 两侧都补查召唤师信息（summonerName 国服为空，60s 缓存）
          const all = [...mySide.map((p) => ({ ...p, teamId: 100 as const })), ...theirSide.map((p) => ({ ...p, teamId: 200 as const }))];
          const infos = await Promise.all(all.map((p) => getCachedSummonerInfo(p.summonerId)));
          players = all.map((p, i) => ({
            summonerId: p.summonerId,
            summonerName: infos[i].name,
            puuid: p.puuid,
            championId: p.championId,
            teamId: p.teamId,
            position: p.selectedPosition ?? '',
            isBot: false,
            profileIconId: p.profileIconId,
            summonerLevel: infos[i].level ?? 0,
          }));
        }
        // 大乱斗系（海克斯大乱斗 KIWI / 普通大乱斗 ARAM）无排位段位：跳过 10 人段位查询（无意义且拖慢加载视图）
        const aramLike = gm === 'KIWI' || gm === 'ARAM' || gm === 'ARAM_GAME';
        const ranked = new Map<number, string>();
        if (!aramLike) {
          const results = await Promise.allSettled(players.filter((pl) => !pl.isBot).map((pl) => getRankedStats(pl.summonerId)));
          players.filter((pl) => !pl.isBot).forEach((pl, i) => {
            const r = results[i];
            if (r.status === 'fulfilled' && r.value && r.value.length) {
              const solo = r.value.find((q) => q.queue.includes('RANKED_SOLO')) ?? r.value[0];
              ranked.set(pl.summonerId, `${solo.tier} ${solo.division} ${solo.lp}LP`);
            }
          });
        }
        // 双方 10 人近期战绩评估（轻量模式：跳过完整对局详情补拉；失败不影响加载表）
        const recents = new Map<number, ReturnType<typeof evaluateByType> | null>();
        const recentResults = await Promise.allSettled(
          players.filter((pl) => !pl.isBot).map((pl) => getPlayerRecentStats(pl.summonerId, { limit: 20, maxDays: 15, fullGame: false })),
        );
        players.filter((pl) => !pl.isBot).forEach((pl, i) => {
          const r = recentResults[i];
          recents.set(pl.summonerId, r.status === 'fulfilled' && r.value ? evaluateByType(r.value) : null);
        });
        ok(res, {
          gameMode: gm || 'KIWI',
          phase: session.phase ?? '',
          aramLike,
          players: players.map((pl) => ({
            ...pl,
            title: pl.isBot ? '人机' : heroDisplayName(heroes.get(pl.championId), pl.championId),
            alias: pl.isBot ? '' : heroes.get(pl.championId)?.alias ?? '',
            rank: ranked.get(pl.summonerId) ?? '',
            recents: recents.get(pl.summonerId) ?? null,
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
    case 'hex/partners': {
      const { recommendHextechPartners } = await import('../services/hextech.js');
      ok(res, await recommendHextechPartners(Number(p('top') ?? 20)));
      return;
    }
    case 'player-recent': {
      // 统一查询：近 15 天排位/海斗各最多 20 场；queueId 仅决定房间详情的当前类型和展示顺序，不参与查询过滤；
      // mode（ranked/hextech）指定时只查该模式（好友页签），否则排位+海斗合并
      const summonerId = Number(p('summonerId'));
      const puuid = p('puuid') ?? '';
      const queueId = Number(p('queueId')) || undefined;
      const mode = p('mode') === 'ranked' || p('mode') === 'hextech' ? p('mode') : undefined;
      const key = Number.isInteger(summonerId) && summonerId > 0 ? summonerId : puuid;
      if (!key) { fail(res, '缺少 summonerId/puuid'); return; }
      const s = typeof key === 'number'
        ? await getPlayerRecentStats(key, { limit: 20, maxDays: 15, mode })
        : await getPlayerRecentStatsByPuuid(key.replace(/@pvp\.net$/, ''), { limit: 20, maxDays: 15, rawLimit: 50, mode });
      if (!s) { ok(res, { stats: null, byType: null, recent: [] }); return; }
      ok(res, {
        stats: evaluateModeStats(s, queueId),
        byType: evaluateByType(s),
        recent: await enrichRecent(s.recent),
      });
      return;
    }
    case 'friends': {
      // 在线好友：近期战绩 + 组队建议 + 逐场明细（lol-chat 只读；pid 去 @pvp.net 即 puuid 查 match-history）
      try {
        const friends = await lcuGet<{
          pid?: string | number; name?: string; gameName?: string; availability?: string;
          lol?: { level?: number | string; rankedLeagueTier?: string; rankedLeagueDivision?: string;
                  gameStatus?: string; gameMode?: string; gameQueueType?: string };
        }[]>('/lol-chat/v1/friends');
        const me = await getCurrentSummoner().catch(() => null);
        const online = (friends ?? []).filter(
          (f) => f.availability && f.availability !== 'offline' && String(f.pid) !== String(me?.summonerId ?? -1),
        );
        const settled = await Promise.allSettled(online.map(async (f) => {
          const puuid = String(f.pid ?? '').replace(/@pvp\.net$/, '');
          if (!/^[0-9a-f-]{20,}$/i.test(puuid)) return null;
          // 好友：只查最近 50 场原始对局（15 天内排位/海斗各最多 20 场），按排位/海斗分类型评估
          const stats = await getPlayerRecentStatsByPuuid(puuid, { limit: 20, maxDays: 15, rawLimit: 50 });
          const v = stats ? evaluateByType(stats) : null;
          const st = friendStatus(f); // availability=dnd 可能是游戏中（LCU 自动勿扰），以 lol.gameStatus 为准
          return {
            puuid,
            name: f.gameName || f.name || `好友${puuid.slice(0, 6)}`,
            status: st.status,
            gameLabel: st.gameLabel,
            level: f.lol?.level != null ? Number(f.lol.level) || null : null,
            tier: f.lol?.rankedLeagueTier ? `${f.lol.rankedLeagueTier} ${f.lol.rankedLeagueDivision ?? ''}`.trim() : '',
            icon: stats?.icon ?? null,
            stats: v,
          };
        }));
        type FriendEntry = {
          puuid: string; name: string; status: string; gameLabel: string;
          level: number | null; tier: string; icon: number | null;
          stats: ReturnType<typeof evaluateByType> | null;
        };
        const list = settled
          .filter((r): r is PromiseFulfilledResult<FriendEntry | null> => r.status === 'fulfilled')
          .map((r) => r.value)
          .filter((x): x is FriendEntry => x !== null)
          .sort((a, b) => {
            const sc = (s: FriendEntry['stats']) => Math.max(s?.ranked?.score ?? -1, s?.hextech?.score ?? -1);
            return sc(b.stats) - sc(a.stats);
          });
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
      // 自动推荐：读游戏内我方阵容 + 官方牌榜 Top 10 评级；无需手动输入牌名（Web 直接展示）
      const { recommendAugmentChoices } = await import('../services/augments.js');
      const { recommendAugments } = await import('../services/hextech.js');
      const ids = (p('ids') ?? '').split(',').map(Number).filter((n) => n > 0);
      // 我方英雄：游戏内自动读（InProgress/GameStart），否则空
      let myHeroIds: number[] = [];   // 全队 5 人（含自己）
      let myHeroId = 0;               // 自己的英雄（评级基准）
      let phase = 'unknown';
      let mode = '未知';
      try {
        phase = await getGameflowPhase();
        if (phase === 'InProgress' || phase === 'GameStart') {
          const g = await getGameflowSession();
          const gd = g?.gameData ?? ({} as typeof g.gameData);
          const gm = gd.queue?.gameMode ?? gd.gameMode ?? '';
          mode = ({ KIWI: '海克斯大乱斗', ARAM: '大乱斗', ARAM_GAME: '大乱斗', CLASSIC: '峡谷', DEFAULT: '峡谷' })[gm] ?? (gm || '未知');
          const me = await getCurrentSummoner().catch(() => null);
          // 普通模式：gameData.players（teamId 100=我方）；KIWI：teamOne/teamTwo + 自己 puuid 判断阵营
          const classic = gd.players ?? [];
          if (classic.length) {
            myHeroIds = [...new Set(classic.filter((pl) => pl.teamId === 100 && pl.championId > 0).map((pl) => pl.championId))];
            myHeroId = classic.find((pl) => pl.teamId === 100 && pl.puuid === me?.puuid)?.championId ?? 0;
          } else if (Array.isArray(gd.teamOne) && gd.teamOne.length) {
            const myTeam = (gd.teamOne ?? []).some((p) => p.puuid === me?.puuid) ? (gd.teamOne ?? []) : (gd.teamTwo ?? []);
            myHeroIds = [...new Set(myTeam.filter((p) => p.championId > 0).map((p) => p.championId))];
            myHeroId = myTeam.find((p) => p.puuid === me?.puuid)?.championId ?? 0;
          }
        }
      } catch { /* 客户端不可用 */ }
      // 官方牌榜 Top 10（Web 选牌参考；服务端缓存，不随轮询重复拉取）
      const topAugments = await recommendAugments(10).catch(() => []);
      const recoIds = ids.length ? ids : topAugments.map((a) => a.augment.augmentID);
      // 评级基准：优先自己的英雄（用户选定后按他来推荐），读不到时回退全队
      const heroIds = myHeroId > 0 ? [myHeroId] : myHeroIds;
      // 海斗英雄榜：找自己英雄的条目（胜率/登场率/推荐海克斯牌/最佳搭档）
      const myHeroStat = myHeroId > 0
        ? (await recommendHextechHeroes(300).catch(() => [])).find((h) => h.heroId === myHeroId) ?? null
        : null;
      ok(res, {
        phase,
        mode,
        myHeroId,
        myHeroIds,
        myHeroStat: myHeroStat ? {
          title: myHeroStat.title,
          alias: myHeroStat.alias,
          winRate: myHeroStat.winRate,
          pickRate: myHeroStat.pickRate,
          rank: myHeroStat.rank,
          bestAugments: myHeroStat.bestAugments.slice(0, 5).map((a) => ({ name_cn: a.name_cn, winRate: a.winRate, pickRate: a.pickRate })),
          bestPartners: myHeroStat.bestPartners.slice(0, 3).map((p) => ({ title: p.title, winRate: p.winRate })),
        } : null,
        heroNames: (await (async () => {
          try {
            const heroes = await getHeroList();
            return Object.fromEntries([...new Set([...myHeroIds, myHeroId].filter((id) => id > 0))].map((id) => [id, heroes.get(id)?.title ?? `#${id}`]));
          } catch { return {}; }
        })()),
        choices: recoIds.length ? await recommendAugmentChoices(recoIds, heroIds) : [],
        topAugments,
      });
      return;
    }
    default:
      fail(res, `未知接口: ${route}`);
  }
}

/** 本机 + 局域网 IPv4 访问地址（手机与电脑同一 Wi-Fi 时可直接访问） */
function lanUrls(port: number): string[] {
  const urls = [`http://127.0.0.1:${port}`];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${port}`);
    }
  }
  return [...new Set(urls)];
}

export function startWebServer(port: number, onListening?: (urls: string[]) => void): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname === '/' || url.pathname === '/index.html') {
        // no-store：前端迭代频繁，防止浏览器缓存旧版页面导致轮询代码不更新
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
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
  // 监听 0.0.0.0：本机 + 局域网（手机同 Wi-Fi 可访问）；读取的是本机游戏数据，公共网络请谨慎使用
  server.listen(port, '0.0.0.0', () => onListening?.(lanUrls(port)));
  return server;
}
