//! 任务详情：这件事做到哪了、结论是什么。
//!
//! 会话流的顺序固定：用户原话 → 思考折叠条（默认收起）→ 工具轨迹 → 产出块。
//! 折叠条的展开态是视图状态，所以它必须进结构快照 —— 两态各一份，改版时才看得出差异。

use crate::models::detail::ToolTrace;
use crate::models::format;
use crate::ui::tokens::{space, text, Weight};
use crate::ui::{kit, Align, Axis, Kind, Node};

use super::ViewCtx;

pub fn build(ctx: &ViewCtx, expanded: bool) -> Node {
    let palette = ctx.palette;
    let detail = match ctx.store.detail.as_ref() {
        Some(detail) => detail,
        None => {
            return kit::panel(
                &palette,
                "任务详情",
                "没有选中任务",
                kit::empty_state(
                    &palette,
                    "从任务列表进入一个任务",
                    "点选任务卡只更新详情，不会自动新建任务",
                ),
            )
        }
    };

    let rows: Vec<Node> = detail
        .thought
        .tools
        .iter()
        .map(|trace: &ToolTrace| {
            kit::tool_trace_row(&palette, &trace.name, &trace.summary, trace.ok, trace.bytes)
        })
        .collect();

    let body = Node::new(Kind::Column)
        .gap(space::MD)
        .child(
            Node::new(Kind::GlassCard)
                .pad(space::MD)
                .gap(space::XS)
                .fill(palette.glass_fill)
                .stroke(1.0, palette.glass_stroke)
                .radius(crate::ui::tokens::radius::MD)
                .child(
                    Node::label("你")
                        .size(text::CAPTION)
                        .weight(Weight::Medium)
                        .color(palette.text_tertiary),
                )
                .child(
                    Node::label(detail.user_message.clone())
                        .size(text::BODY)
                        .color(palette.text_primary),
                ),
        )
        .child(kit::collapsible(
            &palette,
            &detail.thought.summary_line(),
            expanded,
            rows,
        ))
        .child(kit::section_title(
            &palette,
            &format!("{} · {}", detail.output.title, detail.attribution()),
        ))
        .child(
            Node::new(Kind::Column)
                .gap(space::XS)
                .data("task-detail.output.lines", detail.output.lines.len())
                .axis(Axis::Column)
                .children(detail.output.lines.iter().map(|line| {
                    Node::new(Kind::Bullet)
                        .axis(Axis::Row)
                        .gap(space::SM)
                        .align(Align::Start)
                        .child(
                            Node::label("·")
                                .size(text::BODY)
                                .color(palette.text_tertiary),
                        )
                        .child(
                            Node::label(line.clone())
                                .size(text::BODY)
                                .color(palette.text_secondary),
                        )
                })),
        )
        .child(
            Node::label("以上为解释草稿，不是判定结论。判定由规则引擎产出，见风险清单。")
                .size(text::CAPTION)
                .color(palette.text_tertiary),
        );

    kit::panel(
        &palette,
        &format!("任务 · {}", detail.task_id),
        &format!(
            "{} · 耗时 {} · {} 步 · 产出类型 {}",
            detail.state.label(),
            format::duration(detail.thought.duration_ms),
            detail.thought.step_count,
            detail.output.label
        ),
        body,
    )
}
