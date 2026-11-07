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
}

impl<'a> ViewCtx<'a> {
    pub fn new(store: &'a Store, palette: Palette) -> Self {
        Self { store, palette }
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
            View::TaskList(_) => "进行中",
            View::TaskDetail { .. } => "任务",
        }
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
