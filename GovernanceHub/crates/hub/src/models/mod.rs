//! 数据模型：`snapshot.json` 与 `tasks.json` 的**宽容解码**（App 侧）。
//!
//! 边界很清楚（architecture.md §5）：写盘侧严格（sidecar 的 `schema.mjs`），
//! 读盘侧宽容。旧快照缺字段必须能读出来，宁可少显示一块，也不要因为一个字段升级就打不开。

pub mod detail;
pub mod format;
pub mod session;
pub mod snapshot;
pub mod tasks;

pub use detail::TaskDetail;
pub use session::{AgentSession, Attribution, Step, TimelineItem, Usage};
pub use snapshot::{
    AgentState, Evidence, Finding, Item, RulePack, Scope, Severity, Snapshot, SnapshotSource,
    Summary, Unjudged,
};
pub use tasks::{TaskCard, TaskState, TasksFile};
