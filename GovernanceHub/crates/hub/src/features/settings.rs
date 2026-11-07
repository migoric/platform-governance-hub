//! 设置：agent 服务与握手结果。
//!
//! 这一屏只回答三个问题：现在用的是谁、为什么不是更前面的那个、这次产出能不能当真实分析。
//!
//! 数据来自 `pgh agent status` 落下的 `agent-status.json`。界面**不自己探测**：
//! 否则同一个「remote 连不上」会在终端与窗口里各算一遍，迟早出现两套说法。
//!
//! 两个必须写出来的限制，不写就等于骗人：
//!   · 握手通过只说明适配器与命令可用，**不代表账号已登录** —— 真实的失败在会话事件流里；
//!   · 指定某个 provider 之后阶梯不会退让（`ladder.mjs` 的设计），所以选一个连不上的
//!     服务等于把助手配成不可用。切换入口现在只有命令行，这一屏不给假按钮。

use crate::models::{AgentStatus, ProviderStatus};
use crate::ui::tokens::{radius, space, text, Weight};
use crate::ui::{kit, Align, Axis, Kind, Node};

use super::ViewCtx;

pub fn build(ctx: &ViewCtx) -> Node {
    let palette = ctx.palette;
    let Some(status) = ctx.store.status.as_ref() else {
        return kit::panel(
            &palette,
            "设置",
            "agent 服务与握手结果",
            kit::empty_state(
                &palette,
                "还没有握手报告",
                "在终端跑 pgh agent status —— 这一屏只摆结论，不自己探测",
            ),
        )
    };

    let body = Node::new(Kind::Column)
        .gap(space::MD)
        .child(headline(&palette, status))
        .child(kit::section_title(
            &palette,
            &format!(
                "注册的 provider · {} 个可用 / 共 {} 个",
                status.healthy_count(),
                status.providers.len()
            ),
        ))
        .child(
            Node::new(Kind::ProviderList)
                .gap(space::SM)
                .data("agent-status.providers", status.providers.len())
                .children(status.providers.iter().map(|p| provider_row(&palette, p))),
        )
        .child(footnote(&palette));

    kit::panel_with_note(
        &palette,
        "设置",
        "agent 服务与握手结果",
        "只读 · 切换走 CLI",
        body,
    )
}

/// 顶部：现在用谁、这次产出算什么、为什么不是更前面的那个。
fn headline(palette: &crate::ui::Palette, status: &AgentStatus) -> Node {
    let mut card = Node::new(Kind::GlassCard)
        .pad(space::MD)
        .gap(space::XS)
        .fill(palette.glass_fill)
        .stroke(1.0, palette.glass_stroke)
        .radius(radius::MD)
        .data("agent-status.selected", usize::from(status.selected.is_some()));

    let (badge, color) = match status.is_real() {
        Some(true) => ("真实分析", palette.real_data),
        Some(false) => ("回放", palette.replay_data),
        None => ("未声明", palette.text_tertiary),
    };

    card = card.child(
        Node::row(Kind::Row)
            .gap(space::SM)
            .align(Align::Start)
            .child(kit::tag(palette, badge, color))
            .child(
                Node::label(status.headline())
                    .size(text::BODY)
                    .weight(Weight::Medium)
                    .color(palette.text_primary),
            ),
    );

    card = card.child(
        Node::label(match status.preferred.as_deref() {
            Some(id) => format!("配置里指定了 {id}：阶梯只试它，失败也不会换人"),
            None => "没有指定服务：按阶梯依次尝试，第一个能用的胜出".to_string(),
        })
        .size(text::CAPTION)
        .color(palette.text_tertiary),
    );

    for (index, line) in status.reason_lines().iter().enumerate() {
        card = card.child(
            Node::label(line.clone())
                .size(text::CAPTION)
                // 第一行是 sidecar 的结论，后面是逐条踩空的原因
                .color(if index == 0 {
                    palette.text_secondary
                } else {
                    palette.text_tertiary
                }),
        );
    }
    card
}

