//! 设计系统：Panel / 玻璃 / 徽章 / 任务卡。
//!
//! 对应 ui-ia.md §3 的迁移清单 —— 这些是**在 GPUI 里重写的等价控件**，不是继承来的组件。
//! M0 只做前两个必须的控件（严重度徽章 + 任务卡）加骨架，证据引用串 / 状态时间线 / 折叠条
//! 里只有折叠条在 M0 用得上。

use crate::models::{format, Severity, TaskCard, TaskState};
use crate::ui::scene::{Action, Align, Axis, Kind, Node};
use crate::ui::tokens::{radius, space, text, Palette, Weight};

/// 面板骨架：标题 + 副标题 + 主体。`RenderMode` 的两条渲染路径（真窗口 / 结构快照）
/// 都吃这一个函数产出的树，所以布局不会分叉。
pub fn panel(palette: &Palette, title: &str, subtitle: &str, body: Node) -> Node {
    panel_with_note(palette, title, subtitle, "只读", body)
}

/// 同上，但右上角那句话由调用方给。
///
/// 设置页需要：「只读」在别处是事实层的意思（这里的东西模型改不了），
/// 在配置页却容易被读成「不能配置」。把限制写清楚比复用一句标签重要。
pub fn panel_with_note(palette: &Palette, title: &str, subtitle: &str, note: &str, body: Node) -> Node {
    Node::new(Kind::Panel)
        .gap(space::LG)
        .pad(space::XL)
        .child(
            Node::row(Kind::PanelHeader)
                .align(Align::SpaceBetween)
                .gap(space::MD)
                .child(
                    Node::new(Kind::Column)
                        .gap(space::XS)
                        .child(
                            Node::label(title)
                                .size(text::TITLE)
                                .weight(Weight::Semibold)
                                .color(palette.text_primary),
                        )
                        .child(
                            Node::label(subtitle)
                                .size(text::CAPTION)
                                .color(palette.text_secondary),
                        ),
                )
                .child(
                    Node::label(note)
                        .size(text::CAPTION)
                        .color(palette.text_tertiary),
                ),
        )
        .child(divider(palette))
        .child(body)
}

/// 玻璃卡片：半透明底 + 1px 高光边框。不做真 blur（跨端一致性优先，见 ui-ia.md §3）。
pub fn glass(palette: &Palette, child: Node) -> Node {
    Node::new(Kind::GlassCard)
        .pad(space::LG)
        .gap(space::SM)
        .fill(palette.glass_fill)
        .stroke(1.0, palette.glass_highlight)
        .radius(radius::LG)
        .child(child)
}

/// 严重度徽章：四档，**带文字**。颜色只是辅助，色盲/灰度打印也要能读（ui-ia.md §7）。
pub fn severity_badge(palette: &Palette, severity: Severity) -> Node {
    Node::new(Kind::Badge)
        .pad_xy(space::SM, space::XS)
        .radius(radius::SM)
        .stroke(1.0, palette.severity(severity))
        .child(
            Node::label(severity.label())
                .size(text::CAPTION)
                .weight(Weight::Medium)
                .color(palette.severity(severity)),
        )
}

/// 通用小标签：文字 + 语义色。严重度之外的三态（需整改 / 待判 / 可上架）用它。
/// 和 `severity_badge` 一样**必须带文字** —— 颜色只做辅助。
pub fn tag(palette: &Palette, label: &str, color: crate::ui::tokens::Paint) -> Node {
    let _ = palette;
    Node::new(Kind::Badge)
        .pad_xy(space::SM, space::XS)
        .radius(radius::SM)
        .stroke(1.0, color)
        .child(
            Node::label(label.to_string())
                .size(text::CAPTION)
                .weight(Weight::Medium)
                .color(color),
        )
}

/// 任务状态：文字 + 颜色。「等待确认」不能只靠颜色表达。
pub fn state_chip(palette: &Palette, state: TaskState) -> Node {
    let color = match state {
        TaskState::Running => palette.accent,
        TaskState::Awaiting => palette.state_awaiting,
        TaskState::Done => palette.state_done,
        TaskState::Interrupted => palette.state_interrupted,
    };
    Node::new(Kind::Badge)
        .pad_xy(space::SM, space::XS)
        .radius(radius::SM)
        .fill(palette.glass_fill)
        .child(
            Node::label(state.label())
                .size(text::CAPTION)
                .weight(Weight::Medium)
                .color(color),
        )
}

