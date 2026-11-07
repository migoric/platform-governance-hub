//! hub-agent —— agent 内核：内部事件模型 + provider 协议。
//!
//! 依赖方向（architecture.md §5）：`hub` 可以依赖本 crate，本 crate **不依赖 hub**。
//! M0 只有事件模型与能力协商，没有任何 provider 实现 —— provider 在 M2 才出现，
//! 而且 remote provider 要等对端就绪（docs/agent-acl.md §12）。

pub mod capability;
pub mod event;

pub use capability::{Capabilities, DegradeLadder, Plan, ProviderKind};
pub use event::{Event, SessionTimeline, Violation, CONTRACT_VERSION};
