// 101.qq.com 官方数据接口客户端（国服）— 对应 src/api/cn101.ts
// 缓存策略：
//   - 榜单/对位：按「版本号」存快照；海克斯/大乱斗按「日期」存快照
//   - 版本列表/英雄表/海克斯牌表：滚动 TTL 缓存

use crate::models::*;
use crate::storage;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const BASE: &str = "https://mlol.qt.qq.com";

pub struct Cn101 {
    client: reqwest::Client,
}

static CN: OnceLock<Cn101> = OnceLock::new();

// 静态表内存缓存（模块级）
static AUGMENT_CACHE: OnceLock<Mutex<Option<HashMap<i64, AugmentInfo>>>> = OnceLock::new();
static HERO_LIST_CACHE: OnceLock<Mutex<Option<HashMap<i64, ChampionBase>>>> = OnceLock::new();

pub fn cn() -> &'static Cn101 {
    CN.get_or_init(|| Cn101 {
        client: reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36")
            .build()
            .expect("reqwest client"),
    })
}

impl Cn101 {
    /// 通用 GET：解析 { code, msg?, data:{ result?|_fieldValues? } }
    async fn get(&self, path: &str, params: &[(&str, String)]) -> Result<String, String> {
        let url = reqwest::Url::parse_with_params(&format!("{BASE}{path}"), params)
            .map_err(|e| e.to_string())?;
        let res = self
            .client
            .get(url)
            .header("Referer", "https://101.qq.com/")
            .header("Accept", "application/json, text/plain, */*")
            .send()
            .await
            .map_err(|e| format!("网络请求失败: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("HTTP {}: {}", res.status().as_u16(), path));
        }
        let body: Value = res.json().await.map_err(|e| format!("JSON 解析失败: {e}"))?;
        let code = body.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
        if code != 0 {
        let msg = body.get("msg").and_then(|m| m.as_str()).map(String::from).unwrap_or_else(|| code.to_string());
            return Err(format!("接口错误 {path}: {msg}"));
        }
        let data = body.get("data").cloned().unwrap_or(Value::Null);
        if let Some(r) = data.get("result").and_then(|r| r.as_str()) {
            if !r.is_empty() {
                return Ok(r.to_string());
            }
        }
        if let Some(fv) = data.get("_fieldValues").and_then(|f| f.as_object()) {
            if let Some(v) = fv.values().next() {
                if let Some(s) = v.as_str() {
                    return Ok(s.to_string());
                }
            }
        }
        Ok(String::new())
    }

    // ---------- 版本 ----------

    pub async fn get_versions(&self, force: bool) -> Result<Vec<VersionInfo>, String> {
        let key = "versions";
        if !force {
            if let Some(hit) = storage::cache_get::<Vec<VersionInfo>>(key, 6) {
                return Ok(hit);
            }
        }
        let url = format!("{BASE}/go/database/versionlist?zone=lol&from=h5");
        let res = self
            .client
            .get(url)
            .header("Referer", "https://101.qq.com/")
            .header("Accept", "application/json, text/plain, */*")
            .send()
            .await
            .map_err(|e| format!("网络请求失败: {e}"))?;
        let body: Value = res.json().await.map_err(|e| format!("JSON 解析失败: {e}"))?;
        if body.get("code").and_then(|c| c.as_i64()) != Some(0) {
            return Err(format!("versionlist 失败: code={:?}", body.get("code")));
        }
        let list: Vec<VersionInfo> = serde_json::from_value(body.get("data").cloned().unwrap_or(Value::Null))
            .map_err(|e| format!("versionlist 解析失败: {e}"))?;
        storage::cache_set(&key, &list);
        Ok(list)
    }

    async fn latest_version(&self) -> Result<String, String> {
        let versions = self.get_versions(false).await?;
        Ok(versions.first().map(|v| v.name.clone()).unwrap_or_default())
    }

    // ---------- 英雄榜单 ----------

    /// 解析 strategy 接口的管道分隔字符串：rank_heroId_tier_lane_winRate_pickRate_banRate_counters_rankChange
    fn parse_datadetails(raw: &str) -> Vec<ChampionStat> {
        raw.split('#')
            .filter(|l| !l.is_empty())
            .map(|line| {
                let f: Vec<&str> = line.split('_').collect();
                let g = |i: usize| f.get(i).copied().unwrap_or("");
                ChampionStat {
                    rank: g(0).parse().unwrap_or(0),
                    hero_id: g(1).parse().unwrap_or(0),
                    tier: g(2).to_string(),
                    lane: g(3).to_string(),
                    win_rate: g(4).parse().unwrap_or(0.0),
                    pick_rate: g(5).parse().unwrap_or(0.0),
                    ban_rate: g(6).parse().unwrap_or(0.0),
                    counters: g(7).split(',').filter(|s| !s.is_empty() && *s != "NC").filter_map(|s| s.parse().ok()).collect(),
                    rank_change: if g(8) == "NC" { 0 } else { g(8).parse().unwrap_or(0) },
                }
            })
            .collect()
    }

    pub async fn get_champion_rankings(&self, tier: TierId, lane: &str, version: Option<&str>, force: bool) -> Result<Vec<ChampionStat>, String> {
        let version = match version {
            Some(v) => v.to_string(),
            None => self.latest_version().await?,
        };
        let key = format!("rankings:{tier}:{lane}:{version}");
        if !force {
            if let Some((data, _)) = storage::snapshot_get::<Vec<ChampionStat>>(&key) {
                return Ok(data);
            }
        }
        let raw = self
            .get(
                "/go/battle_info/odp_proxy/lol_101strategy",
                &[
                    ("itier", tier.to_string()),
                    ("version_id", version.clone()),
                    ("lane", lane.to_string()),
                    ("sort_metric", "1".into()),
                    ("sort_order", "2".into()),
                    ("zone", "lol".into()),
                    ("from", "h5".into()),
                ],
            )
            .await?;
        if raw.is_empty() {
            return Err("榜单数据为空（接口可能需要重试）".into());
        }
        let parsed = match serde_json::from_str::<Value>(&raw) {
            Ok(obj) => Self::parse_datadetails(obj.get("datadetails").and_then(|d| d.as_str()).unwrap_or("")),
            Err(_) => Self::parse_datadetails(&raw),
        };
        if parsed.is_empty() {
            return Err("榜单数据解析失败".into());
        }
        storage::snapshot_set(&key, &parsed, "101:lol_101strategy", Some(&version), None);
        Ok(parsed)
    }

    // ---------- 对位克制 ----------

    pub async fn get_confront(&self, hero_id: i64, tier: TierId, lane: &str, version: Option<&str>, force: bool) -> Result<ConfrontStats, String> {
        if lane == "ALL" {
            return Err("对位数据必须指定具体位置（TOP/JUNGLE/MIDDLE/BOTTOM/SUPPORT）".into());
        }
        let version = match version {
            Some(v) => v.to_string(),
            None => self.latest_version().await?,
        };
        let key = format!("confront:{hero_id}:{tier}:{lane}:{version}");
        if !force {
            if let Some((data, _)) = storage::snapshot_get::<ConfrontStats>(&key) {
                return Ok(data);
            }
        }
        let raw = self
            .get(
                "/go/battle_info/odp_proxy/lol_101strategy_confront",
                &[
                    ("itier", tier.to_string()),
                    ("championid", hero_id.to_string()),
                    ("lane", lane.to_string()),
                    ("version_id", version.clone()),
                    ("zone", "lol".into()),
                    ("from", "h5".into()),
                ],
            )
            .await?;
        let (mut high, mut low) = (Vec::new(), Vec::new());
        if !raw.is_empty() {
            if let Ok(obj) = serde_json::from_str::<Value>(&raw) {
                let parse = |s: &str| {
                    s.split('#').filter(|l| !l.is_empty()).map(|line| {
                        let f: Vec<&str> = line.split('_').collect();
                        ConfrontRow {
                            rank: f.first().and_then(|x| x.parse().ok()).unwrap_or(0),
                            hero_id: f.get(1).and_then(|x| x.parse().ok()).unwrap_or(0),
                            win_rate: f.get(2).and_then(|x| x.parse().ok()).unwrap_or(0.0),
                        }
                    }).collect::<Vec<_>>()
                };
                high = parse(obj.get("high_op_details").and_then(|d| d.as_str()).unwrap_or(""));
                low = parse(obj.get("low_op_details").and_then(|d| d.as_str()).unwrap_or(""));
            }
        }
        let result = ConfrontStats { high, low };
        storage::snapshot_set(&key, &result, "101:lol_101strategy_confront", Some(&version), None);
        Ok(result)
    }

    // ---------- 大乱斗 / 海克斯大乱斗 ----------

    /// 往前推 n 天的日期 YYYYMMDD
    pub fn days_ago(n: i64) -> String {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
            - n * 86400;
        let d = chrono_from_unix(secs);
        format!("{:04}{:02}{:02}", d.0, d.1, d.2)
    }

    fn parse_aram_hero_list(raw: &str) -> Vec<HextechHeroStat> {
        raw.split('#').filter(|l| !l.is_empty()).map(|line| {
            let s: Vec<&str> = line.split('_').collect();
            let g = |i: usize| s.get(i).copied().unwrap_or("");
            HextechHeroStat {
                hero_id: g(0).parse().unwrap_or(0),
                rank: g(1).parse().unwrap_or(0),
                rank_change_desc: g(2).to_string(),
                win_rate: g(3).parse().unwrap_or(0.0),
                pick_rate: g(4).parse().unwrap_or(0.0),
                best_partners: g(5).split('&').filter(|c| !c.is_empty()).map(|c| {
                    let f: Vec<&str> = c.split(',').collect();
                    PartnerRow {
                        hero_id: f.first().and_then(|x| x.parse().ok()).unwrap_or(0),
                        pick_rate: f.get(1).and_then(|x| x.parse().ok()).unwrap_or(0.0),
                        win_rate: f.get(2).and_then(|x| x.parse().ok()).unwrap_or(0.0),
                        rank: f.get(3).and_then(|x| x.parse().ok()).unwrap_or(0),
                    }
                }).collect(),
                avg_death_time: g(6).parse().unwrap_or(0.0),
                avg_participation_rate: g(7).parse().unwrap_or(0.0),
                avg_damage_ratio: g(8).parse().unwrap_or(0.0),
                avg_tank_ratio: g(9).parse().unwrap_or(0.0),
                best_augments: g(10).split(',').filter_map(|x| x.parse::<i64>().ok()).filter(|n| *n > 0).collect(),
            }
        }).collect()
    }

    /// 海克斯/大乱斗数据当天可能未生成，自动回退到最近有数据的日期
    async fn resolve_date<F, Fut>(&self, fetch: F) -> Result<String, String>
    where
        F: Fn(String) -> Fut,
        Fut: std::future::Future<Output = Result<Option<()>, String>>,
    {
        for i in 0..4 {
            let date = Self::days_ago(i);
            match fetch(date.clone()).await {
                Ok(Some(_)) => return Ok(date),
                _ => continue,
            }
        }
        Err("数据源暂时不可用（近 4 天无数据）".into())
    }

    pub async fn get_hextech_hero_rank(&self, dtstatdate: Option<&str>, force: bool) -> Result<Vec<HextechHeroStat>, String> {
        let date = match dtstatdate {
            Some(d) => d.to_string(),
            None => {
                let c = self;
                let f = force;
                self.resolve_date(|d| async move {
                    let r = c.fetch_hex_hero(&d, f).await?;
                    Ok(r.map(|_| ()))
                }).await?
            }
        };
        self.fetch_hex_hero(&date, force).await?
            .ok_or_else(|| "海克斯大乱斗英雄数据为空".to_string())
    }

    async fn fetch_hex_hero(&self, date: &str, force: bool) -> Result<Option<Vec<HextechHeroStat>>, String> {
        let key = format!("hex_hero:{date}");
        if !force {
            if let Some((data, _)) = storage::snapshot_get::<Vec<HextechHeroStat>>(&key) {
                return Ok(Some(data));
            }
        }
        let raw = self.get(
            "/go/battle_info/odp_proxy/fuwen_aram_hero_rank_v2",
            &[("dtstatdate", date.to_string())],
        ).await?;
        if raw.is_empty() {
            return Ok(None);
        }
        let obj: Value = serde_json::from_str(&raw).map_err(|e| format!("JSON 解析失败: {e}"))?;
        let parsed = Self::parse_aram_hero_list(obj.get("listcollect").and_then(|d| d.as_str()).unwrap_or(""));
        if parsed.is_empty() {
            return Ok(None);
        }
        storage::snapshot_set(&key, &parsed, "101:fuwen_aram_hero_rank_v2", None, Some(date));
        Ok(Some(parsed))
    }

    pub async fn get_hextech_rune_rank(&self, dtstatdate: Option<&str>, force: bool) -> Result<Vec<HextechRuneStat>, String> {
        let date = match dtstatdate {
            Some(d) => d.to_string(),
            None => {
                let c = self;
                let f = force;
                self.resolve_date(|d| async move {
                    let r = c.fetch_hex_rune(&d, f).await?;
                    Ok(r.map(|_| ()))
                }).await?
            }
        };
        self.fetch_hex_rune(&date, force).await?
            .ok_or_else(|| "海克斯牌数据为空".to_string())
    }

    async fn fetch_hex_rune(&self, date: &str, force: bool) -> Result<Option<Vec<HextechRuneStat>>, String> {
        let key = format!("hex_rune:{date}");
        if !force {
            if let Some((data, _)) = storage::snapshot_get::<Vec<HextechRuneStat>>(&key) {
                return Ok(Some(data));
            }
        }
        let raw = self.get(
            "/go/battle_info/odp_proxy/fuwen_aram_rune_rank_v2",
            &[("dtstatdate", date.to_string()), ("augmentid_level", "255".into())],
        ).await?;
        if raw.is_empty() {
            return Ok(None);
        }
        let obj: Value = serde_json::from_str(&raw).map_err(|e| format!("JSON 解析失败: {e}"))?;
        let parsed = obj.get("augmentlist").and_then(|d| d.as_str()).unwrap_or("")
            .split('#').filter(|l| !l.is_empty()).map(|line| {
                let s: Vec<&str> = line.split('_').collect();
                let g = |i: usize| s.get(i).copied().unwrap_or("");
                HextechRuneStat {
                    augment_id: g(0).parse().unwrap_or(0),
                    pick_rate: g(2).parse().unwrap_or(0.0),
                    pick_rank: g(3).parse().unwrap_or(0),
                    pick_rank_change: g(4).parse().unwrap_or(0),
                    win_rate: g(5).parse().unwrap_or(0.0),
                    win_rank: g(6).parse().unwrap_or(0),
                    win_rank_change: g(7).parse().unwrap_or(0),
                    best_heroes: g(8).split(',').filter_map(|x| x.parse::<i64>().ok()).filter(|n| *n > 0).collect(),
                }
            }).collect::<Vec<_>>();
        if parsed.is_empty() {
            return Ok(None);
        }
        storage::snapshot_set(&key, &parsed, "101:fuwen_aram_rune_rank_v2", None, Some(date));
        Ok(Some(parsed))
    }

    // ---------- 静态表 ----------

    pub async fn get_augment_list(&self, force: bool) -> Result<HashMap<i64, AugmentInfo>, String> {
        let cell = AUGMENT_CACHE.get_or_init(|| Mutex::new(None));
        if !force {
            if let Ok(guard) = cell.lock() {
                if let Some(map) = guard.as_ref() {
                    return Ok(map.clone());
                }
            }
        }
        let key = "augment_list";
        if !force {
            if let Some(hit) = storage::cache_get::<Vec<AugmentInfo>>(key, 720) {
                let map: HashMap<i64, AugmentInfo> = hit.into_iter().map(|a| (a.augment_id, a)).collect();
                if let Ok(mut g) = cell.lock() { *g = Some(map.clone()); }
                return Ok(map);
            }
        }
        let res = self
            .client
            .get("https://game.gtimg.cn/images/lol/act/img/js/kiwi/kiwi_augments.json")
            .header("Referer", "https://101.qq.com/")
            .send()
            .await
            .map_err(|e| format!("网络请求失败: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("kiwi_augments HTTP {}", res.status().as_u16()));
        }
        let body: Value = res.json().await.map_err(|e| format!("JSON 解析失败: {e}"))?;
        // 接口可能返回数组（实测）或对象（历史），两者都兼容
        let list: Vec<AugmentInfo> = match body {
            Value::Array(items) => items
                .into_iter()
                .map(|v| serde_json::from_value::<AugmentInfo>(v).map_err(|e| format!("augment 解析失败: {e}")))
                .collect::<Result<_, _>>()?,
            Value::Object(map) => map
                .into_values()
                .map(|v| serde_json::from_value::<AugmentInfo>(v).map_err(|e| format!("augment 解析失败: {e}")))
                .collect::<Result<_, _>>()?,
            _ => return Err("kiwi_augments 结构异常".into()),
        };
        storage::cache_set(&key, &list);
        let map: HashMap<i64, AugmentInfo> = list.into_iter().map(|a| (a.augment_id, a)).collect();
        if let Ok(mut g) = cell.lock() { *g = Some(map.clone()); }
        Ok(map)
    }

    pub async fn get_hero_list(&self, force: bool) -> Result<HashMap<i64, ChampionBase>, String> {
        let cell = HERO_LIST_CACHE.get_or_init(|| Mutex::new(None));
        if !force {
            if let Ok(guard) = cell.lock() {
                if let Some(map) = guard.as_ref() {
                    return Ok(map.clone());
                }
            }
        }
        let key = "hero_list";
        if !force {
            if let Some(hit) = storage::cache_get::<Vec<ChampionBase>>(key, 720) {
                let map: HashMap<i64, ChampionBase> = hit.into_iter().map(|h| (h.hero_id, h)).collect();
                if let Ok(mut g) = cell.lock() { *g = Some(map.clone()); }
                return Ok(map);
            }
        }
        let res = self
            .client
            .get("https://game.gtimg.cn/images/lol/act/img/js/heroList/hero_list.js")
            .header("Referer", "https://101.qq.com/")
            .send()
            .await
            .map_err(|e| format!("网络请求失败: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("hero_list HTTP {}", res.status().as_u16()));
        }
        let text = res.text().await.map_err(|e| format!("读取失败: {e}"))?;
        let body: Value = serde_json::from_str(&text).map_err(|e| format!("JSON 解析失败: {e}"))?;
        let list: Vec<ChampionBase> = serde_json::from_value(body.get("hero").cloned().unwrap_or(Value::Null))
            .map_err(|e| format!("hero 解析失败: {e}"))?;
        storage::cache_set(&key, &list);
        let map: HashMap<i64, ChampionBase> = list.into_iter().map(|h| (h.hero_id, h)).collect();
        if let Ok(mut g) = cell.lock() { *g = Some(map.clone()); }
        Ok(map)
    }

    /// 英雄名 -> id：支持中文常用名、称号、英文、数字 id
    pub async fn resolve_heroes(&self, names: &[String]) -> Result<Vec<(i64, String)>, String> {
        let heroes = self.get_hero_list(false).await?;
        let mut result = Vec::new();
        let mut errors = Vec::new();
        for raw in names {
            let input = raw.trim().to_string();
            if input.is_empty() {
                continue;
            }
            let hit = if let Ok(num) = input.parse::<i64>() {
                heroes.get(&num).cloned()
            } else {
                heroes.values().find(|h| {
                    h.title == input || h.name == input || h.alias.eq_ignore_ascii_case(&input)
                }).cloned()
            };
            match hit {
                Some(h) => result.push((h.hero_id, input)),
                None => errors.push(input),
            }
        }
        if !errors.is_empty() {
            return Err(format!("无法识别的英雄: {}（支持中文名/称号/英文名/ID）", errors.join(", ")));
        }
        Ok(result)
    }
}

fn chrono_from_unix(secs: i64) -> (i64, u32, u32) {
    let days = secs.div_euclid(86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}
