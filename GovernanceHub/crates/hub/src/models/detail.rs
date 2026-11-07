//! 任务记录：这件事是谁要的、做到哪一步、产出是什么。
//!
//! **不含工具轨迹。** M0 这里有一个 `thought.tools` 静态数组，M2 换成事件流投影
//! （`models/session.rs`）后删掉了 —— 两套时间线必然会分叉，而界面上没法标注
//! 「这一份是编的」。

use serde::Deserialize;

use super::tasks::TaskState;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskDetail {
    pub task_id: String,
    pub title: String,
    pub state: TaskState,
    /// 用户原话。详情页第一块，不做改写。
    pub user_message: String,
    /// 产出归因：哪个角色做的。
    pub produced_by: String,
    pub output: Output,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Output {
    /// `explanation` / `draft` / `suggestion`：产出类型标记，和 agent 名字必须同屏（ui-ia.md §2.2）。
    pub kind: String,
    pub label: String,
    pub title: String,
    pub lines: Vec<String>,
}

impl TaskDetail {
    /// 归因行的文字：`条款研究员 · 解释`。名字只做归因，不做背书（ui-ia.md §6）。
    pub fn attribution(&self) -> String {
        if self.produced_by.is_empty() {
            self.output.label.clone()
        } else {
            format!("{} · {}", self.produced_by, self.output.label)
        }
    }

    /// 任务还在跑，但会话已经结束 —— 界面必须说清这两件事的关系，
    /// 否则「进行中」配上一条 `done(ok)` 的会话，读起来像自相矛盾。
    pub fn runs_ahead_of_session(&self) -> bool {
        matches!(self.state, TaskState::Running | TaskState::Awaiting)
    }

    pub fn from_json(text: &str) -> Result<TaskDetail, serde_json::Error> {
        serde_json::from_str(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 归因行带产出类型() {
        let detail: TaskDetail = serde_json::from_str(
            r#"{
                "taskId": "tk_1",
                "producedBy": "条款研究员",
                "output": { "kind": "explanation", "label": "解释", "title": "草稿" }
            }"#,
        )
        .unwrap();
        assert_eq!(detail.attribution(), "条款研究员 · 解释");
    }

    #[test]
    fn 缺字段也能读() {
        let detail = TaskDetail::from_json("{}").expect("宽容解码");
        assert_eq!(detail.attribution(), "");
    }

    #[test]
    fn 只对还在跑的任务提醒会话已结束() {
        let mut detail = TaskDetail::default();
        detail.state = TaskState::Running;
        assert!(detail.runs_ahead_of_session());
        detail.state = TaskState::Done;
        assert!(!detail.runs_ahead_of_session());
    }

    /// 两份 fixture 讲的是同一次请求：任务记录里的原话必须就是发给 agent 的那一句。
    /// 分叉了说明有人只改了一边 —— 界面上就会「你要的」和「它做的」不是一回事。
    #[test]
    fn fixture_里任务原话与会话_prompt_一致() {
        let detail = TaskDetail::from_json(include_str!("../../../../fixtures/task-detail.json")).unwrap();
        let session = crate::models::AgentSession::from_json(include_str!(
            "../../../../fixtures/agent-session.json"
        ))
        .unwrap();
        assert_eq!(detail.user_message, session.prompt);
    }
}
