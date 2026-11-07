//! Selector —— **面板数字唯一计算处**（ui-ia.md §5）。
//!
//! 视图里禁止出现 `findings.iter().filter(...).count()`：总览说 3 条 blocker，
//! 点进风险清单筛选后也必须是 3 条，任务卡上的数字必须是同一批。三处各算一遍迟早对不上。
//! 这里全是纯函数，`node --test` 换成 `cargo test` 一样能直接跑，不需要窗口。

use crate::models::{Finding, Severity, Snapshot, TaskCard, TaskState, TasksFile};

/// 总览的 4 个 KPI（第 4 个是「判不了」，见 snapshot-contract §5）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Kpis {
    pub items: u32,
    pub findings: u32,
    pub blocker: u32,
    pub required: u32,
    pub unjudged: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct Dashboard<'a> {
    snapshot: &'a Snapshot,
}

impl<'a> Dashboard<'a> {
    pub fn new(snapshot: &'a Snapshot) -> Self {
        Self { snapshot }
    }

    /// 读到 `summary`，**不在 App 侧重算**：跨 item 的聚合是 sidecar 的活。
    pub fn kpis(&self) -> Kpis {
        let s = &self.snapshot.summary;
        Kpis {
            items: s.items,
            findings: s.findings,
            blocker: s.by_severity.blocker,
            required: s.by_severity.required,
            unjudged: s.unjudged,
        }
    }

    /// 「最该介入」：3 条 blocker（最旧优先）+ 3 条最旧 required。
    /// 排序口径只在这里定义一次。
    pub fn must_intervene(&self) -> Vec<&'a Finding> {
        let mut blocker = self.open_by(Severity::Blocker);
        let mut required = self.open_by(Severity::Required);
        blocker.truncate(3);
        required.truncate(3);
        blocker.extend(required);
        blocker
    }

    /// 指定严重度的未处置条目，按判定时间从旧到新。
    pub fn open_by(&self, severity: Severity) -> Vec<&'a Finding> {
        let mut out: Vec<&Finding> = self
            .snapshot
            .findings
            .iter()
            .filter(|f| f.severity == severity && f.status == "open")
            .collect();
        out.sort_by(|a, b| a.judged_at.cmp(&b.judged_at).then_with(|| a.id.cmp(&b.id)));
        out
    }

    /// 风险清单的整表顺序：严重度 → 判定时间 → id。稳定排序，重复出图字节一致。
    pub fn findings_sorted(&self) -> Vec<&'a Finding> {
        let mut out: Vec<&Finding> = self.snapshot.findings.iter().collect();
        out.sort_by(|a, b| {
            a.severity
                .cmp(&b.severity)
                .then_with(|| a.judged_at.cmp(&b.judged_at))
                .then_with(|| a.id.cmp(&b.id))
        });
        out
    }

    pub fn total_findings(&self) -> usize {
        self.snapshot.findings.len()
    }

    /// itemId → sku。视图里不许自己 `items.iter().find(...)`：那等于第二份映射逻辑。
    pub fn sku_of(&self, item_id: &str) -> &'a str {
        self.snapshot
            .items
            .iter()
            .find(|it| it.id == item_id)
            .map(|it| it.sku.as_str())
            .unwrap_or("—")
    }

    /// 证据引用串：`title @0+4`。结论与证据必须同屏（ui-ia.md §4.3）。
    pub fn evidence_ref(&self, finding: &Finding) -> String {
        format!(
            "{} @{}+{}",
            finding.evidence.field, finding.evidence.offset, finding.evidence.length
        )
    }
}

/// 按状态取任务（侧栏与四态出图都用这一处）。
pub fn tasks_in(file: &TasksFile, state: TaskState) -> Vec<&TaskCard> {
    let mut out: Vec<&TaskCard> = file.tasks.iter().filter(|t| t.state == state).collect();
    out.sort_by(|a, b| b.duration_ms.cmp(&a.duration_ms).then_with(|| a.id.cmp(&b.id)));
    out
}

/// 「等待确认」的条数：侧栏与 Dock 角标读同一处（ui-ia.md §4.7）。
pub fn awaiting_count(file: &TasksFile) -> usize {
    file.tasks.iter().filter(|t| t.state == TaskState::Awaiting).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SNAPSHOT: &str = include_str!("../../../../fixtures/snapshot.json");
    const TASKS: &str = include_str!("../../../../fixtures/tasks.json");

    fn snapshot() -> Snapshot {
        Snapshot::from_json(SNAPSHOT).expect("fixture 必须可解码")
    }

    fn tasks() -> TasksFile {
        serde_json::from_str(TASKS).expect("fixture 必须可解码")
    }

    #[test]
    fn kpi_直接读_summary_不重算() {
        let s = snapshot();
        let kpis = Dashboard::new(&s).kpis();
        assert_eq!(kpis.items, 8);
        assert_eq!(kpis.findings, 8);
        assert_eq!(kpis.blocker, 3);
        assert_eq!(kpis.required, 2);
        assert_eq!(kpis.unjudged, 2);
        // 与 findings 实算一致，说明 sidecar 的聚合没错
        assert_eq!(kpis.findings as usize, s.findings.len());
    }

    #[test]
    fn 最该介入最多六条且_blocker_在前() {
        let s = snapshot();
        let pick = Dashboard::new(&s).must_intervene();
        assert_eq!(pick.len(), 5, "mock 是 3 blocker + 2 required");
        assert_eq!(pick[0].severity, Severity::Blocker);
        assert_eq!(pick[3].severity, Severity::Required);
    }

    #[test]
    fn 风险清单排序是严重度优先且稳定() {
        let s = snapshot();
        let sorted = Dashboard::new(&s).findings_sorted();
        assert_eq!(sorted.len(), 8);
        let severities: Vec<Severity> = sorted.iter().map(|f| f.severity).collect();
        let mut expected = severities.clone();
        expected.sort();
        assert_eq!(severities, expected, "严重度必须单调不增");
        // 同档内按 judgedAt 升序
        assert!(sorted.windows(2).all(|w| w[0].severity != w[1].severity
            || w[0].judged_at <= w[1].judged_at));
    }

    #[test]
    fn 四态任务各一条且等待确认可计数() {
        let file = tasks();
        for state in TaskState::ALL {
            assert_eq!(tasks_in(&file, state).len(), 1, "{} 应该正好一条", state.label());
        }
        assert_eq!(awaiting_count(&file), 1);
    }

    #[test]
    fn 只有_open_的进入最该介入() {
        let mut s = snapshot();
        for f in s.findings.iter_mut() {
            f.status = "fixed".to_string();
        }
        assert!(Dashboard::new(&s).must_intervene().is_empty());
    }
}
