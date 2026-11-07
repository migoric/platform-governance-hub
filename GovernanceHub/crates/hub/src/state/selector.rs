//! Selector —— **面板数字唯一计算处**（ui-ia.md §5）。
//!
//! 视图里禁止出现 `findings.iter().filter(...).count()`：总览说 3 条 blocker，
//! 点进风险清单筛选后也必须是 3 条，任务卡上的数字必须是同一批。三处各算一遍迟早对不上。
//! 这里全是纯函数，`node --test` 换成 `cargo test` 一样能直接跑，不需要窗口。

use std::collections::HashMap;

use crate::models::{
    Finding, Item, RulePack, Severity, Snapshot, TaskCard, TaskState, TasksFile,
};

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

/// 单个商品的处置结论。**三态**，没有第四种：把「没有结论」说成「通过」是最常见的谎。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Verdict {
    /// 有 finding，得上架前改
    Fix,
    /// 没有 finding，但有规则判不了 —— 不算干净
    Unknown,
    /// 有结论且都通过
    Pass,
}

impl Verdict {
    pub fn label(self) -> &'static str {
        match self {
            Verdict::Fix => "需整改",
            Verdict::Unknown => "待判",
            Verdict::Pass => "可上架",
        }
    }

    /// 排序权重：要处理的排前面，看不清的排中间，干净的排最后。
    pub fn rank(self) -> u8 {
        match self {
            Verdict::Fix => 0,
            Verdict::Unknown => 1,
            Verdict::Pass => 2,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VerdictCounts {
    pub fix: usize,
    pub unknown: usize,
    pub pass: usize,
}

/// 一个商品在上架前检查里的那一行。
#[derive(Clone, Debug)]
pub struct ItemVerdict<'a> {
    pub item: &'a Item,
    pub worst: Option<Severity>,
    pub findings: usize,
    pub unjudged: usize,
}

impl ItemVerdict<'_> {
    pub fn verdict(&self) -> Verdict {
        if self.findings > 0 {
            Verdict::Fix
        } else if self.unjudged > 0 {
            Verdict::Unknown
        } else {
            Verdict::Pass
        }
    }
}

/// 上架前检查：按商品聚合。聚合口径只在这里定义一次（ui-ia.md §5）。
#[derive(Clone, Copy, Debug)]
pub struct Preflight<'a> {
    snapshot: &'a Snapshot,
}

impl<'a> Preflight<'a> {
    pub fn new(snapshot: &'a Snapshot) -> Self {
        Self { snapshot }
    }

    fn tallies(&self) -> HashMap<&'a str, (Option<Severity>, usize, usize)> {
        let mut out: HashMap<&str, (Option<Severity>, usize, usize)> = HashMap::new();
        for item in &self.snapshot.items {
            out.entry(item.id.as_str()).or_insert((None, 0, 0));
        }
        for finding in &self.snapshot.findings {
            let slot = out.entry(finding.item_id.as_str()).or_insert((None, 0, 0));
            slot.1 += 1;
            // 更严重的覆盖：Severity 的 Ord 是 blocker 最小
            slot.0 = Some(match slot.0 {
                Some(current) => current.min(finding.severity),
                None => finding.severity,
            });
        }
        for unjudged in &self.snapshot.unjudged {
            out.entry(unjudged.item_id.as_str()).or_insert((None, 0, 0)).2 += 1;
        }
        out
    }

    /// 排序：需整改在前（按最坏严重度），其次待判，最后可上架；同档按商品 id。
    pub fn rows(&self) -> Vec<ItemVerdict<'a>> {
        let tallies = self.tallies();
        let mut out: Vec<ItemVerdict<'a>> = self
            .snapshot
            .items
            .iter()
            .map(|item| {
                let (worst, findings, unjudged) =
                    tallies.get(item.id.as_str()).copied().unwrap_or((None, 0, 0));
                ItemVerdict { item, worst, findings, unjudged }
            })
            .collect();
        out.sort_by(|a, b| {
            a.verdict()
                .rank()
                .cmp(&b.verdict().rank())
                .then_with(|| {
                    let rank = |s: Option<Severity>| s.map(|x| x as u8).unwrap_or(u8::MAX);
                    rank(a.worst).cmp(&rank(b.worst))
                })
                .then_with(|| a.item.id.cmp(&b.item.id))
        });
        out
    }

    pub fn counts(&self) -> VerdictCounts {
        let mut counts = VerdictCounts::default();
        for row in self.rows() {
            match row.verdict() {
                Verdict::Fix => counts.fix += 1,
                Verdict::Unknown => counts.unknown += 1,
                Verdict::Pass => counts.pass += 1,
            }
        }
        counts
    }
}

/// 一条规则的实际战绩：命中多少、判不了多少。
#[derive(Clone, Debug)]
pub struct RuleStat<'a> {
    pub rule_id: &'a str,
    pub severity: Option<Severity>,
    pub hits: usize,
    pub unjudged: usize,
    pub version: &'a str,
}

impl RuleStat<'_> {
    /// 「吵不吵」：命中 + 待判。规则库的可用性取决于每条规则都有人愿意处理（rule-library §9）。
    pub fn noise(&self) -> usize {
        self.hits + self.unjudged
    }
}

/// 规则库：包信息来自快照的 `rulePacks`，命中数从 findings / unjudged 聚合。
#[derive(Clone, Copy, Debug)]
pub struct RuleLibrary<'a> {
    snapshot: &'a Snapshot,
}

impl<'a> RuleLibrary<'a> {
    pub fn new(snapshot: &'a Snapshot) -> Self {
        Self { snapshot }
    }

