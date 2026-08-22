// 选人阶段分析：从 LCU session 数据 -> BP 推荐
import { getChampSelectSession, getSummoner, queueToMode, isRankedMode, isHextechMode, type ChampSelectSession } from '../api/lcu.js';
import { getHeroList } from '../api/cn101.js';
import { recommendPick } from './pick.js';
import { recommendBan } from './ban.js';
import { recommendHextechHeroes } from './hextech.js';
import { type PickRecommendation, type BanRecommendation, type GameMode } from '../models.js';

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
  picks: PickRecommendation[];
  bans: BanRecommendation[];
  /** 海克斯/大乱斗英雄推荐（仅 aram 模式） */
  aramHeroes?: Awaited<ReturnType<typeof recommendHextechHeroes>>;
}

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
  const [heroes, extraNames] = await Promise.all([getHeroList(), enrichNames(session)]);
  const { mode, label } = queueToMode(session.queueId);

  const myPicks = session.myTeam.filter((p) => p.championId > 0).map((p) => p.championId);
  const enemyPicks = session.theirTeam.filter((p) => p.championId > 0).map((p) => p.championId);
  const myBans = session.bans.myTeamBans.filter((b) => b > 0);
  const enemyBans = session.bans.theirTeamBans.filter((b) => b > 0);

  const me = session.myTeam.find((p) => p.cellId === session.localPlayerCellId);
  const rawLane = me?.assignedPosition ?? '';
  // assignedPosition 映射到榜单 lane 口径（utility -> SUPPORT，fill/none -> ALL）
  const laneMap: Record<string, string> = {
    TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MIDDLE', BOTTOM: 'BOTTOM', UTILITY: 'SUPPORT',
  };
  const myLane = laneMap[rawLane.toUpperCase()] ?? 'ALL';
  const myOpenLanes = session.myTeam
    .filter((p) => p.assignedPosition && !['none', 'utility', 'fill'].includes(p.assignedPosition))
    .map((p) => p.assignedPosition.toUpperCase());

  const [picks, bans, aramHeroes] = await Promise.all([
    // 仅峡谷排位激活 BP 推荐
    isRankedMode(mode) && enemyPicks.length
      ? recommendPick({ enemyHeroIds: enemyPicks, excludeIds: myPicks, myLane, topN: 8 })
      : Promise.resolve([]),
    isRankedMode(mode)
      ? recommendBan({ myHeroIds: myPicks, topN: 5 }).catch(() => [])
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
    picks,
    bans,
    aramHeroes,
  };
}
