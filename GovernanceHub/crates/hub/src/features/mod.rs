//! 视图层：每个面板一个文件，唯一职责是**把 Store 里的数据摆成场景树**。
//!
//! 两条硬规矩：数字只能来自 Selector（不在这里 filter+count），文案只能来自 models::format。

pub mod dashboard;
pub mod preflight;
pub mod risk_list;
pub mod rule_library;
pub mod settings;
pub mod shell;
pub mod task_detail;
pub mod task_list;

use crate::state::Store;
use crate::ui::Palette;

/// 视图上下文：只有数据与配色，没有 gpui 类型 —— 所以视图层可以脱离窗口跑单测。
#[derive(Clone, Copy)]
pub struct ViewCtx<'a> {
    pub store: &'a Store,
    pub palette: Palette,
    /// 当前选中的任务 id（详情页用）。`None` = 没有选中态，出图走这一支。
    pub selected_task: Option<&'a str>,
}

impl<'a> ViewCtx<'a> {
    pub fn new(store: &'a Store, palette: Palette) -> Self {
        Self {
            store,
            palette,
            selected_task: None,
        }
    }

    /// 真窗口用：带上「现在选的是哪个任务」。
    pub fn with_task(store: &'a Store, palette: Palette, task: Option<&'a str>) -> Self {
        Self {
            store,
            palette,
            selected_task: task,
        }
    }
}

/// 七个面板 + 十一个出图视图名。M1 新增上架前检查与规则库，M2 新增设置。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    Dashboard,
    RiskList,
    Preflight,
    RuleLibrary,
    Settings,
    TaskList(crate::models::TaskState),
    TaskDetail { expanded: bool },
}

impl View {
    /// 侧栏高亮的入口名。
    pub fn sidebar_entry(self) -> &'static str {
        match self {
            View::Dashboard => "总览",
            View::RiskList => "风险清单",
            View::Preflight => "上架前检查",
            View::RuleLibrary => "规则与证据",
            View::Settings => "设置",
            // 「已完成」只亮已完成的那个入口；等待确认与已中断都还在进行中的活儿里
            View::TaskList(crate::models::TaskState::Done) => "已完成",
            View::TaskList(_) => "进行中",
            View::TaskDetail { .. } => "任务",
        }
    }

    /// 动作 id：侧栏条目挂的就是它。改名等于改接口，`from_action` 必须同步。
    pub fn action(self) -> &'static str {
        match self {
            View::Dashboard => "overview",
            View::RiskList => "risks",
            View::Preflight => "preflight",
            View::RuleLibrary => "rules",
            View::Settings => "settings",
            View::TaskList(state) => match state {
                crate::models::TaskState::Running => "tasks.running",
                crate::models::TaskState::Awaiting => "tasks.awaiting",
                crate::models::TaskState::Done => "tasks.done",
                crate::models::TaskState::Interrupted => "tasks.interrupted",
            },
            View::TaskDetail { .. } => "task.detail",
        }
    }

    /// 侧栏展示的键位标签（不含修饰键）。`None` = 没有入口快捷键。
    ///
    /// 侧栏写什么键、窗口绑什么键，都从这里来 —— 两边各写一份，迟早出现「标签写着 ⌘4，
    /// 按下去没反应」。
    pub fn shortcut_key(self) -> Option<&'static str> {
        match self {
            View::TaskList(crate::models::TaskState::Running) => Some("1"),
            View::TaskList(crate::models::TaskState::Done) => Some("0"),
            View::Dashboard => Some("2"),
            View::RiskList => Some("3"),
            View::Preflight => Some("4"),
            View::RuleLibrary => Some("7"),
            View::Settings => Some(","),
            _ => None,
        }
    }

    /// 交给 gpui 的键位串（含修饰键）。修饰键跟侧栏标签同一套说法：macOS 是 ⌘，其余是 Ctrl。
    pub fn keystroke(self) -> Option<String> {
        let modifier = if cfg!(target_os = "macos") { "cmd" } else { "ctrl" };
        self.shortcut_key().map(|key| format!("{modifier}-{key}"))
    }

    /// 动作 id → 视图。**认不出来的返回 `None`**：宁可什么都不做，也不要猜一个视图糊弄过去。
    pub fn from_action(action: &str) -> Option<View> {
        use crate::models::TaskState;
        Some(match action {
            "overview" => View::Dashboard,
            "risks" => View::RiskList,
            "preflight" => View::Preflight,
            "rules" => View::RuleLibrary,
            "settings" => View::Settings,
            "tasks.running" => View::TaskList(TaskState::Running),
            "tasks.awaiting" => View::TaskList(TaskState::Awaiting),
            "tasks.done" => View::TaskList(TaskState::Done),
            "tasks.interrupted" => View::TaskList(TaskState::Interrupted),
            "task.detail" => View::TaskDetail { expanded: false },
            _ => return None,
        })
    }

    /// 结构快照的文件名。全 ASCII：Windows 上也别指望文件名编码一致。
    pub fn snapshot_file(self) -> String {
        match self {
            View::Dashboard => "01-overview.json".to_string(),
            View::RiskList => "02-risk-list.json".to_string(),
            View::Preflight => "09-preflight.json".to_string(),
            View::RuleLibrary => "10-rule-library.json".to_string(),
            View::Settings => "11-settings.json".to_string(),
            View::TaskList(state) => format!("0{}-tasks-{}.json", 3 + state_index(state), state.slug()),
            View::TaskDetail { expanded: false } => "07-task-detail-collapsed.json".to_string(),
            View::TaskDetail { expanded: true } => "08-task-detail-expanded.json".to_string(),
        }
    }

    /// 11 份快照的固定顺序：总览 / 风险清单 / 四态任务列表 / 详情两态 / 上架前检查 / 规则库 / 设置。
    pub fn all() -> Vec<View> {
        use crate::models::TaskState;
        vec![
            View::Dashboard,
            View::RiskList,
            View::TaskList(TaskState::Running),
            View::TaskList(TaskState::Awaiting),
            View::TaskList(TaskState::Done),
            View::TaskList(TaskState::Interrupted),
            View::TaskDetail { expanded: false },
            View::TaskDetail { expanded: true },
            View::Preflight,
            View::RuleLibrary,
            View::Settings,
        ]
    }

    /// 渲染成场景树。
    pub fn build(self, ctx: &ViewCtx) -> crate::ui::Node {
        match self {
            View::Dashboard => dashboard::build(ctx),
            View::RiskList => risk_list::build(ctx),
            View::Preflight => preflight::build(ctx),
            View::RuleLibrary => rule_library::build(ctx),
            View::Settings => settings::build(ctx),
            View::TaskList(state) => task_list::build(ctx, state),
            View::TaskDetail { expanded } => task_detail::build(ctx, expanded),
        }
    }
}

