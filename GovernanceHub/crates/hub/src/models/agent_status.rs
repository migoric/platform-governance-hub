//! 握手状态：设置页的数据源（`~/.pgh/agent/status.json`，由 `pgh agent status` 落盘）。
//!
//! 为什么 UI 不自己跑 `pgh agent list`：那样「哪个能用 / 为什么不能用 / 算不算真实分析」
//! 会在终端与窗口里各算一遍。这里只做**宽容解码 + 文案**，不做判断。
//!
//! 两处「不知道」保持原样：
//!   · `attribution: None` —— 适配器没声明归属，界面写「未声明」，不替它说「回放」
//!   · 握手失败的 provider 不展开能力 —— 那会儿的能力是地板值，不是「不支持」

use serde::Deserialize;

use crate::models::Attribution;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentStatus {
    pub schema_version: u32,
    pub contract_version: u32,
    /// 用户在配置里选的 provider；`None` = 按阶梯自动选。
    pub preferred: Option<String>,
    /// 实际会用的那个；`None` = 没有可用服务。
    pub selected: Option<String>,
    /// `true` 只表示**这次产出不能当真实分析**，不表示「发生过降级」。
    pub degraded: bool,
    pub reason: Option<String>,
    pub providers: Vec<ProviderStatus>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderStatus {
    pub id: String,
    pub ok: bool,
    pub contract_version: u32,
    /// 远端服务版本，**只展示**，不参与分支判断（agent-acl §5）。
    pub server_version: Option<String>,
    pub capabilities: Capabilities,
    pub attribution: Option<Attribution>,
    pub reason: Option<String>,
    pub selected: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Capabilities {
    pub streaming: bool,
    pub tools: bool,
    pub vision: bool,
    pub cost: bool,
    pub max_steps: u32,
}

impl AgentStatus {
    pub fn from_json(text: &str) -> Result<AgentStatus, serde_json::Error> {
        serde_json::from_str(text)
    }

    pub fn selected_provider(&self) -> Option<&ProviderStatus> {
        let id = self.selected.as_deref()?;
        self.providers.iter().find(|provider| provider.id == id)
    }

    /// 这次产出算不算真实分析。`None` = 没有选中，或选中的那个没声明 —— 两种情况都不许说「真实」。
    pub fn is_real(&self) -> Option<bool> {
        self.selected_provider()?.attribution.as_ref().map(|a| a.real)
    }

    /// 顶部那句话：`使用 replay · 回放数据，不是真实分析`。
    pub fn headline(&self) -> String {
        match self.selected.as_deref() {
            None => "没有可用的 agent 服务".to_string(),
            Some(id) => match self.selected_provider().and_then(|p| p.attribution.as_ref()) {
                Some(attribution) if !attribution.label.is_empty() => format!("使用 {id} · {}", attribution.label),
                _ => format!("使用 {id}"),
            },
        }
    }

    /// 阶梯上排在选中项前面的、握手失败的 provider。
    ///
    /// 这是「为什么没用 remote」的答案。没有它，界面只会显示「使用 replay」，
    /// 用户会以为自己配好的服务在跑（agent-acl §6 第 1 条的反面）。
    pub fn skipped_before_selected(&self) -> Vec<&ProviderStatus> {
        let Some(selected) = self.selected.as_deref() else {
            return self.providers.iter().filter(|p| !p.ok).collect();
        };
        let mut out = Vec::new();
        for provider in &self.providers {
            if provider.id == selected {
                break;
            }
            if !provider.ok {
                out.push(provider);
            }
        }
        out
    }

    /// 降级/失败原因：先给 sidecar 的结论，再逐条补上被跳过的 provider 的具体原因。
    ///
    /// 结论和归属标签常常是同一句话（replay 的 `reason` 就是它的 `label`）。
    /// 同一行说两遍，界面会读成两个独立的问题 —— 与 CLI 的处理保持一致，只说一次。
    pub fn reason_lines(&self) -> Vec<String> {
        let mut lines = Vec::new();
        let label = self
            .selected_provider()
            .and_then(|provider| provider.attribution.as_ref())
            .map(|attribution| attribution.label.as_str())
            .unwrap_or("");
        if let Some(reason) = &self.reason {
            if !reason.is_empty() && reason != label {
                lines.push(reason.clone());
            }
        }
        for provider in self.skipped_before_selected() {
            lines.push(format!(
                "{} 不可用：{}",
                provider.id,
                provider.reason.as_deref().unwrap_or("没有给出原因")
            ));
        }
        lines
    }

    pub fn healthy_count(&self) -> usize {
        self.providers.iter().filter(|p| p.ok).count()
    }
}

impl ProviderStatus {
    /// `握手通过` / `握手失败`。文字，不靠颜色。
    pub fn status_label(&self) -> &'static str {
        if self.ok {
            "握手通过"
        } else {
            "握手失败"
        }
    }

    /// 能力行。只在握手通过时调用 —— 失败时那些 false 是地板值，说成「不支持」就是编。
    pub fn capability_line(&self) -> String {
        let mark = |value: bool| if value { "有" } else { "无" };
        let caps = &self.capabilities;
        let mut line = format!(
            "流式 {} · 工具 {} · 视觉 {} · 成本 {}",
            mark(caps.streaming),
            mark(caps.tools),
            mark(caps.vision),
            mark(caps.cost)
        );
        if caps.max_steps > 0 {
            line.push_str(&format!(" · 步数上限 {}", caps.max_steps));
        }
        line
    }

    /// 归属行：`真实分析` / `回放数据，不是真实分析` / `未声明产出归属`。
    pub fn attribution_line(&self) -> String {
        match &self.attribution {
            None => "未声明产出归属".to_string(),
            Some(attribution) if attribution.label.is_empty() => {
                if attribution.real {
                    "真实分析".to_string()
                } else {
                    "未声明是什么产出".to_string()
                }
            }
            Some(attribution) => attribution.label.clone(),
        }
    }

    pub fn is_real(&self) -> bool {
        self.attribution.as_ref().map(|a| a.real).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATUS: &str = include_str!("../../../../fixtures/agent-status.json");
    fn status() -> AgentStatus {
        AgentStatus::from_json(STATUS).expect("fixture 必须可解码")
    }

    #[test]
    fn fixture_是离线降级到回放() {
        let s = status();
        assert_eq!(s.selected.as_deref(), Some("replay"));
        assert_eq!(s.is_real(), Some(false), "回放不许被当成真实分析");
        assert!(s.headline().contains("回放数据，不是真实分析"), "{}", s.headline());
    }

    #[test]
    fn 归属标签与降级原因是同一句话时只说一次() {
        let s = status();
        assert_eq!(s.reason.as_deref(), Some(s.selected_provider().unwrap().attribution.as_ref().unwrap().label.as_str()));
        let lines = s.reason_lines();
        assert_eq!(
            lines.iter().filter(|line| line.contains("回放数据")).count(),
            0,
            "headline 已经写过这句话：{lines:?}"
        );
    }

    #[test]
    fn 排在选中项前面失败的都要能解释() {
        let s = status();
        let skipped: Vec<&str> = s.skipped_before_selected().iter().map(|p| p.id.as_str()).collect();
        assert_eq!(skipped, vec!["remote", "claude-cli"]);
        let lines = s.reason_lines().join("\n");
        assert!(lines.contains("remote 不可用"), "{lines}");
        assert!(lines.contains("claude-cli 不可用"), "{lines}");
        // 排在选中项后面的不算「被跳过」
        assert!(!lines.contains("replay 不可用"));
    }

    #[test]
    fn 没有选中时不编造使用者() {
        let mut s = status();
        s.selected = None;
        s.degraded = true;
        assert_eq!(s.headline(), "没有可用的 agent 服务");
        assert_eq!(s.is_real(), None);
        assert!(s.reason_lines().iter().all(|line| !line.contains("使用")));
    }

    #[test]
    fn 没声明归属时说未声明而不是回放() {
        let provider = ProviderStatus {
            id: "x".to_string(),
            ok: true,
            ..ProviderStatus::default()
        };
        assert_eq!(provider.attribution_line(), "未声明产出归属");
        assert!(!provider.is_real(), "没声明一律不算真实分析");
    }

    #[test]
    fn 握手失败不展开能力行() {
        // 能力行本身是纯格式化；这里守住的是「失败项不该被读出能力」这个调用约定
        let s = status();
        let failed = s.providers.iter().find(|p| !p.ok).unwrap();
        assert!(!failed.ok);
        assert!(!failed.capability_line().contains("步数上限"), "地板值不该显示步数上限");
        let ok = s.providers.iter().find(|p| p.ok).unwrap();
        assert!(ok.capability_line().contains("步数上限 6"), "{}", ok.capability_line());
    }

    #[test]
    fn 缺字段的旧报告也能打开() {
        let s = AgentStatus::from_json("{}").unwrap();
        assert_eq!(s.selected, None);
        assert_eq!(s.headline(), "没有可用的 agent 服务");
        assert!(s.providers.is_empty());
        assert_eq!(s.healthy_count(), 0);
    }
}