/// 一条 provider：状态、版本、以及「能用」时才有意义的能力与归属。
///
/// 握手失败时**不展开能力行**：那时的能力是地板值（全 false），
/// 显示出来等于说「它不支持」，而事实是「不知道」。
fn provider_row(palette: &crate::ui::Palette, provider: &ProviderStatus) -> Node {
    let status_color = if provider.ok {
        palette.state_done
    } else {
        palette.state_interrupted
    };

    let mut head = Node::row(Kind::Row)
        .gap(space::SM)
        .align(Align::Start)
        .child(
            Node::label(provider.id.clone())
                .size(text::BODY)
                .weight(Weight::Medium)
                .mono()
                .color(palette.text_primary),
        )
        .child(kit::tag(palette, provider.status_label(), status_color))
        .child(
            Node::label(format!("契约 v{}", provider.contract_version))
                .size(text::CAPTION)
                .color(palette.text_tertiary),
        );

    if provider.selected {
        head = head.child(kit::tag(palette, "当前", palette.accent));
    }
    // 远端服务版本只展示，不参与任何分支判断（agent-acl §5）
    if let Some(version) = &provider.server_version {
        head = head.child(
            Node::label(format!("服务版本 {version}"))
                .size(text::CAPTION)
                .color(palette.text_tertiary),
        );
    }

    let mut card = Node::new(Kind::ProviderRow)
        .gap(space::XS)
        .pad(space::MD)
        .radius(radius::MD)
        .fill(palette.glass_fill)
        .stroke(1.0, palette.glass_stroke)
        .child(head);

    if provider.ok {
        card = card.child(
            Node::new(Kind::CapabilityRow)
                .axis(Axis::Row)
                .gap(space::SM)
                .child(
                    Node::label(provider.capability_line())
                        .size(text::CAPTION)
                        .color(palette.text_secondary),
                )
                .child(
                    Node::label(provider.attribution_line())
                        .size(text::CAPTION)
                        .color(attribution_color(palette, provider)),
                ),
        );
    } else {
        card = card.child(
            Node::label(
                provider
                    .reason
                    .clone()
                    .unwrap_or_else(|| "没有给出原因".to_string()),
            )
            .size(text::CAPTION)
            .color(palette.text_secondary),
        );
    }
    card
}

/// 归属色：真实 / 回放 / 未声明三种，未声明不许借用「回放」的颜色。
fn attribution_color(palette: &crate::ui::Palette, provider: &ProviderStatus) -> crate::ui::tokens::Paint {
    match &provider.attribution {
        None => palette.text_tertiary,
        Some(attribution) if attribution.real => palette.real_data,
        Some(_) => palette.replay_data,
    }
}

fn footnote(palette: &crate::ui::Palette) -> Node {
    Node::new(Kind::Column)
        .gap(space::XS)
        .child(
            Node::label("握手通过只说明适配器与命令可用，不代表账号已登录；真实失败在任务详情的错误行里。")
                .size(text::CAPTION)
                .color(palette.text_tertiary),
        )
        .child(
            Node::label("切换服务：pgh agent use <id>；pgh agent use auto 交回阶梯。指定之后阶梯不退让，服务不可用时会话直接失败。")
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

    fn text_of(store: &Store) -> String {
        build(&ctx(store)).visible_text().join("\n")
    }

    #[test]
    fn 三个问题都要答得出来() {
        let store = store();
        let text = text_of(&store);
        assert!(text.contains("使用 replay"), "{text}");
        assert!(text.contains("回放数据，不是真实分析"), "这次产出算不算真实分析：{text}");
        assert!(text.contains("remote 不可用"), "为什么不是更前面的那个：{text}");
        assert!(text.contains("claude-cli 不可用"), "{text}");
    }

    #[test]
    fn 每个_provider_都列出来包括不可用的() {
        let store = store();
        let text = text_of(&store);
        for id in ["remote", "claude-cli", "replay"] {
            assert!(text.contains(id), "{id} 从界面上消失了：{text}");
        }
        assert!(!text.contains("3 个可用 / 共 3 个"), "实际只有 1 个可用：{text}");
        assert!(text.contains("1 个可用 / 共 3 个"), "{text}");
    }

    #[test]
    fn 握手失败不展开能力行() {
        let store = store();
        let text = text_of(&store);
        // 只有 replay 握手通过，能力行只该出现一次
        assert_eq!(text.matches("流式 有").count(), 1, "{text}");
        // 失败项给的是原因，不是「不支持」
        assert!(text.contains("本机没有 claude 命令"), "{text}");
    }

    #[test]
    fn 限制必须写在界面上() {
        let store = store();
        let text = text_of(&store);
        assert!(text.contains("不代表账号已登录"), "{text}");
        assert!(text.contains("阶梯不退让"), "{text}");
        // 不画假的切换控件：入口只有命令行
        assert!(text.contains("pgh agent use"), "{text}");
    }

    #[test]
    fn 没有状态报告时给空状态而不是空白() {
        let mut store = store();
        store.status = None;
        let text = build(&ctx(&store)).visible_text().join("\n");
        assert!(text.contains("还没有握手报告"), "{text}");
        assert!(text.contains("pgh agent status"), "要说清怎么生成：{text}");
        assert!(!text.contains("使用 replay"), "没有报告时不许编一个使用者");
    }

    #[test]
    fn 没有选中服务时不显示成真实分析() {
        let mut store = store();
        if let Some(status) = store.status.as_mut() {
            status.selected = None;
            status.degraded = true;
        }
        let text = build(&ctx(&store)).visible_text().join("\n");
        assert!(text.contains("没有可用的 agent 服务"), "{text}");
        assert!(text.contains("未声明"), "{text}");
        assert!(!text.contains("使用 replay"), "没有选中时不许编一个使用者：{text}");
        // 徽章不能是「真实分析」—— 那需要 provider 自己声明，而不是缺省
        assert!(!text.contains("\n真实分析\n"), "{text}");
    }
}
