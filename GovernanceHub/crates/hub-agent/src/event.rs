//! 内部事件模型（封闭集，7 种）—— 对应 docs/agent-acl.md §2。
//!
//! 五条铁律里可以在本地校验的是第 3、4、5 条：
//! - `tool_call` 与 `tool_result` 按 `callId` 配对；
//! - `usage` 允许缺失（缺失时不能当 0）；
//! - `error` 之后必须还有 `done`。
//!
//! 事件**不携带**模型名 / temperature / max_tokens：那些属于 provider 内部实现。

use serde::{Deserialize, Serialize};

/// 事件契约版本。加一种新事件语义才允许升版本，升版本 = 全部适配器一起改。
pub const CONTRACT_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    Started {
        #[serde(rename = "sessionId")]
        session_id: String,
        provider: String,
        capabilities: super::Capabilities,
    },
    /// 只有增量，没有整段：整段由消费方自己拼（铁律 2）。
    Text { delta: String },
    ToolCall {
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
        args: serde_json::Value,
    },
    ToolResult {
        #[serde(rename = "callId")]
        call_id: String,
        ok: bool,
        summary: String,
        bytes: u64,
    },
    Usage {
        #[serde(rename = "inputTokens")]
        input_tokens: u64,
        #[serde(rename = "outputTokens")]
        output_tokens: u64,
        #[serde(rename = "costUsd")]
        cost_usd: Option<f64>,
    },
    Error {
        code: String,
        message: String,
        retryable: bool,
    },
    Done { reason: DoneReason },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DoneReason {
    Ok,
    Cancelled,
    Error,
    MaxSteps,
}

/// 违反铁律的一条记录。门禁与单测都读它，不靠 panic。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Violation {
    pub at: usize,
    pub rule: &'static str,
    pub detail: String,
}

fn started_first(at: usize) -> Violation {
    Violation {
        at,
        rule: "started_first",
        detail: "第一个事件必须是 started".to_string(),
    }
}

/// 一次会话的事件时间线（按 `seq` 顺序存放，`seq` 就是下标）。
#[derive(Clone, Debug, Default)]
pub struct SessionTimeline {
    events: Vec<Event>,
}

impl SessionTimeline {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, event: Event) {
        self.events.push(event);
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn events(&self) -> &[Event] {
        &self.events
    }

    /// 逐条校验铁律 3/5。空时间线不算违规（还没开始）。
    pub fn validate(&self) -> Vec<Violation> {
        let mut out = Vec::new();
        let mut open_calls: Vec<(&str, usize)> = Vec::new();
        let mut saw_started = false;
        let mut done_after_error: Option<usize> = None;

        for (at, event) in self.events.iter().enumerate() {
            match event {
                Event::Started { .. } => {
                    if saw_started {
                        out.push(Violation {
                            at,
                            rule: "started_once",
                            detail: "同一条时间线出现第二个 started".to_string(),
                        });
                    }
                    saw_started = true;
                }
                Event::Text { .. } => {
                    if !saw_started {
                        out.push(started_first(at));
                    }
                }
                Event::ToolCall { call_id, .. } => {
                    if !saw_started {
                        out.push(started_first(at));
                    }
                    open_calls.push((call_id.as_str(), at));
                }
                Event::ToolResult { call_id, .. } => {
                    match open_calls.iter().position(|(id, _)| *id == call_id.as_str()) {
                        Some(idx) => {
                            open_calls.remove(idx);
                        }
                        None => out.push(Violation {
                            at,
                            rule: "tool_result_paired",
                            detail: format!("tool_result 找不到对应的 tool_call：{call_id}"),
                        }),
                    }
                }
                Event::Usage { .. } => {}
                Event::Error { .. } => done_after_error = Some(at),
                Event::Done { .. } => done_after_error = None,
            }
        }

        for (call_id, at) in open_calls {
            out.push(Violation {
                at,
                rule: "tool_call_paired",
                detail: format!("tool_call 没有收尾的 tool_result：{call_id}"),
            });
        }
        if let Some(at) = done_after_error {
            out.push(Violation {
                at,
                rule: "error_needs_done",
                detail: "error 之后必须还有 done，否则 UI 的转圈永远不停".to_string(),
            });
        }
        out
    }

    /// 拼接后的正文 —— 唯一的「整段」来源（铁律 2 的消费方一侧）。
    pub fn text(&self) -> String {
        let mut s = String::new();
        for event in &self.events {
            if let Event::Text { delta } = event {
                s.push_str(delta);
            }
        }
        s
    }

    /// 成本合计：拿不到 `usage` 时返回 `None`，UI 显示「—」而不是 0（铁律 4）。
    pub fn cost_usd(&self) -> Option<f64> {
        let mut seen = false;
        let mut sum = 0.0;
        for event in &self.events {
            if let Event::Usage { cost_usd: Some(c), .. } = event {
                seen = true;
                sum += c;
            }
        }
        seen.then_some(sum)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn started() -> Event {
        Event::Started {
            session_id: "s1".into(),
            provider: "replay".into(),
            capabilities: super::super::Capabilities::default(),
        }
    }

    #[test]
    fn 配对正常的轨迹没有违规() {
        let mut t = SessionTimeline::new();
        t.push(started());
        t.push(Event::Text { delta: "a".into() });
        t.push(Event::ToolCall {
            call_id: "c1".into(),
            name: "snapshot_query".into(),
            args: serde_json::json!({}),
        });
        t.push(Event::ToolResult {
            call_id: "c1".into(),
            ok: true,
            summary: "ok".into(),
            bytes: 12,
        });
        t.push(Event::Done { reason: DoneReason::Ok });
        assert!(t.validate().is_empty(), "{:?}", t.validate());
        assert_eq!(t.text(), "a");
    }

    #[test]
    fn 未配对的工具调用会被指出() {
        let mut t = SessionTimeline::new();
        t.push(started());
        t.push(Event::ToolCall {
            call_id: "c9".into(),
            name: "rule_lookup".into(),
            args: serde_json::json!({}),
        });
        let v = t.validate();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].rule, "tool_call_paired");
    }

    #[test]
    fn error_之后必须有_done() {
        let mut t = SessionTimeline::new();
        t.push(started());
        t.push(Event::Error {
            code: "E_DISCONNECT".into(),
            message: "断线".into(),
            retryable: true,
        });
        let v = t.validate();
        assert_eq!(v, vec![Violation {
            at: 1,
            rule: "error_needs_done",
            detail: "error 之后必须还有 done，否则 UI 的转圈永远不停".to_string(),
        }]);

        t.push(Event::Done { reason: DoneReason::Error });
        assert!(t.validate().is_empty());
    }

    #[test]
    fn 拿不到成本时返回_none_而不是零() {
        let mut t = SessionTimeline::new();
        t.push(started());
        assert_eq!(t.cost_usd(), None);

        t.push(Event::Usage {
            input_tokens: 10,
            output_tokens: 20,
            cost_usd: Some(0.25),
        });
        t.push(Event::Usage {
            input_tokens: 1,
            output_tokens: 2,
            cost_usd: None,
        });
        assert_eq!(t.cost_usd(), Some(0.25));
    }

    #[test]
    fn 第一个事件必须是_started() {
        let mut t = SessionTimeline::new();
        t.push(Event::Text { delta: "x".into() });
        let v = t.validate();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].rule, "started_first");
    }
}
