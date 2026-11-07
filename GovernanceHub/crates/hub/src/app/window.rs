//! 真窗口：把**同一棵场景树**翻译成 gpui 元素，并把可点节点接上动作。
//!
//! 这是 `--render` 之外的第二条渲染路径（`ui-ia.md §3` 的 `RenderMode`：出图直排 / 真窗口）。
//! 两条路都读 `ui::scene::Node`，所以布局与文案不可能分叉 —— 分叉的只可能是字体与光栅化结果。
//!
//! 交互**不进场景树**：树只写「这个节点点了要干什么」（`Node.action`），
//! 状态（当前视图 / 选中的任务）在 `Root` 里，改完重建整棵树。小界面重建比增量 diff 便宜，
//! 也保证了「屏幕上的东西 = 由当前状态算出来的东西」——没有第二份可变状态可以对不上。

use gpui::prelude::*;
use gpui::{
    actions, div, px, rgba, size, AnyElement, App, Application, Bounds, Context, Div, FocusHandle,
    FontWeight, IntoElement, KeyBinding, MouseButton, Render, Window, WindowBounds, WindowOptions,
};

use crate::features::{shell, View, ViewCtx};
use crate::state::Store;
use crate::ui::scene::{Action, Align, Axis, Node, Style};
use crate::ui::tokens::{self, Palette, Weight};

// 侧栏七个入口的快捷键。键位串在 `View::keystroke` 里算，跟侧栏标签同一个源 ——
// 不许在这里写死 "cmd-4"，否则改了标签就不一致了。
actions!(
    hub,
    [
        NavOverview,
        NavRisks,
        NavPreflight,
        NavRules,
        NavSettings,
        NavTasksRunning,
        NavTasksDone
    ]
);

/// 有键位的视图 → 绑定。清单必须与 `View::shortcut_key` 对齐（`快捷键全覆盖` 那条测试管着）。
fn nav_bindings() -> Vec<KeyBinding> {
    use crate::models::TaskState;
    [
        View::TaskList(TaskState::Running),
        View::TaskList(TaskState::Done),
        View::Dashboard,
        View::RiskList,
        View::Preflight,
        View::RuleLibrary,
        View::Settings,
    ]
    .into_iter()
    .filter_map(|view| {
        let keystroke = view.keystroke()?;
        Some(match view {
            View::Dashboard => KeyBinding::new(&keystroke, NavOverview, None),
            View::RiskList => KeyBinding::new(&keystroke, NavRisks, None),
            View::Preflight => KeyBinding::new(&keystroke, NavPreflight, None),
            View::RuleLibrary => KeyBinding::new(&keystroke, NavRules, None),
            View::Settings => KeyBinding::new(&keystroke, NavSettings, None),
            View::TaskList(TaskState::Running) => KeyBinding::new(&keystroke, NavTasksRunning, None),
            View::TaskList(TaskState::Done) => KeyBinding::new(&keystroke, NavTasksDone, None),
            // 上面那份清单里不该出现别的视图；出现了就是清单写错了（下面有测试报）
            _ => return None,
        })
    })
    .collect()
}

/// 打开窗口并进入事件循环。数据与配色由调用方给：窗口自己不去读磁盘。
pub fn run(store: Store, palette: Palette, initial: View) {
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
        cx.bind_keys(nav_bindings());
        let store = store.clone();
        let _ = cx.open_window(options, move |window, cx| {
            let root = cx.new(|cx| Root {
                store: store.clone(),
                palette,
                state: State::new(initial),
                focus: cx.focus_handle(),
            });
            // 键盘分发要求根节点拿着焦点。不显式要，窗口开着但按键全落到空处。
            let handle = root.read(cx).focus.clone();
            window.focus(&handle);
            root
        });
        cx.activate(true);
    });
}

/// 界面状态：**与 gpui 无关**，所以点击 / 键位这套状态机可以脱离窗口跑单测。
///
/// 只有这两样是「用户操作出来的」，其余全是从 Store 算出来的。
#[derive(Clone, Debug)]
pub struct State {
    view: View,
    selected_task: Option<String>,
}

impl State {
    pub fn new(view: View) -> Self {
        Self {
            view,
            selected_task: None,
        }
    }

