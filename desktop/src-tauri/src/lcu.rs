// LCU (League Client Update) API 客户端 — 只读使用（对应 src/api/lcu.ts）
// 原理：英雄联盟客户端启动后在 127.0.0.1 开放 HTTPS 端口，凭据在 lockfile 或进程命令行中
// 合规：仅 GET 只读查询，不做任何自动操作

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

// ---------- 连接探测 ----------

#[derive(Clone, Debug)]
pub struct LcuConn {
    pub port: u16,
    pub password: String,
}

fn candidate_lockfiles() -> Vec<PathBuf> {
    let drives = ["C:", "D:", "E:", "F:"];
    let mut paths = Vec::new();
    for d in drives {
        for sub in ["Riot Games\\League of Legends", "Riot Games\\LeagueClient", "腾讯游戏\\英雄联盟", "英雄联盟"] {
            paths.push(PathBuf::from(format!("{d}\\{sub}\\lockfile")));
        }
    }
    paths
}

/// 通过进程命令行拿 --app-port 和 --remoting-auth-token（比 lockfile 更稳，国服适用）
fn probe_process_command_line() -> Option<LcuConn> {
    let out = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "(Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\" -ErrorAction SilentlyContinue).CommandLine",
        ])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let m = text.find("--app-port=")?;
    let rest = &text[m + "--app-port=".len()..];
    let port: u16 = rest.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()?;
    let t = text.find("--remoting-auth-token=")?;
    let rest = &text[t + "--remoting-auth-token=".len()..];
    let token: String = rest.chars().take_while(|c| !c.is_whitespace() && *c != '"').collect();
    if token.is_empty() {
        return None;
    }
    Some(LcuConn { port, password: token })
}

fn parse_lockfile(content: &str) -> Option<LcuConn> {
    let parts: Vec<&str> = content.trim().split(':').collect();
    if parts.len() < 5 {
        return None;
    }
    Some(LcuConn {
        port: parts[2].parse().ok()?,
        password: parts[3].to_string(),
    })
}

fn read_lockfile(path: &std::path::Path) -> Option<LcuConn> {
    let content = std::fs::read_to_string(path).ok()?;
    parse_lockfile(&content)
}

/// 查找 LCU 连接信息；客户端未运行返回 None
pub fn find_lcu_connection() -> Option<LcuConn> {
    if let Ok(env) = std::env::var("T101_LOCKFILE") {
        let p = PathBuf::from(&env);
        if p.exists() {
            if let Some(c) = read_lockfile(&p) {
                return Some(c);
            }
        }
    }
    for lf in candidate_lockfiles() {
        if lf.exists() {
            if let Some(c) = read_lockfile(&lf) {
                return Some(c);
            }
        }
    }
    if let Some(c) = probe_process_command_line() {
        return Some(c);
    }
    None
}

// 探测结果短缓存：面板每 3 秒轮询 lcu/status，避免每次都 spawn PowerShell
static CONN_CACHE: OnceLock<Mutex<Option<(LcuConn, Instant)>>> = OnceLock::new();
const CONN_CACHE_TTL: Duration = Duration::from_secs(30);

pub fn find_lcu_connection_cached() -> Option<LcuConn> {
    let cell = CONN_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cell.lock() {
        if let Some((conn, ts)) = guard.as_ref() {
            if ts.elapsed() < CONN_CACHE_TTL {
                return Some(conn.clone());
            }
        }
    }
    let conn = find_lcu_connection();
    if let Ok(mut g) = cell.lock() {
        *g = conn.clone().map(|c| (c, Instant::now()));
    }
    conn
}

/// 连接失败时立即使缓存失效（客户端可能重启，token 变化）
pub fn invalidate_conn_cache() {
    if let Ok(mut g) = CONN_CACHE.get_or_init(|| Mutex::new(None)).lock() {
        *g = None;
    }
}

// ---------- 请求 ----------

static LCU_HTTP: OnceLock<reqwest::Client> = OnceLock::new();

fn lcu_client() -> &'static reqwest::Client {
    LCU_HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .danger_accept_invalid_certs(true) // LCU 自签证书，仅本机端口
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .expect("lcu reqwest client")
    })
}

