//! 任务列表：哪些活儿在跑、哪些卡住了。M0 就定型，回归基准只建一次（roadmap M0 风险）。
//!
//! 列表是**虚拟化**的（M1 接 `uniform_list`），所以结构快照里记数据源条数而不是渲染行数。
//! 四种状态各出一个视图，空状态文案必须各不相同 —— 不能都写「暂无数据」。

use crate::models::TaskState;
use crate::state::selector;
use crate::ui::tokens::space;
use crate::ui::{kit, Kind, Node};

use super::ViewCtx;

pub fn build(ctx: &ViewCtx, state: TaskState) -> Node {
    let palette = ctx.palette;
    let tasks = match ctx.store.tasks.as_ref() {
        Some(tasks) => tasks,
        None => {
            return kit::panel(
                &palette,
                &format!("任务 · {}", state.label()),
                "还没有任务文件",
                kit::empty_state(
                    &palette,
                    "还没有任务。任务要显式新建，点选列表不会自动开始",
                    "任务列表读 ~/.pgh/agent/tasks.json（M0 由 pgh tasks --mock 生成）",
                ),
            )
        }
    };

    let cards = selector::tasks_in(tasks, state);
    let count = cards.len();
    let body = if cards.is_empty() {
        kit::empty_state(&palette, state.label(), state.empty_hint())
    } else {
        Node::new(Kind::Column)
            .gap(space::SM)
            // 数据源条数：uniform_list 懒渲染时，行数不可靠，条数可靠
            .data("agent.tasks", count)
            .children(cards.into_iter().map(|card| kit::task_card(&palette, card)))
    };

    kit::panel(
        &palette,
        &format!("任务 · {}", state.label()),
        &format!(
            "{} 条 · 等待确认 {} 条 · 来源 {}",
            count,
            selector::awaiting_count(tasks),
            tasks.source.kind
        ),
        body,
    )
}
