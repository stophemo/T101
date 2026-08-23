// 选人阶段分析：从 LCU session 数据 -> BP 推荐
import { getChampSelectSession, getMyTierId, getSummoner, queueToMode, isRankedMode, isHextechMode, type ChampSelectSession } from '../api/lcu.js';
import { getHeroList } from '../api/cn101.js';
import { recommendPick } from './pick.js';
import { recommendBan } from './ban.js';
import { recommendHextechHeroes } from './hextech.js';
import { type PickRecommendation, type BanRecommendation, type GameMode, TIER_NAMES, type TierId } from '../models.js';
import { normalizeLane } from './pick.js';

export interface ChampSelectAnalysis {
  phase: string;
  /** 模式（ranked_solo/ranked_flex/aram/hextech_aram/normal/other） */
  mode: GameMode;
  /** 模式中文名 */
  modeLabel: string;
  queueId?: number;
  /** 自己名字 */
  me: string;
  /** 对面已选（非锁定/已锁定英雄 id 列表） */
  enemyPicks: number[];
  /** 我方已选 */
  myPicks: number[];
  /** 双方 ban（含 0=未ban） */
  myBans: number[];
  enemyBans: number[];
  /** 我方剩余位置（assignedPosition） */
  myOpenLanes: string[];
  /** 我方 assignedPosition */
  myLane: string;
  /** 自己的英雄 id（海斗：翻牌/选定后 >0，用于展示该英雄的海斗榜推荐） */
  myHeroId: number;
  picks: PickRecommendation[];
  bans: BanRecommendation[];
  /** 海克斯/大乱斗英雄推荐（仅 aram 模式） */
  aramHeroes?: Awaited<ReturnType<typeof recommendHextechHeroes>>;
  /** 海克斯大乱斗共享池：我方翻开的英雄（进池后全员可选），按胜率排序（仅 hextech_aram） */
  aramPool: AramPoolEntry[];
  /** 生效段位 id（LCU 自动获取，默认 255 全段位） */
  tier: number;
  /** 生效段位名 */
  tierName: string;
  // ---------- 阶段感知（贴合真实 BP 流程） ----------
  /** timer 阶段中文：位置规划 / 禁用选择 / 最终确认 */
  timerPhase: string;
  /** 本阶段剩余秒数 */
  timeLeftSec: number;
  /** 当前进行中的操作（null = 全部完成/等待） */
  currentAction: {
    type: 'ban' | 'pick';
    /** 操作者名字 */
    actorName: string;
    /** 是否我方 */
    isAlly: boolean;
    /** 是否是我 */
    isMe: boolean;
    /** 操作者位置（LCU 口径） */
    lane: string;
  } | null;
  /** 已完成操作数（第几手，1-10） */
  completedActions: number;
  /** 总操作数（ban 10 + pick 10） */
  totalActions: number;
  /** 我方 5 人（含自己）按楼序：名字/位置/已选英雄/是否当前操作者 */
  myTeamBoard: BoardPlayer[];
  /** 对面 5 人按楼序 */
  enemyTeamBoard: BoardPlayer[];
}

/** 选人棋盘上的一个玩家 */
export interface BoardPlayer {
  cellId: number;
  summonerName: string;
  lane: string;
  championId: number;
  /** 海克斯大乱斗：该玩家翻开的全部卡（部分客户端字段形态） */
  championIds?: number[];
  isMe: boolean;
  /** 是否当前操作者（正在 ban/pick） */
  acting: boolean;
}

/** 海克斯大乱斗共享池中的英雄（翻开的英雄，带胜率/海克斯牌，标注是否自己翻的） */
export interface AramPoolEntry {
  heroId: number;
  title: string;
  alias: string;
  /** 池内推荐序号（按综合分排序，1 起；无数据英雄排最后） */
  rank: number;
  /** 百分比胜率；榜内无数据为 null */
  winRate: number | null;
  pickRate: number | null;
  /** 综合推荐分 0-100（胜率 70% + 登场率 30%）；榜外英雄为 null */
  score: number | null;
  bestAugments: { name_cn: string; winRate: number }[];
  /** 最佳搭档（组合胜率，百分比） */
  bestPartners: { title: string; winRate: number }[];
  /** 是否自己翻开（自己的卡牌） */
  isMine: boolean;
}

