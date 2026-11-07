//! 任务详情：这件事做到哪了、结论是什么。
//!
//! 会话流的顺序固定：用户原话 → 会话时间线（默认收起）→ 产出块 → 归属与用量。
//!
//! **时间线来自事件流，不是手写的。** 数据源是 `agent-session.json`（sidecar 用
//! `pgh agent session` 从 provider 的事件流聚合出来的），不是本文件拼出来的。
//! 折叠条的展开态仍然进结构快照 —— 两态各一份，改版时才看得出差异。
//!
//! 没有会话文件时**不画假时间线**：给一个空状态说清缺什么。M0 那份 fixture 里的
//! `thought.tools` 就是这么退役的 —— 它写得像真的，但没人量过。

use crate::models::{AgentSession, Step, TimelineItem};
use crate::ui::tokens::{space, text, Weight};
use crate::ui::{kit, Action, Align, Axis, Kind, Node};

use super::ViewCtx;

pub fn build(ctx: &ViewCtx, expanded: bool) -> Node {
    let palette = ctx.palette;
    // 选中了谁、这台机器上有没有谁的详情，是两件事。对不上时不许拿唯一那份详情顶上：
    // 界面会变成「标题写着 A、内容讲着 B」，而这两份都像真的。
    let detail = match (ctx.selected_task, ctx.store.detail.as_ref()) {
        (Some(id), Some(detail)) if detail.task_id == id => detail,
        (Some(id), _) => {
            return kit::panel(
                &palette,
                &format!("任务 · {id}"),
                "没有这个任务的记录",
                kit::empty_state(
                    &palette,
                    &format!("这台机器上没有 {id} 的详情"),
                    "详情读 ~/.pgh/agent/task-detail.json（pgh agent session 写）；没有就不画，不拿别的任务顶上",
                ),
            )
        }
        (None, Some(detail)) => detail,
        (None, None) => {
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

    let session = ctx.store.session.as_ref();

    let mut body = Node::new(Kind::Column)
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
        );

    match session {
        Some(session) => {
            // 「进行中」的任务配一条已结束的会话，不加说明会读成自相矛盾
            if detail.runs_ahead_of_session() {
                body = body.child(
                    Node::label("任务仍在进行；下面是这个任务最近一次已结束的会话。")
                        .size(text::CAPTION)
                        .color(palette.text_tertiary),
                );
            }
            body = body
                .child(
                    kit::collapsible(
                        &palette,
                        &session.summary_line(),
                        expanded,
                        timeline_rows(&palette, session),
                    )
                    // 折叠条上画了 ▸ / ▾ 就得能点，否则那个三角是个谎
                    .action(Action::ToggleTimeline),
                )
                .child(attribution_row(&palette, session));
            if session.has_unexplained_error() {
                body = body.child(
                    Node::label(
                        "会话以错误结束，但事件流里没有 error 事件 —— 适配器没给原因。排查只能看上游日志。",
                    )
                    .size(text::CAPTION)
                    .color(palette.state_interrupted),
                );
            }
        }
        None => {
            body = body.child(kit::empty_state(
                &palette,
                "这次任务没有记录会话",
                "只有任务记录：工具轨迹、用量、结束原因都要跑一次会话才有（pgh agent session）",
            ));
        }
    }

    body = body
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
            "{} · {} · {}",
            detail.state.label(),
            detail.attribution(),
            match session {
                Some(s) => s.done_label(),
                None => "无会话记录",
            }
        ),
        body,
    )
}

/// 时间线逐行。文本段是合并后的整段，工具行按调用顺序，错误行单独标。
fn timeline_rows(palette: &crate::ui::Palette, session: &AgentSession) -> Vec<Node> {
    session
        .timeline
        .iter()
        .map(|item: &TimelineItem| match item.step() {
            Step::Text(text_body) => Node::label(text_body.to_string())
                .size(text::BODY)
                .color(palette.text_secondary),
            Step::Tool(tool) => kit::tool_trace_row(
                palette,
                &tool.name,
                &tool.summary,
                tool.ok,
                tool.bytes,
            ),
            Step::Error(error) => Node::row(Kind::Row)
                .gap(space::SM)
                .align(Align::Start)
                .child(kit::tag(palette, "错误", palette.state_interrupted))
                .child(
                    Node::label(format!("{} {}", &error.code, &error.message))
                        .size(text::MONO)
                        .mono()
                        .color(palette.state_interrupted),
                )
                .child(
                    Node::label(if error.retryable { "可重试" } else { "不可重试" })
                        .size(text::CAPTION)
                        .color(palette.text_tertiary),
                ),
            // 不认识的类型要说出来：静默跳过等于把「不知道发生过什么」装成「没发生过」
            Step::Unknown(kind) => Node::label(format!("未识别的事件类型：{kind}"))
                .size(text::CAPTION)
                .color(palette.text_tertiary),
        })
        .collect()
}