    /// 应用一个动作，返回「要不要重绘」。
    ///
    /// 没变化就不重绘：连点同一个入口不该让整棵树重新组装一遍。
    /// 认不出来的动作 id 什么都不做 —— 但那是 bug，`View::from_action` 那边有测试守着。
    pub fn apply(&mut self, action: &Action) -> bool {
        match action {
            Action::Nav(id) => match View::from_action(id) {
                Some(view) if view != self.view => {
                    self.view = view;
                    true
                }
                Some(_) => false,
                None => false,
            },
            Action::OpenTask(id) => {
                // 已经在看这个任务就别动：再点一下会把展开的时间线收回去，等于惩罚点击
                if self.selected_task.as_deref() == Some(id.as_str())
                    && matches!(self.view, View::TaskDetail { .. })
                {
                    return false;
                }
                self.selected_task = Some(id.clone());
                self.view = View::TaskDetail { expanded: false };
                true
            }
            Action::ToggleTimeline => match self.view {
                View::TaskDetail { expanded } => {
                    self.view = View::TaskDetail { expanded: !expanded };
                    true
                }
                // 折叠条只出现在详情页；不在详情页时收到这个动作说明状态算错了，别猜。
                _ => false,
            },
        }
    }

    pub fn view(&self) -> View {
        self.view
    }

    pub fn selected_task(&self) -> Option<&str> {
        self.selected_task.as_deref()
    }
}

/// gpui 侧：数据 + 配色 + 状态 + 焦点句柄。
pub struct Root {
    store: Store,
    palette: Palette,
    state: State,
    /// 根节点的焦点句柄：键盘分发靠它把按键送到 `on_action`。
    focus: FocusHandle,
}

impl Root {
    fn shift(&mut self, action: Action, cx: &mut Context<Self>) {
        if self.state.apply(&action) {
            cx.notify();
        }
    }

    fn tree(&self) -> Node {
        let ctx = ViewCtx::with_task(&self.store, self.palette, self.state.selected_task());
        shell::build(self.state.view, &ctx)
    }
}

impl Render for Root {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tree = self.tree();
        div()
            .flex()
            .flex_col()
            .size_full()
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &NavOverview, _, cx| this.shift(Action::Nav("overview"), cx)))
            .on_action(cx.listener(|this, _: &NavRisks, _, cx| this.shift(Action::Nav("risks"), cx)))
            .on_action(cx.listener(|this, _: &NavPreflight, _, cx| this.shift(Action::Nav("preflight"), cx)))
            .on_action(cx.listener(|this, _: &NavRules, _, cx| this.shift(Action::Nav("rules"), cx)))
            .on_action(cx.listener(|this, _: &NavSettings, _, cx| this.shift(Action::Nav("settings"), cx)))
            .on_action(cx.listener(|this, _: &NavTasksRunning, _, cx| this.shift(Action::Nav("tasks.running"), cx)))
            .on_action(cx.listener(|this, _: &NavTasksDone, _, cx| this.shift(Action::Nav("tasks.done"), cx)))
            .child(to_element(&tree, cx))
    }
}