    pub fn packs(&self) -> &'a [RulePack] {
        &self.snapshot.rule_packs
    }

    /// 按 `noise` 降序、ruleId 升序。同一份输入永远同一个顺序。
    pub fn stats(&self) -> Vec<RuleStat<'a>> {
        let mut map: HashMap<&str, RuleStat<'a>> = HashMap::new();
        for finding in &self.snapshot.findings {
            let slot = map.entry(finding.rule_id.as_str()).or_insert(RuleStat {
                rule_id: finding.rule_id.as_str(),
                severity: Some(finding.severity),
                hits: 0,
                unjudged: 0,
                version: finding.rule_version.as_str(),
            });
            slot.hits += 1;
            slot.severity = Some(match slot.severity {
                Some(current) => current.min(finding.severity),
                None => finding.severity,
            });
        }
        for unjudged in &self.snapshot.unjudged {
            let slot = map.entry(unjudged.rule_id.as_str()).or_insert(RuleStat {
                rule_id: unjudged.rule_id.as_str(),
                severity: None,
                hits: 0,
                unjudged: 0,
                version: "",
            });
            slot.unjudged += 1;
        }
        let mut out: Vec<RuleStat<'a>> = map.into_values().collect();
        out.sort_by(|a, b| {
            b.noise()
                .cmp(&a.noise())
                .then_with(|| a.rule_id.cmp(b.rule_id))
        });
        out
    }

    /// 待判原因分布：按条数降序，同数按原因名字典序。
    pub fn unjudged_by_reason(&self) -> Vec<(&'a str, usize)> {
        let mut map: HashMap<&str, usize> = HashMap::new();
        for unjudged in &self.snapshot.unjudged {
            *map.entry(unjudged.reason.as_str()).or_insert(0) += 1;
        }
        let mut out: Vec<(&str, usize)> = map.into_iter().collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        out
    }
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
        assert_eq!(kpis.findings, 7);
        assert_eq!(kpis.blocker, 1);
        assert_eq!(kpis.required, 4);
        // 判不了不是通过：6 条语义/人工判定留在待判
        assert_eq!(kpis.unjudged, 6);
        // 与 findings 实算一致，说明 sidecar 的聚合没错
        assert_eq!(kpis.findings as usize, s.findings.len());
    }

    #[test]
    fn 最该介入最多六条且_blocker_在前() {
        let s = snapshot();
        let pick = Dashboard::new(&s).must_intervene();
        assert_eq!(pick.len(), 4, "mock 是 1 blocker + 4 required，required 截到 3 条");
        assert_eq!(pick[0].severity, Severity::Blocker);
        assert_eq!(pick[3].severity, Severity::Required);
    }

    #[test]
    fn 风险清单排序是严重度优先且稳定() {
        let s = snapshot();
        let sorted = Dashboard::new(&s).findings_sorted();
        assert_eq!(sorted.len(), 7);
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
    fn 上架前检查三态齐全且需整改在前() {
        let s = snapshot();
        let preflight = Preflight::new(&s);
        let rows = preflight.rows();
        assert_eq!(rows.len(), 8);
        let counts = preflight.counts();
        assert_eq!(counts.fix + counts.unknown + counts.pass, 8);
        assert_eq!(counts.fix, 6, "6 个商品有 finding");
        assert_eq!(counts.unknown, 1, "1 个没有 finding 但有规则判不了");
        assert_eq!(counts.pass, 1, "1 个既无 finding 也无待判");
        assert_eq!(rows[0].verdict(), Verdict::Fix);
        assert_eq!(rows[0].worst, Some(Severity::Blocker), "最坏的排最前");
        // 顺序必须单调：需整改 → 待判 → 可上架
        let ranks: Vec<u8> = rows.iter().map(|r| r.verdict().rank()).collect();
        assert_eq!(ranks, {
            let mut sorted = ranks.clone();
            sorted.sort();
            sorted
        });
    }

    #[test]
    fn 没有结论的商品既不算可上架也不算需整改() {
        let mut s = snapshot();
        s.findings.clear();
        s.unjudged.clear();
        let preflight = Preflight::new(&s);
        assert_eq!(preflight.counts().pass, 8);

        // 只留待判：全部降级成「待判」，不能算干净
        let json = SNAPSHOT.to_string();
        let mut restored = Snapshot::from_json(&json).unwrap();
        restored.findings.clear();
        let counts = Preflight::new(&restored).counts();
        assert_eq!(counts.pass, 2);
        assert_eq!(counts.unknown, 6);
    }

    #[test]
    fn 规则库按噪音降序且包信息来自快照() {
        let s = snapshot();
        let library = RuleLibrary::new(&s);
        assert_eq!(library.packs().len(), 3);
        assert_eq!(
            library.packs().iter().map(|p| p.rule_count).sum::<u32>(),
            23
        );
        let stats = library.stats();
        assert!(!stats.is_empty());
        let noises: Vec<usize> = stats.iter().map(|s| s.noise()).collect();
        assert_eq!(noises, {
            let mut sorted = noises.clone();
            sorted.sort_by(|a, b| b.cmp(a));
            sorted
        });
        // 命中与待判分开统计，不混成一个数
        assert!(stats.iter().any(|s| s.unjudged > 0 && s.hits == 0));
        assert_eq!(stats.iter().map(|s| s.hits).sum::<usize>(), 7);
        assert_eq!(stats.iter().map(|s| s.unjudged).sum::<usize>(), 6);
    }

    #[test]
    fn 待判原因分布按条数降序() {
        let s = snapshot();
        let reasons = RuleLibrary::new(&s).unjudged_by_reason();
        assert_eq!(reasons[0], ("requires_semantic", 5));
        assert_eq!(reasons[1], ("requires_manual", 1));
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
