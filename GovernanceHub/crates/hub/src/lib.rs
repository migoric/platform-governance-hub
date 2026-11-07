//! hub —— GPUI 桌面应用（M0）。
//!
//! 分层（architecture.md §6）：`features → state → models`，`ui` 被 features 使用，
//! `app` 只做入口分派。依赖方向单向：`hub` 可以依赖 `hub-agent`，反向不允许。

pub mod app;
pub mod features;
pub mod models;
pub mod state;
pub mod ui;

/// agent 内核（事件模型 + 能力协商）。M0 不接任何 provider。
pub use hub_agent as agent;
