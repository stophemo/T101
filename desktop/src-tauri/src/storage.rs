// 本地存储：滚动 TTL 缓存（cache.json）+ 版本/日期级快照（data/snapshots/）
// 与 src/utils/cache.ts、src/utils/snapshot.ts 行为一致

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn data_dir() -> &'static Path {
    DATA_DIR.get().expect("DATA_DIR 未初始化")
}

fn cache_file() -> PathBuf {
    data_dir().join("cache.json")
}

fn snapshots_dir() -> PathBuf {
    data_dir().join("snapshots")
}

// ---------- 滚动 TTL 缓存 ----------

type CacheDb = std::collections::HashMap<String, (f64, Value)>;
static CACHE: OnceLock<std::sync::Mutex<CacheDb>> = OnceLock::new();

fn cache_db() -> &'static std::sync::Mutex<CacheDb> {
    CACHE.get_or_init(|| {
        let db = fs::read_to_string(cache_file())
            .ok()
            .and_then(|s| serde_json::from_str::<std::collections::HashMap<String, (f64, Value)>>(&s).ok())
            .unwrap_or_default();
        std::sync::Mutex::new(db)
    })
}

fn cache_flush() {
    if let Some(db) = CACHE.get() {
        if let Ok(db) = db.lock() {
            let _ = fs::create_dir_all(data_dir());
            let _ = fs::write(cache_file(), serde_json::to_string(&*db).unwrap_or_default());
        }
    }
}

/// 读缓存，未命中或过期返回 None（ttl 单位：小时）
pub fn cache_get<T: serde::de::DeserializeOwned>(key: &str, ttl_hours: u64) -> Option<T> {
    let db = cache_db().lock().ok()?;
    let (ts, data) = db.get(key)?;
    let age_hours = (now_ms() - ts) / 3_600_000.0;
    if age_hours > ttl_hours as f64 {
        return None;
    }
    serde_json::from_value(data.clone()).ok()
}

pub fn cache_set<T: serde::Serialize>(key: &str, data: &T) {
    let val = serde_json::to_value(data).unwrap_or(Value::Null);
    if let Ok(mut db) = cache_db().lock() {
        db.insert(key.to_string(), (now_ms(), val));
    }
    cache_flush();
}

// ---------- 快照 ----------

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMeta {
    pub key: String,
    pub fetched_at: i64,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
}

fn slug(key: &str) -> String {
    key.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

pub fn snapshot_get<T: serde::de::DeserializeOwned>(key: &str) -> Option<(T, SnapshotMeta)> {
    let path = snapshots_dir().join(format!("{}.json", slug(key)));
    let raw = fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let meta: SnapshotMeta = serde_json::from_value(v.get("meta")?.clone()).ok()?;
    let data: T = serde_json::from_value(v.get("data")?.clone()).ok()?;
    Some((data, meta))
}

pub fn snapshot_set<T: serde::Serialize>(key: &str, data: &T, source: &str, version: Option<&str>, date: Option<&str>) {
    let meta = SnapshotMeta {
        key: key.to_string(),
        fetched_at: now_ms() as i64,
        source: source.to_string(),
        version: version.map(String::from),
        date: date.map(String::from),
        count: None,
    };
    let _ = fs::create_dir_all(snapshots_dir());
    let path = snapshots_dir().join(format!("{}.json", slug(key)));
    let _ = fs::write(path, serde_json::to_string(&json!({ "meta": meta, "data": data })).unwrap_or_default());
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}