/// LCU GET 请求（自签证书，仅对本机端口生效）
pub async fn lcu_get(path: &str) -> Result<Value, String> {
    let conn = find_lcu_connection_cached().ok_or("未检测到英雄联盟客户端（需要先启动游戏客户端）")?;
    let url = format!("https://127.0.0.1:{}{}", conn.port, path);
    let res = lcu_client()
        .get(&url)
        .basic_auth("riot", Some(&conn.password))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            invalidate_conn_cache();
            format!("LCU 连接失败: {e}")
        })?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if status.as_u16() == 404 {
        let extra = body.trim();
        let msg = if extra.is_empty() {
            format!("LCU 接口不存在: {path}")
        } else {
            let slice: String = extra.chars().take(150).collect();
            format!("LCU 接口不存在: {path} — {slice}")
        };
        return Err(msg);
    }
    if status.as_u16() >= 400 {
        let slice: String = body.chars().take(200).collect();
        return Err(format!("LCU HTTP {}: {path} {slice}", status.as_u16()));
    }
    if body.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&body).map_err(|_| body)
}

// ---------- 常用接口 ----------

pub async fn get_gameflow_phase() -> Result<String, String> {
    let v = lcu_get("/lol-gameflow/v1/gameflow-phase").await?;
    Ok(v.as_str().map(|s| s.trim_matches('"').to_string()).unwrap_or_default())
}

pub async fn get_current_summoner() -> Result<Value, String> {
    lcu_get("/lol-summoner/v1/current-summoner").await
}

pub async fn get_summoner(summoner_id: i64) -> Result<Value, String> {
    lcu_get(&format!("/lol-summoner/v1/summoners/{summoner_id}")).await
}

