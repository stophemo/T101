// 海克斯大乱斗：游戏内海克斯牌选择推荐（对应 src/services/augments.ts）
// 评分 = 牌榜胜率 + 阵容适配加分（牌榜 bestHeroes 命中我方英雄数），输出 S/A/B/C/D 等级

use crate::cn101::cn;
use crate::hextech::augment_level_name;
use crate::models::*;
use std::collections::{HashMap, HashSet};

/// 每个命中我方阵容的英雄加分（牌榜 top4 适配）
pub const MATCH_BONUS: f64 = 1.2;

/// 纯函数：给定可选牌 + 我方阵容，输出分级推荐（按综合分降序）
pub fn grade_augment_choices(
    option_ids: &[i64],
    my_hero_ids: &[i64],
    stats: &[HextechRuneStat],
    augments: &HashMap<i64, AugmentInfo>,
    hero_titles: &HashMap<i64, String>,
) -> Vec<AugmentChoice> {
    let my: HashSet<i64> = my_hero_ids.iter().copied().collect();
    let stat_map: HashMap<i64, &HextechRuneStat> = stats.iter().map(|s| (s.augment_id, s)).collect();
    let mut seen = HashSet::new();
    let mut list: Vec<AugmentChoice> = Vec::new();
    for id in option_ids {
        if !seen.insert(*id) {
            continue;
        }
        let s = stat_map.get(id).copied();
        let a = augments.get(id);
        let win_rate = s.map(|s| (s.win_rate * 100.0 * 100.0).round() / 100.0).unwrap_or(f64::NAN);
        let best = s.map(|s| s.best_heroes.clone()).unwrap_or_default();
        let matched: Vec<i64> = best.iter().filter(|h| my.contains(h)).copied().collect();
        let score = (if win_rate.is_finite() { win_rate } else { 0.0 }) + matched.len() as f64 * MATCH_BONUS;
        let title_of = |id: i64| hero_titles.get(&id).cloned().unwrap_or_else(|| format!("#{id}"));
        list.push(AugmentChoice {
            augment_id: *id,
            name: a.map(|x| x.name_cn.clone()).unwrap_or_else(|| format!("牌#{id}")),
            level: augment_level_name(a.map(|x| x.level.as_str()).unwrap_or("")).to_string(),
            win_rate,
            pick_rate: s.map(|s| (s.pick_rate * 100.0 * 100.0).round() / 100.0).unwrap_or(f64::NAN),
            best_heroes: best.iter().map(|h| title_of(*h)).collect(),
            matched_heroes: matched.iter().map(|h| title_of(*h)).collect(),
            score: (score * 100.0).round() / 100.0,
            grade: grade_of(score).to_string(),
        });
    }
    list.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    list
}

/// 网络版：拉取牌榜/牌表/英雄表后评分
pub async fn recommend_augment_choices(option_ids: &[i64], my_hero_ids: &[i64]) -> Result<Vec<AugmentChoice>, String> {
    let (stats, augments, heroes) = tokio::join!(
        cn().get_hextech_rune_rank(None, false),
        cn().get_augment_list(false),
        cn().get_hero_list(false),
    );
    let (stats, augments, heroes) = (stats?, augments?, heroes?);
    let hero_titles: HashMap<i64, String> = heroes.iter().map(|(id, h)| (*id, h.title.clone())).collect();
    Ok(grade_augment_choices(option_ids, my_hero_ids, &stats, &augments, &hero_titles))
}

/// 按名称关键词模糊匹配牌（中文/英文）
pub async fn search_augments(q: &str) -> Result<Vec<AugmentInfo>, String> {
    let augments = cn().get_augment_list(false).await?;
    let key = q.trim().to_lowercase();
    if key.is_empty() {
        return Ok(Vec::new());
    }
    Ok(augments.values().filter(|a| {
        a.name_cn.contains(&key) || a.name_en.to_lowercase().contains(&key)
    }).cloned().collect())
}