/// 四态在文件名里的次序：进行中 / 等待确认 / 已完成 / 已中断。
fn state_index(state: crate::models::TaskState) -> u32 {
    use crate::models::TaskState;
    match state {
        TaskState::Running => 0,
        TaskState::Awaiting => 1,
        TaskState::Done => 2,
        TaskState::Interrupted => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 动作 id 与视图一一对应：改名字忘了改另一边，这条先红。
    #[test]
    fn 动作_id_能往返() {
        for view in View::all() {
            let back = View::from_action(view.action())
                .unwrap_or_else(|| panic!("{} 的 id 认不回来", view.snapshot_file()));
            // 详情只记得住「打开」，记不住展开态 —— 展开是选中之后的第二次动作
            if matches!(view, View::TaskDetail { .. }) {
                assert_eq!(back, View::TaskDetail { expanded: false });
            } else {
                assert_eq!(back, view);
            }
        }
    }

    /// 键位标签与绑定串同源：侧栏写 ⌘4，绑定就是 cmd-4（非 macOS 是 ctrl-4）。
    #[test]
    fn 快捷键标签与绑定串同源() {
        let modifier = if cfg!(target_os = "macos") { "cmd" } else { "ctrl" };
        let mut with_key = 0;
        for view in View::all() {
            match (view.shortcut_key(), view.keystroke()) {
                (Some(key), Some(keystroke)) => {
                    with_key += 1;
                    assert_eq!(keystroke, format!("{modifier}-{key}"));
                }
                (None, None) => {}
                other => panic!("{} 的键位只配了一半：{other:?}", view.snapshot_file()),
            }
        }
        assert_eq!(with_key, 7, "侧栏七个入口各有一条键位");
    }
}
