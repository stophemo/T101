// 选人阶段分析（对应 src/services/champselect.ts）：从 LCU session 数据 -> BP 推荐

use crate::ban::{self, BanInput};
use crate::cn101::cn;
use crate::hextech::recommend_hextech_heroes;
use crate::lcu::{get_champ_select_session, get_my_tier_id, get_summoner};
use crate::models::*;
use crate::pick::{self, PickInput};
use serde_json::{json, Value};
use std::collections::HashMap;

/// 海斗共享池英雄综合推荐分（0-100）：胜率 70% + 登场率 30%
pub fn aram_pool_score(win_rate: Option<f64>, pick_rate: Option<f64>) -> Option<f64> {
    let wr = win_rate?;
    let pr = pick_rate?;
    let wr_s = (wr - 45.0).clamp(0.0, 100.0) * 8.0;
    let pr_s = pr.clamp(0.0, 100.0) * 6.0;
    Some(((wr_s * 0.7 + pr_s * 0.3) * 100.0).round() / 100.0)
}

fn timer_phase_name(phase: &str) -> String {
    match phase {
        "PLANNING" => "位置规划".to_string(),
        "BAN_PICK" => "禁用/选择".to_string(),
        "FINALIZATION" => "最终确认".to_string(),
        "IDLE" => "等待".to_string(),
        _ => phase.to_string(),
    }
}

