//! 状态层：Store（读盘）+ Selector（面板数字的唯一计算处）。

pub mod selector;
pub mod store;

pub use selector::{Dashboard, Kpis};
pub use store::{Origin, Store};