/// 任务卡：四个字段固定（目标 / 状态·耗时·agent / 来源），四行定高，列表虚拟化。
pub fn task_card(palette: &Palette, card: &TaskCard) -> Node {
    // 状态由 chip 表达，这里只放「耗时 · 参与的 agent」，避免同一个词出现两遍
    let meta = format!(
        "{} · {}",
        format::duration(card.duration_ms),
        card.agents_line()
    );
    let mut node = Node::new(Kind::TaskCard)
        .gap(space::XS)
        .pad(space::MD)
        .radius(radius::MD)
        .fill(palette.glass_fill)
        .stroke(1.0, palette.glass_stroke)
        .height(96.0)
        .child(
            Node::label(card.title.clone())
                .size(text::BODY)
                .weight(Weight::Medium)
                .color(palette.text_primary),
        )
        .child(
            Node::row(Kind::TaskMeta)
                .gap(space::SM)
                .child(state_chip(palette, card.state))
                .child(
                    Node::label(meta)
                        .size(text::CAPTION)
                        .color(palette.text_secondary),
                ),
        )
        .child(
            Node::label(card.origin_label())
                .size(text::CAPTION)
                .color(if card.is_real() {
                    palette.real_data
                } else {
                    palette.replay_data
                }),
        );
    // 卡片能点：点开是这个任务的详情。没有 id 的卡不给动作 —— 点了也说不清打开的是谁。
    if !card.id.is_empty() {
        node = node.action(Action::OpenTask(card.id.clone()));
    }
    node
}

/// KPI 卡：数字 + 标签 + 一句解释（解释写清「这个数字不算什么」）。
pub fn kpi(palette: &Palette, label: &str, value: &str, hint: &str) -> Node {
    Node::new(Kind::Kpi)
        .gap(space::XS)
        .pad(space::LG)
        .radius(radius::MD)
        .fill(palette.glass_fill)
        .stroke(1.0, palette.glass_stroke)
        .width(150.0)
        .child(
            Node::label(value)
                .size(text::DISPLAY)
                .weight(Weight::Semibold)
                .color(palette.text_primary),
        )
        .child(
            Node::label(label)
                .size(text::CAPTION)
                .weight(Weight::Medium)
                .color(palette.text_secondary),
        )
        .child(
            Node::label(hint)
                .size(text::CAPTION)
                .color(palette.text_tertiary),
        )
}

/// 空状态：必须说清**为什么空**（没采集 / 规则没跑 / 这条真的没问题）。
pub fn empty_state(palette: &Palette, title: &str, body: &str) -> Node {
    Node::new(Kind::EmptyState)
        .gap(space::SM)
        .pad(space::XXL)
        .radius(radius::MD)
        .fill(palette.glass_fill)
        .stroke(1.0, palette.glass_stroke)
        .child(
            Node::label(title)
                .size(text::BODY)
                .weight(Weight::Medium)
                .color(palette.text_secondary),
        )
        .child(
            Node::label(body)
                .size(text::CAPTION)
                .color(palette.text_tertiary),
        )
}

pub fn section_title(palette: &Palette, title: &str) -> Node {
    Node::new(Kind::SectionTitle)
        .pad_top(space::SM)
        .child(
            Node::label(title)
                .size(text::BODY)
                .weight(Weight::Semibold)
                .color(palette.text_primary),
        )
}

pub fn divider(palette: &Palette) -> Node {
    // 不写 width(INFINITY)：JSON 表达不了 Infinity，会被静默序列化成 null，
    // 等于把「铺满」这条布局信息丢进快照的黑洞里。靠父容器的交叉轴拉伸。
    Node::new(Kind::Divider).height(1.0).fill(palette.divider)
}

/// 思考折叠条：收起态一行 `思考 2 分 14 秒 · 12 步`，展开后逐条列出工具调用。
/// 「展开态」是视图状态，写进快照才能对比两态。
pub fn collapsible(palette: &Palette, header: &str, expanded: bool, rows: Vec<Node>) -> Node {
    let marker = if expanded { "▾" } else { "▸" };
    let mut node = Node::new(Kind::Collapsible)
        .gap(space::SM)
        .pad(space::MD)
        .radius(radius::MD)
        .fill(palette.glass_fill)
        .stroke(1.0, palette.glass_stroke)
        .child(
            Node::row(Kind::Row)
                .gap(space::SM)
                .child(
                    Node::label(marker)
                        .size(text::CAPTION)
                        .color(palette.text_tertiary),
                )
                .child(
                    Node::label(header)
                        .size(text::CAPTION)
                        .weight(Weight::Medium)
                        .color(palette.text_secondary),
                ),
        );
    if expanded {
        node = node.children(rows);
    }
    node
}

/// 页内分段控件：全站唯一实现（键盘 ←→ 自己接，M0 只画）。
pub fn segment(palette: &Palette, items: &[&str], active: usize) -> Node {
    let mut bar = Node::row(Kind::Segment)
        .gap(space::XS)
        .pad(space::XS)
        .radius(radius::MD)
        .fill(palette.glass_fill)
        .stroke(1.0, palette.glass_stroke);
    for (index, label) in items.iter().enumerate() {
        let is_active = index == active;
        bar = bar.child(
            Node::new(Kind::SegmentItem)
                .pad_xy(space::SM, space::XS)
                .radius(radius::SM)
                .fill(if is_active {
                    palette.accent_soft
                } else {
                    palette.glass_fill
                })
                .child(
                    Node::label(*label).size(text::CAPTION).color(if is_active {
                        palette.accent
                    } else {
                        palette.text_secondary
                    }),
                ),
        );
    }
    bar
}

