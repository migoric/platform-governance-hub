//! 真窗口：把**同一棵场景树**翻译成 gpui 元素。
//!
//! 这是 `--render` 之外的第二条渲染路径（`ui-ia.md §3` 的 `RenderMode`：出图直排 / 真窗口）。
//! 两条路都读 `ui::scene::Node`，所以布局与文案不可能分叉 —— 分叉的只可能是字体与光栅化结果。

use gpui::prelude::*;
use gpui::{
    div, px, rgba, size, AnyElement, App, Application, Bounds, Context, Div, FontWeight,
    IntoElement, Render, Window, WindowBounds, WindowOptions,
};

use crate::ui::scene::{Align, Axis, Node, Style};
use crate::ui::tokens::{self, Weight};

/// 打开窗口并进入事件循环。`tree` 是已经按当前 Store 构建好的整窗场景树。
pub fn run(tree: Node) {
    Application::new().run(move |cx: &mut App| {
        let bounds = Bounds::centered(
            None,
            size(px(tokens::WINDOW_WIDTH), px(tokens::WINDOW_HEIGHT)),
            cx,
        );
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            ..Default::default()
        };
        let root = tree.clone();
        let _ = cx.open_window(options, move |_window, cx| {
            cx.new(|_| RootView { tree: root.clone() })
        });
        cx.activate(true);
    });
}

struct RootView {
    tree: Node,
}

impl Render for RootView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        to_element(&self.tree)
    }
}

/// 场景树 → gpui 元素。规整的 1:1 翻译，不许在这里加任何业务判断。
pub fn to_element(node: &Node) -> AnyElement {
    let mut el = div().flex();
    el = match node.style.axis {
        Axis::Row => el.flex_row(),
        Axis::Column => el.flex_col(),
    };
    el = apply(el, &node.style);
    if let Some(text) = &node.text {
        el = el.child(text.clone());
    }
    for child in &node.children {
        el = el.child(to_element(child));
    }
    el.into_any_element()
}

fn apply(mut el: Div, style: &Style) -> Div {
    if style.gap > 0.0 {
        el = el.gap(px(style.gap));
    }
    let pad = style.pad;
    if pad[0] > 0.0 {
        el = el.pt(px(pad[0]));
    }
    if pad[1] > 0.0 {
        el = el.pr(px(pad[1]));
    }
    if pad[2] > 0.0 {
        el = el.pb(px(pad[2]));
    }
    if pad[3] > 0.0 {
        el = el.pl(px(pad[3]));
    }
    if let Some(width) = style.width {
        el = if width.is_finite() { el.w(px(width)) } else { el.w_full() };
    }
    if let Some(height) = style.height {
        el = if height.is_finite() { el.h(px(height)) } else { el.h_full() };
    }
    if style.grow {
        el = el.flex_grow();
    }
    if let Some(fill) = style.fill {
        el = el.bg(rgba(fill.rgba));
    }
    if let Some(stroke) = style.stroke {
        el = el.border_1().border_color(rgba(stroke.paint.rgba));
    }
    if style.radius > 0.0 {
        el = el.rounded(px(style.radius));
    }
    if let Some(size) = style.text_size {
        el = el.text_size(px(size));
    }
    if let Some(color) = style.text_color {
        el = el.text_color(rgba(color.rgba));
    }
    if style.weight != Weight::Regular {
        el = el.font_weight(weight(style.weight));
    }
    if style.mono {
        el = el.font_family("Menlo");
    }
    match style.align {
        Align::SpaceBetween => el.justify_between(),
        Align::Center => el.justify_center(),
        Align::End => el.justify_end(),
        Align::Start => el,
    }
}

fn weight(weight: Weight) -> FontWeight {
    match weight {
        Weight::Regular => FontWeight::NORMAL,
        Weight::Medium => FontWeight::MEDIUM,
        Weight::Semibold => FontWeight::SEMIBOLD,
    }
}
