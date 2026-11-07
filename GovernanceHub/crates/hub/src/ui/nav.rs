//! 侧栏：条目 + 分段（任务 / 事实 / 设置）。
//!
//! 从 `kit.rs` 拆出来的：那边被导航改动推过了 500 行门禁（AGENTS.md §4）。
//! 纯移动，没有行为变化 —— 拆完结构基准逐字节一致。

use crate::ui::scene::{Action, Align, Axis, Kind, Node};
use crate::ui::tokens::{self, radius, space, text, Palette, Weight};

/// 侧栏条目：文字、快捷键、点了去哪。
///
/// `action` 为 `None` = 这个面板还没做。条目照样列出来（它属于已经定下的信息架构），
/// 但右侧不写快捷键、改写「未实现」—— 不许在侧栏摆一个点了没反应、也不说为什么的入口。
#[derive(Clone)]
pub struct NavItem {
    pub label: &'static str,
    pub key: &'static str,
    pub action: Option<Action>,
}

impl NavItem {
    /// 能点到的入口。
    pub fn go(label: &'static str, key: &'static str, action: Action) -> Self {
        Self {
            label,
            key,
            action: Some(action),
        }
    }

    /// 设计里有、还没做的入口。
    pub fn planned(label: &'static str) -> Self {
        Self {
            label,
            key: "",
            action: None,
        }
    }
}

/// 侧栏：三段（任务 / 事实 / 设置），标签按平台换快捷键写法。
pub fn sidebar(palette: &Palette, sections: &[(&str, Vec<NavItem>)], active: &str) -> Node {
    let mut bar = Node::new(Kind::Sidebar)
        .axis(Axis::Column)
        .gap(space::LG)
        .pad(space::MD)
        .width(tokens::SIDEBAR_WIDTH)
        .fill(palette.panel_bg)
        .stroke(1.0, palette.divider);
    for (title, items) in sections {
        let mut section = Node::new(Kind::SidebarSection).gap(space::XS).child(
            Node::label(*title)
                .size(text::CAPTION)
                .weight(Weight::Medium)
                .color(palette.text_tertiary),
        );
        for item in items {
            let is_active = item.label == active;
            let tail = match item.action {
                Some(_) => Node::label(tokens::shortcut(item.key))
                    .size(text::CAPTION)
                    .color(palette.text_tertiary),
                None => Node::label("未实现")
                    .size(text::CAPTION)
                    .color(palette.text_tertiary),
            };
            let mut row = Node::new(Kind::SidebarItem)
                .pad_xy(space::SM, space::XS)
                .radius(radius::SM)
                .axis(Axis::Row)
                .align(Align::SpaceBetween)
                .width(tokens::SIDEBAR_WIDTH - space::MD * 2.0)
                .fill(if is_active {
                    palette.accent_soft
                } else {
                    palette.glass_fill
                })
                .child(
                    Node::label(item.label).size(text::BODY).color(if is_active {
                        palette.accent
                    } else {
                        palette.text_secondary
                    }),
                )
                .child(tail);
            if let Some(action) = item.action.clone() {
                row = row.action(action);
            }
            section = section.child(row);
        }
        bar = bar.child(section);
    }
    bar
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::tokens::LIGHT;

    #[test]
    fn 侧栏快捷键按平台换标签() {
        let items = vec![NavItem::go("总览", "2", Action::Nav("overview"))];
        let bar = sidebar(&LIGHT, &[("事实", items)], "总览");
        assert!(bar.visible_text().contains(&tokens::shortcut("2")));
    }

    /// 没做的入口不写快捷键、也不挂动作：右侧「未实现」是它唯一的说明。
    #[test]
    fn 没做的入口写未实现且不可点() {
        let items = vec![NavItem::planned("定时任务")];
        let bar = sidebar(&LIGHT, &[("任务", items)], "总览");
        let text = bar.visible_text();
        assert!(text.contains(&"未实现".to_string()), "{text:?}");
        assert!(
            !text.iter().any(|t| t.starts_with('⌘') || t.starts_with("Ctrl+")),
            "{text:?}"
        );
        assert!(bar.children[0].children[1].action.is_none());
    }
}
