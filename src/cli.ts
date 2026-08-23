#!/usr/bin/env node
// t101 — 英雄联盟国服 BP 助手
import { execSync } from 'node:child_process';
import http from 'node:http';
import { startWebServer } from './web/server.js';

// Windows 下把控制台切到 UTF-8，避免中文乱码
if (process.platform === 'win32') {
  try { execSync('chcp 65001 > NUL', { stdio: 'ignore' }); } catch { /* ignore */ }
}

import { Command, InvalidArgumentError } from 'commander';
import { getChampionRankings, getHeroList, getVersions, resolveHeroes, getConfront, getAugmentList, getHextechHeroRank, getHextechRuneRank, getAramHeroRank, daysAgo, type TierId } from './api/cn101.js';
import { snapshotGet, snapshotList, snapshotClear, SNAPSHOT_DIR } from './utils/snapshot.js';
import { getOpggChampionRankings, getOpggChampionRankingsCached, matchOpggToHero, normalizeOpggPosition, type OpggChampionStat } from './api/opgg.js';
import { findLcuConnection, getGameflowPhase, getGameflowSession, getRankedStats, getSummoner, getCurrentSummoner, summonerDisplayName, KNOWN_QUEUE_IDS } from './api/lcu.js';
import { analyzeChampSelect } from './services/champselect.js';
import { heroDisplayName, TIER_NAMES } from './models.js';
import { recommendPick, inferLane } from './services/pick.js';
import { recommendBan } from './services/ban.js';
import { printTable, println, pct, tierColor, rankChange } from './utils/table.js';
import { cacheClear } from './utils/cache.js';

const program = new Command();

function parseTier(v: string): TierId {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 255) throw new InvalidArgumentError('段位 id 需为 1~255（255=全段位）');
  return n as TierId;
}