/// 读取当前选人 session 并给出 BP 建议
pub async fn analyze_champ_select() -> Result<Value, String> {
    let session = get_champ_select_session().await?;
    let heroes = cn().get_hero_list(false).await?;
    let tier_id = get_my_tier_id().await;
    let tier: TierId = tier_id.unwrap_or(255);
    let queue_id = session.get("queueId").and_then(|v| v.as_i64()).unwrap_or(0);
    let (mode, label) = queue_to_mode(queue_id);

    let my_team = session.get("myTeam").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let their_team = session.get("theirTeam").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let local_cell = session.get("localPlayerCellId").and_then(|v| v.as_i64()).unwrap_or(-1);

    // 补全 summonerName（新版 LCU session 可能不含名字）
    let mut extra_names: HashMap<i64, String> = HashMap::new();
    for p in my_team.iter().chain(their_team.iter()) {
        let has_name = p.get("summonerName").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
        if has_name {
            continue;
        }
        let is_bot = p.get("isBot").and_then(|v| v.as_bool()).unwrap_or(false);
        if is_bot {
            continue;
        }
        if let Some(sid) = p.get("summonerId").and_then(|v| v.as_i64()) {
            if let Ok(s) = get_summoner(sid).await {
                let name = crate::lcu::summoner_display_name(&s);
                if !name.is_empty() {
                    extra_names.insert(sid, name);
                }
            }
        }
    }

    let cid = |p: &Value| p.get("championId").and_then(|v| v.as_i64()).unwrap_or(0);
    let my_picks: Vec<i64> = my_team.iter().filter(|p| cid(p) > 0).map(cid).collect();
    let enemy_picks: Vec<i64> = their_team.iter().filter(|p| cid(p) > 0).map(cid).collect();
    let bans = session.get("bans").cloned().unwrap_or(Value::Null);
    let my_bans: Vec<i64> = bans.get("myTeamBans").and_then(|v| v.as_array()).unwrap_or(&vec![])
        .iter().filter(|b| b.as_i64().unwrap_or(0) > 0).filter_map(|b| b.as_i64()).collect();
    let enemy_bans: Vec<i64> = bans.get("theirTeamBans").and_then(|v| v.as_array()).unwrap_or(&vec![])
        .iter().filter(|b| b.as_i64().unwrap_or(0) > 0).filter_map(|b| b.as_i64()).collect();

    // 对面英雄各自位置
    let mut enemy_lanes: HashMap<i64, String> = HashMap::new();
    for p in &their_team {
        let hero_id = cid(p);
        if hero_id <= 0 {
            continue;
        }
        let pos = p.get("assignedPosition").and_then(|v| v.as_str()).unwrap_or("");
        if !pos.is_empty() && pos != "none" && pos != "fill" {
            enemy_lanes.insert(hero_id, pick::normalize_lane(pos));
        }
    }

    let me = my_team.iter().find(|p| p.get("cellId").and_then(|v| v.as_i64()).unwrap_or(-1) == local_cell).cloned();
    let raw_lane = me.as_ref().and_then(|m| m.get("assignedPosition")).and_then(|v| v.as_str()).unwrap_or("");
    let my_lane = if raw_lane.is_empty() || raw_lane == "none" || raw_lane == "fill" {
        "ALL".to_string()
    } else {
        pick::normalize_lane(raw_lane)
    };
    let my_hero_id = me.as_ref().map(&cid).unwrap_or(0);
    let my_open_lanes: Vec<String> = my_team.iter()
        .filter(|p| {
            let pos = p.get("assignedPosition").and_then(|v| v.as_str()).unwrap_or("");
            !pos.is_empty() && pos != "none" && pos != "utility" && pos != "fill"
        })
        .map(|p| p.get("assignedPosition").and_then(|v| v.as_str()).unwrap_or("").to_uppercase())
        .collect();

    // ---------- 阶段感知 ----------
    let name_of = |p: Option<&Value>| -> String {
        match p {
            Some(p) => p.get("summonerName").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
                .map(String::from)
                .or_else(|| p.get("summonerId").and_then(|v| v.as_i64()).and_then(|id| extra_names.get(&id).cloned()))
                .unwrap_or_else(|| "召唤师".to_string()),
            None => "未知".to_string(),
        }
    };
    let actions: Vec<Value> = session.get("actions").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let flat: Vec<&Value> = actions.iter().flat_map(|a| {
        a.as_array().map(|arr| arr.iter().collect::<Vec<&Value>>()).unwrap_or_default()
    }).collect();
    let completed = flat.iter().filter(|a| a.get("completed").and_then(|v| v.as_bool()).unwrap_or(false)).count();
    let total = flat.len();
    let pending = flat.iter().find(|a| !a.get("completed").and_then(|v| v.as_bool()).unwrap_or(false)).copied();
    let mut current_action: Option<Value> = None;
    if let Some(p) = pending {
        let actor_cell = p.get("actorCellId").and_then(|v| v.as_i64()).unwrap_or(-1);
        let all: Vec<&Value> = my_team.iter().chain(their_team.iter()).collect();
        let actor = all.iter().find(|x| x.get("cellId").and_then(|v| v.as_i64()).unwrap_or(-1) == actor_cell).copied();
        let is_ally = my_team.iter().any(|x| x.get("cellId").and_then(|v| v.as_i64()).unwrap_or(-1) == actor_cell);
        let atype = p.get("type").and_then(|v| v.as_str()).unwrap_or("");
        current_action = Some(json!({
            "type": if atype == "ban" { "ban" } else { "pick" },
            "actorName": name_of(actor),
            "isAlly": is_ally,
            "isMe": actor_cell == local_cell,
            "lane": actor.and_then(|a| a.get("assignedPosition")).and_then(|v| v.as_str()).unwrap_or(""),
        }));
    }
    let board = |team: &Vec<Value>| -> Vec<Value> {
        let mut sorted: Vec<&Value> = team.iter().collect();
        sorted.sort_by(|a, b| {
            a.get("cellId").and_then(|v| v.as_i64()).unwrap_or(0)
                .cmp(&b.get("cellId").and_then(|v| v.as_i64()).unwrap_or(0))
        });
        sorted.into_iter().map(|p| {
            let cell = p.get("cellId").and_then(|v| v.as_i64()).unwrap_or(-1);
            json!({
                "cellId": cell,
                "summonerName": name_of(Some(p)),
                "lane": p.get("assignedPosition").and_then(|v| v.as_str()).unwrap_or(""),
                "championId": cid(p),
                "isMe": cell == local_cell,
                "acting": pending.map(|a| a.get("actorCellId").and_then(|v| v.as_i64()).unwrap_or(-1) == cell).unwrap_or(false),
            })
        }).collect()
    };
    let my_board = board(&my_team);
    let enemy_board = board(&their_team);

    // ---------- 推荐 ----------
    let ranked = is_ranked_mode(mode);
    let hex = is_hextech_mode(mode);
    let picks: Vec<Value> = if ranked && !enemy_picks.is_empty() {
        let input = PickInput {
            enemy_hero_names: Vec::new(),
            enemy_hero_ids: enemy_picks.clone(),
            enemy_lanes: enemy_lanes.clone(),
            my_lane: my_lane.clone(),
            exclude: Vec::new(),
            exclude_ids: my_picks.clone(),
            top_n: 8,
            tier,
        };
        pick::recommend_pick(&input).await.unwrap_or_default().into_iter().map(|r| serde_json::to_value(r).unwrap_or(Value::Null)).collect()
    } else {
        Vec::new()
    };
    let bans: Vec<Value> = if ranked {
        let input = BanInput { my_hero_names: Vec::new(), my_hero_ids: my_picks.clone(), top_n: 5, tier };
        ban::recommend_ban(&input).await.unwrap_or_default().into_iter().map(|r| serde_json::to_value(r).unwrap_or(Value::Null)).collect()
    } else {
        Vec::new()
    };
    let aram_heroes: Vec<Value> = if hex {
        recommend_hextech_heroes(10).await.unwrap_or_default().into_iter().map(|h| serde_json::to_value(h).unwrap_or(Value::Null)).collect()
    } else {
        Vec::new()
    };

    // 海斗共享池
    let aram_pool: Vec<Value> = if hex {
        let bench = session.get("benchChampions").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        build_aram_pool(&bench, &heroes, &aram_heroes)
    } else {
        Vec::new()
    };

    // 我的英雄海斗榜推荐
    let my_hero_stat: Option<Value> = if my_hero_id > 0 {
        recommend_hextech_heroes(300).await.ok()
            .and_then(|list| list.into_iter().find(|h| h.hero_id == my_hero_id))
            .map(|h| json!({
                "title": h.title,
                "alias": h.alias,
                "winRate": h.win_rate,
                "pickRate": h.pick_rate,
                "rank": h.rank,
                "bestAugments": h.best_augments.iter().take(5).map(|a| json!({ "name_cn": a.name_cn, "winRate": a.win_rate, "pickRate": a.pick_rate })).collect::<Vec<_>>(),
                "bestPartners": h.best_partners.iter().take(3).map(|p| json!({ "title": p.title, "winRate": p.win_rate })).collect::<Vec<_>>(),
            }))
    } else {
        None
    };

    let timer = session.get("timer").cloned().unwrap_or(Value::Null);
    let phase = timer.get("phase").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let time_left = timer.get("adjustedTimeLeftInPhase").and_then(|v| v.as_i64()).unwrap_or(0).max(0);

    let me_name = me.as_ref()
        .and_then(|m| m.get("summonerName").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from))
        .or_else(|| me.as_ref().and_then(|m| m.get("summonerId").and_then(|v| v.as_i64())).and_then(|id| extra_names.get(&id).cloned()))
        .unwrap_or_else(|| "我".to_string());

    Ok(json!({
        "phase": phase,
        "mode": mode.as_str(),
        "modeLabel": label,
        "queueId": queue_id,
        "me": me_name,
        "enemyPicks": enemy_picks,
        "myPicks": my_picks,
        "myBans": my_bans,
        "enemyBans": enemy_bans,
        "myOpenLanes": my_open_lanes,
        "myLane": my_lane,
        "myHeroId": my_hero_id,
        "myHeroStat": my_hero_stat,
        "picks": picks,
        "bans": bans,
        "aramHeroes": aram_heroes,
        "aramPool": aram_pool,
        "tier": tier,
        "tierName": tier_names(tier),
        "timerPhase": timer_phase_name(&phase),        "timeLeftSec": time_left,
        "currentAction": current_action,
        "completedActions": completed,
        "totalActions": total,
        "myTeamBoard": my_board,
        "enemyTeamBoard": enemy_board,
    }))
}

