//! 会话投影：`agent/session.mjs` 的产物，界面**唯一**的事件流消费点。
//!
//! 为什么不让 UI 自己聚合事件：那样「调了几次工具」在任务卡、详情、设置页会各算一遍，
//! 迟早对不上（ui-ia.md §5 的老账）。投影在 sidecar 算一次，UI 只读。
//!
//! 三处「不知道」必须原样保留，不许被默认值填成「没事」：
//!   · `duration_ms: None`  —— 事件契约里没有时间戳，耗时就是未知，不是 0
//!   · `usage: None`        —— provider 没上报用量，不是「没用」
//!   · `cost_usd: None`     —— 拿不到成本，显示「—」，不是 0
//!
//! 时间线里 `ok: None` 同理：没见过工具结果（流被截断）和「工具失败了」是两件事。

use serde::Deserialize;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentSession {
    pub schema_version: u32,
    pub contract_version: u32,
    pub session_id: String,
    pub provider: String,
    pub attribution: Attribution,
    /// 用户原话：发给 agent 的那一句，不是任务卡上的标题。
    pub prompt: String,
    pub event_count: u32,
    pub timeline: Vec<TimelineItem>,
    pub tool_count: u32,
    pub step_count: u32,
    /// `None` = 不知道。事件契约（v1）没有时间戳字段，加了就得升版本。
    pub duration_ms: Option<u64>,
    pub usage: Option<Usage>,
    /// `ok` / `cancelled` / `error` / `max_steps`；空串表示旧文件没写。
    pub done_reason: String,
}

/// 产出归因。由 provider 自己声明（`attribution()`），不是按名字猜的。
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Attribution {
    /// 是不是真实分析。`false` 时 `label` 必填 —— 回放/模拟必须自报家门。
    pub real: bool,
    pub label: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    /// `None` = 拿不到成本。不是 0（agent-acl 铁律 4）。
    pub cost_usd: Option<f64>,
}

