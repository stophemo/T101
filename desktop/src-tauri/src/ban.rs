// Ban 建议（对应 src/services/ban.ts）：
// 场景 A（无我方阵容）：版本梯度榜 T0/T1 优先，组内按禁用率+胜率排序
// 场景 B（有我方阵容）：对位威胁分析（confront low_op = 被谁克制），按（威胁数、对位胜率、禁用率）综合排序

use crate::cn101::cn;
use crate::models::*;
use std::collections::{HashMap, HashSet};

pub struct BanInput {
    pub my_hero_names: Vec<String>,
    pub my_hero_ids: Vec<i64>,
    pub top_n: i64,
    pub tier: TierId,
}

pub async fn recommend_ban(input: &BanInput) -> Result<Vec<BanRecommendation>, String> {
    let top_n = input.top_n;
    let (heroes, rankings) = tokio::join!(
        cn().get_hero_list(false),
        cn().get_champion_rankings(input.tier, "ALL", None, false),
    );
    let heroes = heroes?;
    let rankings = rankings?;

    let my_ids: Option<HashSet<i64>> = if !input.my_hero_ids.is_empty() {
        Some(input.my_hero_ids.iter().copied().collect())
    } else if !input.my_hero_names.is_empty() {
        let resolved = cn().resolve_heroes(&input.my_hero_names).await?;
        Some(resolved.into_iter().map(|(id, _)| id).collect())
    } else {
        None
    };

    // 场景 B：对每个我方英雄查对位（被谁克制 = 威胁）
    let mut my_threats: Vec<(i64, i64, f64)> = Vec::new(); // (myId, threatHeroId, winRate)
    if let Some(ids) = &my_ids {
        if !ids.is_empty() {
            for my_id in ids {
                let lane = infer_lane_for(&rankings, *my_id);
                if let Ok(confront) = cn().get_confront(*my_id, input.tier, &lane, None, false).await {
                    for h in confront.low {
                        my_threats.push((*my_id, h.hero_id, h.win_rate));
                    }
                }
            }
        }
    }

    Ok(compute_ban_recommendations(&heroes, &rankings, my_ids, &my_threats, top_n))
}

fn infer_lane_for(rankings: &[ChampionStat], hero_id: i64) -> String {
    crate::pick::infer_lane(rankings, hero_id)
}

/// 纯计算：不依赖网络
pub fn compute_ban_recommendations(
    heroes: &HashMap<i64, ChampionBase>,
    rankings: &[ChampionStat],
    my_ids: Option<HashSet<i64>>,
    my_threats: &[(i64, i64, f64)],
    top_n: i64,
) -> Vec<BanRecommendation> {
    let tier_order = |t: &str| match t {
        "T0" => 0, "T1" => 1, "T2" => 2, "T3" => 3, _ => 4,
    };

    let mut my_ids = my_ids;
    // 有阵容但无威胁数据：降级为版本梯度榜
    if let Some(ids) = &my_ids {
        if !ids.is_empty() && my_threats.is_empty() {
            my_ids = None;
        }
    }

    // 场景 A：版本梯度榜
    if my_ids.is_none() || my_ids.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
        let mut best: HashMap<i64, BanRecommendation> = HashMap::new();
        for r in rankings {
            let tier = tier_order(&r.tier);
            let rec = BanRecommendation {
                hero_id: r.hero_id,
                title: hero_display_name(heroes.get(&r.hero_id), r.hero_id),
                alias: heroes.get(&r.hero_id).map(|h| h.alias.clone()).unwrap_or_default(),
                win_rate: r.win_rate,
                pick_rate: r.pick_rate,
                ban_rate: r.ban_rate,
                tier: r.tier.clone(),
                lane: r.lane.clone(),
                threatens_count: 0,
                threatens: Vec::new(),
                matchups: Vec::new(),
                score: -tier as f64 * 1000.0 + r.ban_rate + r.win_rate * 0.5 + r.pick_rate * 0.2,
            };
            let prev = best.get(&r.hero_id);
            if prev.is_none() || rec.score > prev.unwrap().score {
                best.insert(r.hero_id, rec);
            }
        }
        let mut list: Vec<BanRecommendation> = best.into_values().collect();
        list.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        list.truncate(top_n.max(0) as usize);
        return list;
    }

    // 场景 B：威胁并集
    let ids = my_ids.as_ref().unwrap();
    let mut candidates: HashMap<i64, Vec<(i64, f64)>> = HashMap::new();
    for (my_id, hero_id, win_rate) in my_threats {
        if ids.contains(hero_id) {
            continue; // 自己人不用 ban
        }
        candidates.entry(*hero_id).or_default().push((*my_id, *win_rate));
    }
    let by_id: HashMap<i64, &ChampionStat> = rankings.iter().map(|r| (r.hero_id, r)).collect();
    let my_title = |id: i64| hero_display_name(heroes.get(&id), id);

    let mut recs: Vec<BanRecommendation> = Vec::new();
    for (hero_id, threats) in &candidates {
        let Some(stat) = by_id.get(hero_id) else { continue };
        let avg = threats.iter().map(|t| t.1).sum::<f64>() / threats.len() as f64;
        let score = threats.len() as f64 * 10.0 + (avg - 50.0) * 0.8 + stat.ban_rate * 0.3 + stat.win_rate * 0.2;
        recs.push(BanRecommendation {
            hero_id: *hero_id,
            title: hero_display_name(heroes.get(hero_id), *hero_id),
            alias: heroes.get(hero_id).map(|h| h.alias.clone()).unwrap_or_default(),
            win_rate: stat.win_rate,
            pick_rate: stat.pick_rate,
            ban_rate: stat.ban_rate,
            tier: stat.tier.clone(),
            lane: stat.lane.clone(),
            threatens_count: threats.len() as i64,
            threatens: threats.iter().map(|t| my_title(t.0)).collect(),
            matchups: threats.iter().map(|t| BanMatchupRow {
                my_title: my_title(t.0),
                win_rate: t.1,
            }).collect(),
            score,
        });
    }
    recs.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    recs.truncate(top_n.max(0) as usize);
    recs
}