/// 构建海克斯大乱斗共享池（只读 LCU session.benchChampions）
pub fn build_aram_pool(
    bench_champions: &[Value],
    heroes: &HashMap<i64, ChampionBase>,
    aram_heroes: &[Value],
) -> Vec<Value> {
    let mut ids: Vec<i64> = bench_champions.iter()
        .filter_map(|b| b.get("championId").and_then(|v| v.as_i64()))
        .filter(|id| *id > 0)
        .collect::<std::collections::HashSet<_>>()
        .into_iter().collect();
    ids.sort_unstable();
    let rank_map: HashMap<i64, &Value> = aram_heroes.iter()
        .filter_map(|h| h.get("heroId").and_then(|v| v.as_i64()).map(|id| (id, h)))
        .collect();
    let mut entries: Vec<Value> = ids.into_iter().map(|id| {
        let r = rank_map.get(&id).copied();
        let h = heroes.get(&id);
        let win_rate = r.and_then(|r| r.get("winRate").and_then(|v| v.as_f64()));
        let pick_rate = r.and_then(|r| r.get("pickRate").and_then(|v| v.as_f64()));
        let best_augments: Vec<Value> = r.and_then(|r| r.get("bestAugments").and_then(|v| v.as_array())).unwrap_or(&vec![])
            .iter().map(|a| json!({ "name_cn": a.get("name_cn").and_then(|v| v.as_str()).unwrap_or(""), "winRate": a.get("winRate").and_then(|v| v.as_f64()).unwrap_or(0.0) })).collect();
        let best_partners: Vec<Value> = r.and_then(|r| r.get("bestPartners").and_then(|v| v.as_array())).unwrap_or(&vec![])
            .iter().take(3).map(|p| json!({ "title": p.get("title").and_then(|v| v.as_str()).unwrap_or(""), "winRate": p.get("winRate").and_then(|v| v.as_f64()).unwrap_or(0.0) })).collect();
        json!({
            "heroId": id,
            "title": h.map(|x| x.title.clone()).unwrap_or_else(|| format!("#{id}")),
            "alias": h.map(|x| x.alias.clone()).unwrap_or_default(),
            "winRate": win_rate,
            "pickRate": pick_rate,
            "score": aram_pool_score(win_rate, pick_rate),
            "bestAugments": best_augments,
            "bestPartners": best_partners,
        })
    }).collect();
    entries.sort_by(|a, b| {
        let sa = a.get("score").and_then(|v| v.as_f64()).unwrap_or(-1.0);
        let sb = b.get("score").and_then(|v| v.as_f64()).unwrap_or(-1.0);
        sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
    });
    for (i, e) in entries.iter_mut().enumerate() {
        e["rank"] = json!(i + 1);
    }
    entries
}