/// 归属与用量：谁跑的、怎么结束的、花了多少、契约版本。
///
/// 「回放」两个字必须是文字，不能只靠颜色 —— 灰度和色盲下都要读得出来。
fn attribution_row(palette: &crate::ui::Palette, session: &AgentSession) -> Node {
    let real = session.is_real();
    let mut row = Node::row(Kind::Row)
        .gap(space::SM)
        .align(Align::Start)
        .data("task-detail.session.events", session.event_count as usize)
        .child(kit::tag(
            palette,
            if real { "真实分析" } else { "回放" },
            if real {
                palette.real_data
            } else {
                palette.replay_data
            },
        ));
    // 自报家门的原话照抄，不换成「模拟」之类的委婉说法：那句话是 provider 自己给的
    if !session.attribution.label.is_empty() {
        row = row.child(
            Node::label(session.attribution.label.clone())
                .size(text::CAPTION)
                .weight(Weight::Medium)
                .color(if real {
                    palette.text_secondary
                } else {
                    palette.replay_data
                }),
        );
    }
    row.child(
        Node::label(format!(
            "{} · {} · {} · 契约 v{}",
            session.provider,
            session.done_label(),
            session.usage_line(),
            session.contract_version
        ))
        .size(text::CAPTION)
        .color(palette.text_tertiary),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Store;
    use crate::ui::{Appearance, Palette};

    fn ctx(store: &Store) -> ViewCtx<'_> {
        ViewCtx::new(store, Palette::for_appearance(Appearance::Light))
    }

    fn store() -> Store {
        Store::from_fixtures(crate::state::store::fixtures_dir())
    }

    fn text_of(expanded: bool) -> String {
        let store = store();
        build(&ctx(&store), expanded).visible_text().join("\n")
    }

    #[test]
    fn 时间线来自事件流而不是手写() {
        let text = text_of(true);
        // 这三段文本只存在于 replay 的事件流里
        assert!(text.contains("先把这个 SKU 的现状读出来。"), "{text}");
        assert!(text.contains("绝对化用语是硬拦的"), "{text}");
        // 两行工具，summary 来自 tool_result
        assert!(text.contains("snapshot_query"));
        assert!(text.contains("1 个 item：Best Women Summer Floral Midi Dress"));
        assert!(text.contains("rule_lookup"));
    }

    #[test]
    fn 回放必须写在界面上() {
        let text = text_of(false);
        assert!(text.contains("回放"), "收起态也要看得出来：{text}");
        assert!(text.contains("回放数据，不是真实分析"));
    }

    #[test]
    fn 成本拿不到时显示破折号() {
        let text = text_of(true);
        assert!(text.contains("成本 —"), "{text}");
        assert!(!text.contains("成本 $0"), "拿不到成本不能写成 0：{text}");
    }

    #[test]
    fn 耗时未知不写编出来的时长() {
        let text = text_of(true);
        assert!(text.contains("耗时未记录"));
        assert!(!text.contains("2 分 14 秒"), "旧 fixture 那个数字是编的：{text}");
    }

    #[test]
    fn 收起态不渲染时间线正文() {
        let closed = text_of(false);
        let open = text_of(true);
        assert!(open.len() > closed.len());
        assert!(!closed.contains("先把这个 SKU 的现状读出来。"));
        // 收起时仍要能看到「怎么结束的」
        assert!(closed.contains("正常结束"), "{closed}");
    }

    #[test]
    fn 没有会话文件时给空状态而不是编一段时间线() {
        let mut store = store();
        store.session = None;
        let body = build(&ctx(&store), true).visible_text().join("\n");
        assert!(body.contains("这次任务没有记录会话"), "{body}");
        assert!(body.contains("无会话记录"), "副标题也要说清：{body}");
        assert!(!body.contains("snapshot_query"), "不许回落到旧的手写轨迹");
    }

    #[test]
    fn 进行中的任务会被提醒会话已结束() {
        let text = text_of(true);
        assert!(text.contains("最近一次已结束的会话"), "{text}");
    }

    #[test]
    fn 错误结束但没给原因要说出来() {
        let mut store = store();
        if let Some(session) = store.session.as_mut() {
            session.done_reason = "error".to_string();
            session.timeline.retain(|item| !matches!(item.step(), Step::Error(_)));
        }
        let text = build(&ctx(&store), true).visible_text().join("\n");
        assert!(text.contains("适配器没给原因"), "{text}");
    }

    #[test]
    fn 未知行类型会显示成未识别() {
        let mut store = store();
        if let Some(session) = store.session.as_mut() {
            session.timeline.push(TimelineItem {
                kind: "thinking".to_string(),
                ..TimelineItem::default()
            });
        }
        let text = build(&ctx(&store), true).visible_text().join("\n");
        assert!(text.contains("未识别的事件类型：thinking"), "{text}");
    }
}