/// 一条工具轨迹：`name · summary`，失败要能一眼看出（ok=false 用状态色）。
///
/// `ok` 是三态而不是布尔：`None` = 事件流里没见过这条调用的结果。
/// 把「没见过结果」画成「失败」或者「成功」都是在替适配器编故事。
pub fn tool_trace_row(
    palette: &Palette,
    name: &str,
    summary: &str,
    ok: Option<bool>,
    bytes: Option<u64>,
) -> Node {
    let color = match ok {
        Some(true) => palette.text_secondary,
        Some(false) => palette.state_interrupted,
        None => palette.text_tertiary,
    };
    let tail = match (ok, bytes) {
        (Some(false), _) => "失败".to_string(),
        (None, _) => "未返回".to_string(),
        (Some(true), Some(bytes)) => format!("{bytes} B"),
        (Some(true), None) => "—".to_string(),
    };
    Node::new(Kind::ToolTraceRow)
        .axis(Axis::Row)
        .gap(space::SM)
        .pad_top(space::XS)
        .child(
            Node::label(format!("{name}"))
                .size(text::MONO)
                .mono()
                .color(palette.text_secondary)
                .width(150.0),
        )
        .child(
            Node::label(summary.to_string())
                .size(text::MONO)
                .mono()
                .color(color),
        )
        .child(
            Node::label(tail)
                .size(text::CAPTION)
                .color(palette.text_tertiary),
        )
}

#[cfg(test)]
mod tests {
    use super::super::tokens::{DARK, LIGHT};
    use super::*;

    fn card(state: TaskState) -> TaskCard {
        TaskCard {
            id: "tk_1".into(),
            title: "把 12 条 blocker 解释一遍".into(),
            state,
            agents: vec!["条款研究员".into()],
            origin: "replay".into(),
            duration_ms: 134_000,
            step_count: 12,
            ..TaskCard::default()
        }
    }

    #[test]
    fn 任务卡四字段都在且耗时来自投影() {
        let node = task_card(&LIGHT, &card(TaskState::Awaiting));
        let text = node.visible_text().join("\n");
        assert!(text.contains("把 12 条 blocker 解释一遍"));
        assert!(text.contains("2 分 14 秒 · 条款研究员"));
        assert!(text.contains("回放数据"));
        assert_eq!(node.style.height, Some(96.0), "卡面定高，列表才能虚拟化");
    }

    #[test]
    fn 徽章带文字不只靠颜色() {
        for severity in Severity::ALL {
            let node = severity_badge(&LIGHT, severity);
            assert_eq!(node.visible_text(), vec![severity.label().to_string()]);
        }
    }

    #[test]
    fn 两套配色下徽章颜色跟随令牌() {
        let light = severity_badge(&LIGHT, Severity::Blocker).to_json();
        let dark = severity_badge(&DARK, Severity::Blocker).to_json();
        assert_eq!(light["style"]["stroke"]["paint"]["token"], "severity_blocker");
        assert_ne!(
            light["style"]["stroke"]["paint"]["hex"],
            dark["style"]["stroke"]["paint"]["hex"]
        );
    }

    #[test]
    fn 折叠条收起时不渲染轨迹行() {
        let rows = vec![tool_trace_row(
            &LIGHT,
            "snapshot_query",
            "读到 3 条",
            Some(true),
            Some(2048),
        )];
        let closed = collapsible(&LIGHT, "思考 2 分 14 秒 · 12 步", false, rows.clone());
        let open = collapsible(&LIGHT, "思考 2 分 14 秒 · 12 步", true, rows);
        assert_eq!(closed.visible_text().len(), 2, "只有标记与标题");
        assert_eq!(open.visible_text().len(), 5, "展开后多出三条轨迹字段");
    }

    #[test]
    fn 工具轨迹三态各有各的说法() {
        let ok = tool_trace_row(&LIGHT, "a", "s", Some(true), Some(418));
        assert!(ok.visible_text().contains(&"418 B".to_string()));
        let failed = tool_trace_row(&LIGHT, "a", "s", Some(false), None);
        assert!(failed.visible_text().contains(&"失败".to_string()));
        // 没见过结果 ≠ 失败：这一行不许说「失败」，也不许说 0 B
        let missing = tool_trace_row(&LIGHT, "a", "s", None, None);
        let texts = missing.visible_text();
        assert!(texts.contains(&"未返回".to_string()), "{texts:?}");
        assert!(!texts.iter().any(|t| t == "失败"));
        assert!(!texts.iter().any(|t| t.contains("0 B")));
    }

    #[test]
    fn 空状态文案不是暂无数据() {
        let node = empty_state(&LIGHT, "尚无数据", "点这里采集");
        assert_ne!(node.visible_text()[1], "暂无数据");
    }
}
