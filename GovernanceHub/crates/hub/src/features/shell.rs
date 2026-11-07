//! 外壳：侧栏 + 主区。三段侧栏对应三种意图（正在做的事 / 要判断的事 / 配置）。
//!
//! 侧栏条目**带动作**：点得动的挂 `Action::Nav`，指向 `View::action()` 那个 slug；
//! 设计里有、还没做的挂 `None`，右侧显示「未实现」而不是快捷键 —— 点了没反应又不说
//! 为什么，比没有这个入口更糟。

use crate::models::TaskState;
use crate::ui::nav::{sidebar, NavItem};
use crate::ui::scene::Action;
use crate::ui::tokens::{space, WINDOW_HEIGHT, WINDOW_WIDTH};
use crate::ui::{Kind, Node};

use super::{View, ViewCtx};

/// 侧栏三段。快捷键按 `ui-ia.md §1.2` 的键位；键位绑定在 `app::window` 里注册。
pub fn sidebar_sections() -> Vec<(&'static str, Vec<NavItem>)> {
    // 键位标签从 `View::shortcut_key` 来，跟 `app::window` 注册的绑定是同一个源
    let go = |label: &'static str, view: View| {
        NavItem::go(
            label,
            view.shortcut_key().unwrap_or(""),
            Action::Nav(view.action()),
        )
    };
    vec![
        (
            "任务",
            vec![
                go("进行中", View::TaskList(TaskState::Running)),
                go("已完成", View::TaskList(TaskState::Done)),
                NavItem::planned("定时任务"),
            ],
        ),
        (
            "事实",
            vec![
                go("总览", View::Dashboard),
                go("风险清单", View::RiskList),
                go("上架前检查", View::Preflight),
                NavItem::planned("在售巡检"),
                NavItem::planned("整改与复核"),
                go("规则与证据", View::RuleLibrary),
            ],
        ),
        ("设置", vec![go("设置", View::Settings)]),
    ]
}

/// 整窗：左栏固定宽 + 主区自适应。尺寸写死是为了让结构快照可重复。
pub fn build(view: View, ctx: &ViewCtx) -> Node {
    let palette = ctx.palette;
    Node::row(Kind::Window)
        .width(WINDOW_WIDTH)
        .height(WINDOW_HEIGHT)
        .fill(palette.app_bg)
        .child(sidebar(&palette, &sidebar_sections(), view.sidebar_entry()))
        .child(
            Node::new(Kind::Main)
                .grow()
                .gap(space::LG)
                .child(view.build(ctx)),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 能点的入口都指向一个真视图() {
        for (_, items) in sidebar_sections() {
            for item in items {
                match &item.action {
                    Some(Action::Nav(id)) => {
                        let view = View::from_action(id)
                            .unwrap_or_else(|| panic!("{} 指向了认不出来的动作 {id}", item.label));
                        assert_eq!(
                            view.sidebar_entry(),
                            item.label,
                            "{} 点进去高亮的却是「{}」",
                            item.label,
                            view.sidebar_entry()
                        );
                    }
                    Some(other) => panic!("{} 挂了不该挂在侧栏的动作：{other:?}", item.label),
                    None => assert_eq!(item.key, "", "未实现的入口不该写快捷键"),
                }
            }
        }
    }

    #[test]
    fn 侧栏标签里的键位就是绑定的那个键() {
        let mut keys = Vec::new();
        for (_, items) in sidebar_sections() {
            for item in items {
                if let Some(Action::Nav(id)) = &item.action {
                    let view = View::from_action(id).expect("动作要认得");
                    assert_eq!(
                        Some(item.key),
                        view.shortcut_key(),
                        "{} 的标签键位跟视图的快捷键不一致",
                        item.label
                    );
                    keys.push(item.key);
                }
            }
        }
        assert_eq!(keys, vec!["1", "0", "2", "3", "4", "7", ","]);
    }

    #[test]
    fn 没做的入口明说未实现() {
        let store = crate::state::Store::from_fixtures(crate::state::store::fixtures_dir());
        let ctx = ViewCtx::new(&store, crate::ui::Palette::for_appearance(crate::ui::Appearance::Light));
        let text = build(View::Dashboard, &ctx).visible_text().join("\n");
        for label in ["定时任务", "在售巡检", "整改与复核"] {
            assert!(text.contains(label), "{label} 还是入口：{text}");
        }
        assert_eq!(
            text.lines().filter(|line| *line == "未实现").count(),
            3,
            "三个没做的入口各要说一次：{text}"
        );
    }
}
