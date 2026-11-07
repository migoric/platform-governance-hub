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
    /// 待判明细（snapshot-contract §2）：规则说「判不了」的那条，不是通过。
    pub unjudged: Vec<Unjudged>,
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
    /// 出处是否核实过：`draft` / `verified`。
    ///
    /// 用字符串而不是枚举，是为了让旧快照（没有这个字段）落成空串而不是解析失败 ——
    /// 但空串不能当成「已核实」，界面上要显示成「出处状态未知」。
    pub source_status: String,
}

impl RulePack {
    /// 出处状态的可展示形态：已核实是常态（不打扰），其余两种都要说出来。
    pub fn source_label(&self) -> Option<&'static str> {
        match self.source_status.as_str() {
            "verified" => None,
            "draft" => Some("出处未核实"),
            _ => Some("出处状态未知"),
        }
    }

    pub fn source_is_unverified(&self) -> bool {
        self.source_status != "verified"
    }
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

/// 一条「规则判不了」的记录。`reason` 是 sidecar 的封闭集，UI 只展示不解释。
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Unjudged {
    pub rule_id: String,
    pub item_id: String,
    pub reason: String,
    pub detail: String,
}

impl Unjudged {
    /// 人话版原因。封闭集之外的值原样显示 —— 不猜，也不吞。
    pub fn reason_label(&self) -> &str {
        match self.reason.as_str() {
            "requires_semantic" => "需语义判定",
            "requires_manual" => "需人工核对",
            "dict_missing" => "词典缺失",
            "pattern_rejected" => "正则被拒绝",
            "check_type_unsupported" => "判据未实现",
            "check_threw" => "判据异常",
            "field_missing" => "字段不存在",
            "field_not_string" => "字段不是文本",
            "field_not_array" => "字段不是数组",
            "value_not_string" => "值不是文本",
            other => other,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Evidence {
    /// `quote` / `absence` / `element`；旧快照不写这个字段，空串按 `quote` 处理。
    pub kind: String,
    pub field: String,
    pub quote: String,
    pub offset: usize,
    pub length: usize,
    /// 只有 `kind == "element"` 时有意义：出问题的是数组里第几个元素。
    pub element_index: Option<usize>,
    pub asset_ref: Option<String>,
    pub source_ref: String,
}

impl Evidence {
    pub fn kind_slug(&self) -> &str {
        if self.kind.is_empty() {
            "quote"
        } else {
            self.kind.as_str()
        }
    }

    /// 屏幕上给人看的证据：缺字段时不能显示一对空引号，那等于假装有引文。
    pub fn quote_display(&self) -> String {
        match self.kind_slug() {
            "absence" => "（字段未填）".to_string(),
            "element" => format!("「{}」[{}]", self.quote, self.element_index.unwrap_or(0)),
            _ => format!("「{}」", self.quote),
        }
    }
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
