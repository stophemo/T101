// API 分发层探测：模拟前端 invoke('api', {route, params}) 调用，验证响应结构
// 运行：cd desktop/src-tauri && cargo run --bin probe-api

use std::collections::HashMap;
use t101_panel::api_cmd;

fn p(items: &[(&str, &str)]) -> HashMap<String, String> {
    items.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

#[tokio::main]
async fn main() {
    let data_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../data");
    let _ = t101_panel::storage::DATA_DIR.set(data_dir.clone());

    let cases: Vec<(&str, HashMap<String, String>)> = vec![
        ("versions", p(&[])),
        ("lcu/status", p(&[])),
        ("readycheck", p(&[])),
        ("rank", p(&[("tier", "255"), ("lane", "ALL"), ("top", "5")])),
        ("hero", p(&[("name", "亚索"), ("tier", "255")])),
        ("pick", p(&[("enemy", "亚索,盲僧"), ("lane", "MIDDLE"), ("top", "5"), ("tier", "255")])),
        ("ban", p(&[("my", "亚索,锤石"), ("top", "5"), ("tier", "255")])),
        ("hex/heroes", p(&[("top", "5")])),
        ("hex/augments", p(&[("top", "5")])),
        ("hex/partners", p(&[("top", "5")])),
        ("player-recent", p(&[("summonerId", "4000337165")])),
        ("friends", p(&[])),
        ("augment/search", p(&[("q", "飞弹")])),
        ("augment/reco", p(&[("ids", "")])),
        ("lobby", p(&[])),
        ("champselect", p(&[])),
        ("loading", p(&[])),
    ];

    for (route, params) in cases {
        match api_cmd::dispatch(route, params).await {
            Ok(v) => {
                let summary = summarize(&v);
                println!("✅ {route}: {summary}");
            }
            Err(e) => println!("ℹ️ {route}: ERR {e}"),
        }
    }
}

fn summarize(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Array(a) => format!("[{}] 首项={}", a.len(), a.first().map(|x| summarize(x)).unwrap_or_default()),
        serde_json::Value::Object(o) => {
            let keys: Vec<&String> = o.keys().collect();
            let mut parts = Vec::new();
            for k in ["count", "connected", "phase", "state", "modeLabel", "tierName", "queueId", "totalGames", "gameMode", "name"] {
                if let Some(val) = o.get(k) {
                    parts.push(format!("{k}={}", short(val)));
                }
            }
            for k in ["players", "members", "friends", "recent", "choices", "picks", "bans", "aramPool", "high", "low"] {
                if let Some(val) = o.get(k) {
                    if let Some(a) = val.as_array() {
                        parts.push(format!("{k}={}", a.len()));
                    }
                }
            }
            if parts.is_empty() { format!("{{{}}}", keys.iter().take(6).map(|k| k.as_str()).collect::<Vec<_>>().join(",")) } else { parts.join(" ") }
        }
        other => short(other),
    }
}

fn short(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => format!("\"{}\"", s.chars().take(18).collect::<String>()),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Null => "null".into(),
        serde_json::Value::Array(a) => format!("[{}]", a.len()),
        serde_json::Value::Object(_) => "{}".into(),
    }
}
