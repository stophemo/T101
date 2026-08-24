// 数据模型：与 src/models.ts（TS 版）字段一一对应，序列化用 camelCase 匹配前端

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ---------- 段位 ----------

/// 段位 id：255 全段位 / 10 王者 / 9 宗师 / 8 大师 / 7 钻石 / 6 翡翠 / 5 铂金 / 4 黄金 / 3 白银 / 2 青铜 / 1 黑铁
pub type TierId = i64;

pub fn tier_names(tier: TierId) -> &'static str {
    match tier {
        255 => "全段位", 10 => "王者", 9 => "宗师", 8 => "大师", 7 => "钻石",
        6 => "翡翠", 5 => "铂金", 4 => "黄金", 3 => "白银", 2 => "青铜",
        1 => "黑铁", _ => "全段位",
    }
}

/// LCU 段位名 -> itier
pub fn tier_name_to_id(name: &str) -> Option<i64> {
    Some(match name.to_uppercase().as_str() {
        "CHALLENGER" => 10, "GRANDMASTER" => 9, "MASTER" => 8, "DIAMOND" => 7,
        "EMERALD" => 6, "PLATINUM" => 5, "GOLD" => 4, "SILVER" => 3,
        "BRONZE" => 2, "IRON" => 1, _ => return None,
    })
}

// ---------- 英雄静态信息 ----------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChampionBase {
    /// heroId 在 hero_list.js 中是字符串（如 "1"），需兼容数字/字符串
    #[serde(deserialize_with = "de_i64_any")]
    pub hero_id: i64,
    /// 称号，如「黑暗之女」
    pub name: String,
    /// 常用名，如「安妮」
    pub title: String,
    /// 英文名，如「Annie」
    pub alias: String,
    pub roles: Vec<String>,
}

fn de_i64_any<'de, D>(d: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = Value::deserialize(d)?;
    match v {
        Value::Number(n) => n.as_i64().ok_or_else(|| serde::de::Error::custom("expected i64")),
        Value::String(s) => s.parse().map_err(|_| serde::de::Error::custom("expected i64 string")),
        _ => Err(serde::de::Error::custom("expected number or string")),
    }
}

/// 展示用英雄名：国服 hero_list 的 title 即常用名
pub fn hero_display_name(h: Option<&ChampionBase>, hero_id: i64) -> String {
    h.map(|x| x.title.clone()).unwrap_or_else(|| hero_id.to_string())
}

// ---------- 榜单 ----------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChampionStat {
    pub rank: i64,
    pub hero_id: i64,
    /// 强度等级 T0~T4
    pub tier: String,
    pub lane: String,
    pub win_rate: f64,
    pub pick_rate: f64,
    pub ban_rate: f64,
    pub counters: Vec<i64>,
    pub rank_change: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfrontRow {
    pub hero_id: i64,
    pub win_rate: f64,
    pub rank: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfrontStats {
    pub high: Vec<ConfrontRow>,
    pub low: Vec<ConfrontRow>,
}

// ---------- 海克斯大乱斗 ----------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AugmentInfo {
    /// 接口字段为 augmentID（其余字段名与接口一致：name_cn/name_en/small_Icon/large_Icon）
    #[serde(rename = "augmentID")]
    pub augment_id: i64,
    pub name_cn: String,
    pub name_en: String,
    /// kSilver / kGold / kPrismatic
    pub level: String,
    pub tooltip: String,
    #[serde(rename = "small_Icon")]
    pub small_icon: String,
    #[serde(rename = "large_Icon")]
    pub large_icon: String,
}