/// 场景树 → gpui 元素。规整的 1:1 翻译，不许在这里加任何业务判断。
///
/// 唯一多出来的一件事：带 `action` 的节点变成可点，命中时把动作交回 `Root::apply`。
fn to_element(node: &Node, cx: &mut Context<Root>) -> AnyElement {
    let mut el = div().flex();
    el = match node.style.axis {
        Axis::Row => el.flex_row(),
        Axis::Column => el.flex_col(),
    };
    el = apply(el, &node.style);
    if let Some(action) = node.action.clone() {
        // 指针变手 = 「这里能点」的最基本反馈；没有动作的节点保持箭头
        el = el.cursor_pointer().on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this: &mut Root, _event, _window, cx| {
                this.shift(action.clone(), cx);
            }),
        );
    }
    if let Some(text) = &node.text {
        el = el.child(text.clone());
    }
    for child in &node.children {
        el = el.child(to_element(child, cx));
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TaskState;
    use crate::state::store;

    fn state() -> State {
        State::new(View::Dashboard)
    }

    #[test]
    fn 侧栏动作真的能换视图() {
        let mut state = state();
        for (view, action) in [
            (View::RiskList, "risks"),
            (View::Preflight, "preflight"),
            (View::RuleLibrary, "rules"),
            (View::Settings, "settings"),
            (View::TaskList(TaskState::Done), "tasks.done"),
            (View::Dashboard, "overview"),
        ] {
            assert!(state.apply(&Action::Nav(action)), "{action} 应该换视图");
            assert_eq!(state.view(), view, "{action} 落到了别的视图");
        }
    }

    #[test]
    fn 点当前入口不重绘也不改状态() {
        let mut state = state();
        assert!(!state.apply(&Action::Nav("overview")), "本来就在总览");
        assert_eq!(state.view(), View::Dashboard);
    }

    #[test]
    fn 认不出来的动作什么都不做() {
        let mut state = state();
        assert!(!state.apply(&Action::Nav("nope")));
        assert_eq!(state.view(), View::Dashboard);
        assert_eq!(state.selected_task(), None);
    }

    #[test]
    fn 点任务卡打开详情且记住是谁() {
        let mut state = state();
        assert!(state.apply(&Action::OpenTask("tk_2f47".into())));
        assert_eq!(state.view(), View::TaskDetail { expanded: false });
        assert_eq!(state.selected_task(), Some("tk_2f47"));
        // 展开时间线
        assert!(state.apply(&Action::ToggleTimeline));
        assert_eq!(state.view(), View::TaskDetail { expanded: true });
        assert!(state.apply(&Action::ToggleTimeline));
        assert_eq!(state.view(), View::TaskDetail { expanded: false });
    }

    #[test]
    fn 再点同一张卡不会把展开态重置() {
        let mut state = state();
        state.apply(&Action::OpenTask("tk_2f47".into()));
        state.apply(&Action::ToggleTimeline);
        assert!(
            !state.apply(&Action::OpenTask("tk_2f47".into())),
            "已经在看这个任务了，不该重来一遍"
        );
        assert_eq!(state.view(), View::TaskDetail { expanded: true });
    }

    /// 换视图不动选中项：从详情退回列表再点回来，选中的还是那个任务。
    #[test]
    fn 换视图不影响选中任务() {
        let mut state = state();
        state.apply(&Action::OpenTask("tk_2f47".into()));
        state.apply(&Action::Nav("tasks.running"));
        assert_eq!(state.selected_task(), Some("tk_2f47"));
    }

    /// 有键位的视图必须都注册了绑定 —— 侧栏写着 ⌘4，键盘上按不出来是更隐蔽的「点了没反应」。
    #[test]
    fn 快捷键全覆盖() {
        let bound = nav_bindings().len();
        let with_key = View::all()
            .into_iter()
            .filter(|view| view.shortcut_key().is_some())
            .count();
        assert_eq!(bound, with_key, "有键位的视图数与注册的绑定数不一致");
        assert_eq!(bound, 7);
    }

    /// 界面上的每个可点节点都必须能落到一个真实动作上（死按钮 = 用户点了没反应）。
    #[test]
    fn 场景树里的动作全都认得() {
        let store = Store::from_fixtures(store::fixtures_dir());
        let palette = Palette::for_appearance(crate::ui::Appearance::Light);
        for view in View::all() {
            let ctx = ViewCtx::with_task(&store, palette, None);
            let mut stack = vec![shell::build(view, &ctx)];
            while let Some(node) = stack.pop() {
                if let Some(action) = &node.action {
                    // 动作本身得能跑：换成真状态走一遍，不能只「认得」
                    let mut state = State::new(view);
                    state.apply(action);
                    match action {
                        Action::Nav(id) => assert!(
                            View::from_action(id).is_some(),
                            "{} 里有认不出来的动作 {id}",
                            view.snapshot_file()
                        ),
                        Action::OpenTask(id) => assert!(!id.is_empty()),
                        Action::ToggleTimeline => assert_eq!(
                            node.kind,
                            crate::ui::Kind::Collapsible,
                            "折叠动作只挂在折叠条上"
                        ),
                    }
                }
                stack.extend(node.children.iter().cloned());
            }
        }
    }
}
