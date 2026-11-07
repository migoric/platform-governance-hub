//! 规则库：哪些包在生效、每条规则到底吵不吵、判不了都是为什么。
//!
//! 包里有什么（规则标题、条款原文）不在快照里 —— 快照只存 `ruleId / ruleVersion / rulePacks`，
//! 规则正文在 `~/.pgh/packs/`。所以这里显示的是**包级信息 + 命中战绩**，不假装能看到规则全文。

use crate::state::selector::RuleLibrary;
use crate::ui::tokens::{space, text, Weight};
use crate::ui::{kit, Axis, Kind, Node};

use super::ViewCtx;

const COL_PACK: f32 = 220.0;
const COL_VERSION: f32 = 110.0;
const COL_COUNT: f32 = 56.0;
const COL_RULE: f32 = 320.0;

pub fn build(ctx: &ViewCtx) -> Node {
    let palette = ctx.palette;
    let snapshot = match ctx.store.snapshot.as_ref() {
        Some(snapshot) => snapshot,
        None => {
            return kit::panel(
                &palette,
                "规则库与证据",
                "还没有快照",
                kit::empty_state(&palette, "尚无数据，点这里采集", "规则跑过一次之后才有命中数"),
            )
        }
    };

    let library = RuleLibrary::new(snapshot);
    let packs = library.packs();
    let stats = library.stats();
    let reasons = library.unjudged_by_reason();

    let mut body = Node::new(Kind::Column)
        .gap(space::MD)
        .child(kit::section_title(&palette, "规则包"))
        .child(
            Node::new(Kind::RulePackTable)
                .gap(space::XS)
                .data("rulePacks", packs.len())
                .child(pack_header(ctx))
                .children(packs.iter().map(|pack| pack_row(ctx, pack))),
        )
        .child(kit::divider(&palette))
        .child(kit::section_title(
            &palette,
            &format!("命中分布（{} 条规则有战绩）", stats.len()),
        ));

    body = if stats.is_empty() {
        body.child(kit::empty_state(
            &palette,
            "还没有命中",
            "规则跑过、且至少命中一次之后这里才有内容",
        ))
    } else {
        body.child(
            Node::new(Kind::RuleStatTable)
                .gap(space::XS)
                .data("ruleStats", stats.len())
                .child(stat_header(ctx))
                .children(stats.iter().map(|stat| stat_row(ctx, stat))),
        )
    };

    body = body
        .child(kit::divider(&palette))
        .child(kit::section_title(
            &palette,
            &format!("判不了的原因（{} 条）", snapshot.summary.unjudged),
        ));

    body = if reasons.is_empty() {
        body.child(kit::empty_state(
            &palette,
            "没有待判",
            "每条规则都给出了结论 —— 这不等于商品都合规，只是没有判不了的",
        ))
    } else {
        body.child(
            Node::new(Kind::Column)
                .gap(space::XS)
                .data("unjudgedReasons", reasons.len())
                .children(reasons.iter().map(|(reason, count)| {
                    Node::new(Kind::ReasonRow)
                        .axis(Axis::Row)
                        .gap(space::SM)
                        .pad_top(space::XS)
                        .child(
                            Node::label(reason_label(reason))
                                .size(text::CAPTION)
                                .color(palette.text_secondary)
                                .width(160.0),
                        )
                        .child(
                            Node::label(reason.to_string())
                                .size(text::MONO)
                                .mono()
                                .color(palette.text_tertiary)
                                .width(200.0),
                        )
                        .child(
                            Node::label(format!("{count} 条"))
                                .size(text::MONO)
                                .mono()
                                .color(palette.state_awaiting),
                        )
                })),
        )
    };

    // 出处未核实的包数要出现在标题栏：这是「结论能追到什么」的前提，不该藏在表格里
    let unverified = packs.iter().filter(|pack| pack.source_is_unverified()).count();
    let subtitle = if unverified == 0 {
        format!(
            "{} 个包 · {} 条规则 · 命中 {} 条 · 待判 {} 条",
            packs.len(),
            snapshot.summary.rules_evaluated,
            snapshot.summary.findings,
            snapshot.summary.unjudged
        )
    } else {
        format!(
            "{} 个包（{} 个出处未核实） · {} 条规则 · 命中 {} 条 · 待判 {} 条",
            packs.len(),
            unverified,
            snapshot.summary.rules_evaluated,
            snapshot.summary.findings,
            snapshot.summary.unjudged
        )
    };

    kit::panel(&palette, "规则库与证据", &subtitle, body)
}

/// `reason` 是 sidecar 的封闭集；这里只做展示映射，遇到不认识的原样显示 —— 不猜，也不吞。
fn reason_label(reason: &str) -> &str {
    match reason {
        "requires_semantic" => "需语义判定",
        "requires_manual" => "需人工核对",
        "dict_missing" => "词典缺失",
        "pattern_rejected" => "正则被拒绝",
        "check_type_unsupported" => "判据未实现",
        "check_threw" => "判据异常",
        "field_missing" => "字段不存在",
        "field_not_string" => "字段不是文本",
        "field_not_array" => "字段不是数组",
        "value_not_string" => "值不是文本",
        other => other,
    }
}