/// 时间线的一行。
///
/// 用「宽结构 + kind 判定」而不是 serde 的 internally tagged enum：旧版本多一种行类型时，
/// 整份会话不该打不开（宽容解码）。未知类型由 [`TimelineItem::step`] 落到 `Unknown`，
/// 界面上明说「不认识这一行」，不静默丢。
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TimelineItem {
    pub kind: String,
    pub text: String,
    pub call_id: String,
    pub name: String,
    pub ok: Option<bool>,
    pub bytes: Option<u64>,
    pub summary: String,
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

/// 时间线一行的语义。视图只匹配这个，不直接比字符串。
#[derive(Clone, Copy, Debug)]
pub enum Step<'a> {
    /// 思考/正文的一段（相邻增量已由 sidecar 合并）
    Text(&'a str),
    Tool(&'a TimelineItem),
    Error(&'a TimelineItem),
    /// 契约里没有的类型：显示出来，别假装没有
    Unknown(&'a str),
}

impl TimelineItem {
    pub fn step(&self) -> Step<'_> {
        match self.kind.as_str() {
            "text" => Step::Text(self.text.as_str()),
            "tool" => Step::Tool(self),
            "error" => Step::Error(self),
            other => Step::Unknown(other),
        }
    }

    /// 工具行的字节数文案：没法给数字时给「—」，不是 0 B。
    pub fn bytes_label(&self) -> String {
        match self.bytes {
            Some(bytes) => format!("{bytes} B"),
            None => "—".to_string(),
        }
    }
}

impl AgentSession {
    pub fn from_json(text: &str) -> Result<AgentSession, serde_json::Error> {
        serde_json::from_str(text)
    }

    pub fn is_real(&self) -> bool {
        self.attribution.real
    }

    /// 归因行：`replay · 回放数据，不是真实分析`。标签为空时只报 provider。
    pub fn attribution_line(&self) -> String {
        if self.attribution.label.is_empty() {
            self.provider.clone()
        } else {
            format!("{} · {}", self.provider, self.attribution.label)
        }
    }

    /// 结束原因的人话版。空串（旧文件）显示成「未记录」，不显示成成功。
    pub fn done_label(&self) -> &'static str {
        match self.done_reason.as_str() {
            "ok" => "正常结束",
            "cancelled" => "已取消",
            "error" => "错误结束",
            "max_steps" => "到达步数上限",
            _ => "结束原因未记录",
        }
    }

    /// 折叠条那一行：`11 个事件 · 2 次工具 · 耗时未记录`。
    ///
    /// 耗时只在真的知道时才写。原来是 fixture 里编的「2 分 14 秒」—— 那时候没人量过。
    pub fn summary_line(&self) -> String {
        let duration = match self.duration_ms {
            Some(ms) => crate::models::format::duration(ms),
            None => "耗时未记录".to_string(),
        };
        format!(
            "{} 个事件 · {} 次工具 · {}",
            self.event_count, self.tool_count, duration
        )
    }

    /// 用量行：`输入 1280 / 输出 96 token · 成本 —`。
    /// 没有 usage 时说「未上报用量」——「没上报」和「用了 0」是两件事。
    pub fn usage_line(&self) -> String {
        match &self.usage {
            None => "用量未上报".to_string(),
            Some(usage) => format!(
                "输入 {} / 输出 {} token · 成本 {}",
                usage.input_tokens,
                usage.output_tokens,
                crate::models::format::cost(usage.cost_usd)
            ),
        }
    }

    /// 以错误结束、却没有任何 error 行 —— 适配器没说原因。
    /// 这种情况界面必须自己承认不知道，不能只显示一个「错误结束」了事。
    pub fn has_unexplained_error(&self) -> bool {
        self.done_reason == "error"
            && !self
                .timeline
                .iter()
                .any(|item| matches!(item.step(), Step::Error(_)))
    }

    pub fn tool_items(&self) -> impl Iterator<Item = &TimelineItem> {
        self.timeline
            .iter()
            .filter(|item| matches!(item.step(), Step::Tool(_)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = include_str!("../../../../fixtures/agent-session.json");

    fn session() -> AgentSession {
        AgentSession::from_json(SESSION).expect("fixture 必须可解码")
    }

    #[test]
    fn fixture_是回放且自报家门() {
        let s = session();
        assert!(!s.is_real(), "回放不许声称是真实分析");
        assert!(s.attribution_line().contains("回放"), "{}", s.attribution_line());
    }

    #[test]
    fn 相邻增量合并成段且工具按调用顺序() {
        let s = session();
        // 11 个事件投影成 5 段：3 段文本 + 2 次工具
        assert_eq!(s.event_count, 11);
        assert_eq!(s.timeline.len(), 5);
        assert_eq!(s.tool_count, 2);
        let kinds: Vec<&str> = s
            .timeline
            .iter()
            .map(|i| match i.step() {
                Step::Text(_) => "text",
                Step::Tool(_) => "tool",
                Step::Error(_) => "error",
                Step::Unknown(_) => "unknown",
            })
            .collect();
        assert_eq!(kinds, vec!["text", "tool", "text", "tool", "text"]);
        // 最后一段是两条增量拼起来的（否则「另外提醒一句」会自成一截）
        match s.timeline.last().unwrap().step() {
            Step::Text(text) => assert!(text.contains("另外提醒一句") && text.contains("确定性词典匹配")),
            other => panic!("最后一段应该是文本：{other:?}"),
        }
    }

    #[test]
    fn 拿不到成本时是破折号不是零() {
        let s = session();
        assert_eq!(s.usage.as_ref().unwrap().cost_usd, None);
        assert!(s.usage_line().ends_with("成本 —"), "{}", s.usage_line());
        assert!(s.usage_line().contains("输入 1280"));
    }

    #[test]
    fn 耗时未知不编数字() {
        let s = session();
        assert_eq!(s.duration_ms, None);
        assert!(s.summary_line().contains("耗时未记录"), "{}", s.summary_line());
    }

    #[test]
    fn 缺字段的旧会话也能打开() {
        let s = AgentSession::from_json("{}").unwrap();
        assert_eq!(s.done_label(), "结束原因未记录");
        assert_eq!(s.usage_line(), "用量未上报");
        assert!(s.timeline.is_empty());
    }

    #[test]
    fn 未知行类型会显示成未知而不是消失() {
        let item = TimelineItem {
            kind: "thinking".to_string(),
            ..TimelineItem::default()
        };
        assert!(matches!(item.step(), Step::Unknown("thinking")));
    }

    #[test]
    fn 工具结果缺失时不给零字节() {
        let item = TimelineItem {
            kind: "tool".to_string(),
            bytes: None,
            ..TimelineItem::default()
        };
        assert_eq!(item.bytes_label(), "—");
    }

    #[test]
    fn 错误结束但没给原因时要认账() {
        let mut s = session();
        s.done_reason = "error".to_string();
        assert!(s.has_unexplained_error());
        s.timeline.push(TimelineItem {
            kind: "error".to_string(),
            code: "E_X".to_string(),
            message: "说清了".to_string(),
            ..TimelineItem::default()
        });
        assert!(!s.has_unexplained_error());
    }
}
