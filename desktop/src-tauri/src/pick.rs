// Pick 推荐（对应 src/services/pick.ts）：对位驱动
// 对每个对面英雄查官方对位接口 high_op（该英雄的劣势对线），候选 = 所有克制者的并集，
// 按（克制数、平均对位胜率、段位榜单胜率/T级）综合排序。

use crate::cn101::cn;
use crate::models::*;
use std::collections::{HashMap, HashSet};

pub struct PickInput {
    pub enemy_hero_names: Vec<String>,
    pub enemy_hero_ids: Vec<i64>,
    pub enemy_lanes: HashMap<i64, String>,
    pub my_lane: String,
    pub exclude: Vec<String>,
    pub exclude_ids: Vec<i64>,
    pub top_n: i64,
    pub tier: TierId,
}

/// 位置名归一化（LCU 的 UTILITY/BOTTOM -> SUPPORT/BOTTOM；中文/小写兼容）
pub fn normalize_lane(lane: &str) -> String {
    let map = [
        ("TOP", "TOP"), ("top", "TOP"), ("上单", "TOP"), ("上路", "TOP"),
        ("JUNGLE", "JUNGLE"), ("jungle", "JUNGLE"), ("打野", "JUNGLE"),
        ("MIDDLE", "MIDDLE"), ("MID", "MIDDLE"), ("middle", "MIDDLE"), ("mid", "MIDDLE"), ("中单", "MIDDLE"), ("中路", "MIDDLE"),
        ("BOTTOM", "BOTTOM"), ("BOT", "BOTTOM"), ("bottom", "BOTTOM"), ("ADC", "BOTTOM"), ("adc", "BOTTOM"), ("下路", "BOTTOM"),
        ("SUPPORT", "SUPPORT"), ("SUP", "SUPPORT"), ("support", "SUPPORT"), ("UTILITY", "SUPPORT"), ("辅助", "SUPPORT"),
    ];
    let up = lane.to_uppercase();
    for (k, v) in map {
        if up == k || lane == k {
            return v.to_string();
        }
    }
    "ALL".to_string()
}

/// 榜单位置推断：该英雄登场率最高的位置
pub fn infer_lane(rankings: &[ChampionStat], hero_id: i64) -> String {
    let rows: Vec<&ChampionStat> = rankings.iter().filter(|r| r.hero_id == hero_id).collect();
    if rows.is_empty() {
        return "MIDDLE".to_string();
    }
    rows.iter().max_by(|a, b| a.pick_rate.partial_cmp(&b.pick_rate).unwrap_or(std::cmp::Ordering::Equal))
        .map(|r| r.lane.clone())
        .unwrap_or_else(|| "MIDDLE".to_string())
}

pub async fn recommend_pick(input: &PickInput) -> Result<Vec<PickRecommendation>, String> {
    let top_n = input.top_n;
    let enemy_ids: Vec<i64> = if !input.enemy_hero_ids.is_empty() {
        input.enemy_hero_ids.clone()
    } else {
        let resolved = cn().resolve_heroes(&input.enemy_hero_names).await?;
        resolved.into_iter().map(|(id, _)| id).collect()
    };
    let mut excluded: HashSet<i64> = HashSet::new();
    excluded.extend(enemy_ids.iter().copied());
    excluded.extend(input.exclude_ids.iter().copied());
    if !input.exclude.is_empty() {
        let resolved = cn().resolve_heroes(&input.exclude).await?;
        excluded.extend(resolved.into_iter().map(|(id, _)| id));
    }
    let (heroes, rankings) = tokio::join!(
        cn().get_hero_list(false),
        cn().get_champion_rankings(input.tier, "ALL", None, false),
    );
    let heroes = heroes?;
    let rankings = rankings?;

    // 每个对面英雄的位置：LCU 给了直接用；否则按榜单登场率最高的位置
    let enemy_lanes: HashMap<i64, String> = enemy_ids
        .iter()
        .map(|id| {
            let lane = input.enemy_lanes.get(id)
                .map(|l| normalize_lane(l))
                .unwrap_or_else(|| infer_lane(&rankings, *id));
            (*id, lane)
        })
        .collect();

    // 并行查对位（单个失败不阻塞整体，跳过该英雄）
    let mut enemy_matchups: Vec<(i64, i64, f64)> = Vec::new(); // (enemyId, candidateId, winRate)
    for enemy_id in &enemy_ids {
        let lane = enemy_lanes.get(enemy_id).cloned().unwrap_or_else(|| "MIDDLE".to_string());
        if let Ok(confront) = cn().get_confront(*enemy_id, input.tier, &lane, None, false).await {
            for h in confront.high {
                enemy_matchups.push((*enemy_id, h.hero_id, h.win_rate));
            }
        }
    }

    Ok(compute_pick_recommendations(&heroes, &rankings, &enemy_matchups, &excluded, &input.my_lane, top_n))
}

