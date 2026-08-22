// 海克斯大乱斗实测监控：轮询 LCU，记录阶段变化/queueId/选人进度/10人信息
// 运行: node monitor.mjs（后台启动，日志写入 monitor.log，可随时 kill）
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const LOG = 'monitor.log';
const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
}

function parseLockfile(p) {
  const parts = readFileSync(p, 'utf-8').trim().split(':');
  if (parts.length < 5) throw new Error('lockfile 格式异常');
  return { port: Number(parts[2]), password: parts[3], protocol: parts[4] };
}

function findConn() {
  const env = process.env.T101_LOCKFILE;
  if (env && existsSync(env)) { try { return parseLockfile(env); } catch { /* ignore */ } }
  const dirs = [];
  for (const d of ['C:', 'D:', 'E:', 'F:']) {
    dirs.push(`${d}\\Riot Games\\League of Legends`, `${d}\\Riot Games\\LeagueClient`, `${d}\\腾讯游戏\\英雄联盟`, `${d}\\英雄联盟`);
  }
  for (const dir of dirs) {
    const lf = join(dir, 'lockfile');
    if (existsSync(lf)) { try { return parseLockfile(lf); } catch { /* ignore */ } }
  }
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

async function lcuGet(conn, path) {
  const res = await fetch(`${conn.protocol}://127.0.0.1:${conn.port}${path}`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`riot:${conn.password}`).toString('base64') },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 英雄名映射（game.gtimg.cn 官方英雄表）
let heroNames = {};
try {
  const res = await fetch('https://game.gtimg.cn/images/lol/act/img/js/heroList/hero_list.js', {
    signal: AbortSignal.timeout(10000),
  });
  const txt = await res.text();
  const m = txt.match(/\{[\s\S]*\}/);
  if (m) {
    const list = JSON.parse(m[0]).hero || [];
    for (const h of list) heroNames[h.heroId] = h.name;
  }
} catch { /* 英雄名映射失败则显示 id */ }
const hname = (id) => heroNames[id] || `#${id}`;

let lastPhase = null;
let lastBanCount = -1;
let lastPickCount = -1;
let lastActor = '';
let lastDumpTs = 0;
let probedAugEndpoints = false;

log('👀 监控启动：等待客户端…');

setInterval(async () => {
  const conn = findConn();
  if (!conn) {
    if (lastPhase !== 'NO_CLIENT') { log('⏳ 客户端未运行，等待启动…'); lastPhase = 'NO_CLIENT'; }
    return;
  }
  try {
    const phase = await lcuGet(conn, '/lol-gameflow/v1/gameflow-phase');
    if (phase !== lastPhase) {
      log(`🔄 阶段: ${lastPhase ?? '?'} → ${phase}`);
      if (phase === 'Lobby') { const l = await lcuGet(conn, '/lol-lobby/v2/lobby').catch(() => null); if (l?.gameConfig) log(`   房间: queueId=${l.gameConfig.queueId} 成员=${(l.members || []).map(m => m.summonerName).join(',')}`); }
      if (phase === 'Matchmaking') { const g = await lcuGet(conn, '/lol-lobby/v2/lobby').catch(() => null); if (g?.gameConfig) log(`   排队中: queueId=${g.gameConfig.queueId}`); }
      if (phase === 'ReadyCheck') log('   ✅ 对局接受弹窗出现（等 10 人确认）');
      if (phase === 'ChampSelect') {
        const s = await lcuGet(conn, '/lol-champ-select/v1/session');
        log(`   ⚔️ 进入选人: queueId=${s.queueId} 我方=[${s.myTeam.map(m => m.summonerName).join(', ')}] 对面=[${s.theirTeam.map(m => m.summonerName).join(', ')}]`);
        lastBanCount = -1; lastPickCount = -1; lastActor = '';
      }
      if (phase === 'GameStart') {
        const g = await lcuGet(conn, '/lol-gameflow/v1/session').catch(() => null);
        const players = g?.gameData?.players || [];
        log(`   🎬 加载画面: queueId=${g?.queue?.id} gameId=${g?.gameData?.gameId} 地图=${g?.map?.name || '?'} 玩家=${players.length}`);
        if (players.length) {
          for (const p of players) log(`      ${p.teamId === 100 ? '🔵' : '🔴'} ${p.summonerName} (${p.championId ? hname(p.championId) : '?'}) Lv.${p.level || '?'} ${p.teamId === 100 ? '蓝方' : '红方'}`);
        }
      }
      if (phase === 'InProgress') {
        const g = await lcuGet(conn, '/lol-gameflow/v1/session').catch(() => null);
        log(`   🎮 游戏进行中: queueId=${g?.queue?.id} gameId=${g?.gameData?.gameId}`);
      }
      if (phase === 'EndOfGame') log('   🏁 对局结束（继续监控下一把…）');
      lastPhase = phase;
    } else if (phase === 'InProgress') {
      // 游戏内：探测海克斯选项数据源（每 20s 节流），3/7/11/14 级选择窗口期重点观察
      const now = Date.now();
      if (!lastDumpTs || now - lastDumpTs > 20000) {
        lastDumpTs = now;
        const g = await lcuGet(conn, '/lol-gameflow/v1/session').catch(() => null);
        const players = g?.gameData?.players || [];
        if (players.length) {
          const p0 = players[0];
          const aug = Object.keys(p0).filter((k) => /augment|perk|rune/i.test(k));
          const levels = players.map((p) => `${p.summonerName?.slice(0, 6) || '?'}:${p.level || '?'}`).join(' ');
          const anyAug = players.some((p) => p.augmentSelections || p.augments || p.augmentIds);
          log(`   [游戏内] 等级: ${levels}`);
          if (aug.length || anyAug) log(`   ⚡ 玩家字段含海克斯: ${aug.join(',')} ${anyAug ? '(有数据!)' : ''} ${JSON.stringify(players[0]).slice(0, 400)}`);
        }
        // 候选端点探测（只测一次）
        if (!probedAugEndpoints) {
          probedAugEndpoints = true;
          for (const ep of ['/lol-augments/v1/augments', '/lol-augments/v1/current-augments', '/lol-gameflow/v1/augments', '/lol-gameflow/v1/active-boosts']) {
            try {
              const d = await lcuGet(conn, ep);
              log(`   ✅ 端点 ${ep} 可用: ${JSON.stringify(d).slice(0, 400)}`);
            } catch { log(`   ❌ 端点 ${ep} 不可用`); }
          }
        }
      }
    } else if (phase === 'ChampSelect') {
      // 选人进度：ban/pick 完成数 + 当前操作者
      const s = await lcuGet(conn, '/lol-champ-select/v1/session').catch(() => null);
      if (s?.actions) {
        const flat = s.actions.flat();
        const banCount = flat.filter(a => a.type === 'ban' && a.completed).length;
        const pickCount = flat.filter(a => a.type === 'pick' && a.completed).length;
        if (banCount !== lastBanCount) { log(`   🚫 ban 进度: ${banCount}/${flat.filter(a => a.type === 'ban').length}（我方 ${s.myTeam.map(m => m.championId > 0 ? hname(m.championId) : '?').join(',')}）`); lastBanCount = banCount; }
        if (pickCount !== lastPickCount) { log(`   🎯 pick 进度: ${pickCount}/${flat.filter(a => a.type === 'pick').length}`); lastPickCount = pickCount; }
        const cur = flat.find(a => !a.completed);
        if (cur) {
          const cell = s.myTeam.concat(s.theirTeam).find(m => m.cellId === cur.actorCellId);
          const who = cell ? (s.myTeam.includes(cell) ? '我方' : '对面') + ' ' + cell.summonerName : `cell#${cur.actorCellId}`;
          const desc = `${who} 正在${cur.type === 'ban' ? '禁用' : '选择'}`;
          if (desc !== lastActor) { log(`   👉 ${desc}`); lastActor = desc; }
        }
      }
    }
  } catch { /* 客户端重启瞬间忽略 */ }
}, 3000);

// 防止进程静默退出
process.on('uncaughtException', (e) => log('监控异常: ' + e.message));
