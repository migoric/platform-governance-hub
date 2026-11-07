//! 任务详情：M0 用静态 fixture（`fixtures/task-detail.json`），M2 换成 provider 回放的同一份内容。
//!
//! 思考折叠条的文案格式只在这里算一次：`思考 2 分 14 秒 · 12 步`。
//! 折叠条的价值不是「展示 AI 在思考」，而是给出可审计的时间线 —— 展开后必须逐条列出工具调用。

use serde::Deserialize;

use super::format;
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
    pub thought: Thought,
    pub output: Output,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Thought {
    pub duration_ms: u64,
    pub step_count: u32,
    pub tools: Vec<ToolTrace>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ToolTrace {
    pub name: String,
    pub summary: String,
    pub ok: bool,
    pub bytes: u64,
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

impl Thought {
    /// 收起态那一行：`思考 2 分 14 秒 · 12 步`。
    pub fn summary_line(&self) -> String {
        format!(
            "思考 {} · {} 步",
            format::duration(self.duration_ms),
            self.step_count
        )
    }

    pub fn tool_count(&self) -> usize {
        self.tools.len()
    }
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

    pub fn from_json(text: &str) -> Result<TaskDetail, serde_json::Error> {
        serde_json::from_str(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 折叠条文案的格式只算一次() {
        let thought = Thought {
            duration_ms: 134_000,
            step_count: 12,
            tools: vec![],
        };
        assert_eq!(thought.summary_line(), "思考 2 分 14 秒 · 12 步");
    }

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
        assert_eq!(detail.thought.tool_count(), 0);
    }
}
