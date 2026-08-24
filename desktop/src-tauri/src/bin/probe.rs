// 开发探测程序：连真实 LCU + 101 接口验证数据链路（不随应用发布）
// 运行：cd desktop/src-tauri && cargo run --bin probe

use t101_panel::cn101::cn;
use t101_panel::lcu;
use t101_panel::{ban, hextech, pick, player};

#[tokio::main]
async fn main() {
    let data_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../data");
    let _ = t101_panel::storage::DATA_DIR.set(data_dir.clone());
    println!("== 数据目录: {}", data_dir.display());

    // ---------- LCU ----------
    match lcu::find_lcu_connection() {
        Some(conn) => println!("✅ LCU 连接: port={}", conn.port),
        None => println!("❌ 未检测到 LCU"),
    }
    match lcu::get_gameflow_phase().await {
        Ok(p) => println!("✅ gameflow-phase: {p}"),
        Err(e) => println!("❌ phase: {e}"),
    }
    let me = lcu::get_current_summoner().await;
    match &me {
        Ok(s) => println!("✅ 当前召唤师: {} (id={}, level={})",
            lcu::summoner_display_name(s),
            s.get("summonerId").and_then(|v| v.as_i64()).unwrap_or(0),
            s.get("summonerLevel").and_then(|v| v.as_i64()).unwrap_or(0)),
        Err(e) => println!("❌ summoner: {e}"),
    }
    if let Ok(s) = &me {
        let sid = s.get("summonerId").and_then(|v| v.as_i64()).unwrap_or(0);
        // 调试：直接拉原始 match-history
        match lcu::lcu_get(&format!("/lol-match-history/v1/products/lol/{}/matches?begIndex=0&endIndex=5",
            s.get("puuid").and_then(|v| v.as_str()).unwrap_or(""))).await {
            Ok(v) => println!("✅ 原始 match-history: games={} 顶层keys={:?}",
                v.get("games").and_then(|g| g.get("games")).and_then(|g| g.as_array()).map(|a| a.len()).unwrap_or(0),
                v.get("games").map(|g| g.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default()).unwrap_or_default()),
            Err(e) => println!("❌ 原始 match-history: {e}"),
        }
        match lcu::get_ranked_stats(sid).await {
            Some(stats) => for r in stats {
                println!("✅ 段位: {} {} {}LP ({}胜{}负)", r.tier, r.division, r.lp, r.wins, r.losses);
            },
            None => println!("ℹ️ 无段位数据"),
        }
        match lcu::get_player_recent_stats(sid, &lcu::RecentOpts::new()).await {
            Some(stats) => {
                println!("✅ 近期战绩: {} 场, {} 胜 (近15天 排位/海斗各20)", stats.total_games, stats.wins);
                let verdict = player::evaluate_by_type(&stats, 15);
                println!("   排位评估: {:?}", verdict.ranked.map(|v| (v.score, v.verdict.clone())));
                println!("   海斗评估: {:?}", verdict.hextech.map(|v| (v.score, v.verdict.clone())));
                for g in stats.recent.iter().take(3) {
                    let players = g.players.as_ref().map(|p| p.len()).unwrap_or(0);
                    println!("   场次: queue={} champion={} win={} 10人详情={}",
                        g.queue_id, g.champion_id, g.win, players);
                }
            }
            None => println!("ℹ️ 无近期战绩（或接口不可用）"),
        }
    }
    match lcu::get_ready_check().await {
        Ok(v) => println!("✅ ready-check: {v}"),
        Err(e) => println!("ℹ️ ready-check: {e}"),
    }
    match lcu::get_lobby().await {
        Ok(v) => println!("✅ lobby: members={}", v.get("members").and_then(|m| m.as_array()).map(|a| a.len()).unwrap_or(0)),
        Err(e) => println!("ℹ️ lobby: {e}"),
    }
    match lcu::get_friends().await {
        Ok(v) => println!("✅ friends: {}", v.as_array().map(|a| a.len()).unwrap_or(0)),
        Err(e) => println!("ℹ️ friends: {e}"),
    }

    // ---------- 101 ----------
    match cn().get_versions(false).await {
        Ok(v) => println!("✅ 版本: {}", v.first().map(|x| x.name.clone()).unwrap_or_default()),
        Err(e) => println!("❌ versions: {e}"),
    }
    match cn().get_hero_list(false).await {
        Ok(h) => println!("✅ 英雄表: {} 个 (如 {} / {})", h.len(),
            h.get(&103).map(|x| x.title.clone()).unwrap_or_default(),
            h.get(&1).map(|x| x.title.clone()).unwrap_or_default()),
        Err(e) => println!("❌ hero_list: {e}"),
    }
    match cn().get_champion_rankings(255, "ALL", None, false).await {
        Ok(r) => println!("✅ 全段位榜单: {} 条, top1={:?} 胜率={}", r.len(),
            r.first().map(|x| x.hero_id), r.first().map(|x| x.win_rate).unwrap_or(0.0)),
        Err(e) => println!("❌ rankings: {e}"),
    }
    match cn().get_confront(103, 255, "TOP", None, false).await {
        Ok(c) => println!("✅ 对位(103 TOP): high={} low={}", c.high.len(), c.low.len()),
        Err(e) => println!("❌ confront: {e}"),
    }
    match cn().get_hextech_hero_rank(None, false).await {
        Ok(h) => println!("✅ 海斗英雄榜: {} 条", h.len()),
        Err(e) => println!("❌ hex hero: {e}"),
    }
    match cn().get_hextech_rune_rank(None, false).await {
        Ok(r) => println!("✅ 海克斯牌榜: {} 条", r.len()),
        Err(e) => println!("❌ hex rune: {e}"),
    }
    match cn().get_augment_list(false).await {
        Ok(a) => println!("✅ 海克斯牌表: {} 张", a.len()),
        Err(e) => println!("❌ augment list: {e}"),
    }
    match cn().resolve_heroes(&["亚索".to_string(), "Annie".to_string()]).await {
        Ok(r) => println!("✅ resolveHeroes: {r:?}"),
        Err(e) => println!("❌ resolve: {e}"),
    }

    // ---------- 服务 ----------
    let input = pick::PickInput {
        enemy_hero_names: vec!["亚索".into(), "盲僧".into()],
        enemy_hero_ids: Vec::new(),
        enemy_lanes: std::collections::HashMap::new(),
        my_lane: "MIDDLE".into(),
        exclude: Vec::new(),
        exclude_ids: Vec::new(),
        top_n: 5,
        tier: 255,
    };
    match pick::recommend_pick(&input).await {
        Ok(recs) => {
            println!("✅ 推荐 Pick（对 亚索/盲僧）:");
            for r in recs {
                println!("   {} {} ({} · {}% · score={:.1}) 克: {}",
                    r.title, r.lane, r.tier, r.win_rate, r.score, r.counters.join("、"));
            }
        }
        Err(e) => println!("❌ pick: {e}"),
    }
    let binput = ban::BanInput {
        my_hero_names: vec!["亚索".into(), "锤石".into()],
        my_hero_ids: Vec::new(),
        top_n: 5,
        tier: 255,
    };
    match ban::recommend_ban(&binput).await {
        Ok(recs) => {
            println!("✅ 推荐 Ban（我方 亚索/锤石）:");
            for r in recs {
                println!("   {} ({} · 威胁 {} 人) score={:.1}", r.title, r.tier, r.threatens_count, r.score);
            }
        }
        Err(e) => println!("❌ ban: {e}"),
    }
    match hextech::recommend_hextech_heroes(5).await {
        Ok(list) => {
            println!("✅ 海斗英雄推荐:");
            for h in list {
                let augs: Vec<String> = h.best_augments.iter().take(2).map(|a| a.name_cn.clone()).collect();
                println!("   #{} {} {}% 牌: {}", h.rank, h.title, h.win_rate, augs.join("、"));
            }
        }
        Err(e) => println!("❌ hex heroes: {e}"),
    }
    match hextech::recommend_augments(5).await {
        Ok(list) => {
            println!("✅ 海克斯牌推荐:");
            for a in list {
                println!("   {} ({} · 胜率 {}%)", a.augment.name_cn, a.augment.level, a.win_rate);
            }
        }
        Err(e) => println!("❌ hex augments: {e}"),
    }
    match t101_panel::augments::recommend_augment_choices(&[14, 22, 30], &[103, 64, 36]).await {
        Ok(choices) => {
            println!("✅ 选牌评级 (id 14/22/30, 阵容 103/64/36):");
            for c in choices {
                println!("   {} {} · score={} · 命中 {}", c.grade, c.name, c.score, c.matched_heroes.join("、"));
            }
        }
        Err(e) => println!("❌ augment reco: {e}"),
    }

    // ---------- champselect（当前不在选人阶段时会报错，属预期） ----------
    match t101_panel::champselect::analyze_champ_select().await {
        Ok(v) => println!("✅ champselect: mode={} picks={}", v.get("modeLabel").and_then(|x| x.as_str()).unwrap_or(""), v.get("picks").and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0)),
        Err(e) => println!("ℹ️ champselect: {e}"),
    }

    println!("\n== 探测完成 ==");
}
