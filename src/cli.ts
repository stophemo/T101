#!/usr/bin/env node
// lola — 英雄联盟国服 BP 助手
import { execSync } from 'node:child_process';
import { startWebServer } from './web/server.js';

// Windows 下把控制台切到 UTF-8，避免中文乱码
if (process.platform === 'win32') {
  try { execSync('chcp 65001 > NUL', { stdio: 'ignore' }); } catch { /* ignore */ }
}

import { Command, InvalidArgumentError } from 'commander';
import { getChampionRankings, getHeroList, getVersions, resolveHeroes, getConfront, type TierId } from './api/cn101.js';
import { findLcuConnection, getGameflowPhase, getGameflowSession, getRankedStats, KNOWN_QUEUE_IDS } from './api/lcu.js';
import { analyzeChampSelect } from './services/champselect.js';
import { heroDisplayName } from './models.js';
import { recommendPick } from './services/pick.js';
import { recommendBan } from './services/ban.js';
import { printTable, println, pct, tierColor, rankChange } from './utils/table.js';
import { cacheClear } from './utils/cache.js';

const program = new Command();

function parseTier(v: string): TierId {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 255) throw new InvalidArgumentError('段位 id 需为 1~255（255=全段位）');
  return n as TierId;
}

program
  .name('lola')
  .description('英雄联盟国服 BP 助手（数据源：101.qq.com 官方 + OP.GG 参考）')
  .version('0.1.0');

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
      println(`🎯 推荐 Pick（克制 ${enemy} 的英雄，按综合分排序）`);
      printTable(
        [{ header: '#', align: 'right' }, { header: '英雄' }, { header: '位置' }, { header: '强度' }, { header: '胜率', align: 'right' }, { header: '克制对象' }],
        recs.map((r, i) => [
          i + 1, r.title, r.lane, tierColor(r.tier), pct(r.winRate),
          r.counters.join('、') + `（${r.counterCount}个）`,
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
      println(withMyTeam ? '🛡️ 推荐 Ban（克制我方阵容最多的英雄）' : '🛡️ 推荐 Ban（版本强势/高禁用英雄）');
      printTable(
        [
          { header: '#', align: 'right' }, { header: '英雄' }, { header: '强度' },
          { header: '胜率', align: 'right' }, { header: '登场', align: 'right' }, { header: '禁用', align: 'right' },
          ...(withMyTeam ? [{ header: '威胁我方' }] : []),
        ],
        recs.map((r, i) => [
          i + 1, r.title, tierColor(r.tier), pct(r.winRate), pct(r.pickRate), pct(r.banRate),
          ...(withMyTeam ? [r.threatens.join('、') + `（${r.threatensCount}个）`] : []),
        ]),
      );
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
  .option('-l, --lane <lane>', '位置', 'ALL')
  .option('-t, --tier <id>', '段位过滤', parseTier, 255)
  .option('--no-color', '禁用颜色')
  .action(async (hero: string, opts) => {
    try {
      const [{ heroId }, heroes] = await Promise.all([
        (await resolveHeroes([hero]))[0],
        getHeroList(),
      ]);
      const stats = await getConfront(heroId, { tier: opts.tier, lane: opts.lane.toUpperCase() });
      const title = heroDisplayName(heroes.get(heroId), heroId);
      println(`⚔️ ${title} 的对位克制（${opts.lane.toUpperCase()}）`);
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
      println('   提示：国服客户端也可用；如检测不到可设置环境变量 LOLA_LOCKFILE 指向 lockfile 路径');
      process.exitCode = 1;
      return;
    }
    println(`✅ 已连接客户端（端口 ${conn.port}）`);
    try {
      const phase = await getGameflowPhase();
      println(`当前阶段: ${phase}`);
      if (phase === 'ChampSelect') println('  → 可以用 lola champselect 查看 BP 推荐');
      if (phase === 'GameStart' || phase === 'InProgress') println('  → 可以用 lola loading 查看 10 人信息');
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
        println(`⏱️  选人阶段: ${a.phase} · 模式: ${a.modeLabel} · 我方位置: ${a.myLane === 'ALL' ? '未分配' : a.myLane}`);
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
          println('\n🃏 海克斯大乱斗：无 Ban 阶段，参考英雄胜率与推荐海克斯牌');
          printTable(
            [{ header: '#', align: 'right' }, { header: '英雄' }, { header: '胜率', align: 'right' }, { header: '登场率', align: 'right' }, { header: '推荐海克斯牌' }],
            (a.aramHeroes ?? []).map((h, i) => [i + 1, h.title, pct(h.winRate), pct(h.pickRate), h.bestAugments.slice(0, 2).map((x) => x.name_cn).join('、')]),
          );
          return;
        }

        if (a.enemyPicks.length) {
          println(`\n👹 对面已选: ${a.enemyPicks.map((id) => heroDisplayName(heroes.get(id), id)).join('、')}`);
          println(`🎯 推荐 Pick（克制对面，按综合分排序）`);
          printTable(
            [{ header: '#', align: 'right' }, { header: '英雄' }, { header: '位置' }, { header: '强度' }, { header: '胜率', align: 'right' }, { header: '克制对象' }],
            a.picks.map((r, i) => [i + 1, r.title, r.lane, tierColor(r.tier), pct(r.winRate), r.counters.join('、')]),
          );
        } else {
          println('\n👹 对面还没选英雄');
        }

        if (a.myPicks.length) {
          println(`\n🛡️ 推荐 Ban（克制我方 ${a.myPicks.map((id) => heroDisplayName(heroes.get(id), id)).join('、')}）`);
          printTable(
            [{ header: '#', align: 'right' }, { header: '英雄' }, { header: '胜率', align: 'right' }, { header: '禁用率', align: 'right' }, { header: '威胁我方' }],
            a.bans.map((r, i) => [i + 1, r.title, pct(r.winRate), pct(r.banRate), r.threatens.join('、')]),
          );
        } else {
          println('\n🛡️ 我方还没选英雄（选完英雄后自动给出 Ban 建议）');
        }
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('不存在')) {
          println('❌ 当前不在选人阶段。请先进入对局选人界面（训练模式/匹配/排位均可）。');
          println('   提示：选人阶段用 lola champselect，加载画面用 lola loading');
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
      const players = session.gameData.players;
      if (!players.length) {
        println('当前对局没有玩家数据（确认已进入加载画面）');
        return;
      }
      println(`🎮 ${session.gameData.gameMode} · 地图 ${session.gameData.mapId} · 共 ${players.length} 人`);

      // 并发查段位（失败不阻塞）
      const ranked = new Map<number, string>();
      const results = await Promise.allSettled(players.filter((p) => !p.isBot).map((p) => getRankedStats(p.summonerId)));
      players.filter((p) => !p.isBot).forEach((p, i) => {
        const r = results[i];
        if (r.status === 'fulfilled' && r.value && r.value.length) {
          const solo = r.value.find((q) => q.queue.includes('RANKED_SOLO')) ?? r.value[0];
          ranked.set(p.summonerId, `${solo.tier} ${solo.division} ${solo.lp}LP`);
        }
      });

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
        println('   提示：选人阶段用 lola champselect，加载画面用 lola loading');
      } else {
        println(`❌ ${msg}`);
      }
      process.exitCode = 1;
    }
  });

program
  .command('web')
  .description('启动 Web 界面（浏览器打开，含 BP 助手/榜单/加载画面等全部功能）')
  .option('-p, --port <port>', '端口', '8765')
  .option('--no-open', '不自动打开浏览器')
  .action(async (opts) => {
    const port = Number(opts.port);
    // startWebServer 内部绑定 127.0.0.1（仅本机可访问）并在就绪时回调
    startWebServer(port, (url) => {
      println(`🌐 LOLA Web 界面已启动: ${url}`);
      println('   Ctrl+C 停止服务');
      if (opts.open) {
        try { execSync(`start ${url}`, { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
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
  .command('cache')
  .description('缓存管理')
  .command('clear')
  .description('清空缓存')
  .action(() => {
    cacheClear();
    println('✅ 缓存已清空');
  });

program.parse();
