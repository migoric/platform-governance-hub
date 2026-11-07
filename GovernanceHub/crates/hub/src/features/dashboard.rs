//! 总览：4 个 KPI + 「最该介入」清单。
//!
//! 唯一的问题是「今天必须处置哪几条」，所以 KPI 之外只放两组：最旧的 blocker 与最旧的 required。
//! 数字全部来自 `Dashboard`（Selector），这里一个 `filter` 都不写。

use crate::models::format;
use crate::models::{Severity, Snapshot};
use crate::state::selector::Dashboard;
use crate::ui::tokens::{radius, space, text, Weight};
use crate::ui::{kit, Kind, Node};

use super::ViewCtx;

pub fn build(ctx: &ViewCtx) -> Node {
    let palette = ctx.palette;
    let snapshot = match ctx.store.snapshot.as_ref() {
        Some(snapshot) => snapshot,
        None => return empty(ctx),
    };
    let dashboard = Dashboard::new(snapshot);
    let kpis = dashboard.kpis();
    let body = Node::new(Kind::Column)
        .gap(space::LG)
        .child(kpi_row(ctx, &kpis))
        .child(kit::section_title(&palette, "最该介入"))
        .child(intervene_list(ctx, &dashboard))
        .child(kit::section_title(&palette, "范围"))
        .child(scope_line(ctx, snapshot));

    kit::panel(
        &palette,
        "总览",
        &format!("{} · 快照 {}", ctx.store.provenance_line(), snapshot.generated_at),
        body,
    )
}

fn kpi_row(ctx: &ViewCtx, kpis: &crate::state::Kpis) -> Node {
    let palette = ctx.palette;
    Node::row(Kind::KpiRow)
        .gap(space::MD)
        .child(kit::kpi(
            &palette,
            "商品",
            &kpis.items.to_string(),
            "本次快照的范围",
        ))
        .child(kit::kpi(
            &palette,
            "问题条目",
            &kpis.findings.to_string(),
            "含已处置",
        ))
        .child(kit::kpi(
            &palette,
            "阻断",
            &kpis.blocker.to_string(),
            "必须先处理",
        ))
        .child(kit::kpi(
            &palette,
            "判不了",
            &kpis.unjudged.to_string(),
            "不算通过",
        ))
}

/// 3 条 blocker + 3 条最旧 required。空的时候要说清为什么空。
fn intervene_list(ctx: &ViewCtx, dashboard: &Dashboard) -> Node {
    let palette = ctx.palette;
    let picks = dashboard.must_intervene();
    if picks.is_empty() {
        return kit::empty_state(
            &palette,
            "没有待处置的阻断项",
            "要么这批真的干净，要么规则还没跑 —— 看上面的「判不了」条数",
        );
    }
    let rows: Vec<Node> = picks
        .into_iter()
        .map(|finding| {
            let severity = finding.severity;
            kit::glass(
                &palette,
                Node::new(Kind::Row)
                    .gap(space::SM)
                    .pad(space::SM)
                    .radius(radius::MD)
                    .child(kit::severity_badge(&palette, severity))
                    .child(
                        Node::label(dashboard.sku_of(&finding.item_id).to_string())
                            .size(text::MONO)
                            .mono()
                            .color(palette.text_secondary)
                            .width(150.0),
                    )
                    .child(
                        Node::label(finding.message.clone())
                            .size(text::BODY)
                            .color(palette.text_primary)
                            .grow(),
                    )
                    .child(
                        Node::label(format!("「{}」{}", finding.evidence.quote, dashboard.evidence_ref(finding)))
                            .size(text::CAPTION)
                            .color(palette.text_tertiary),
                    ),
            )
            .pad(0.0)
        })
        .collect();
    Node::new(Kind::Column)
        .gap(space::SM)
        .data("dashboard.must_intervene", picks_total(dashboard))
        .children(rows)
}

fn picks_total(dashboard: &Dashboard) -> usize {
    dashboard.must_intervene().len()
}

fn scope_line(ctx: &ViewCtx, snapshot: &Snapshot) -> Node {
    let palette = ctx.palette;
    let line = format!(
        "{} · 站点 {} · 类目 {} · 规则 {} 条（{} 个包）· 严重度 {}",
        snapshot.scope.platform,
        format::sites(&snapshot.scope.sites),
        snapshot.scope.categories.join(" / "),
        snapshot.summary.rules_evaluated,
        snapshot.summary.rule_packs,
        format::severity_line(
            snapshot.summary.by_severity.blocker,
            snapshot.summary.by_severity.required,
            snapshot.summary.by_severity.suggest,
            snapshot.summary.by_severity.observe,
        )
    );
    Node::new(Kind::Row)
        .axis(crate::ui::Axis::Column)
        .child(
            Node::label(line)
                .size(text::CAPTION)
                .color(palette.text_secondary),
        )
        .child(
            Node::label(format!("来源 {}", snapshot.source.kind))
                .size(text::CAPTION)
                .color(palette.text_tertiary)
                .weight(Weight::Regular),
        )
}

fn empty(ctx: &ViewCtx) -> Node {
    let palette = ctx.palette;
    kit::panel(
        &palette,
        "总览",
        "还没有快照",
        kit::empty_state(
            &palette,
            "尚无数据，点这里采集",
            "快照由 sidecar 生成：pgh snapshot --mock > ~/.pgh/snapshot.json",
        ),
    )
}

/// 供单测断言用：总览里必须四个严重度都出现在同一行摘要里。
pub const SUMMARY_SEVERITIES: [Severity; 4] = Severity::ALL;
