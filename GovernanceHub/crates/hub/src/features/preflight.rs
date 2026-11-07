//! 上架前检查：这一批商品里，哪些能上、哪些得改、哪些还没判。
//!
//! 三态是这张表的全部意义（rule-library §7）：**没有结论 ≠ 通过**。
//! 所以「待判」是独立一列，而且和「需整改」一样往前排 —— 看不清的东西不该被埋在后面。

use crate::state::selector::{ItemVerdict, Preflight, Verdict};
use crate::ui::tokens::{space, text, Weight};
use crate::ui::{kit, Axis, Kind, Node};

use super::ViewCtx;

const SEGMENTS: [&str; 4] = ["全部", "需整改", "待判", "可上架"];
const COL_SKU: f32 = 190.0;
const COL_BADGE: f32 = 76.0;
const COL_COUNT: f32 = 56.0;
const COL_VERDICT: f32 = 72.0;

pub fn build(ctx: &ViewCtx) -> Node {
    let palette = ctx.palette;
    let snapshot = match ctx.store.snapshot.as_ref() {
        Some(snapshot) => snapshot,
        None => {
            return kit::panel(
                &palette,
                "上架前检查",
                "还没有快照",
                kit::empty_state(&palette, "尚无数据，点这里采集", "没有快照就没有商品可检查"),
            )
        }
    };

    let preflight = Preflight::new(snapshot);
    let counts = preflight.counts();
    let rows = preflight.rows();

    let table = Node::new(Kind::PreflightTable)
        .gap(space::XS)
        // 数据源条数：列表将来会虚拟化，行数不可靠，条数可靠
        .data("items", rows.len())
        .child(header_row(ctx))
        .children(rows.iter().map(|row| row_node(ctx, row)));

    let body = Node::new(Kind::Column)
        .gap(space::MD)
        .child(kit::segment(&palette, &SEGMENTS, 0))
        .child(table);

    kit::panel(
        &palette,
        "上架前检查",
        &format!(
            "{} 个商品 · 需整改 {} · 待判 {} · 可上架 {} · 规则 {} 条",
            rows.len(),
            counts.fix,
            counts.unknown,
            counts.pass,
            snapshot.summary.rules_evaluated
        ),
        body,
    )
}

fn row_node(ctx: &ViewCtx, row: &ItemVerdict) -> Node {
    let palette = ctx.palette;
    let verdict = row.verdict();
    let (verdict_color, badge) = match (verdict, row.worst) {
        (Verdict::Fix, Some(severity)) => (palette.severity(severity), kit::severity_badge(&palette, severity)),
        (Verdict::Fix, None) => (palette.state_interrupted, kit::tag(&palette, "有结论", palette.state_interrupted)),
        (Verdict::Unknown, _) => (palette.state_awaiting, kit::tag(&palette, "待判", palette.state_awaiting)),
        (Verdict::Pass, _) => (palette.state_done, kit::tag(&palette, "通过", palette.state_done)),
    };

    Node::new(Kind::PreflightRow)
        .axis(Axis::Row)
        .gap(space::SM)
        .pad_top(space::SM)
        .child(
            Node::label(row.item.sku.clone())
                .size(text::MONO)
                .mono()
                .color(palette.text_secondary)
                .width(COL_SKU),
        )
        .child(
            Node::label(row.item.title.clone())
                .size(text::BODY)
                .color(palette.text_primary)
                .grow(),
        )
        .child(badge.width(COL_BADGE))
        .child(
            Node::label(format!("{}", row.findings))
                .size(text::MONO)
                .mono()
                .color(palette.text_secondary)
                .width(COL_COUNT),
        )
        .child(
            Node::label(format!("{}", row.unjudged))
                .size(text::MONO)
                .mono()
                .color(if row.unjudged > 0 {
                    palette.state_awaiting
                } else {
                    palette.text_tertiary
                })
                .width(COL_COUNT),
        )
        .child(
            Node::label(verdict.label())
                .size(text::CAPTION)
                .weight(Weight::Medium)
                .color(verdict_color)
                .width(COL_VERDICT),
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
        .child(header("商品").width(COL_SKU))
        .child(header("标题").grow())
        .child(header("最严重").width(COL_BADGE))
        .child(header("命中").width(COL_COUNT))
        .child(header("待判").width(COL_COUNT))
        .child(header("判定").width(COL_VERDICT))
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
    fn 三个数字与商品数对得上() {
        let text = tree().visible_text().join("\n");
        assert!(text.contains("8 个商品 · 需整改 6 · 待判 1 · 可上架 1"), "{text}");
    }

    #[test]
    fn 待判是独立一列而不是被当成通过() {
        let text = tree().visible_text().join("\n");
        assert!(text.contains("待判"), "三态之一必须出现在表头与行里");
        assert!(text.contains("最严重"), "只给标签不给严重度，等于没说");
        assert!(text.contains("命中"), "命中数要有自己的列，不能和待判混在一起");
    }

    #[test]
    fn 没有快照时给的是可执行提示() {
        let store = Store::empty();
        let ctx = ViewCtx::new(&store, LIGHT);
        let text = build(&ctx).visible_text().join("\n");
        assert!(text.contains("尚无数据，点这里采集"));
    }

    #[test]
    fn 行数记在数据源上() {
        fn find(node: &Node) -> Option<usize> {
            if node.kind == Kind::PreflightTable {
                return node.data.as_ref().map(|d| d.total);
            }
            node.children.iter().find_map(find)
        }
        assert_eq!(find(&tree()), Some(8));
    }
}
