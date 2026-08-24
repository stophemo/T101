// 海克斯大乱斗推荐（对应 src/services/hextech.ts）：选英雄推荐 + 选海克斯牌推荐

use crate::cn101::cn;
use crate::models::*;
use std::collections::HashMap;

/// 展示用胜率：接口返回 0.5773 表示 57.73%
pub fn to_pct(v: f64) -> f64 {
    (v * 100.0 * 100.0).round() / 100.0
}

/// 品质显示名
pub fn augment_level_name(level: &str) -> String {
    match level {
        "kSilver" => "白银".to_string(),
        "kGold" => "黄金".to_string(),
        "kPrismatic" => "棱彩".to_string(),
        _ => level.to_string(),
    }
}

/// 选牌推荐：全牌榜按胜率排序（带品质、适用英雄）
pub async fn recommend_augments(top_n: i64) -> Result<Vec<AugmentPick>, String> {
    let (runes, augments, heroes) = tokio::join!(
        cn().get_hextech_rune_rank(None, false),
        cn().get_augment_list(false),
        cn().get_hero_list(false),
    );
    let (runes, augments, heroes) = (runes?, augments?, heroes?);
    let mut sorted = runes.clone();
    sorted.sort_by(|a, b| b.win_rate.partial_cmp(&a.win_rate).unwrap_or(std::cmp::Ordering::Equal));
    Ok(sorted.into_iter().take(top_n.max(0) as usize).map(|r| AugmentPick {
        augment: augments.get(&r.augment_id).cloned().unwrap_or_else(|| AugmentInfo::fallback(r.augment_id)),
        win_rate: to_pct(r.win_rate),
        pick_rate: to_pct(r.pick_rate),
        win_rank: r.win_rank,
        pick_rank: r.pick_rank,
        best_heroes: r.best_heroes.iter().take(4).map(|id| hero_display_name(heroes.get(id), *id)).collect(),
    }).collect())
}

/// 选英雄推荐：海克斯大乱斗英雄榜（胜率排序），附推荐海克斯牌与搭档
pub async fn recommend_hextech_heroes(top_n: i64) -> Result<Vec<HeroAugmentSuggestion>, String> {
    let (heroes, augments, list, runes) = tokio::join!(
        cn().get_hero_list(false),
        cn().get_augment_list(false),
        cn().get_hextech_hero_rank(None, false),
        cn().get_hextech_rune_rank(None, false),
    );
    let (heroes, augments, list, runes) = (heroes?, augments?, list?, runes.ok().unwrap_or_default());
    let rune_win: HashMap<i64, f64> = runes.iter().map(|r| (r.augment_id, to_pct(r.win_rate))).collect();
    let rune_pick: HashMap<i64, f64> = runes.iter().map(|r| (r.augment_id, to_pct(r.pick_rate))).collect();
    let rune_rank: HashMap<i64, i64> = runes.iter().map(|r| (r.augment_id, r.win_rank)).collect();

    let mut sorted = list.clone();
    sorted.sort_by(|a, b| b.win_rate.partial_cmp(&a.win_rate).unwrap_or(std::cmp::Ordering::Equal));
    Ok(sorted.into_iter().take(top_n.max(0) as usize).map(|h| {
        let best_augments = h.best_augments.iter().take(3).map(|id| {
            let a = augments.get(id).cloned().unwrap_or_else(|| AugmentInfo::fallback(*id));
            BestAugment {
                name_cn: a.name_cn,
                win_rate: rune_win.get(id).copied().unwrap_or(0.0),
                pick_rate: rune_pick.get(id).copied().unwrap_or(0.0),
                win_rank: rune_rank.get(id).copied().unwrap_or(0),
            }
        }).collect();
        let mut partners: Vec<&PartnerRow> = h.best_partners.iter().collect();
        partners.sort_by(|a, b| b.win_rate.partial_cmp(&a.win_rate).unwrap_or(std::cmp::Ordering::Equal));
        let best_partners = partners.into_iter().take(3).map(|p| BestPartner {
            hero_id: p.hero_id,
            title: hero_display_name(heroes.get(&p.hero_id), p.hero_id),
            alias: heroes.get(&p.hero_id).map(|h| h.alias.clone()).unwrap_or_default(),
            win_rate: to_pct(p.win_rate),
        }).collect();
        HeroAugmentSuggestion {
            hero_id: h.hero_id,
            title: hero_display_name(heroes.get(&h.hero_id), h.hero_id),
            alias: heroes.get(&h.hero_id).map(|h| h.alias.clone()).unwrap_or_default(),
            win_rate: to_pct(h.win_rate),
            pick_rate: to_pct(h.pick_rate),
            rank: h.rank,
            best_augments,
            best_partners,
        }
    }).collect())
}

/// 最佳拍档榜：聚合官方英雄榜的搭档数据，按组合胜率排序
pub async fn recommend_hextech_partners(top_n: i64) -> Result<Vec<PartnerRankRow>, String> {
    let (heroes, list) = tokio::join!(
        cn().get_hero_list(false),
        cn().get_hextech_hero_rank(None, false),
    );
    let (heroes, list) = (heroes?, list?);
    let mut rows: Vec<PartnerRankRow> = Vec::new();
    for h in &list {
        for p in &h.best_partners {
            rows.push(PartnerRankRow {
                hero_id: h.hero_id,
                hero_title: hero_display_name(heroes.get(&h.hero_id), h.hero_id),
                hero_alias: heroes.get(&h.hero_id).map(|x| x.alias.clone()).unwrap_or_default(),
                partner_id: p.hero_id,
                partner_title: hero_display_name(heroes.get(&p.hero_id), p.hero_id),
                partner_alias: heroes.get(&p.hero_id).map(|x| x.alias.clone()).unwrap_or_default(),
                win_rate: to_pct(p.win_rate),
                pick_rate: to_pct(p.pick_rate),
            });
        }
    }
    rows.sort_by(|a, b| b.win_rate.partial_cmp(&a.win_rate).unwrap_or(std::cmp::Ordering::Equal));
    rows.truncate(top_n.max(0) as usize);
    Ok(rows)
}
