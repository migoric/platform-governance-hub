//! 能力协商与降级阶梯 —— `remote → claude-cli → replay → none`。
//!
//! 业务分支永远不看「是哪家服务」，只看 `Capabilities`（AGENTS.md §5 第 3 问）。
//! 这个模块是那条规矩唯一允许出现 provider 名字的地方：它产出**计划**，不产出判断。

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Capabilities {
    pub streaming: bool,
    pub tools: bool,
    pub vision: bool,
    /// 拿不到成本的服务必须为 `false`，UI 显示「—」而不是 0。
    pub cost: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    /// 远程 hub（对端尚未存在，见 docs/agent-acl.md §12）
    Remote,
    /// 本机 claude CLI
    ClaudeCli,
    /// 回放 fixture：断网也能演示，但 UI 必须标注「回放数据」
    Replay,
    /// 没有任何可用 provider
    None,
}

impl ProviderKind {
    /// 阶梯顺序，越靠前越强。
    pub const LADDER: [ProviderKind; 3] = [
        ProviderKind::Remote,
        ProviderKind::ClaudeCli,
        ProviderKind::Replay,
    ];

    pub fn id(self) -> &'static str {
        match self {
            ProviderKind::Remote => "remote",
            ProviderKind::ClaudeCli => "claude-cli",
            ProviderKind::Replay => "replay",
            ProviderKind::None => "none",
        }
    }

    /// 这份产出是真实分析还是回放。UI 的来源标记只读这个，不读 provider 名。
    pub fn is_real(self) -> bool {
        matches!(self, ProviderKind::Remote | ProviderKind::ClaudeCli)
    }
}

/// 选出来的计划：主 provider + 是否降级 + 降级原因（给人看的一句话）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub primary: ProviderKind,
    pub degraded: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct DegradeLadder {
    available: Vec<ProviderKind>,
}

impl DegradeLadder {
    pub fn new(available: &[ProviderKind]) -> Self {
        let mut kept: Vec<ProviderKind> = Vec::new();
        for kind in ProviderKind::LADDER {
            if available.contains(&kind) {
                kept.push(kind);
            }
        }
        Self { available: kept }
    }

    pub fn available(&self) -> &[ProviderKind] {
        &self.available
    }

    /// 取阶梯上最强的可用者。全部不可用时返回 `None`，调用方据此禁用助手面板
    /// —— 事实层（快照 + 规则）不受影响，这是两条独立的路径。
    pub fn plan(&self) -> Plan {
        match self.available.first() {
            None => Plan {
                primary: ProviderKind::None,
                degraded: true,
                reason: Some("没有可用的 agent 服务：助手面板禁用，事实层照常可用".to_string()),
            },
            Some(&primary) => {
                let weak = matches!(primary, ProviderKind::Replay);
                Plan {
                    primary,
                    degraded: weak,
                    reason: weak.then(|| "回放数据，不是真实分析".to_string()),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 按阶梯取最强可用者() {
        let ladder = DegradeLadder::new(&[ProviderKind::Replay, ProviderKind::ClaudeCli]);
        let plan = ladder.plan();
        assert_eq!(plan.primary, ProviderKind::ClaudeCli);
        assert!(!plan.degraded);
        assert_eq!(plan.reason, None);
    }

    #[test]
    fn 只剩回放时必须标注回放() {
        let plan = DegradeLadder::new(&[ProviderKind::Replay]).plan();
        assert_eq!(plan.primary, ProviderKind::Replay);
        assert!(plan.degraded);
        assert_eq!(plan.reason.as_deref(), Some("回放数据，不是真实分析"));
    }

    #[test]
    fn 一个都没有时退到_none_且不崩() {
        let plan = DegradeLadder::new(&[]).plan();
        assert_eq!(plan.primary, ProviderKind::None);
        assert!(plan.degraded);
        assert!(plan.reason.is_some());
    }

    #[test]
    fn 真实与回放的判定只看能力不看名字() {
        assert!(ProviderKind::Remote.is_real());
        assert!(ProviderKind::ClaudeCli.is_real());
        assert!(!ProviderKind::Replay.is_real());
        assert!(!ProviderKind::None.is_real());
    }
}
