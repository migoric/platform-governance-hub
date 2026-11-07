//! `snapshot.json` 的 Rust 侧模型（宽容解码）。
//!
//! 字段顺序与 `docs/snapshot-contract.md` 一致；这里只声明 UI 用得到的部分，
//! 未来 sidecar 加字段不需要动这份代码（serde 默认忽略未知字段）。

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// 四档严重度是封闭集，不许加第五档（refactor-constraints §1.1）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Severity {
    Blocker,
    Required,
    Suggest,
    /// 缺省与未知档位都落到这里：宁可让人「留意」，也不要因为一个陌生值打不开快照。
    #[default]
    Observe,
}

impl Severity {
    /// 排序用：阻断最靠前。
    pub const ALL: [Severity; 4] = [
        Severity::Blocker,
        Severity::Required,
        Severity::Suggest,
        Severity::Observe,
    ];

    pub fn slug(self) -> &'static str {
        match self {
            Severity::Blocker => "blocker",
            Severity::Required => "required",
            Severity::Suggest => "suggest",
            Severity::Observe => "observe",
        }
    }

    /// 徽章上的文字。**不能只靠颜色表达严重度**（ui-ia.md §7）。
    pub fn label(self) -> &'static str {
        match self {
            Severity::Blocker => "阻断",
            Severity::Required => "必改",
            Severity::Suggest => "建议",
            Severity::Observe => "留意",
        }
    }

    /// 未知档位一律降到「留意」：宁可见得少，也不让一份陌生快照打不开。
    pub fn from_slug(slug: &str) -> Option<Severity> {
        Severity::ALL.into_iter().find(|s| s.slug() == slug)
    }
}

impl Serialize for Severity {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.slug())
    }
}

impl<'de> Deserialize<'de> for Severity {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Ok(Severity::from_slug(&raw).unwrap_or(Severity::Observe))
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Snapshot {
    pub schema_version: u32,
    pub generated_at: String,
    pub duration_ms: u64,
    pub source: SnapshotSource,
    pub scope: Scope,
    pub summary: Summary,
    pub rule_packs: Vec<RulePack>,
    pub items: Vec<Item>,
    pub findings: Vec<Finding>,
    pub agent: AgentState,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SnapshotSource {
    pub kind: String,
    pub label: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Scope {
    pub platform: String,
    pub sites: Vec<String>,
    pub categories: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Summary {
    pub items: u32,
    pub findings: u32,
    pub by_severity: BySeverity,
    /// 判不了的不算通过（snapshot-contract §5）。
    pub unjudged: u32,
    pub rules_evaluated: u32,
    pub rule_packs: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BySeverity {
    pub blocker: u32,
    pub required: u32,
    pub suggest: u32,
    pub observe: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RulePack {
    pub id: String,
    pub version: String,
    pub rule_count: u32,
    pub effective_from: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Item {
    pub id: String,
    pub sku: String,
    pub title: String,
    pub category: Vec<String>,
    pub site: String,
    pub status: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Finding {
    pub id: String,
    pub item_id: String,
    pub rule_id: String,
    pub rule_version: String,
    pub severity: Severity,
    /// `deterministic` / `semantic` / `manual` —— 视觉上必须可区分（ui-ia.md §6）。
    pub kind: String,
    pub message: String,
    pub evidence: Evidence,
    pub remediation: Remediation,
    pub judged_at: String,
    pub status: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Evidence {
    pub field: String,
    pub quote: String,
    pub offset: usize,
    pub length: usize,
    pub asset_ref: Option<String>,
    pub source_ref: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Remediation {
    pub hint: String,
    pub auto_fixable: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentState {
    pub provider: String,
    pub capabilities: Capabilities,
    pub degraded: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Capabilities {
    pub streaming: bool,
    pub tools: bool,
    pub vision: bool,
    pub cost: bool,
}

impl Snapshot {
    /// 从 JSON 文本解码。失败信息带行号，便于对着 fixture 定位。
    pub fn from_json(text: &str) -> Result<Snapshot, serde_json::Error> {
        serde_json::from_str(text)
    }

    pub fn finding_count(&self) -> usize {
        self.findings.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 未知严重度降级成留意而不是报错() {
        let f: Finding = serde_json::from_str(
            r#"{"id":"f1","severity":"catastrophic","message":"x"}"#,
        )
        .expect("宽容解码不该失败");
        assert_eq!(f.severity, Severity::Observe);
    }

    #[test]
    fn 缺字段的快照能打开() {
        let s = Snapshot::from_json(r#"{"schemaVersion":1}"#).expect("旧快照必须能读");
        assert_eq!(s.schema_version, 1);
        assert!(s.findings.is_empty());
        assert_eq!(s.summary.items, 0);
        assert_eq!(s.agent.provider, "");
    }

    #[test]
    fn 四档严重度按阻断到留意排序() {
        let mut v = vec![Severity::Observe, Severity::Blocker, Severity::Suggest];
        v.sort();
        assert_eq!(v, vec![Severity::Blocker, Severity::Suggest, Severity::Observe]);
    }

    #[test]
    fn 徽章文字是中文四档() {
        assert_eq!(Severity::Blocker.label(), "阻断");
        assert_eq!(Severity::Required.label(), "必改");
        assert_eq!(Severity::Suggest.label(), "建议");
        assert_eq!(Severity::Observe.label(), "留意");
    }
}
