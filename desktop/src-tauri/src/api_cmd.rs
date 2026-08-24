// Tauri 命令分发：面板前端 invoke('api', { route, params }) -> 数据（对应 src/web/server.ts 的 handleApi）
// 前端参数均为字符串，与 URLSearchParams 语义一致

use crate::augments;
use crate::ban::{self, BanInput};
use crate::champselect;
use crate::cn101::cn;
use crate::hextech;
use crate::lcu;
use crate::models::*;
use crate::pick::{self, PickInput};
use crate::player;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

type Params = HashMap<String, String>;

fn p<'a>(params: &'a Params, k: &str) -> Option<&'a str> {
    params.get(k).map(|s| s.as_str()).filter(|s| !s.is_empty())
}

fn tier_of(params: &Params) -> TierId {
    let n = p(params, "tier").and_then(|s| s.parse::<i64>().ok()).unwrap_or(255);
    if (1..=255).contains(&n) { n } else { 255 }
}

fn lane_of(params: &Params, default: &str) -> String {
    p(params, "lane").unwrap_or(default).to_uppercase()
}

fn num(params: &Params, k: &str, default: i64) -> i64 {
    p(params, k).and_then(|s| s.parse::<i64>().ok()).unwrap_or(default)
}

/// 附加英雄 alias（前端拼头像 URL）
async fn with_alias(items: Vec<Value>) -> Result<Vec<Value>, String> {
    let heroes = cn().get_hero_list(false).await?;
    Ok(items.into_iter().map(|mut it| {
        let id = it.get("heroId").and_then(|v| v.as_i64()).unwrap_or(0);
        let alias = heroes.get(&id).map(|h| h.alias.clone()).unwrap_or_default();
        it["alias"] = json!(alias);
        it
    }).collect())
}

/// 召唤师信息缓存（国服 lobby members 无昵称字段，需补查；60s TTL）
static SUMMONER_CACHE: OnceLock<Mutex<HashMap<i64, (String, Option<i64>, Option<i64>, Instant)>>> = OnceLock::new();

async fn get_cached_summoner_info(summoner_id: i64) -> (String, Option<i64>, Option<i64>) {
    let cell = SUMMONER_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cell.lock() {
        if let Some((name, icon, level, ts)) = guard.get(&summoner_id) {
            if ts.elapsed().as_millis() < 60_000 {
                return (name.clone(), *icon, *level);
            }
        }
    }
    let fallback = (format!("召唤师{summoner_id}"), None, None);
    let info = match lcu::get_summoner(summoner_id).await {
        Ok(s) => {
            let name = lcu::summoner_display_name(&s);
            (
                if name.is_empty() { fallback.0.clone() } else { name },
                s.get("profileIconId").and_then(|v| v.as_i64()),
                s.get("summonerLevel").and_then(|v| v.as_i64()),
            )
        }
        Err(_) => fallback,
    };
    if let Ok(mut g) = cell.lock() {
        g.insert(summoner_id, (info.0.clone(), info.1, info.2, Instant::now()));
    }
    info
}

/// 好友状态：LCU 中好友游戏中 availability 自动为 dnd，以 lol.gameStatus 为准
fn friend_status(f: &Value) -> (String, String) {
    let gs = f.get("lol").and_then(|l| l.get("gameStatus")).and_then(|v| v.as_str()).unwrap_or("");
    let gm = f.get("lol").and_then(|l| l.get("gameMode")).and_then(|v| v.as_str()).unwrap_or("");
    let qt = f.get("lol").and_then(|l| l.get("gameQueueType")).and_then(|v| v.as_str()).unwrap_or("");
    let mode_label = || -> &'static str {
        if gm == "KIWI" { "海克斯大乱斗" }
        else if gm == "ARAM" || gm == "ARAM_GAME" { "大乱斗" }
        else if qt == "RANKED_SOLO_5x5" { "排位单双" }
        else if qt == "RANKED_FLEX_SR" { "排位灵活" }
        else if qt == "NORMAL" { "匹配" }
        else { "未知" }
    };
    match gs {
        "inGame" => ("in_game".into(), mode_label().to_string()),
        "inQueue" => ("in_queue".into(), mode_label().to_string()),
        "inChampSelect" => ("in_queue".into(), "选人中".into()),
        "inLobby" => ("in_queue".into(), "房间中".into()),
        _ => (f.get("availability").and_then(|v| v.as_str()).unwrap_or("unknown").to_string(), String::new()),
    }
}

