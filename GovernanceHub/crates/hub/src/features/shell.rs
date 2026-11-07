//! 外壳：侧栏 + 主区。三段侧栏对应三种意图（正在做的事 / 要判断的事 / 配置）。

use crate::features::{View, ViewCtx};
use crate::ui::tokens::{space, WINDOW_HEIGHT, WINDOW_WIDTH};
use crate::ui::{kit, Kind, Node};

/// 侧栏三段。快捷键只是标签，真正的键位绑定在 M1 之后接（M0 只画）。
const TASK_ITEMS: &[(&str, &str)] = &[("进行中", "1"), ("已完成", "0"), ("定时任务", "⇧S")];
const FACT_ITEMS: &[(&str, &str)] = &[
    ("总览", "2"),
    ("风险清单", "3"),
    ("上架前检查", "4"),
    ("在售巡检", "5"),
    ("整改与复核", "6"),
    ("规则与证据", "7"),
];
const SETTINGS_ITEMS: &[(&str, &str)] = &[("设置", ",")];

pub fn sidebar_sections() -> Vec<(&'static str, &'static [(&'static str, &'static str)])> {
    vec![
        ("任务", TASK_ITEMS),
        ("事实", FACT_ITEMS),
        ("设置", SETTINGS_ITEMS),
    ]
}

/// 整窗：左栏固定宽 + 主区自适应。尺寸写死是为了让结构快照可重复。
pub fn build(view: View, ctx: &ViewCtx) -> Node {
    let palette = ctx.palette;
    Node::row(Kind::Window)
        .width(WINDOW_WIDTH)
        .height(WINDOW_HEIGHT)
        .fill(palette.app_bg)
        .child(kit::sidebar(&palette, &sidebar_sections(), view.sidebar_entry()))
        .child(
            Node::new(Kind::Main)
                .grow()
                .gap(space::LG)
                .child(view.build(ctx)),
        )
}
