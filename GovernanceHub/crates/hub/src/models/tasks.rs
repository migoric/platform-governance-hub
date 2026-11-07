//! `~/.pgh/agent/tasks.json` 的模型。
//!
//! 这个文件是**视图投影**，不是会话事实源：卡面四字段（目标 / 状态 / 耗时 / 参与的 agent）
//! 由 sidecar 算好再写进来，`durationMs` 直接显示、不重算（ui-ia.md §5）。
//! M2 接真实事件流后改的是投影逻辑，不是卡面。

use serde::{Deserialize, Deserializer};

/// 四种状态：进行中 / 等待确认 / 已完成 / 已中断。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TaskState {
    Running,
    Awaiting,
    Done,
    Interrupted,
}

impl TaskState {
    pub const ALL: [TaskState; 4] = [
        TaskState::Running,
        TaskState::Awaiting,
        TaskState::Done,
        TaskState::Interrupted,
    ];

    pub fn slug(self) -> &'static str {
        match self {
            TaskState::Running => "running",
            TaskState::Awaiting => "awaiting",
            TaskState::Done => "done",
            TaskState::Interrupted => "interrupted",
        }
    }

    /// 侧栏与卡面用的文字。**「等待确认」必须能从侧栏看到**（ui-ia.md §1.2）。
    pub fn label(self) -> &'static str {
        match self {
            TaskState::Running => "进行中",
            TaskState::Awaiting => "等待确认",
            TaskState::Done => "已完成",
            TaskState::Interrupted => "已中断",
        }
    }

    /// 空状态文案：为什么这里没有东西（ui-ia.md §4.4）。
    pub fn empty_hint(self) -> &'static str {
        match self {
            TaskState::Running => "没有正在跑的任务。任务要显式新建，点选列表不会自动开始",
            TaskState::Awaiting => "没有等你确认的任务。agent 到决策点才会出现在这里",
            TaskState::Done => "还没有完成的任务",
            TaskState::Interrupted => "没有被中断的任务",
        }
    }

    /// 未知状态按「已中断」处理：宁可让人以为它出过问题，也不要假装还在跑。
    pub fn from_slug(slug: &str) -> Option<TaskState> {
        TaskState::ALL.into_iter().find(|s| s.slug() == slug)
    }
}

impl<'de> Deserialize<'de> for TaskState {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Ok(TaskState::from_slug(&raw).unwrap_or(TaskState::Interrupted))
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TasksFile {
    pub schema_version: u32,
    pub generated_at: String,
    pub source: TasksSource,
    pub tasks: Vec<TaskCard>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TasksSource {
    pub kind: String,
}

/// 任务卡：四个字段固定，不随任务类型变化。
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskCard {
    pub id: String,
    /// 用户原话首句，不改写成标题党。
    pub title: String,
    pub state: TaskState,
    pub agents: Vec<String>,
    /// `real` / `replay`：来源标记，读的是产出性质，不是 provider 名。
    pub origin: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    /// 由 sidecar 算好，UI 只显示。
    pub duration_ms: u64,
    pub step_count: u32,
}

impl Default for TaskState {
    fn default() -> Self {
        TaskState::Running
    }
}

impl TaskCard {
    /// 参与的 agent 用「·」连；空则显示「未指派」而不是留白。
    pub fn agents_line(&self) -> String {
        if self.agents.is_empty() {
            "未指派".to_string()
        } else {
            self.agents.join(" · ")
        }
    }

    pub fn is_real(&self) -> bool {
        self.origin == "real"
    }

    pub fn origin_label(&self) -> &'static str {
        if self.is_real() { "真实数据" } else { "回放数据" }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 未知状态按已中断处理() {
        let card: TaskCard = serde_json::from_str(r#"{"id":"t1","state":"zombie"}"#).unwrap();
        assert_eq!(card.state, TaskState::Interrupted);
    }

    #[test]
    fn 没有_agent_时显示未指派() {
        let card = TaskCard::default();
        assert_eq!(card.agents_line(), "未指派");
    }

    #[test]
    fn 来源标记读的是产出性质() {
        let mut card = TaskCard::default();
        card.origin = "replay".into();
        assert_eq!(card.origin_label(), "回放数据");
        card.origin = "real".into();
        assert_eq!(card.origin_label(), "真实数据");
    }

    #[test]
    fn 四态文案齐全且互不相同() {
        let labels: Vec<&str> = TaskState::ALL.iter().map(|s| s.label()).collect();
        assert_eq!(labels, vec!["进行中", "等待确认", "已完成", "已中断"]);
        let hints: Vec<&str> = TaskState::ALL.iter().map(|s| s.empty_hint()).collect();
        for (i, a) in hints.iter().enumerate() {
            for b in &hints[i + 1..] {
                assert_ne!(a, b, "四态的空状态文案不能重复");
            }
        }
    }
}