/** 海斗共享池英雄综合推荐分（0-100，数据驱动）：胜率 70% + 登场率 30%；无榜数据为 null */
export function aramPoolScore(winRate: number | null, pickRate: number | null): number | null {
  if (winRate === null || pickRate === null) return null;
  const wr = Math.max(0, Math.min(100, (winRate - 45) * 8)); // 胜率 45%→0 分，50%→40，55%→80
  const pr = Math.max(0, Math.min(100, pickRate * 6));       // 登场率 8%→48 分，16%→96
  return Math.round(wr * 0.7 + pr * 0.3);
}

/** 取一名玩家翻开的英雄（兼容 LCU 字段形态：championId 单值 / championIds 数组） */
function flippedHeroIds(p: { championId: number; championIds?: number[] }): number[] {
  const ids = new Set<number>();
  for (const id of p.championIds ?? []) if (id > 0) ids.add(id);
  if (p.championId > 0) ids.add(p.championId);
  return [...ids];
}

/**
 * 构建海克斯大乱斗共享池：双方已翻开（championId>0 / championIds）的英雄去重，
 * 匹配胜率榜数据（无榜数据的补空），按胜率降序。
 * 海斗共享池为 10 人共用：我方 + 对面翻开的卡都会进池，全员可选。
 */
export function buildAramPool(
  myTeam: { cellId: number; championId: number; championIds?: number[] }[],
  theirTeam: { cellId: number; championId: number; championIds?: number[] }[],
  localPlayerCellId: number,
  heroes: ReadonlyMap<number, { heroId: number; name: string; title: string; alias: string }>,
  aramHeroes: Awaited<ReturnType<typeof recommendHextechHeroes>>,
): AramPoolEntry[] {
  const flipped = [...myTeam, ...theirTeam].flatMap(flippedHeroIds);
  const mine = new Set(flippedHeroIds(myTeam.find((p) => p.cellId === localPlayerCellId) ?? { championId: 0 }));
  const rankMap = new Map(aramHeroes.map((h) => [h.heroId, h]));
  return [...new Set(flipped)]
    .map((id) => {
      const r = rankMap.get(id);
      const h = heroes.get(id);
      const winRate = r?.winRate ?? null;
      const pickRate = r?.pickRate ?? null;
      return {
        heroId: id,
        title: h?.title ?? `#${id}`,
        alias: h?.alias ?? '',
        winRate,
        pickRate,
        score: aramPoolScore(winRate, pickRate),
        bestAugments: (r?.bestAugments ?? []).map((a) => ({ name_cn: a.name_cn, winRate: a.winRate })),
        bestPartners: (r?.bestPartners ?? []).slice(0, 3).map((p) => ({ title: p.title, winRate: p.winRate })),
        isMine: mine.has(id),
      };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1)) // 有分在前按分降序，榜外（无分）排最后
    .map((entry, i) => ({ ...entry, rank: i + 1 }));
}

const TIMER_PHASE_NAMES: Record<string, string> = {
  PLANNING: '位置规划',
  BAN_PICK: '禁用/选择',
  FINALIZATION: '最终确认',
  IDLE: '等待',
};

/** 补全 summonerName（新版 LCU session 可能不含名字） */
async function enrichNames(session: ChampSelectSession): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  const all = [...session.myTeam, ...session.theirTeam];
  const need = all.filter((p) => !p.summonerName && !p.isBot);
  const results = await Promise.allSettled(
    need.map((p) => getSummoner(p.summonerId).then((s) => [p.summonerId, s.displayName] as const)),
  );
  for (const r of results) {
    if (r.status === 'fulfilled') names.set(r.value[0], r.value[1]);
  }
  return names;
}