impl AugmentInfo {
    /// 与 TS 的 `?? { augmentID, name_cn: 牌#id, ... }` 兜底一致
    pub fn fallback(id: i64) -> Self {
        AugmentInfo {
            augment_id: id,
            name_cn: format!("牌#{id}"),
            name_en: String::new(),
            level: String::new(),
            tooltip: String::new(),
            small_icon: String::new(),
            large_icon: String::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerRow {
    pub hero_id: i64,
    pub pick_rate: f64,
    pub win_rate: f64,
    pub rank: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HextechHeroStat {
    pub hero_id: i64,
    pub rank: i64,
    pub rank_change_desc: String,
    /// 胜率 0.5773 = 57.73%
    pub win_rate: f64,
    pub pick_rate: f64,
    pub best_partners: Vec<PartnerRow>,
    pub avg_death_time: f64,
    pub avg_participation_rate: f64,
    pub avg_damage_ratio: f64,
    pub avg_tank_ratio: f64,
    pub best_augments: Vec<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HextechRuneStat {
    pub augment_id: i64,
    pub pick_rate: f64,
    pub pick_rank: i64,
    pub pick_rank_change: i64,
    pub win_rate: f64,
    pub win_rank: i64,
    pub win_rank_change: i64,
    pub best_heroes: Vec<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VersionInfo {
    pub id: String,
    pub name: String,
    pub title: String,
    pub public_date: String,
}

// ---------- pick / ban 推荐 ----------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickRecommendation {
    pub hero_id: i64,
    pub title: String,
    pub alias: String,
    pub win_rate: f64,
    pub tier: String,
    pub lane: String,
    pub counters: Vec<String>,
    pub counter_count: i64,
    pub matchups: Vec<MatchupRow>,
    pub score: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchupRow {
    pub enemy_title: String,
    pub win_rate: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BanRecommendation {
    pub hero_id: i64,
    pub title: String,
    pub alias: String,
    pub win_rate: f64,
    pub pick_rate: f64,
    pub ban_rate: f64,
    pub tier: String,
    pub lane: String,
    pub threatens_count: i64,
    pub threatens: Vec<String>,
    pub matchups: Vec<BanMatchupRow>,
    pub score: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BanMatchupRow {
    pub my_title: String,
    pub win_rate: f64,
}

// ---------- 海克斯推荐 ----------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AugmentPick {
    pub augment: AugmentInfo,
    pub win_rate: f64,
    pub pick_rate: f64,
    pub win_rank: i64,
    pub pick_rank: i64,
    pub best_heroes: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BestAugment {
    pub name_cn: String,
    pub win_rate: f64,
    pub pick_rate: f64,
    pub win_rank: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BestPartner {
    pub hero_id: i64,
    pub title: String,
    pub alias: String,
    pub win_rate: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeroAugmentSuggestion {
    pub hero_id: i64,
    pub title: String,
    pub alias: String,
    pub win_rate: f64,
    pub pick_rate: f64,
    pub rank: i64,
    pub best_augments: Vec<BestAugment>,
    pub best_partners: Vec<BestPartner>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerRankRow {
    pub hero_id: i64,
    pub hero_title: String,
    pub hero_alias: String,
    pub partner_id: i64,
    pub partner_title: String,
    pub partner_alias: String,
    pub win_rate: f64,
    pub pick_rate: f64,
}

// ---------- 海克斯牌选择评级 ----------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AugmentChoice {
    pub augment_id: i64,
    pub name: String,
    pub level: String,
    pub win_rate: f64,
    pub pick_rate: f64,
    pub best_heroes: Vec<String>,
    pub matched_heroes: Vec<String>,
    pub score: f64,
    pub grade: String,
}

pub fn grade_of(score: f64) -> &'static str {
    if score >= 56.0 { "S" } else if score >= 53.0 { "A" } else if score >= 50.5 { "B" } else if score >= 48.5 { "C" } else { "D" }
}

// ---------- 对局模式 ----------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GameMode {
    RankedSolo,
    RankedFlex,
    Aram,
    HextechAram,
    Normal,
    Other,
}

impl GameMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            GameMode::RankedSolo => "ranked_solo",
            GameMode::RankedFlex => "ranked_flex",
            GameMode::Aram => "aram",
            GameMode::HextechAram => "hextech_aram",
            GameMode::Normal => "normal",
            GameMode::Other => "other",
        }
    }
}

/// 队列 id -> 模式族（同族合并统计/过滤）
pub fn queue_family(queue_id: i64) -> String {
    match queue_id {
        420 | 440 => "ranked".into(),
        2400 | 2410 => "hextech_aram".into(),
        450 => "aram".into(),
        430 | 400 | 490 => "normal".into(),
        other => other.to_string(),
    }
}

/// 队列 id → 模式/中文名（未知 id 视为海克斯大乱斗）
pub fn queue_to_mode(queue_id: i64) -> (GameMode, &'static str) {
    match queue_id {
        420 => (GameMode::RankedSolo, "单双排"),
        440 => (GameMode::RankedFlex, "灵活排位"),
        450 => (GameMode::Aram, "普通大乱斗"),
        430 | 400 | 490 => (GameMode::Normal, "匹配"),
        2400 => (GameMode::HextechAram, "海克斯大乱斗"),
        _ => (GameMode::HextechAram, "海克斯大乱斗"),
    }
}

pub fn is_ranked_mode(mode: GameMode) -> bool {
    matches!(mode, GameMode::RankedSolo | GameMode::RankedFlex)
}

pub fn is_hextech_mode(mode: GameMode) -> bool {
    matches!(mode, GameMode::HextechAram)
}

// ---------- 战绩评估 ----------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerVerdict {
    pub score: i64,
    pub verdict: String,
    pub total_games: i64,
    pub win_rate: f64,
    pub mode_win_rate: Option<f64>,
    pub kda: f64,
    pub mode_games: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ByTypeVerdict {
    pub ranked: Option<PlayerVerdict>,
    pub hextech: Option<PlayerVerdict>,
    pub ranked_last_days: Option<i64>,
    pub hextech_last_days: Option<i64>,
    pub overall_last_days: Option<i64>,
}

// ---------- 小工具 ----------

pub fn to_json_opt<T: serde::Serialize>(v: &Option<T>) -> Value {
    match v {
        Some(x) => serde_json::to_value(x).unwrap_or(Value::Null),
        None => Value::Null,
    }
}

pub fn json_null() -> Value {
    Value::Null
}

pub fn ok_json(data: Value) -> Value {
    json!({ "ok": true, "data": data })
}