/// 逐场明细 enrich：英雄名/别名/模式名 + 完整对局玩家的头像别名 + 海克斯牌名
async fn enrich_recent(recent: Vec<Value>) -> Result<Vec<Value>, String> {
    let (heroes, augments) = tokio::join!(cn().get_hero_list(false), cn().get_augment_list(false));
    let (heroes, augments) = (heroes?, augments?);
    let aug_name = |id: i64| augments.get(&id).map(|a| a.name_cn.clone()).unwrap_or_else(|| format!("#{id}"));
    Ok(recent.into_iter().map(|r| {
        let mut r = r;
        let cid = r.get("championId").and_then(|v| v.as_i64()).unwrap_or(0);
        let hero = heroes.get(&cid);
        r["title"] = json!(hero_display_name(hero, cid));
        r["alias"] = json!(hero.map(|h| h.alias.clone()).unwrap_or_default());
        let qid = r.get("queueId").and_then(|v| v.as_i64()).unwrap_or(0);
        r["modeLabel"] = json!(queue_to_mode(qid).1);
        let aug_ids: Vec<i64> = r.get("augments").and_then(|v| v.as_array()).unwrap_or(&vec![])
            .iter().filter_map(|v| v.as_i64()).collect();
        r["augNames"] = json!(aug_ids.iter().map(|id| aug_name(*id)).collect::<Vec<_>>());
        if let Some(players) = r.get("players").and_then(|v| v.as_array()).cloned() {
            let mapped: Vec<Value> = players.into_iter().map(|mut pl| {
                let pcid = pl.get("championId").and_then(|v| v.as_i64()).unwrap_or(0);
                let ph = heroes.get(&pcid);
                pl["alias"] = json!(ph.map(|h| h.alias.clone()).unwrap_or_default());
                let paug: Vec<i64> = pl.get("augments").and_then(|v| v.as_array()).unwrap_or(&vec![])
                    .iter().filter_map(|v| v.as_i64()).collect();
                pl["augNames"] = json!(paug.iter().map(|id| aug_name(*id)).collect::<Vec<_>>());
                pl
            }).collect();
            r["players"] = json!(mapped);
        }
        r
    }).collect())
}