/// 纯计算：不依赖网络
pub fn compute_pick_recommendations(
    heroes: &HashMap<i64, ChampionBase>,
    rankings: &[ChampionStat],
    enemy_matchups: &[(i64, i64, f64)],
    excluded: &HashSet<i64>,
    my_lane: &str,
    top_n: i64,
) -> Vec<PickRecommendation> {
    let mut candidates: HashMap<i64, Vec<(i64, f64)>> = HashMap::new();
    for (enemy_id, hero_id, win_rate) in enemy_matchups {
        candidates.entry(*hero_id).or_default().push((*enemy_id, *win_rate));
    }
    build_pick_recs(heroes, rankings, &candidates, excluded, my_lane, top_n)
}

pub fn build_pick_recs(
    heroes: &HashMap<i64, ChampionBase>,
    rankings: &[ChampionStat],
    candidates: &HashMap<i64, Vec<(i64, f64)>>,
    excluded: &HashSet<i64>,
    my_lane: &str,
    top_n: i64,
) -> Vec<PickRecommendation> {
    let enemy_name = |id: i64| hero_display_name(heroes.get(&id), id);

    let mut recs: Vec<PickRecommendation> = Vec::new();
    for (hero_id, matchups) in candidates {
        if excluded.contains(hero_id) {
            continue;
        }
        let rows: Vec<&ChampionStat> = rankings.iter().filter(|r| r.hero_id == *hero_id).collect();
        if rows.is_empty() {
            continue;
        }
        if my_lane != "ALL" && !my_lane.is_empty() && !rows.iter().any(|r| r.lane == my_lane) {
            continue;
        }
        let main = rows.iter().max_by(|a, b| a.pick_rate.partial_cmp(&b.pick_rate).unwrap_or(std::cmp::Ordering::Equal)).unwrap();
        let lane_row = if my_lane != "ALL" && !my_lane.is_empty() {
            rows.iter().find(|r| r.lane == my_lane)
        } else {
            None
        };
        let row = lane_row.unwrap_or(main);
        let avg = matchups.iter().map(|m| m.1).sum::<f64>() / matchups.len() as f64;
        let score = matchups.len() as f64 * 10.0 + (avg - 50.0) * 0.8 + row.win_rate * 0.2;
        recs.push(PickRecommendation {
            hero_id: *hero_id,
            title: hero_display_name(heroes.get(hero_id), *hero_id),
            alias: heroes.get(hero_id).map(|h| h.alias.clone()).unwrap_or_default(),
            win_rate: row.win_rate,
            tier: row.tier.clone(),
            lane: row.lane.clone(),
            counters: matchups.iter().map(|m| enemy_name(m.0)).collect(),
            counter_count: matchups.len() as i64,
            matchups: matchups.iter().map(|m| MatchupRow {
                enemy_title: enemy_name(m.0),
                win_rate: m.1,
            }).collect(),
            score,
        });
    }
    recs.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    recs.truncate(top_n.max(0) as usize);
    recs
}