/** sync 全量段位/位置清单 */
const ALL_TIERS: TierId[] = [255, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
const ALL_LANES = ['ALL', 'TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'SUPPORT'] as const;

program
  .name('t101')
  .description('英雄联盟国服 BP 助手（数据源：101.qq.com 官方 + OP.GG 参考）')
  .version('0.2.0');

program
  .command('pick')
  .description('对面已选英雄 -> 推荐克制他们的高胜率英雄')
  .argument('<enemy>', '对面已选英雄，逗号分隔（中文名/英文名/ID），如 "亚索,盲僧"')
  .option('-l, --lane <lane>', '我方想选的位置 TOP/JUNGLE/MIDDLE/BOTTOM/SUPPORT', 'ALL')
  .option('-e, --exclude <heroes>', '我方已选英雄（不推荐重复），逗号分隔')
  .option('-t, --tier <id>', '段位过滤，255=全段位（默认）', parseTier, 255)
  .option('-n, --top <n>', '推荐数量', '8')
  .option('--no-color', '禁用颜色')
  .action(async (enemy: string, opts) => {
    try {
      const recs = await recommendPick({
        enemyHeroes: enemy.split(/[,，]/),
        myLane: opts.lane.toUpperCase(),
        exclude: opts.exclude ? opts.exclude.split(/[,，]/) : [],
        topN: Number(opts.top),
        opts: { tier: opts.tier },
      });
      if (recs.length === 0) {
        println('没有找到推荐（检查对面英雄名是否输入正确）');
        return;
      }
      println(`🎯 推荐 Pick（克制 ${enemy} · 段位 ${TIER_NAMES[opts.tier]} · 按对位胜率+段位强度综合排序）`);
      printTable(
        [{ header: '#', align: 'right' }, { header: '英雄' }, { header: '位置' }, { header: '强度' }, { header: '胜率', align: 'right' }, { header: '对位（vs 对面，%越高越好）' }],
        recs.map((r, i) => [
          i + 1, r.title, r.lane, tierColor(r.tier), pct(r.winRate),
          r.matchups.map((m) => `${m.enemyTitle} ${m.winRate.toFixed(1)}%`).join('、'),
        ]),
      );
    } catch (e) {
      println(`❌ ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('ban')
  .description('Ban 建议：无参数=版本强势榜；给出我方英雄=推荐克制我方最多的')
  .argument('[my]', '我方已选英雄，逗号分隔，可选')
  .option('-t, --tier <id>', '段位过滤', parseTier, 255)
  .option('-n, --top <n>', '推荐数量', '10')
  .option('--no-color', '禁用颜色')
  .action(async (my: string | undefined, opts) => {
    try {
      const recs = await recommendBan({
        myHeroes: my ? my.split(/[,，]/) : [],
        topN: Number(opts.top),
        opts: { tier: opts.tier },
      });
      const withMyTeam = !!my;
      if (withMyTeam) {
        println(`🛡️ 推荐 Ban（克制我方阵容最多的英雄 · 段位 ${TIER_NAMES[opts.tier]}）`);
        printTable(
          [
            { header: '#', align: 'right' }, { header: '英雄' }, { header: '位置' }, { header: '强度' },
            { header: '胜率', align: 'right' }, { header: '禁用', align: 'right' }, { header: '威胁我方（对位胜率）' },
          ],
          recs.map((r, i) => [
            i + 1, r.title, r.lane ?? '-', tierColor(r.tier), pct(r.winRate), pct(r.banRate),
            (r.matchups ?? []).map((m) => `${m.myTitle} ${m.winRate.toFixed(1)}%`).join('、') || '-',
          ]),
        );
      } else {
        println(`🛡️ 版本梯度榜（T0→T2 优先 · 段位 ${TIER_NAMES[opts.tier]} · 按强度+禁用率排序，优先 ban）`);
        printTable(
          [
            { header: '#', align: 'right' }, { header: '英雄' }, { header: '位置' }, { header: '强度' },
            { header: '胜率', align: 'right' }, { header: '登场', align: 'right' }, { header: '禁用', align: 'right' },
          ],
          recs.map((r, i) => [
            i + 1, r.title, r.lane ?? '-', tierColor(r.tier), pct(r.winRate), pct(r.pickRate), pct(r.banRate),
          ]),
        );
      }
    } catch (e) {
      println(`❌ ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('rank')
  .description('当前版本英雄榜单（胜率/登场率/禁用率）')
  .option('-l, --lane <lane>', '位置 TOP/JUNGLE/MIDDLE/BOTTOM/SUPPORT/ALL', 'ALL')
  .option('-t, --tier <id>', '段位过滤', parseTier, 255)
  .option('-n, --top <n>', '展示数量', '20')
  .option('--no-color', '禁用颜色')
  .action(async (opts) => {
    try {
      const [rankings, heroes, versions] = await Promise.all([
        getChampionRankings({ tier: opts.tier, lane: opts.lane.toUpperCase() }),
        getHeroList(),
        getVersions(),
      ]);
      println(`📊 国服英雄榜单（版本 ${versions[0].name} · ${opts.lane.toUpperCase()} · 段位 ${opts.tier === 255 ? '全段位' : opts.tier}）`);
      printTable(
        [{ header: '排名', align: 'right' }, { header: '英雄' }, { header: '位置' }, { header: '强度' }, { header: '胜率', align: 'right' }, { header: '登场率', align: 'right' }, { header: '禁用率', align: 'right' }, { header: '变化' }],
        rankings.slice(0, Number(opts.top)).map((r) => [
          r.rank, heroDisplayName(heroes.get(r.heroId), r.heroId), r.lane, tierColor(r.tier),
          pct(r.winRate), pct(r.pickRate), pct(r.banRate), rankChange(r.rankChange),
        ]),
      );
    } catch (e) {
      println(`❌ ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('hero')
  .description('对位克制查询：某英雄被谁克制 / 克制谁')
  .argument('<hero>', '英雄名（中文/英文/ID）')
  .option('-l, --lane <lane>', '位置（默认按榜单推断主位置）', 'ALL')
  .option('-t, --tier <id>', '段位过滤', parseTier, 255)
  .option('--no-color', '禁用颜色')
  .action(async (hero: string, opts) => {
    try {
      const [{ heroId }, heroes] = await Promise.all([
        (await resolveHeroes([hero]))[0],
        getHeroList(),
      ]);
      // 对位数据必须指定具体位置：ALL 时按该英雄在榜单中登场率最高的位置
      const lane = opts.lane.toUpperCase();
      const finalLane = lane === 'ALL'
        ? inferLane(await getChampionRankings({ tier: opts.tier, lane: 'ALL' }), heroId)
        : lane;
      const stats = await getConfront(heroId, { tier: opts.tier, lane: finalLane });
      const title = heroDisplayName(heroes.get(heroId), heroId);
      println(`⚔️ ${title} 的对位克制（${finalLane}）`);
      if (stats.high.length) {
        println(`\n克制 ${title} 的英雄（对面选 ${title} 时，可考虑这些）：`);
        printTable(
          [{ header: '#', align: 'right' }, { header: '英雄' }, { header: '对位胜率', align: 'right' }],
          stats.high.map((h, i) => [i + 1, heroDisplayName(heroes.get(h.heroId), h.heroId), pct(h.winRate)]),
        );
      }
      if (stats.low.length) {
        println(`\n被 ${title} 克制的英雄：`);
        printTable(
          [{ header: '#', align: 'right' }, { header: '英雄' }, { header: '对位胜率', align: 'right' }],
          stats.low.map((h, i) => [i + 1, heroDisplayName(heroes.get(h.heroId), h.heroId), pct(h.winRate)]),
        );
      }
    } catch (e) {
      println(`❌ ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('lcu')
  .description('LCU（本地客户端）连接检测')
  .command('status')
  .description('检测客户端连接与当前阶段')
  .action(async () => {
    const conn = findLcuConnection();
    if (!conn) {
      println('❌ 未检测到英雄联盟客户端。请先启动游戏客户端（登录到主界面即可）。');
      println('   提示：国服客户端也可用；如检测不到可设置环境变量 T101_LOCKFILE 指向 lockfile 路径');
      process.exitCode = 1;
      return;
    }
    println(`✅ 已连接客户端（端口 ${conn.port}）`);
    try {
      const phase = await getGameflowPhase();
      println(`当前阶段: ${phase}`);
      if (phase === 'ChampSelect') println('  → 可以用 t101 champselect 查看 BP 推荐');
      if (phase === 'GameStart' || phase === 'InProgress') println('  → 可以用 t101 loading 查看 10 人信息');
    } catch (e) {
      println(`❌ ${(e as Error).message}`);
    }
  });

program
  .command('champselect')
  .description('选人阶段实时 BP 推荐（从本地客户端自动读取双方英雄）')
  .option('-w, --watch', '持续监听（每 5 秒刷新），Ctrl+C 退出', false)
  .option('--no-color', '禁用颜色')
  .action(async (opts) => {
    const run = async () => {
      try {
        const a = await analyzeChampSelect();
        const heroes = await getHeroList();
        println(`⏱️  选人阶段: ${a.phase} · 模式: ${a.modeLabel} · 段位: ${a.tierName} · 我方位置: ${a.myLane === 'ALL' ? '未分配' : a.myLane}`);
        const act = a.currentAction;
        if (act) {
          println(`🔄  ${a.timerPhase} · 剩余 ${a.timeLeftSec}s · 第 ${a.completedActions + 1}/${a.totalActions} 手 · ${act.isAlly ? '我方' : '对面'} ${act.lane} ${act.actorName} 正在${act.type === 'ban' ? '禁用' : '选择'}${act.isMe ? ' ← 轮到你！' : ''}`);
        } else {
          println(`🔄  ${a.timerPhase} · 已操作 ${a.completedActions}/${a.totalActions} 手`);
        }
        if (a.mode === 'hextech_aram' && a.queueId !== undefined && !KNOWN_QUEUE_IDS.has(a.queueId)) {
          println(`ℹ️  队列 id=${a.queueId} 不在已知列表，已按海克斯大乱斗处理（如与实际不符请反馈）`);
        }
        const isRanked = a.mode === 'ranked_solo' || a.mode === 'ranked_flex';
        const isHex = a.mode === 'hextech_aram';
        if (!isRanked && !isHex) {
          println(`ℹ️  当前模式（${a.modeLabel}）暂未支持`);
          return;
        }
        if (a.enemyBans.length) println(`🚫 对面 Ban: ${a.enemyBans.map((id) => heroDisplayName(heroes.get(id), id)).join('、')}`);
        if (a.myBans.length) println(`🚫 我方 Ban: ${a.myBans.map((id) => heroDisplayName(heroes.get(id), id)).join('、')}`);

        if (isHex) {
          println('\n🎴 海克斯大乱斗：无 Ban 阶段，翻牌进共享池，全员可选');
          if (a.aramPool.length) {
            println(`🏊 当前共享池（已翻开 ${a.aramPool.length} 个，按推荐分排序）:`);
            printTable(
              [{ header: '#', align: 'right' }, { header: '英雄' }, { header: '推荐分', align: 'right' }, { header: '胜率', align: 'right' }, { header: '登场率', align: 'right' }, { header: '推荐海克斯牌' }, { header: '备注' }],
              a.aramPool.map((h) => [h.rank, h.title, h.score !== null ? String(h.score) : '—', h.winRate !== null ? pct(h.winRate) : '—', h.pickRate !== null ? pct(h.pickRate) : '—', h.bestAugments.slice(0, 2).map((x) => x.name_cn).join('、'), h.isMine ? '🌟 我翻的' : (h.score === null ? '无榜数据' : '')]),
            );
          } else {
            println('🎴 队友还在翻牌，翻开的英雄进池后自动刷新');
          }
          println('🃏 全英雄胜率榜（可参考池外英雄）:');
          printTable(
            [{ header: '#', align: 'right' }, { header: '英雄' }, { header: '胜率', align: 'right' }, { header: '登场率', align: 'right' }, { header: '推荐海克斯牌' }],
            (a.aramHeroes ?? []).map((h, i) => [i + 1, h.title, pct(h.winRate), pct(h.pickRate), h.bestAugments.slice(0, 2).map((x) => x.name_cn).join('、')]),
          );
          return;
        }

        if (a.enemyPicks.length) {
          println(`\n👹 对面已选: ${a.enemyPicks.map((id) => heroDisplayName(heroes.get(id), id)).join('、')}`);
          println(`🎯 推荐 Pick（按对位胜率+${a.tierName}段位强度综合排序）`);
          printTable(
            [{ header: '#', align: 'right' }, { header: '英雄' }, { header: '位置' }, { header: '强度' }, { header: '胜率', align: 'right' }, { header: '对位（vs 对面，%越高越好）' }],
            a.picks.map((r, i) => [
              i + 1, r.title, r.lane, tierColor(r.tier), pct(r.winRate),
              r.matchups.map((m) => `${m.enemyTitle} ${m.winRate.toFixed(1)}%`).join('、'),
            ]),
          );
        } else {
          println('\n👹 对面还没选英雄');
        }

        if (a.myPicks.length) {
          println(`\n🛡️ 推荐 Ban（克制我方 ${a.myPicks.map((id) => heroDisplayName(heroes.get(id), id)).join('、')} · ${a.tierName}）`);
          printTable(
            [{ header: '#', align: 'right' }, { header: '英雄' }, { header: '位置' }, { header: '胜率', align: 'right' }, { header: '禁用率', align: 'right' }, { header: '威胁我方（对位胜率）' }],
            a.bans.map((r, i) => [
              i + 1, r.title, r.lane ?? '-', pct(r.winRate), pct(r.banRate),
              (r.matchups ?? []).map((m) => `${m.myTitle} ${m.winRate.toFixed(1)}%`).join('、') || '-',
            ]),
          );
        } else {
          println('\n🛡️ 我方还没选英雄（选完英雄后自动给出 Ban 建议）');
        }
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('不存在')) {
          println('❌ 当前不在选人阶段。请先进入对局选人界面（训练模式/匹配/排位均可）。');
          println('   提示：选人阶段用 t101 champselect，加载画面用 t101 loading');
        } else {
          println(`❌ ${msg}`);
        }
        if (opts.watch) return;
        process.exitCode = 1;
      }
    };
    await run();
    if (opts.watch) {
      println('\n（监听中，每 5 秒刷新，Ctrl+C 退出）');
      // 自调度 setTimeout：上次执行完成后再排下一次，避免网络慢时任务重叠
      let timer: NodeJS.Timeout;
      const loop = async () => {
        await run();
        timer = setTimeout(loop, 5000);
      };
      timer = setTimeout(loop, 5000);
    }
  });

program
  .command('loading')
  .description('加载画面：10 名玩家信息（召唤师名/英雄/位置/段位/等级）')
  .option('--no-color', '禁用颜色')
  .action(async () => {
    try {
      const session = await getGameflowSession();
      const heroes = await getHeroList();
      const gd = session.gameData ?? ({} as typeof session.gameData);
      // 普通模式：gameData.players；KIWI（海克斯大乱斗）：无 players，用 teamOne/teamTwo（各 5 人）
      const gm = gd.queue?.gameMode ?? gd.gameMode ?? '';
      let players: import('./api/lcu.js').GamePlayer[] = [];
      // 敌我归一化：用当前召唤师 puuid 定位自己所在队伍，自己队 → teamId 100（我方），对面 → 200
      const me = await getCurrentSummoner().catch(() => null);
      if ((gd.players ?? []).length) {
        const classic = gd.players as import('./api/lcu.js').GamePlayer[];
        const myTid = classic.find((p) => p.puuid === me?.puuid)?.teamId ?? 100;
        players = classic.map((p) => ({ ...p, teamId: p.teamId === myTid ? 100 : 200 }));
      } else if (Array.isArray(gd.teamOne) && gd.teamOne.length) {
        // KIWI：先按 puuid 定位自己阵营，再映射 100=我方 / 200=对面
        const inOne = (gd.teamOne ?? []).some((p) => p.puuid === me?.puuid);
        const mySide = inOne ? (gd.teamOne ?? []) : (gd.teamTwo ?? []);
        const theirSide = inOne ? (gd.teamTwo ?? []) : (gd.teamOne ?? []);
        const all = [...mySide.map((p) => ({ ...p, teamId: 100 as const })), ...theirSide.map((p) => ({ ...p, teamId: 200 as const }))];
        const infos = await Promise.all(all.map((p) => getSummoner(p.summonerId).then((s) => ({ name: summonerDisplayName(s), level: s.summonerLevel ?? 0 })).catch(() => ({ name: `召唤师${p.summonerId}`, level: 0 }))));
        players = all.map((p, i) => ({
          summonerId: p.summonerId,
          summonerName: infos[i].name,
          puuid: p.puuid,
          championId: p.championId,
          teamId: p.teamId,
          position: p.selectedPosition ?? '',
          isBot: false,
          profileIconId: p.profileIconId,
          summonerLevel: infos[i].level,
        }));
      }
      if (!players.length) {
        println('当前对局没有玩家数据（确认已进入加载画面）');
        return;
      }
      // 大乱斗系（海克斯大乱斗 KIWI / 普通大乱斗 ARAM）无排位段位：跳过 10 人段位查询
      const aramLike = gm === 'KIWI' || gm === 'ARAM' || gm === 'ARAM_GAME';
      println(`🎮 ${gm} · 地图 ${gd.mapId ?? session.gameData.mapId} · 共 ${players.length} 人${aramLike ? ' · 大乱斗无段位' : ''}`);

      // 并发查段位（失败不阻塞；大乱斗跳过）
      const ranked = new Map<number, string>();
      if (!aramLike) {
        const results = await Promise.allSettled(players.filter((p) => !p.isBot).map((p) => getRankedStats(p.summonerId)));
        players.filter((p) => !p.isBot).forEach((p, i) => {
          const r = results[i];
          if (r.status === 'fulfilled' && r.value && r.value.length) {
            const solo = r.value.find((q) => q.queue.includes('RANKED_SOLO')) ?? r.value[0];
            ranked.set(p.summonerId, `${solo.tier} ${solo.division} ${solo.lp}LP`);
          }
        });
      }

      for (const team of [100, 200]) {
        const members = players.filter((p) => p.teamId === team);
        if (!members.length) continue;
        println(`\n${team === 100 ? '🔵 我方' : '🔴 对面'}`);
        printTable(
          [{ header: '召唤师' }, { header: '英雄' }, { header: '位置' }, { header: '段位' }, { header: '等级', align: 'right' }],
          members.map((p) => [
            p.summonerName,
            p.isBot ? '🤖 人机' : heroDisplayName(heroes.get(p.championId), p.championId),
            p.position || '-',
            ranked.get(p.summonerId) ?? '-',
            p.summonerLevel ?? '-',
          ]),
        );
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('不存在')) {
        println('❌ 当前不在对局中。请确认：客户端已进入加载画面（读取中界面）后再运行本命令。');
        println('   提示：选人阶段用 t101 champselect，加载画面用 t101 loading');
      } else {
        println(`❌ ${msg}`);
      }
      process.exitCode = 1;
    }
  });

/** 检测端口上是否已有 t101 Web 实例在运行（避免重复启动/重复开标签页） */
function isLolaWebRunning(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 4000) res.destroy(); });
      res.on('end', () => resolve(data.includes('T101')));
      res.on('error', () => resolve(false));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

program
  .command('web')
  .description('启动 Web 界面（浏览器打开，含 BP 助手/榜单/加载画面等全部功能）')
  .option('-p, --port <port>', '端口', '8765')
  .option('--no-open', '不自动打开浏览器')
  .action(async (opts) => {
    const port = Number(opts.port);
    const url = `http://127.0.0.1:${port}`;
    // 已有 t101 实例在运行：直接提示，不重复启动、不重复开标签页
    if (await isLolaWebRunning(port)) {
      println(`ℹ️ T101 Web 已在运行: ${url}`);
      println('   直接打开浏览器访问即可，或 Ctrl+C 退出本命令');
      return;
    }
    // watch 模式（npm run web:watch）：代码变更会重启进程，自动开浏览器会不断新增标签页，故跳过
    const isWatch = process.env.npm_lifecycle_event === 'web:watch';
    // startWebServer 监听 0.0.0.0：本机 + 局域网（手机同 Wi-Fi 可访问）
    startWebServer(port, (urls) => {
      const [localUrl, ...lanList] = urls;
      println(`🌐 T101 Web 界面已启动: ${localUrl}`);
      for (const u of lanList) println(`📱 手机访问（同一 Wi-Fi）: ${u}`);
      if (lanList.length) println('   ⚠️ 已开放局域网访问：同网络设备可查看本机游戏数据，公共 Wi-Fi 请谨慎使用');
      println('   Ctrl+C 停止服务');
      if (opts.open && !isWatch) {
        try { execSync(`start ${localUrl}`, { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
      }
    });
  });

program
  .command('hex')
  .description('海克斯大乱斗数据：英雄胜率榜 + 海克斯牌推荐')
  .option('-n, --top <n>', '展示数量', '15')
  .option('--no-color', '禁用颜色')
  .action(async (opts) => {
    try {
      const { recommendHextechHeroes, recommendAugments, augmentLevelName } = await import('./services/hextech.js');
      const [heroes, augments] = await Promise.all([
        recommendHextechHeroes(Number(opts.top)),
        recommendAugments(Number(opts.top)),
      ]);
      println('🃏 海克斯大乱斗 · 英雄胜率榜（含推荐海克斯牌）');
      printTable(
        [{ header: '#', align: 'right' }, { header: '英雄' }, { header: '胜率', align: 'right' }, { header: '登场率', align: 'right' }, { header: '推荐海克斯牌' }, { header: '最佳搭档' }],
        heroes.map((h, i) => [i + 1, h.title, pct(h.winRate), pct(h.pickRate),
          h.bestAugments.slice(0, 2).map((a) => a.name_cn).join('、'),
          h.bestPartners.slice(0, 2).map((p) => p.title).join('、')]),
      );
      println('\n🃏 海克斯牌推荐（按持有胜率排序，选牌时优先）');
      printTable(
        [{ header: '#', align: 'right' }, { header: '海克斯牌' }, { header: '品质' }, { header: '胜率', align: 'right' }, { header: '出场率', align: 'right' }, { header: '适合英雄' }],
        augments.map((a, i) => [i + 1, a.augment.name_cn, augmentLevelName(a.augment.level), pct(a.winRate), pct(a.pickRate), a.bestHeroes.join('、')]),
      );
    } catch (e) {
      println(`❌ ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('augment')
  .description('游戏内海克斯牌选择推荐（3/7/11/15 级选牌，泉水复活后出现选牌界面，输入当前三张牌名）')
  .argument('[names]', '当前可选牌名关键词，逗号分隔（如：魔法飞弹,风暴之怒,超频）')
  .option('--heroes <names>', '手动指定我方英雄（逗号分隔），默认自动读游戏内我方阵容')
  .action(async (names: string | undefined, opts: { heroes?: string }) => {
    try {
      const { searchAugments, recommendAugmentChoices } = await import('./services/augments.js');
      const { getGameflowSession } = await import('./api/lcu.js');
      if (!names) {
        println('🎮 海克斯牌选择推荐 — 用法示例:');
        println('  t101 augment 魔法飞弹,风暴之怒,超频');
        println('  t101 augment 魔法飞弹 --heroes 卡特琳娜,亚索,盲僧');
        println('（在游戏里选牌时，把当前出现的三张牌名输入即可，每张牌至少可重抽一次）');
        return;
      }
      // 解析牌名 -> id
      const ids: number[] = [];
      const missing: string[] = [];
      for (const kw of names.split(',').map((s) => s.trim()).filter(Boolean)) {
        const hits = await searchAugments(kw);
        if (!hits.length) { missing.push(kw); continue; }
        if (hits.length > 1 && hits[0].name_cn !== kw && hits[0].name_en.toLowerCase() !== kw.toLowerCase()) {
          println(`⚠️  "${kw}" 匹配到多个: ${hits.slice(0, 5).map((a) => a.name_cn).join('、')}，取第一个「${hits[0].name_cn}」`);
        }
        ids.push(hits[0].augmentID);
      }
      if (missing.length) println(`❌ 未找到牌: ${missing.join('、')}（可用 t101 hex 查看牌名）`);
      if (!ids.length) return;
      // 我方英雄：优先 --heroes，否则自动读游戏内阵容
      let myHeroIds: number[] = [];
      let myHeroNames = '';
      let myHeroId = 0; // 自己的英雄（评级基准）
      const heroes = await getHeroList();
      if (opts.heroes) {
        const resolved = await resolveHeroes(opts.heroes.split(','));
        myHeroIds = resolved.map((h) => h.heroId);
        myHeroNames = resolved.map((h) => h.input).join('、');
      } else {
        const phase = await getGameflowPhase();
        if (phase !== 'InProgress' && phase !== 'GameStart') {
          println(`ℹ️  当前不在游戏中（阶段: ${phase}），推荐按「无阵容加成」计算；可用 --heroes 手动指定阵容`);
        }
        const g = await getGameflowSession().catch(() => null);
        const gd = g?.gameData ?? ({} as NonNullable<typeof g>['gameData']);
        // 普通模式：gameData.players（teamId 100=我方）；KIWI（海克斯大乱斗）：teamOne/teamTwo + 自己 puuid 判断阵营
        const classic = gd.players ?? [];
        if (classic.length) {
          myHeroIds = [...new Set(classic.filter((p) => p.teamId === 100 && p.championId > 0).map((p) => p.championId))];
          const me = await getCurrentSummoner().catch(() => null);
          myHeroId = classic.find((p) => p.teamId === 100 && p.puuid === me?.puuid)?.championId ?? 0;
        } else if (Array.isArray(gd.teamOne) && gd.teamOne.length) {
          const me = await getCurrentSummoner().catch(() => null);
          const myTeam = (gd.teamOne ?? []).some((p) => p.puuid === me?.puuid) ? (gd.teamOne ?? []) : (gd.teamTwo ?? []);
          myHeroIds = [...new Set(myTeam.filter((p) => p.championId > 0).map((p) => p.championId))];
          myHeroId = myTeam.find((p) => p.puuid === me?.puuid)?.championId ?? 0;
        }
        myHeroNames = myHeroIds.map((id) => heroes.get(id)?.title ?? `#${id}`).join('、');
      }
      // 评级基准：优先自己的英雄，读不到（手动 --heroes / 不在游戏）时回退全队
      const heroIds = myHeroId > 0 ? [myHeroId] : myHeroIds;
      const myHeroName = myHeroId > 0 ? heroes.get(myHeroId)?.title ?? `#${myHeroId}` : '';
      const recs = await recommendAugmentChoices(ids, heroIds);
      const heroLine = myHeroId > 0
        ? `🎯 你的英雄: ${myHeroName} · 队友: ${myHeroNames.split('、').filter((h) => h !== myHeroName).join('、') || '—'}`
        : `我方阵容: ${myHeroNames || '未知'}`;
      println(`\n🎮 海克斯牌选择推荐（${heroLine} · 评级按你的英雄适配）`);
      printTable(
        [{ header: '评级', align: 'left' }, { header: '海克斯牌' }, { header: '品质' }, { header: '胜率', align: 'right' }, { header: '出场率', align: 'right' }, { header: '命中阵容' }, { header: '适合英雄' }],
        recs.map((r) => [
          r.grade, r.name, r.level,
          Number.isFinite(r.winRate) ? pct(r.winRate) : '—',
          Number.isFinite(r.pickRate) ? pct(r.pickRate) : '—',
          r.matchedHeroes.join('、') || '—',
          r.bestHeroes.join('、') || '—',
        ]),
      );
      const best = recs[0];
      if (best) println(`\n✅ 推荐选择: ${best.grade} ${best.name}（综合分 ${best.score}）`);
      // 海斗榜：自己英雄的官方推荐海克斯 + 最佳搭档
      if (myHeroId > 0) {
        const { recommendHextechHeroes } = await import('./services/hextech.js');
        const myStat = (await recommendHextechHeroes(300).catch(() => [])).find((h) => h.heroId === myHeroId);
        if (myStat) {
          println(`\n🏆 海斗榜 #${myStat.rank} ${myStat.title} · 胜率 ${pct(myStat.winRate)} · 登场 ${pct(myStat.pickRate)}`);
          if (myStat.bestAugments.length) {
            println(`🃏 推荐海克斯: ${myStat.bestAugments.slice(0, 5).map((a) => `${a.name_cn} ${pct(a.winRate)}`).join('、')}`);
          }
          if (myStat.bestPartners.length) {
            println(`🤝 最佳搭档: ${myStat.bestPartners.slice(0, 3).map((p) => `${p.title} ${pct(p.winRate)}`).join('、')}`);
          }
        }
      }
    } catch (e) {
      println(`❌ ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('sync')
  .description('定期更新本地数据快照（版本变更才重拉；可配合 Windows 计划任务定时运行）')
  .option('-a, --all', '拉取所有段位榜单（默认仅全段位 255）')
  .option('-f, --force', '强制重拉所有数据（忽略已有快照）')
  .option('--no-ranks', '跳过峡谷榜单')
  .option('--no-hex', '跳过海克斯/大乱斗数据')
  .option('--opgg', '同时拉取 op.gg 韩服榜单（参考）')
  .option('-r, --region <region>', 'op.gg 服务器（配合 --opgg）', 'kr')
  .action(async (opts) => {
    try {
      const started = Date.now();
      const rows: [string, string, string, string][] = [];
      let updated = 0;
      let skipped = 0;

      // 版本列表（强制刷新，识别新版本；之后各接口按版本号命中/新建快照）
      const versions = await getVersions(true);
      const version = versions[0]?.name ?? '?';
      println(`📦 当前版本: ${version}${versions[0]?.public_date ? `（${versions[0].public_date}）` : ''}`);

      // 1. 峡谷榜单：默认全段位 × 6 位置；--all 时 11 段位 × 6 位置
      if (opts.ranks) {
        const tiers: TierId[] = opts.all ? ALL_TIERS : [255];
        for (const tier of tiers) {
          for (const lane of ALL_LANES) {
            const key = `rankings:${tier}:${lane}:${version}`;
            if (!opts.force && snapshotGet(key)) {
              skipped++;
              continue;
            }
            const data = await getChampionRankings({ tier, lane, version }, true);
            updated++;
            rows.push([`榜单 ${TIER_NAMES[tier]} ${lane}`, version, `${data.length} 条`, '✓ 已更新']);
          }
        }
      }

      // 2. 海克斯/大乱斗（按日期快照：当天数据生成后不再变化，已有则跳过）
      if (opts.hex) {
        const existed = (prefix: string) => {
          for (let i = 0; i < 4; i++) if (snapshotGet(`${prefix}:${daysAgo(i)}`)) return true;
          return false;
        };
        const heroExisted = existed('hex_hero');
        const runeExisted = existed('hex_rune');
        const aramExisted = existed('aram_hero');
        const [hexHero, hexRune, aram] = await Promise.all([
          opts.force ? getHextechHeroRank(undefined, true) : getHextechHeroRank(),
          opts.force ? getHextechRuneRank(undefined, true) : getHextechRuneRank(),
          opts.force ? getAramHeroRank(undefined, true) : getAramHeroRank(),
        ]);
        const findDate = (prefix: string) => {
          for (let i = 0; i < 4; i++) {
            const m = snapshotGet(`${prefix}:${daysAgo(i)}`)?.meta;
            if (m) return m.date ?? daysAgo(i);
          }
          return '?';
        };
        const hexDate = findDate('hex_hero');
        const runeDate = findDate('hex_rune');
        const aramDate = findDate('aram_hero');
        const push = (label: string, date: string, data: unknown[], existedBefore: boolean) => {
          if (existedBefore) {
            skipped++;
            rows.push([label, date, `${(data as unknown[]).length} 条`, '✓ 已是最新']);
          } else {
            updated++;
            rows.push([label, date, `${(data as unknown[]).length} 条`, '✓ 已更新']);
          }
        };
        push('海克斯英雄榜', hexDate, hexHero, heroExisted);
        push('海克斯牌榜', runeDate, hexRune, runeExisted);
        push('大乱斗英雄榜', aramDate, aram, aramExisted);
      }

      // 3. 静态表（英雄/海克斯牌）
      const [heroes, augments] = await Promise.all([getHeroList(opts.force), getAugmentList(opts.force)]);
      rows.push(['英雄静态表', '', `${heroes.size} 条`, opts.force ? '✓ 已刷新' : '✓ 已确认']);
      rows.push(['海克斯牌表', '', `${augments.size} 条`, opts.force ? '✓ 已刷新' : '✓ 已确认']);

      // 4. op.gg 韩服参考（可选）
      if (opts.opgg) {
        try {
          const cachedBefore = !!getOpggChampionRankingsCached(opts.region, 'all');
          const opgg = await getOpggChampionRankings({ region: opts.region, tier: 'all' }, opts.force);
          if (cachedBefore && !opts.force) {
            skipped++;
            rows.push([`op.gg ${opts.region} 榜单`, opgg[0]?.patch ?? '?', `${opgg.length} 条`, '✓ 已是最新']);
          } else {
            updated++;
            rows.push([`op.gg ${opts.region} 榜单`, opgg[0]?.patch ?? '?', `${opgg.length} 条`, '✓ 已更新']);
          }
        } catch (e) {
          println(`⚠️ op.gg 拉取失败（不影响其他数据）: ${(e as Error).message}`);
        }
      }

      println('');
      printTable(
        [{ header: '数据集' }, { header: '版本/日期' }, { header: '规模' }, { header: '状态' }],
        rows,
      );
      println(`✅ sync 完成：更新 ${updated} 项、跳过 ${skipped} 项（已是最新）· 耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
      println(`   📁 本地快照共 ${snapshotList().length} 个 → ${SNAPSHOT_DIR}`);
      println('   提示：可配合 Windows 计划任务定时执行（如每天一次），版本变更时自动重拉');
    } catch (e) {
      println(`❌ ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('opgg')
  .description('op.gg 韩服榜单（参考：游戏版本与国服一致，可对比趋势/禁用率）')
  .option('-r, --region <region>', '服务器 kr/na/euw/eune/oce/jp/ru/tr/br/las/lan/sg/ph/tw/th/vn', 'kr')
  .option('-t, --tier <tier>', '段位 all/challenger/grandmaster/master/diamond/emerald/platinum/gold/silver/bronze/iron', 'all')
  .option('-n, --top <n>', '展示数量', '20')
  .option('-f, --force', '强制重新拉取（默认用 24h 内本地快照）')
  .option('--no-color', '禁用颜色')
  .action(async (opts) => {
    try {
      const [data, heroes] = await Promise.all([
        getOpggChampionRankings({ region: opts.region, tier: opts.tier }, opts.force),
        getHeroList(),
      ]);
      // 每英雄取排名最好的位置，按 rank 排序
      const best = new Map<string, OpggChampionStat>();
      for (const row of data) {
        const prev = best.get(row.key);
        if (!prev || row.rank < prev.rank) best.set(row.key, row);
      }
      const rows = [...best.values()].sort((a, b) => a.rank - b.rank).slice(0, Number(opts.top));
      const patch = rows[0]?.patch ?? '?';
      println(`🌐 op.gg ${opts.region.toUpperCase()} 英雄榜（${opts.tier} · patch ${patch} · 每英雄取最佳位置）`);
      printTable(
        [{ header: '排名', align: 'right' }, { header: '英雄' }, { header: '位置' }, { header: 'T级' }, { header: '胜率', align: 'right' }, { header: '登场率', align: 'right' }, { header: '禁用率', align: 'right' }, { header: '克制它（前3）' }],
        rows.map((r, i) => {
          const hid = matchOpggToHero(heroes, r.key);
          const cn = (name: string) => {
            const h = matchOpggToHero(heroes, name);
            return h ? heroDisplayName(heroes.get(h), h) : name;
          };
          return [
            i + 1,
            hid ? heroDisplayName(heroes.get(hid), hid) : r.name,
            normalizeOpggPosition(r.positionName),
            tierColor(`T${r.tier}`),
            pct(r.winRate),
            pct(r.pickRate),
            pct(r.banRate),
            r.counters.slice(0, 3).map(cn).join('、'),
          ];
        }),
      );
      println('   ℹ️ 参考数据：游戏版本与国服一致，但玩家行为（胜率/禁用率）有差异；快照存本地，可用 t101 sync --opgg 定期更新');
    } catch (e) {
      println(`❌ ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('cache')
  .description('缓存管理')
  .command('clear')
  .description('清空缓存与本地快照')
  .action(() => {
    cacheClear();
    snapshotClear();
    println('✅ 缓存与快照已清空');
  });

program.parse();
