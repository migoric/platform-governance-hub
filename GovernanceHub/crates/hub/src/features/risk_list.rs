//! 风险清单：这批商品违反了哪些规则。
//!
//! 结论与证据同屏（ui-ia.md §4.3）：每一行都带 `quote` 与 `field @offset+len`，
//! 点回原文是 M1 的事，但位置信息现在就得上屏，否则「说了不算」。

use crate::state::selector::Dashboard;
use crate::ui::tokens::{space, text, Weight};
use crate::ui::{kit, Axis, Kind, Node};

use super::ViewCtx;

const SEGMENTS: [&str; 5] = ["全部", "阻断", "必改", "建议", "留意"];
const COL_SEVERITY: f32 = 64.0;
const COL_SKU: f32 = 190.0;
const COL_FIELD: f32 = 120.0;

pub fn build(ctx: &ViewCtx) -> Node {
    let palette = ctx.palette;
    let snapshot = match ctx.store.snapshot.as_ref() {
        Some(snapshot) => snapshot,
        None => {
            return kit::panel(
                &palette,
                "风险清单",
                "还没有快照",
                kit::empty_state(&palette, "尚无数据，点这里采集", "没有快照就没有结论可列"),
            )
        }
    };
    let dashboard = Dashboard::new(snapshot);
    let body = Node::new(Kind::Column)
        .gap(space::MD)
        .child(kit::segment(&palette, &SEGMENTS, 0))
        .child(
            Node::new(Kind::RiskTable)
                .gap(space::XS)
                .data("summary.findings", dashboard.total_findings())
                .child(header_row(ctx))
                .children(dashboard.findings_sorted().into_iter().map(|f| {
                    let severity = f.severity;
                    Node::new(Kind::RiskRow)
                        .axis(Axis::Row)
                        .gap(space::SM)
                        .pad_top(space::SM)
                        .child(kit::severity_badge(&palette, severity).width(COL_SEVERITY))
                        .child(
                            Node::label(dashboard.sku_of(&f.item_id).to_string())
                                .size(text::MONO)
                                .mono()
                                .color(palette.text_secondary)
                                .width(COL_SKU),
                        )
                        .child(
                            Node::label(f.evidence.field.clone())
                                .size(text::MONO)
                                .mono()
                                .color(palette.text_tertiary)
                                .width(COL_FIELD),
                        )
                        .child(
                            Node::label(f.message.clone())
                                .size(text::BODY)
                                .color(palette.text_primary)
                                .grow(),
                        )
                        .child(
                            Node::label(format!("「{}」{}", f.evidence.quote, dashboard.evidence_ref(f)))
                                .size(text::CAPTION)
                                .color(palette.text_tertiary),
                        )
                })),
        );

    kit::panel(
        &palette,
        "风险清单",
        &format!(
            "{} 条 · 按严重度排序 · {} · 规则 {} 条",
            dashboard.total_findings(),
            snapshot.scope.platform,
            snapshot.summary.rules_evaluated
        ),
        body,
    )
}

fn header_row(ctx: &ViewCtx) -> Node {
    let palette = ctx.palette;
    let header = |label: &str| {
        Node::label(label.to_string())
            .size(text::CAPTION)
            .weight(Weight::Medium)
            .color(palette.text_tertiary)
    };
    Node::new(Kind::Row)
        .axis(Axis::Row)
        .gap(space::SM)
        .pad_bottom(space::XS)
        .child(header("严重度").width(COL_SEVERITY))
        .child(header("商品").width(COL_SKU))
        .child(header("字段").width(COL_FIELD))
        .child(header("问题").grow())
        .child(header("证据"))
}