pub fn summoner_display_name(s: &Value) -> String {
    s.get("displayName").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
        .or_else(|| s.get("gameName").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
        .unwrap_or("")
        .to_string()
}

/// 当前登录召唤师的段位 -> itier
pub async fn get_my_tier_id() -> Option<i64> {
    let me = get_current_summoner().await.ok()?;
    let sid = me.get("summonerId").and_then(|v| v.as_i64())?;
    let stats = get_ranked_stats(sid).await?;
    let solo = stats.iter().find(|q| q.queue.contains("RANKED_SOLO")).or_else(|| stats.first())?;
    crate::models::tier_name_to_id(&solo.tier)
}

// ---------- 选人阶段 ----------

pub async fn get_champ_select_session() -> Result<Value, String> {
    lcu_get("/lol-champ-select/v1/session").await
}

// ---------- 加载画面（游戏开始） ----------

pub async fn get_gameflow_session() -> Result<Value, String> {
    lcu_get("/lol-gameflow/v1/session").await
}

/// 段位查询（失败返回 None）
#[derive(Clone, Debug)]
pub struct RankedEntry {
    pub queue: String,
    pub tier: String,
    pub division: String,
    pub lp: i64,
    pub wins: i64,
    pub losses: i64,
}

pub async fn get_ranked_stats(summoner_id: i64) -> Option<Vec<RankedEntry>> {
    let data = lcu_get(&format!("/lol-ranked/v1/ranked-stats/{summoner_id}")).await.ok()?;
    let pick = |e: &Value| -> Option<RankedEntry> {
        let tier = e.get("tier").and_then(|v| v.as_str()).unwrap_or("");
        let division = e.get("division").and_then(|v| v.as_str()).unwrap_or("");
        if tier.is_empty() || tier == "NONE" || division.is_empty() || division == "NA" {
            return None;
        }
        Some(RankedEntry {
            queue: e.get("queueType").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            tier: tier.to_string(),
            division: division.to_string(),
            lp: e.get("leaguePoints").and_then(|v| v.as_i64()).unwrap_or(0),
            wins: e.get("wins").and_then(|v| v.as_i64()).unwrap_or(0),
            losses: e.get("losses").and_then(|v| v.as_i64()).unwrap_or(0),
        })
    };
    let mut result = Vec::new();
    if let Some(e) = data.get("highestRankedEntrySR") {
        if let Some(r) = pick(e) {
            result.push(r);
        }
    }
    if let Some(e) = data.get("highestRankedEntry") {
        if let Some(r) = pick(e) {
            result.push(r);
        }
    }
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

// ---------- 战绩（match-history） ----------

#[derive(Clone, Debug)]
pub struct MatchStat {
    pub game_id: i64,
    pub champion_id: i64,
    pub win: bool,
    pub game_creation: i64,
    pub queue_id: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub duration: i64,
    pub cs: i64,
    pub gold: i64,
    pub vision: i64,
    pub level: i64,
    pub dmg: i64,
    pub taken: i64,
    pub items: Vec<i64>,
    pub augments: Vec<i64>,
    pub players: Option<Vec<MatchPlayer>>,
}

#[derive(Clone, Debug)]
pub struct MatchPlayer {
    pub team_id: i64,
    pub champion_id: i64,
    pub summoner_name: String,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub dmg: i64,
    pub items: Vec<i64>,
    pub augments: Vec<i64>,
    pub win: bool,
    pub is_self: bool,
}

#[derive(Clone, Debug)]
pub struct PlayerRecentStats {
    pub summoner_id: i64,
    pub name: String,
    pub icon: Option<i64>,
    pub total_games: i64,
    pub wins: i64,
    pub kda: (i64, i64, i64),
    pub recent: Vec<MatchStat>,
}

fn stat_items(st: &Value) -> (Vec<i64>, Vec<i64>) {
    let mut items = Vec::new();
    for k in ["item0", "item1", "item2", "item3", "item4", "item5", "item6"] {
        if let Some(v) = st.get(k).and_then(|v| v.as_i64()) {
            if v > 0 {
                items.push(v);
            }
        }
    }
    let mut augments = Vec::new();
    for k in ["playerAugment1", "playerAugment2", "playerAugment3", "playerAugment4", "playerAugment5", "playerAugment6"] {
        if let Some(v) = st.get(k).and_then(|v| v.as_i64()) {
            if v > 0 {
                augments.push(v);
            }
        }
    }
    (items, augments)
}

/// 完整对局详情（10 人）：LCU 仅本地存储当前召唤师参与过的对局；好友场次返回 errorCode → None
async fn fetch_full_game(game_id: i64, self_puuid: &str) -> Option<Vec<MatchPlayer>> {
    let g = lcu_get(&format!("/lol-match-history/v1/games/{game_id}")).await.ok()?;
    if g.get("errorCode").is_some() {
        return None;
    }
    let ps = g.get("participants")?.as_array()?;
    if ps.is_empty() {
        return None;
    }
    let ids = g.get("participantIdentities").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    Some(ps.iter().map(|p| {
        let st = p.get("stats").cloned().unwrap_or(Value::Null);
        let pl = ids.iter().find(|i| i.get("participantId") == p.get("participantId")).and_then(|i| i.get("player").cloned()).unwrap_or(Value::Null);
        let (items, augments) = stat_items(&st);
        MatchPlayer {
            team_id: p.get("teamId").and_then(|v| v.as_i64()).unwrap_or(100),
            champion_id: p.get("championId").and_then(|v| v.as_i64()).unwrap_or(0),
            summoner_name: pl.get("gameName").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
                .or_else(|| pl.get("summonerName").and_then(|v| v.as_str()))
                .unwrap_or("未知").to_string(),
            kills: st.get("kills").and_then(|v| v.as_i64()).unwrap_or(0),
            deaths: st.get("deaths").and_then(|v| v.as_i64()).unwrap_or(0),
            assists: st.get("assists").and_then(|v| v.as_i64()).unwrap_or(0),
            dmg: st.get("totalDamageDealtToChampions").and_then(|v| v.as_i64()).unwrap_or(0),
            items,
            augments,
            win: st.get("win").and_then(|v| v.as_bool()).unwrap_or(false),
            is_self: pl.get("puuid").and_then(|v| v.as_str()).map(|s| s == self_puuid).unwrap_or(false),
        }
    }).collect())
}

/// 查询召唤师近期战绩：排位（420/440）与海克斯大乱斗（2400/2410）各最多 limit 场（15 天内）
pub async fn get_player_recent_stats(summoner_id: i64, opts: &RecentOpts) -> Option<PlayerRecentStats> {
    let s = get_summoner(summoner_id).await.ok()?;
    let puuid = s.get("puuid").and_then(|v| v.as_str())?.to_string();
    let name = if opts.name_hint.is_empty() { summoner_display_name(&s) } else { opts.name_hint.clone() };
    let icon = s.get("profileIconId").and_then(|v| v.as_i64());
    fetch_match_history(&puuid, summoner_id, name, icon, opts).await
}

pub async fn get_player_recent_stats_by_puuid(puuid: &str, opts: &RecentOpts) -> Option<PlayerRecentStats> {
    fetch_match_history(&puuid.replace("@pvp.net", ""), 0, String::new(), None, opts).await
}

#[derive(Default, Clone)]
pub struct RecentOpts {
    pub limit: i64,
    pub max_days: i64,
    pub raw_limit: i64,
    pub mode: Option<String>,
    pub fetch_full: bool,
    pub name_hint: String,
}

impl RecentOpts {
    pub fn new() -> Self {
        RecentOpts { limit: 20, max_days: 15, raw_limit: 100, mode: None, fetch_full: true, name_hint: String::new() }
    }
    pub fn light() -> Self {
        RecentOpts { limit: 20, max_days: 15, raw_limit: 100, mode: None, fetch_full: false, name_hint: String::new() }
    }
    pub fn by_puuid(raw_limit: i64) -> Self {
        RecentOpts { limit: 20, max_days: 15, raw_limit, mode: None, fetch_full: true, name_hint: String::new() }
    }
}

async fn fetch_match_history(puuid: &str, summoner_id: i64, name: String, icon: Option<i64>, opts: &RecentOpts) -> Option<PlayerRecentStats> {
    // 是否查询当前召唤师自己：自己的对局才能拿到完整 10 人详情
    let mut is_self = false;
    if let Ok(me) = lcu_get("/lol-summoner/v1/current-summoner").await {
        if let Some(mep) = me.get("puuid").and_then(|v| v.as_str()) {
            is_self = mep == puuid;
        }
    }
    let raw = lcu_get(&format!(
        "/lol-match-history/v1/products/lol/{puuid}/matches?begIndex=0&endIndex={}",
        opts.raw_limit
    )).await.ok()?;
    let cutoff = now_ms() as i64 - opts.max_days * 86400_000;
    let games = raw.get("games").and_then(|g| g.get("games")).and_then(|g| g.as_array()).cloned().unwrap_or_default();
    let mut recent: Vec<MatchStat> = Vec::new();
    let mut icon_from_games = icon;
    for g in &games {
        let creation = g.get("gameCreation").and_then(|v| v.as_i64()).unwrap_or(0);
        if creation < cutoff {
            continue;
        }
        let identities = g.get("participantIdentities").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let idx = identities.iter().position(|p| {
            let pid = p.get("player").and_then(|pl| pl.get("summonerId")).and_then(|v| v.as_i64());
            let puu = p.get("player").and_then(|pl| pl.get("puuid")).and_then(|v| v.as_str());
            pid == Some(summoner_id) || (summoner_id == 0 && puu == Some(puuid))
        });
        let Some(idx) = idx else { continue };
        if icon_from_games.is_none() {
            if let Some(ic) = identities[idx].get("player").and_then(|pl| pl.get("profileIcon")).and_then(|v| v.as_i64()) {
                icon_from_games = Some(ic);
            }
        }
        let p = g.get("participants").and_then(|v| v.as_array()).and_then(|a| a.get(idx)).cloned();
        let st = p.as_ref().and_then(|p| p.get("stats").cloned()).unwrap_or(Value::Null);
        let Some(queue_id) = g.get("queueId").and_then(|v| v.as_i64()) else { continue };
        if st.is_null() {
            continue;
        }
        let (items, augments) = stat_items(&st);
        recent.push(MatchStat {
            game_id: g.get("gameId").and_then(|v| v.as_i64()).unwrap_or(0),
            champion_id: p.as_ref().and_then(|p| p.get("championId")).and_then(|v| v.as_i64()).unwrap_or(0),
            win: st.get("win").and_then(|v| v.as_bool()).unwrap_or(false),
            game_creation: creation,
            queue_id,
            kills: st.get("kills").and_then(|v| v.as_i64()).unwrap_or(0),
            deaths: st.get("deaths").and_then(|v| v.as_i64()).unwrap_or(0),
            assists: st.get("assists").and_then(|v| v.as_i64()).unwrap_or(0),
            duration: g.get("gameDuration").and_then(|v| v.as_i64()).unwrap_or(0),
            cs: st.get("minionsKilled").and_then(|v| v.as_i64()).unwrap_or(0) + st.get("neutralMinionsKilled").and_then(|v| v.as_i64()).unwrap_or(0),
            gold: st.get("goldEarned").and_then(|v| v.as_i64()).unwrap_or(0),
            vision: st.get("visionScore").and_then(|v| v.as_i64()).unwrap_or(0),
            level: st.get("champLevel").and_then(|v| v.as_i64()).unwrap_or(0),
            dmg: st.get("totalDamageDealtToChampions").and_then(|v| v.as_i64()).unwrap_or(0),
            taken: st.get("totalDamageTaken").and_then(|v| v.as_i64()).unwrap_or(0),
            items,
            augments,
            players: None,
        });
    }
    if recent.is_empty() {
        return None;
    }
    // 排位/海斗各取最近 limit 场，合并后按时间倒序；mode 指定时只保留该模式族
    let family = |q: i64| crate::models::queue_family(q);
    let limit = opts.limit;
    let kept: Vec<MatchStat> = match opts.mode.as_deref() {
        Some("ranked") => {
            let mut v: Vec<MatchStat> = recent.into_iter().filter(|r| family(r.queue_id) == "ranked").take(limit as usize).collect();
            v.sort_by(|a, b| b.game_creation.cmp(&a.game_creation));
            v
        }
        Some("hextech") => {
            let mut v: Vec<MatchStat> = recent.into_iter().filter(|r| family(r.queue_id) == "hextech_aram").take(limit as usize).collect();
            v.sort_by(|a, b| b.game_creation.cmp(&a.game_creation));
            v
        }
        _ => {
            let mut ranked: Vec<MatchStat> = recent.iter().filter(|r| family(r.queue_id) == "ranked").take(limit as usize).cloned().collect();
            let mut hex: Vec<MatchStat> = recent.iter().filter(|r| family(r.queue_id) == "hextech_aram").take(limit as usize).cloned().collect();
            ranked.append(&mut hex);
            ranked.sort_by(|a, b| b.game_creation.cmp(&a.game_creation));
            ranked
        }
    };
    if kept.is_empty() {
        return None;
    }
    // 自己的对局：并发补拉完整 10 人详情（fetch_full=false 时跳过）
    let mut kept = kept;
    if is_self && opts.fetch_full {
        let self_puuid = puuid.to_string();
        let mut with_players = Vec::with_capacity(kept.len());
        for mut g in kept {
            if let Some(players) = fetch_full_game(g.game_id, &self_puuid).await {
                g.players = Some(players);
            }
            with_players.push(g);
        }
        kept = with_players;
    }
    let mut wins = 0;
    let mut kda = (0i64, 0i64, 0i64);
    for r in &kept {
        if r.win {
            wins += 1;
        }
        kda.0 += r.kills;
        kda.1 += r.deaths;
        kda.2 += r.assists;
    }
    Some(PlayerRecentStats {
        summoner_id,
        name: if name.is_empty() { format!("召唤师{}", if summoner_id > 0 { summoner_id.to_string() } else { puuid.chars().take(6).collect::<String>() }) } else { name },
        icon: icon_from_games,
        total_games: kept.len() as i64,
        wins,
        kda,
        recent: kept,
    })
}

// ---------- 其他只读接口 ----------

pub async fn get_ready_check() -> Result<Value, String> {
    lcu_get("/lol-matchmaking/v1/ready-check").await
}

pub async fn get_lobby() -> Result<Value, String> {
    lcu_get("/lol-lobby/v2/lobby").await
}

pub async fn get_friends() -> Result<Value, String> {
    lcu_get("/lol-chat/v1/friends").await
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

// 供 player.rs 使用的序列化辅助
pub fn match_stat_to_json(r: &MatchStat, hero_title: &str, alias: &str, mode_label: &str, aug_names: &[String]) -> Value {
    json!({
        "gameId": r.game_id,
        "championId": r.champion_id,
        "win": r.win,
        "gameCreation": r.game_creation,
        "queueId": r.queue_id,
        "kills": r.kills,
        "deaths": r.deaths,
        "assists": r.assists,
        "duration": r.duration,
        "cs": r.cs,
        "gold": r.gold,
        "vision": r.vision,
        "level": r.level,
        "dmg": r.dmg,
        "taken": r.taken,
        "items": r.items,
        "augments": r.augments,
        "title": hero_title,
        "alias": alias,
        "modeLabel": mode_label,
        "augNames": aug_names,
        "players": r.players.as_ref().map(|ps| {
            ps.iter().map(|p| json!({
                "teamId": p.team_id,
                "championId": p.champion_id,
                "summonerName": p.summoner_name,
                "kills": p.kills,
                "deaths": p.deaths,
                "assists": p.assists,
                "dmg": p.dmg,
                "items": p.items,
                "augments": p.augments,
                "win": p.win,
                "isSelf": p.is_self,
                "alias": "",
                "augNames": [],
            })).collect::<Vec<_>>()
        }),
    })
}