/** 读取当前选人 session 并给出 BP 建议（按模式门控：仅排位/大乱斗有推荐） */
export async function analyzeChampSelect(): Promise<ChampSelectAnalysis> {
  const session = await getChampSelectSession();
  const [heroes, extraNames, tierId] = await Promise.all([
    getHeroList(),
    enrichNames(session),
    getMyTierId().catch(() => null),
  ]);
  const tier = (tierId ?? 255) as TierId; // 查不到段位（未排位/客户端差异）用全段位
  const { mode, label } = queueToMode(session.queueId);

  const myPicks = session.myTeam.filter((p) => p.championId > 0).map((p) => p.championId);
  const enemyPicks = session.theirTeam.filter((p) => p.championId > 0).map((p) => p.championId);
  const myBans = session.bans.myTeamBans.filter((b) => b > 0);
  const enemyBans = session.bans.theirTeamBans.filter((b) => b > 0);

  // 对面英雄各自位置（assignedPosition -> 榜单 lane 口径）；缺失时 pick 服务按榜单登场率推断
  const enemyLanes: Record<number, string> = {};
  for (const p of session.theirTeam) {
    if (p.championId > 0 && p.assignedPosition && !['none', 'fill'].includes(p.assignedPosition)) {
      enemyLanes[p.championId] = normalizeLane(p.assignedPosition);
    }
  }

  const me = session.myTeam.find((p) => p.cellId === session.localPlayerCellId);
  const rawLane = me?.assignedPosition ?? '';
  const myLane = rawLane && !['none', 'fill'].includes(rawLane) ? normalizeLane(rawLane) : 'ALL';
  const myHeroId = me?.championId ?? 0;
  const myOpenLanes = session.myTeam
    .filter((p) => p.assignedPosition && !['none', 'utility', 'fill'].includes(p.assignedPosition))
    .map((p) => p.assignedPosition.toUpperCase());

  // ---------- 阶段感知：真实 BP 流程（ban 10 人同时 → pick 按楼序轮选） ----------
  const nameOf = (p: { cellId: number; summonerId: number; summonerName?: string } | undefined) => {
    if (!p) return '未知';
    return p.summonerName ?? extraNames.get(p.summonerId) ?? '召唤师';
  };
  // actions 数组按流程顺序排列（每个 cell 的 ban/pick 动作），第一个未完成的就是当前操作
  const completedActions = session.actions
    .flat()
    .filter((a) => a.completed).length;
  const totalActions = session.actions.flat().length;
  const pending = session.actions.flat().find((a) => !a.completed) ?? null;
  let currentAction: ChampSelectAnalysis['currentAction'] = null;
  if (pending) {
    const actor = [...session.myTeam, ...session.theirTeam].find((p) => p.cellId === pending.actorCellId);
    const isAlly = !!session.myTeam.find((p) => p.cellId === pending.actorCellId);
    currentAction = {
      type: pending.type === 'ban' ? 'ban' : 'pick',
      actorName: nameOf(actor),
      isAlly,
      isMe: pending.actorCellId === session.localPlayerCellId,
      lane: actor?.assignedPosition ?? '',
    };
  }
  const board = (team: typeof session.myTeam): BoardPlayer[] =>
    team
      .slice()
      .sort((a, b) => a.cellId - b.cellId) // 按楼序
      .map((p) => ({
        cellId: p.cellId,
        summonerName: nameOf(p),
        lane: p.assignedPosition ?? '',
        championId: p.championId,
        championIds: p.championIds,
        isMe: p.cellId === session.localPlayerCellId,
        acting: pending?.actorCellId === p.cellId,
      }));

  const [picks, bans, aramHeroes] = await Promise.all([
    // 仅峡谷排位激活 BP 推荐（按账号段位查对位/榜单）
    isRankedMode(mode) && enemyPicks.length
      ? recommendPick({ enemyHeroIds: enemyPicks, enemyLanes, excludeIds: myPicks, myLane, topN: 8, opts: { tier } })
      : Promise.resolve([]),
    isRankedMode(mode)
      ? recommendBan({ myHeroIds: myPicks, topN: 5, opts: { tier } }).catch(() => [])
      : Promise.resolve([]),
    // 仅海克斯大乱斗激活英雄/海克斯牌推荐
    isHextechMode(mode)
      ? recommendHextechHeroes(10)
      : Promise.resolve([]),
  ]);

  return {
    phase: session.timer.phase,
    mode,
    modeLabel: label,
    queueId: session.queueId,
    me: me?.summonerName ?? extraNames.get(me?.summonerId ?? -1) ?? '我',
    enemyPicks,
    myPicks,
    myBans,
    enemyBans,
    myOpenLanes,
    myLane,
    myHeroId,
    picks,
    bans,
    aramHeroes,
    aramPool: isHextechMode(mode) ? buildAramPool(session.myTeam, session.theirTeam, session.localPlayerCellId, heroes, aramHeroes) : [],
    tier,
    tierName: TIER_NAMES[tier] ?? '全段位',
    timerPhase: TIMER_PHASE_NAMES[session.timer.phase] ?? session.timer.phase,
    timeLeftSec: Math.max(0, Math.round((session.timer.adjustedTimeLeftInPhase ?? 0) / 1000)),
    currentAction,
    completedActions,
    totalActions,
    myTeamBoard: board(session.myTeam),
    enemyTeamBoard: board(session.theirTeam),
  };
}