async fn handle_route(route: &str, params: &Params) -> Result<Value, String> {
    match route {
        "versions" => {
            let versions = cn().get_versions(false).await?;
            Ok(serde_json::to_value(versions).unwrap_or(Value::Null))
        }
        "rank" => {
            let lane = lane_of(params, "ALL");
            let (rankings, heroes) = tokio::join!(
                cn().get_champion_rankings(tier_of(params), &lane, None, false),
                cn().get_hero_list(false),
            );
            let (rankings, heroes) = (rankings?, heroes?);
            let top = num(params, "top", 50) as usize;
            Ok(json!(rankings.into_iter().take(top).map(|r| {
                let id = r.hero_id;
                json!({
                    "rank": r.rank, "heroId": id, "tier": r.tier, "lane": r.lane,
                    "winRate": r.win_rate, "pickRate": r.pick_rate, "banRate": r.ban_rate,
                    "counters": r.counters, "rankChange": r.rank_change,
                    "title": hero_display_name(heroes.get(&id), id),
                    "alias": heroes.get(&id).map(|h| h.alias.clone()).unwrap_or_default(),
                })
            }).collect::<Vec<_>>()))
        }
        "pick" => {
            let enemy = p(params, "enemy").unwrap_or("").to_string();
            if enemy.trim().is_empty() {
                return Err("请输入对面英雄".into());
            }
            let input = PickInput {
                enemy_hero_names: enemy.split(|c| c == ',' || c == '，').map(String::from).collect(),
                enemy_hero_ids: Vec::new(),
                enemy_lanes: HashMap::new(),
                my_lane: lane_of(params, "ALL"),
                exclude: p(params, "exclude").map(|s| s.split(|c| c == ',' || c == '，').map(String::from).collect()).unwrap_or_default(),
                exclude_ids: Vec::new(),
                top_n: num(params, "top", 12),
                tier: tier_of(params),
            };
            let recs = pick::recommend_pick(&input).await?;
            let items = recs.into_iter().map(|r| serde_json::to_value(r).unwrap_or(Value::Null)).collect();
            Ok(json!(with_alias(items).await?))
        }
        "ban" => {
            let input = BanInput {
                my_hero_names: p(params, "my").map(|s| s.split(|c| c == ',' || c == '，').map(String::from).collect()).unwrap_or_default(),
                my_hero_ids: Vec::new(),
                top_n: num(params, "top", 12),
                tier: tier_of(params),
            };
            let recs = ban::recommend_ban(&input).await?;
            let items = recs.into_iter().map(|r| serde_json::to_value(r).unwrap_or(Value::Null)).collect();
            Ok(json!(with_alias(items).await?))
        }
        "hero" => {
            let name = p(params, "name").unwrap_or("").to_string();
            if name.trim().is_empty() {
                return Err("请输入英雄名".into());
            }
            let resolved = cn().resolve_heroes(&[name.clone()]).await?;
            let hero_id = resolved[0].0;
            let (heroes, rankings) = tokio::join!(
                cn().get_hero_list(false),
                cn().get_champion_rankings(tier_of(params), "ALL", None, false),
            );
            let (heroes, rankings) = (heroes?, rankings?);
            let req_lane = lane_of(params, "ALL");
            let final_lane = if req_lane == "ALL" {
                pick::infer_lane(&rankings, hero_id)
            } else {
                req_lane
            };
            let stats = cn().get_confront(hero_id, tier_of(params), &final_lane, None, false).await?;
            let high = with_alias(stats.high.into_iter().map(|h| json!({"heroId": h.hero_id, "winRate": h.win_rate, "rank": h.rank})).collect()).await?;
            let low = with_alias(stats.low.into_iter().map(|h| json!({"heroId": h.hero_id, "winRate": h.win_rate, "rank": h.rank})).collect()).await?;
            Ok(json!({
                "heroId": hero_id,
                "title": hero_display_name(heroes.get(&hero_id), hero_id),
                "alias": heroes.get(&hero_id).map(|h| h.alias.clone()).unwrap_or_default(),
                "high": high,
                "low": low,
            }))
        }
        "lobby" => {
            let lobby = lcu::get_lobby().await?;
            let queue_id = lobby.get("gameConfig").and_then(|c| c.get("queueId")).and_then(|v| v.as_i64());
            let local_sid = lobby.get("localMember").and_then(|m| m.get("summonerId")).and_then(|v| v.as_i64());
            let members_raw = lobby.get("members").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let mut members: Vec<Value> = members_raw.into_iter().map(|m| {
                json!({
                    "summonerId": m.get("summonerId").and_then(|v| v.as_i64()).unwrap_or(0),
                    "name": m.get("displayName").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
                        .or_else(|| m.get("gameName").and_then(|v| v.as_str()))
                        .unwrap_or("").to_string(),
                    "level": m.get("summonerLevel").and_then(|v| v.as_i64()),
                    "icon": m.get("profileIconId").and_then(|v| v.as_i64()).or_else(|| m.get("summonerIconId").and_then(|v| v.as_i64())),
                    "isMe": m.get("summonerId").and_then(|v| v.as_i64()) == local_sid,
                })
            }).collect();
            // 国服 lobby 无昵称字段：缺名成员补查召唤师信息（缓存 60s）
            for m in members.iter_mut() {
                let sid = m.get("summonerId").and_then(|v| v.as_i64()).unwrap_or(0);
                let name = m.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if name.is_empty() && sid > 0 {
                    let (name, level, icon) = get_cached_summoner_info(sid).await;
                    m["name"] = json!(name);
                    if m.get("level").and_then(|v| v.as_i64()).is_none() { m["level"] = json!(level); }
                    if m.get("icon").and_then(|v| v.as_i64()).is_none() { m["icon"] = json!(icon); }
                }
            }
            // 统一查询：近 15 天排位/海斗各最多 20 场
            let mut enriched: Vec<Value> = Vec::new();
            for m in members {
                let sid = m.get("summonerId").and_then(|v| v.as_i64()).unwrap_or(0);
                let stats = lcu::get_player_recent_stats(sid, &lcu::RecentOpts::new()).await;
                let mut entry = m;
                entry["stats"] = stats.as_ref().and_then(|s| player::evaluate_mode_stats(s, queue_id)).map(|v| serde_json::to_value(v).unwrap_or(Value::Null)).unwrap_or(Value::Null);
                entry["byType"] = stats.as_ref().map(|s| serde_json::to_value(player::evaluate_by_type(s, 15)).unwrap_or(Value::Null)).unwrap_or(Value::Null);
                enriched.push(entry);
            }
            let team_members: Vec<(String, bool, Option<&lcu::PlayerRecentStats>)> = Vec::new();
            let _ = team_members;
            let team = {
                // 重新拉一次 stats 构造 team 评估（避免借用冲突，直接按成员顺序查询）
                let mut names = Vec::new();
                let mut is_mes = Vec::new();
                let mut stats_list = Vec::new();
                for m in &enriched {
                    names.push(m.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string());
                    is_mes.push(m.get("isMe").and_then(|v| v.as_bool()).unwrap_or(false));
                    let sid = m.get("summonerId").and_then(|v| v.as_i64()).unwrap_or(0);
                    stats_list.push(lcu::get_player_recent_stats(sid, &lcu::RecentOpts::new()).await);
                }
                let members_ref: Vec<(String, bool, Option<&lcu::PlayerRecentStats>)> = names.into_iter()
                    .zip(is_mes.into_iter()).zip(stats_list.iter())
                    .map(|((n, im), s)| (n, im, s.as_ref()))
                    .collect();
                player::evaluate_team(&members_ref, queue_id)
            };
            let (mode, mode_label) = queue_to_mode(queue_id.unwrap_or(0));
            Ok(json!({
                "queueId": queue_id,
                "mode": mode.as_str(),
                "modeLabel": mode_label,
                "localSummonerId": local_sid,
                "members": enriched,
                "team": team,
            }))
        }
        "lcu/status" => {
            let conn = lcu::find_lcu_connection_cached();
            let Some(conn) = conn else {
                return Ok(json!({ "connected": false }));
            };
            let (phase, summoner) = tokio::join!(lcu::get_gameflow_phase(), lcu::get_current_summoner());
            let phase = phase.ok();
            let summoner = summoner.ok();
            Ok(json!({
                "connected": true,
                "port": conn.port,
                "phase": phase.unwrap_or_default(),
                "summoner": summoner.as_ref().map(lcu::summoner_display_name).unwrap_or_default(),
                "level": summoner.and_then(|s| s.get("summonerLevel").and_then(|v| v.as_i64())),
            }))
        }
        "readycheck" => {
            match lcu::get_ready_check().await {
                Ok(rc) => Ok(rc),
                Err(msg) => {
                    if msg.contains("Not attached to a matchmaking queue") || msg.contains("No matchmaking search") {
                        Ok(json!({ "state": "none" }))
                    } else {
                        Err(msg)
                    }
                }
            }
        }
        "champselect" => {
            let analysis = champselect::analyze_champ_select().await
                .map_err(|e| if e.contains("不存在") { "NOT_IN_CHAMPSELECT".to_string() } else { e })?;
            let heroes = cn().get_hero_list(false).await?;
            let mut ids: Vec<i64> = Vec::new();
            for k in ["myPicks", "enemyPicks", "myBans", "enemyBans"] {
                if let Some(arr) = analysis.get(k).and_then(|v| v.as_array()) {
                    ids.extend(arr.iter().filter_map(|v| v.as_i64()));
                }
            }
            if let Some(arr) = analysis.get("aramPool").and_then(|v| v.as_array()) {
                ids.extend(arr.iter().filter_map(|v| v.get("heroId")).filter_map(|v| v.as_i64()));
            }
            for k in ["myTeamBoard", "enemyTeamBoard"] {
                if let Some(arr) = analysis.get(k).and_then(|v| v.as_array()) {
                    ids.extend(arr.iter().filter_map(|v| v.get("championId")).filter_map(|v| v.as_i64()));
                }
            }
            let mut hero_names: HashMap<i64, String> = HashMap::new();
            let mut hero_aliases: HashMap<i64, String> = HashMap::new();
            for id in ids {
                let h = heroes.get(&id);
                hero_names.insert(id, hero_display_name(h, id));
                hero_aliases.insert(id, h.map(|x| x.alias.clone()).unwrap_or_default());
            }
            let picks = with_alias(analysis.get("picks").and_then(|v| v.as_array()).cloned().unwrap_or_default()).await?;
            let bans = with_alias(analysis.get("bans").and_then(|v| v.as_array()).cloned().unwrap_or_default()).await?;
            let mut out = analysis;
            out["picks"] = json!(picks);
            out["bans"] = json!(bans);
            out["heroNames"] = serde_json::to_value(hero_names).unwrap_or(Value::Null);
            out["heroAliases"] = serde_json::to_value(hero_aliases).unwrap_or(Value::Null);
            Ok(out)
        }
        "loading" => {
            let session = lcu::get_gameflow_session().await
                .map_err(|e| if e.contains("不存在") { "NOT_IN_GAME".to_string() } else { e })?;
            let heroes = cn().get_hero_list(false).await?;
            let gd = session.get("gameData").cloned().unwrap_or(Value::Null);
            let gm = gd.get("queue").and_then(|q| q.get("gameMode")).and_then(|v| v.as_str())
                .or_else(|| gd.get("gameMode").and_then(|v| v.as_str()))
                .unwrap_or("").to_string();
            let me = lcu::get_current_summoner().await.ok();
            let me_puuid = me.as_ref().and_then(|m| m.get("puuid")).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let classic = gd.get("players").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let mut players: Vec<Value> = Vec::new();
            if !classic.is_empty() {
                let my_tid = classic.iter().find(|p| p.get("puuid").and_then(|v| v.as_str()) == Some(me_puuid.as_str()))
                    .and_then(|p| p.get("teamId")).and_then(|v| v.as_i64()).unwrap_or(100);
                players = classic.into_iter().map(|mut p| {
                    let tid = p.get("teamId").and_then(|v| v.as_i64()).unwrap_or(100);
                    p["teamId"] = json!(if tid == my_tid { 100 } else { 200 });
                    p
                }).collect();
            } else if let Some(t1) = gd.get("teamOne").and_then(|v| v.as_array()) {
                if !t1.is_empty() {
                    let t2 = gd.get("teamTwo").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                    let in_one = t1.iter().any(|p| p.get("puuid").and_then(|v| v.as_str()) == Some(me_puuid.as_str()));
                    let (my_side, their_side): (Vec<Value>, Vec<Value>) = if in_one {
                        (t1.clone(), t2)
                    } else {
                        (t2, t1.clone())
                    };
                    let mut all: Vec<Value> = Vec::new();
                    for p in my_side {
                        let mut v = p.clone();
                        v["teamId"] = json!(100);
                        all.push(v);
                    }
                    for p in their_side {
                        let mut v = p.clone();
                        v["teamId"] = json!(200);
                        all.push(v);
                    }
                    for p in all {
                        let sid = p.get("summonerId").and_then(|v| v.as_i64()).unwrap_or(0);
                        let (name, level, _) = get_cached_summoner_info(sid).await;
                        let mut out = Value::Null;
                        let _ = std::mem::replace(&mut out, json!({
                            "summonerId": sid,
                            "summonerName": name,
                            "puuid": p.get("puuid").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            "championId": p.get("championId").and_then(|v| v.as_i64()).unwrap_or(0),
                            "teamId": p.get("teamId").and_then(|v| v.as_i64()).unwrap_or(0),
                            "position": p.get("selectedPosition").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            "isBot": false,
                            "profileIconId": p.get("profileIconId").and_then(|v| v.as_i64()).unwrap_or(0),
                            "summonerLevel": level.unwrap_or(0),
                        }));
                        players.push(out);
                    }
                }
            }
            let aram_like = gm == "KIWI" || gm == "ARAM" || gm == "ARAM_GAME";
            // 段位查询（大乱斗跳过）
            let mut ranked: HashMap<i64, String> = HashMap::new();
            if !aram_like {
                for pl in players.iter().filter(|p| !p.get("isBot").and_then(|v| v.as_bool()).unwrap_or(false)) {
                    let sid = pl.get("summonerId").and_then(|v| v.as_i64()).unwrap_or(0);
                    if let Some(stats) = lcu::get_ranked_stats(sid).await {
                        if !stats.is_empty() {
                            let solo = stats.iter().find(|q| q.queue.contains("RANKED_SOLO")).unwrap_or(&stats[0]);
                            ranked.insert(sid, format!("{} {} {}LP", solo.tier, solo.division, solo.lp));
                        }
                    }
                }
            }
            // 近期战绩评估（轻量模式）
            let mut recents: HashMap<i64, Value> = HashMap::new();
            for pl in players.iter().filter(|p| !p.get("isBot").and_then(|v| v.as_bool()).unwrap_or(false)) {
                let sid = pl.get("summonerId").and_then(|v| v.as_i64()).unwrap_or(0);
                if let Some(stats) = lcu::get_player_recent_stats(sid, &lcu::RecentOpts::light()).await {
                    recents.insert(sid, serde_json::to_value(player::evaluate_by_type(&stats, 15)).unwrap_or(Value::Null));
                }
            }
            let out_players: Vec<Value> = players.into_iter().map(|pl| {
                let sid = pl.get("summonerId").and_then(|v| v.as_i64()).unwrap_or(0);
                let cid = pl.get("championId").and_then(|v| v.as_i64()).unwrap_or(0);
                let is_bot = pl.get("isBot").and_then(|v| v.as_bool()).unwrap_or(false);
                let hero = heroes.get(&cid);
                json!({
                    "summonerId": sid,
                    "summonerName": pl.get("summonerName").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    "puuid": pl.get("puuid").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    "championId": cid,
                    "teamId": pl.get("teamId").and_then(|v| v.as_i64()).unwrap_or(0),
                    "position": pl.get("position").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    "isBot": is_bot,
                    "profileIconId": pl.get("profileIconId").and_then(|v| v.as_i64()).unwrap_or(0),
                    "summonerLevel": pl.get("summonerLevel").and_then(|v| v.as_i64()).unwrap_or(0),
                    "title": if is_bot { "人机".to_string() } else { hero_display_name(hero, cid) },
                    "alias": if is_bot { String::new() } else { hero.map(|h| h.alias.clone()).unwrap_or_default() },
                    "rank": ranked.get(&sid).cloned().unwrap_or_default(),
                    "isMe": pl.get("puuid").and_then(|v| v.as_str()) == Some(me_puuid.as_str()),
                    "recents": recents.get(&sid).cloned().unwrap_or(Value::Null),
                })
            }).collect();
            Ok(json!({
                "gameMode": if gm.is_empty() { "KIWI".to_string() } else { gm.clone() },
                "phase": session.get("phase").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                "aramLike": aram_like,
                "players": out_players,
            }))
        }
        "hex/heroes" => {
            let list = hextech::recommend_hextech_heroes(num(params, "top", 20)).await?;
            Ok(serde_json::to_value(list).unwrap_or(Value::Null))
        }
        "hex/augments" => {
            let list = hextech::recommend_augments(num(params, "top", 20)).await?;
            Ok(serde_json::to_value(list).unwrap_or(Value::Null))
        }
        "hex/partners" => {
            let list = hextech::recommend_hextech_partners(num(params, "top", 20)).await?;
            Ok(serde_json::to_value(list).unwrap_or(Value::Null))
        }
        "player-recent" => {
            let summoner_id = num(params, "summonerId", 0);
            let puuid = p(params, "puuid").unwrap_or("").to_string();
            let queue_id = num(params, "queueId", 0);
            let queue_id = if queue_id > 0 { Some(queue_id) } else { None };
            let mode = match p(params, "mode") {
                Some("ranked") | Some("hextech") => p(params, "mode").map(String::from),
                _ => None,
            };
            let stats = if summoner_id > 0 {
                let mut opts = lcu::RecentOpts::new();
                opts.mode = mode.clone();
                lcu::get_player_recent_stats(summoner_id, &opts).await
            } else if !puuid.is_empty() {
                let mut opts = lcu::RecentOpts::by_puuid(50);
                opts.mode = mode.clone();
                lcu::get_player_recent_stats_by_puuid(&puuid, &opts).await
            } else {
                return Err("缺少 summonerId/puuid".into());
            };
            let Some(stats) = stats else {
                return Ok(json!({ "stats": Value::Null, "byType": Value::Null, "recent": [] }));
            };
            let recent = enrich_recent(stats.recent.iter().map(|r| {
                json!({
                    "gameId": r.game_id, "championId": r.champion_id, "win": r.win,
                    "gameCreation": r.game_creation, "queueId": r.queue_id,
                    "kills": r.kills, "deaths": r.deaths, "assists": r.assists,
                    "duration": r.duration, "cs": r.cs, "gold": r.gold, "vision": r.vision,
                    "level": r.level, "dmg": r.dmg, "taken": r.taken,
                    "items": r.items, "augments": r.augments,
                    "players": r.players.as_ref().map(|ps| ps.iter().map(|p| json!({
                        "teamId": p.team_id, "championId": p.champion_id, "summonerName": p.summoner_name,
                        "kills": p.kills, "deaths": p.deaths, "assists": p.assists, "dmg": p.dmg,
                        "items": p.items, "augments": p.augments, "win": p.win, "isSelf": p.is_self,
                    })).collect::<Vec<_>>()),
                })
            }).collect()).await?;
            Ok(json!({
                "stats": player::evaluate_mode_stats(&stats, queue_id).map(|v| serde_json::to_value(v).unwrap_or(Value::Null)).unwrap_or(Value::Null),
                "byType": serde_json::to_value(player::evaluate_by_type(&stats, 15)).unwrap_or(Value::Null),
                "recent": recent,
            }))
        }
        "friends" => {
            let friends = lcu::get_friends().await?;
            let me = lcu::get_current_summoner().await.ok();
            let me_sid = me.as_ref().and_then(|m| m.get("summonerId")).and_then(|v| v.as_i64()).unwrap_or(-1);
            let online: Vec<Value> = friends.as_array().cloned().unwrap_or_default().into_iter().filter(|f| {
                let avail = f.get("availability").and_then(|v| v.as_str()).unwrap_or("");
                let pid = f.get("pid").and_then(|v| v.as_str()).unwrap_or("");
                avail != "offline" && !avail.is_empty() && pid != me_sid.to_string()
            }).collect();
            let mut list: Vec<Value> = Vec::new();
            for f in online {
                let pid = f.get("pid").and_then(|v| v.as_str()).unwrap_or("").replace("@pvp.net", "");
                let valid = pid.len() >= 20 && pid.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
                if !valid {
                    continue;
                }
                let stats = lcu::get_player_recent_stats_by_puuid(&pid, &lcu::RecentOpts::by_puuid(50)).await;
                let verdict = stats.as_ref().map(|s| serde_json::to_value(player::evaluate_by_type(s, 15)).unwrap_or(Value::Null));
                let (status, game_label) = friend_status(&f);
                let name = f.get("gameName").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
                    .or_else(|| f.get("name").and_then(|v| v.as_str()))
                    .map(String::from)
                    .unwrap_or_else(|| format!("好友{}", pid.chars().take(6).collect::<String>()));
                let tier = {
                    let t = f.get("lol").and_then(|l| l.get("rankedLeagueTier")).and_then(|v| v.as_str()).unwrap_or("");
                    let d = f.get("lol").and_then(|l| l.get("rankedLeagueDivision")).and_then(|v| v.as_str()).unwrap_or("");
                    if t.is_empty() { String::new() } else { format!("{t} {d}").trim().to_string() }
                };
                list.push(json!({
                    "puuid": pid,
                    "name": name,
                    "status": status,
                    "gameLabel": game_label,
                    "level": f.get("lol").and_then(|l| l.get("level")).and_then(|v| v.as_str()).and_then(|s| s.parse::<i64>().ok()).or_else(|| f.get("lol").and_then(|l| l.get("level")).and_then(|v| v.as_i64())),
                    "tier": tier,
                    "icon": stats.as_ref().and_then(|s| s.icon),
                    "stats": verdict.unwrap_or(Value::Null),
                }));
            }
            list.sort_by(|a, b| {
                let sc = |v: &Value| -> f64 {
                    let mut best = -1.0f64;
                    for k in ["ranked", "hextech"] {
                        if let Some(s) = v.get("stats").and_then(|s| s.get(k)).and_then(|s| s.get("score")).and_then(|s| s.as_f64()) {
                            best = best.max(s);
                        }
                    }
                    best
                };
                sc(b).partial_cmp(&sc(a)).unwrap_or(std::cmp::Ordering::Equal)
            });
            Ok(json!({ "count": list.len(), "friends": list }))
        }
        "augment/search" => {
            let hits = augments::search_augments(p(params, "q").unwrap_or("")).await?;
            Ok(serde_json::to_value(hits).unwrap_or(Value::Null))
        }
        "augment/reco" => {
            let ids: Vec<i64> = p(params, "ids").unwrap_or("").split(',').filter_map(|s| s.parse::<i64>().ok()).filter(|n| *n > 0).collect();
            // 我方英雄：游戏内自动读（InProgress/GameStart），否则空
            let mut my_hero_ids: Vec<i64> = Vec::new();
            let mut my_hero_id: i64 = 0;
            let mut phase = "unknown".to_string();
            let mut mode = "未知".to_string();
            let phase_result = lcu::get_gameflow_phase().await;
            if let Ok(ph) = &phase_result {
                phase = ph.clone();
                if ph == "InProgress" || ph == "GameStart" {
                    if let Ok(g) = lcu::get_gameflow_session().await {
                        let gd = g.get("gameData").cloned().unwrap_or(Value::Null);
                        let gm = gd.get("queue").and_then(|q| q.get("gameMode")).and_then(|v| v.as_str())
                            .or_else(|| gd.get("gameMode").and_then(|v| v.as_str())).unwrap_or("");
                        mode = match gm {
                            "KIWI" => "海克斯大乱斗".to_string(),
                            "ARAM" | "ARAM_GAME" => "大乱斗".to_string(),
                            "CLASSIC" => "峡谷".to_string(),
                            "DEFAULT" => "峡谷".to_string(),
                            other => { if other.is_empty() { "未知".to_string() } else { other.to_string() } }
                        };
                        let me = lcu::get_current_summoner().await.ok();
                        let me_puuid = me.as_ref().and_then(|m| m.get("puuid")).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let classic = gd.get("players").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                        if !classic.is_empty() {
                            my_hero_ids = classic.iter()
                                .filter(|p| p.get("teamId").and_then(|v| v.as_i64()) == Some(100) && p.get("championId").and_then(|v| v.as_i64()).unwrap_or(0) > 0)
                                .filter_map(|p| p.get("championId").and_then(|v| v.as_i64())).collect::<std::collections::HashSet<_>>().into_iter().collect();
                            my_hero_id = classic.iter()
                                .find(|p| p.get("teamId").and_then(|v| v.as_i64()) == Some(100) && p.get("puuid").and_then(|v| v.as_str()) == Some(me_puuid.as_str()))
                                .and_then(|p| p.get("championId").and_then(|v| v.as_i64())).unwrap_or(0);
                        } else if let Some(t1) = gd.get("teamOne").and_then(|v| v.as_array()) {
                            if !t1.is_empty() {
                                let t2 = gd.get("teamTwo").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                                let my_team: Vec<Value> = if t1.iter().any(|p| p.get("puuid").and_then(|v| v.as_str()) == Some(me_puuid.as_str())) { t1.clone() } else { t2 };
                                my_hero_ids = my_team.iter()
                                    .filter(|p| p.get("championId").and_then(|v| v.as_i64()).unwrap_or(0) > 0)
                                    .filter_map(|p| p.get("championId").and_then(|v| v.as_i64())).collect::<std::collections::HashSet<_>>().into_iter().collect();
                                my_hero_id = my_team.iter()
                                    .find(|p| p.get("puuid").and_then(|v| v.as_str()) == Some(me_puuid.as_str()))
                                    .and_then(|p| p.get("championId").and_then(|v| v.as_i64())).unwrap_or(0);
                            }
                        }
                    }
                }
            }
            // 官方牌榜 Top 10
            let top_augments = hextech::recommend_augments(10).await.unwrap_or_default();
            let reco_ids: Vec<i64> = if ids.is_empty() {
                top_augments.iter().map(|a| a.augment.augment_id).collect()
            } else {
                ids
            };
            let hero_ids: Vec<i64> = if my_hero_id > 0 { vec![my_hero_id] } else { my_hero_ids.clone() };
            // 海斗英雄榜：自己英雄的条目
            let my_hero_stat: Option<Value> = if my_hero_id > 0 {
                hextech::recommend_hextech_heroes(300).await.ok()
                    .and_then(|list| list.into_iter().find(|h| h.hero_id == my_hero_id))
                    .map(|h| json!({
                        "title": h.title, "alias": h.alias, "winRate": h.win_rate, "pickRate": h.pick_rate, "rank": h.rank,
                        "bestAugments": h.best_augments.iter().take(5).map(|a| json!({ "name_cn": a.name_cn, "winRate": a.win_rate, "pickRate": a.pick_rate })).collect::<Vec<_>>(),
                        "bestPartners": h.best_partners.iter().take(3).map(|p| json!({ "title": p.title, "winRate": p.win_rate })).collect::<Vec<_>>(),
                    }))
            } else {
                None
            };
            let hero_names: HashMap<i64, String> = if my_hero_ids.is_empty() {
                HashMap::new()
            } else {
                let heroes = cn().get_hero_list(false).await.unwrap_or_default();
                let mut seen = std::collections::HashSet::new();
                let mut m = HashMap::new();
                for id in my_hero_ids.iter().chain(std::iter::once(&my_hero_id)) {
                    if *id <= 0 || !seen.insert(*id) {
                        continue;
                    }
                    let h = heroes.get(id);
                    m.insert(*id, hero_display_name(h, *id));
                }
                m
            };
            let choices = if reco_ids.is_empty() {
                Vec::new()
            } else {
                augments::recommend_augment_choices(&reco_ids, &hero_ids).await.unwrap_or_default()
            };
            Ok(json!({
                "phase": phase,
                "mode": mode,
                "myHeroId": my_hero_id,
                "myHeroIds": my_hero_ids,
                "myHeroStat": my_hero_stat,
                "heroNames": hero_names,
                "choices": choices,
                "topAugments": top_augments,
            }))
        }
        other => Err(format!("未知接口: {other}")),
    }
}

pub async fn dispatch(route: &str, params: Params) -> Result<Value, String> {
    handle_route(route, &params).await
}
