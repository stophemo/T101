// 队伍房间：召唤师近期状态评估（对应 src/services/player.ts）
// 胜率 + KDA + 对应模式表现，0-100 分 + 中文结论

use crate::lcu::PlayerRecentStats;
use crate::models::*;

/// 纯函数：按近期战绩评估状态
pub fn evaluate_recent_stats(
    total_games: i64,
    wins: i64,
    kda: (i64, i64, i64),
    recent: &[(i64, bool)], // (queueId, win)
    queue_id: Option<i64>,
) -> PlayerVerdict {
    let total = total_games.max(1);
    let win_rate = wins as f64 / total as f64 * 100.0;
    let kda_v = (kda.0 + kda.2) as f64 / (kda.1.max(1) as f64);
    let mut mode_win_rate: Option<f64> = None;
    let mut mode_games = 0i64;
    if let Some(qid) = queue_id {
        let family = crate::models::queue_family(qid);
        let ms: Vec<&(i64, bool)> = recent.iter().filter(|(q, _)| crate::models::queue_family(*q) == family).collect();
        mode_games = ms.len() as i64;
        if ms.len() >= 2 {
            mode_win_rate = Some(ms.iter().filter(|(_, w)| *w).count() as f64 / ms.len() as f64 * 100.0);
        }
    }
    // 状态分：胜率 70% + KDA 30%（KDA 封顶 8:1 记满分）
    let score = (win_rate * 0.7 + (kda_v / 8.0).min(1.0) * 100.0 * 0.3).round() as i64;
    let verdict = if total_games < 3 {
        "📊 样本不足".to_string()
    } else if score >= 65 {
        "🔥 状态火热".to_string()
    } else if score >= 55 {
        "👍 状态不错".to_string()
    } else if score >= 45 {
        "😐 状态一般".to_string()
    } else {
        "📉 状态低迷".to_string()
    };
    PlayerVerdict {
        score,
        verdict,
        total_games,
        win_rate: (win_rate * 10.0).round() / 10.0,
        mode_win_rate: mode_win_rate.map(|v| (v * 10.0).round() / 10.0),
        kda: (kda_v * 100.0).round() / 100.0,
        mode_games,
    }
}

/// 按类型分别评估：排位（420/440）与海克斯大乱斗（2400/2410）各出一份
pub fn evaluate_by_type(stats: &PlayerRecentStats, days: i64) -> ByTypeVerdict {
    let now = now_ms() as i64;
    let cutoff = now - days * 86400_000;
    let recent: Vec<&crate::lcu::MatchStat> = stats.recent.iter().filter(|r| r.game_creation >= cutoff).collect();
    let ranked_all: Vec<&crate::lcu::MatchStat> = recent.iter().filter(|r| queue_family(r.queue_id) == "ranked").copied().collect();
    let hextech_all: Vec<&crate::lcu::MatchStat> = recent.iter().filter(|r| queue_family(r.queue_id) == "hextech_aram").copied().collect();
    let eval_set = |games: &[&crate::lcu::MatchStat]| -> Option<PlayerVerdict> {
        if games.is_empty() {
            return None;
        }
        let wins = games.iter().filter(|g| g.win).count() as i64;
        let kda = games.iter().fold((0i64, 0i64, 0i64), |acc, g| (acc.0 + g.kills, acc.1 + g.deaths, acc.2 + g.assists));
        let pairs: Vec<(i64, bool)> = games.iter().map(|g| (g.queue_id, g.win)).collect();
        Some(evaluate_recent_stats(games.len() as i64, wins, kda, &pairs, None))
    };
    let days_ago = |games: &[&crate::lcu::MatchStat]| -> Option<i64> {
        if games.is_empty() {
            return None;
        }
        let max = games.iter().map(|g| g.game_creation).max().unwrap_or(0);
        Some(((now - max) / 86400_000).max(0))
    };
    ByTypeVerdict {
        ranked: eval_set(&ranked_all),
        hextech: eval_set(&hextech_all),
        ranked_last_days: days_ago(&ranked_all),
        hextech_last_days: days_ago(&hextech_all),
        overall_last_days: days_ago(&recent),
    }
}

/// 按当前队列选择对应类型的评估（房间视图用）
pub fn evaluate_mode_stats(stats: &PlayerRecentStats, queue_id: Option<i64>) -> Option<PlayerVerdict> {
    let family = queue_id.map(queue_family);
    match family.as_deref() {
        Some("ranked") => evaluate_by_type(stats, 15).ranked,
        Some("hextech_aram") => evaluate_by_type(stats, 15).hextech,
        _ => {
            let pairs: Vec<(i64, bool)> = stats.recent.iter().map(|r| (r.queue_id, r.win)).collect();
            Some(evaluate_recent_stats(stats.total_games, stats.wins, stats.kda, &pairs, queue_id))
        }
    }
}

/// 队伍整体评估（纯函数）
pub fn evaluate_team(
    members: &[(String, bool, Option<&PlayerRecentStats>)],
    queue_id: Option<i64>,
) -> serde_json::Value {
    let evals: Vec<(String, bool, Option<PlayerVerdict>)> = members
        .iter()
        .map(|(name, is_me, stats)| (name.clone(), *is_me, stats.and_then(|s| evaluate_mode_stats(s, queue_id))))
        .collect();
    let with_v: Vec<&(String, bool, Option<PlayerVerdict>)> = evals.iter().filter(|m| m.2.is_some()).collect();
    if with_v.is_empty() {
        return serde_json::json!({
            "avgScore": 0,
            "verdict": "暂无近期战绩数据（客户端不可用或战绩接口受限）",
            "best": serde_json::Value::Null,
            "worst": serde_json::Value::Null,
            "hasData": false,
        });
    }
    let avg = with_v.iter().map(|m| m.2.as_ref().unwrap().score).sum::<i64>() as f64 / with_v.len() as f64;
    let best = with_v.iter().max_by(|a, b| a.2.as_ref().unwrap().score.cmp(&b.2.as_ref().unwrap().score)).unwrap();
    let worst = with_v.iter().min_by(|a, b| a.2.as_ref().unwrap().score.cmp(&b.2.as_ref().unwrap().score)).unwrap();
    let verdict = if avg >= 60.0 {
        "🟢 队伍整体状态不错，可放心开局"
    } else if avg >= 50.0 {
        "🟡 队伍状态一般，稳扎稳打"
    } else {
        "🔴 队伍近期状态偏弱，谨慎运营"
    };
    serde_json::json!({
        "avgScore": avg.round() as i64,
        "verdict": verdict,
        "best": best.0,
        "worst": worst.0,
        "hasData": true,
    })
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}