fn pack_row(ctx: &ViewCtx, pack: &crate::models::RulePack) -> Node {
    let palette = ctx.palette;
    Node::new(Kind::RulePackRow)
        .axis(Axis::Row)
        .gap(space::SM)
        .pad_top(space::SM)
        .child(
            Node::label(pack.id.clone())
                .size(text::BODY)
                .weight(Weight::Medium)
                .color(palette.text_primary)
                .width(COL_PACK),
        )
        .child(
            Node::label(pack.version.clone())
                .size(text::MONO)
                .mono()
                .color(palette.text_secondary)
                .width(COL_VERSION),
        )
        .child(
            Node::label(format!("{} 条", pack.rule_count))
                .size(text::MONO)
                .mono()
                .color(palette.text_secondary)
                .width(COL_COUNT),
        )
        .child(
            Node::label(format!("{} 起生效", pack.effective_from))
                .size(text::CAPTION)
                .color(palette.text_tertiary),
        )
        .child(match pack.source_label() {
            // 已核实是常态，不用标签打扰；未核实与未知都必须写在脸上
            Some(label) => kit::tag(
                &palette,
                label,
                if pack.source_status == "draft" {
                    palette.state_awaiting
                } else {
                    palette.text_tertiary
                },
            ),
            None => kit::tag(&palette, "出处已核实", palette.state_done),
        })
}

fn stat_row(ctx: &ViewCtx, stat: &crate::state::selector::RuleStat) -> Node {
    let palette = ctx.palette;
    Node::new(Kind::RuleStatRow)
        .axis(Axis::Row)
        .gap(space::SM)
        .pad_top(space::SM)
        .child(
            Node::label(stat.rule_id.to_string())
                .size(text::MONO)
                .mono()
                .color(palette.text_primary)
                .width(COL_RULE),
        )
        .child(
            Node::label(format!("{}", stat.hits))
                .size(text::MONO)
                .mono()
                .color(palette.text_secondary)
                .width(COL_COUNT),
        )
        .child(
            Node::label(format!("{}", stat.unjudged))
                .size(text::MONO)
                .mono()
                .color(if stat.unjudged > 0 {
                    palette.state_awaiting
                } else {
                    palette.text_tertiary
                })
                .width(COL_COUNT),
        )
        .child(match stat.severity {
            Some(severity) => kit::severity_badge(&palette, severity),
            // 只有待判、没有命中的规则：严重度未知，明确写出来，不借用别的档位
            None => kit::tag(&palette, "未定", palette.text_tertiary),
        })
        .child(
            Node::label(stat.version.to_string())
                .size(text::CAPTION)
                .color(palette.text_tertiary),
        )
}

fn pack_header(ctx: &ViewCtx) -> Node {
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
        .child(header("包").width(COL_PACK))
        .child(header("版本").width(COL_VERSION))
        .child(header("条数").width(COL_COUNT))
        .child(header("生效期"))
        .child(header("出处"))
}

fn stat_header(ctx: &ViewCtx) -> Node {
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
        .child(header("规则").width(COL_RULE))
        .child(header("命中").width(COL_COUNT))
        .child(header("待判").width(COL_COUNT))
        .child(header("严重度"))
        .child(header("版本"))
}

#[cfg(test)]
mod tests {
    use crate::ui::tokens::LIGHT;
    use super::*;
    use crate::state::store::fixtures_dir;
    use crate::state::Store;

    fn tree() -> Node {
        let store = Store::from_fixtures(fixtures_dir());
        let ctx = ViewCtx::new(&store, LIGHT);
        build(&ctx)
    }

    #[test]
    fn 三个包与总数都在() {
        let text = tree().visible_text().join("\n");
        assert!(text.contains("3 个包（3 个出处未核实） · 23 条规则"), "{text}");
        assert!(text.contains("baseline"));
        assert!(text.contains("category-certs"));
        assert!(text.contains("eu-market"));
    }

    #[test]
    fn 出处未核实要在标题栏和每一行都写出来() {
        let tree = tree();
        let text = tree.visible_text().join("\n");
        // 标题栏：一眼看到有几个包没核实
        assert!(text.contains("3 个出处未核实"), "{text}");
        // 每一行：三个包各自带标签，不是一个总括词糊过去
        assert_eq!(
            tree.visible_text().iter().filter(|t| *t == "出处未核实").count(),
            3,
            "{text}",
        );
        assert!(text.contains("出处"), "表头要有这一列");
    }

    #[test]
    fn 待判原因用人话加原始值() {
        let text = tree().visible_text().join("\n");
        assert!(text.contains("需语义判定"));
        assert!(text.contains("requires_semantic"), "原始原因要留着，别只给人话");
        assert!(text.contains("需人工核对"));
    }

    #[test]
    fn 只有待判没有命中的规则不会被写成某个严重度() {
        let text = tree().visible_text().join("\n");
        assert!(text.contains("未定"), "没有命中就没有严重度，不许借用档位");
    }

    #[test]
    fn 规则条数来自快照而不是数表格行() {
        assert_eq!(tree().visible_text().iter().filter(|t| *t == "规则包").count(), 1);
    }
}
