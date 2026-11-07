//! Store：把三份数据读进来，读不到就明确记下「为什么没有」。
//!
//! App 的三种降级（architecture.md §10 验收 2）：断网 / sidecar 不存在 / 快照不存在，
//! 都要能打开并给出人话提示。所以这里不用 `Result` 往上抛，而是把缺口变成状态。

use std::path::{Path, PathBuf};

use crate::models::{AgentSession, AgentStatus, Snapshot, TaskDetail, TasksFile};

/// 数据从哪来 —— 出图基准与真窗口的区别只体现在这里。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Origin {
    /// `--render` 与 UI 测试用：只读 fixtures，绝不碰本机数据。
    Fixture(PathBuf),
    /// 真窗口：`~/.pgh/`
    Home(PathBuf),
    /// 什么都没有：每个面板自己给空状态文案。
    None,
}

#[derive(Clone, Debug, Default)]
pub struct Store {
    pub snapshot: Option<Snapshot>,
    pub tasks: Option<TasksFile>,
    pub detail: Option<TaskDetail>,
    /// 会话投影（事件流聚合后的结果）。`None` = 没跑过 / 跑失败 / 旧版本没有这个文件。
    pub session: Option<AgentSession>,
    /// 握手状态报告（`pgh agent status` 落盘）。`None` = 没探过。
    pub status: Option<AgentStatus>,
    pub origin: Option<Origin>,
    /// 读失败的原因（不是「没有文件」，而是「文件坏了」）。
    pub load_error: Option<String>,
}

impl Store {
    pub fn empty() -> Self {
        Self {
            origin: Some(Origin::None),
            ..Self::default()
        }
    }

    /// 从 fixture 目录读：`snapshot.json` / `tasks.json` / `task-detail.json`。
    pub fn from_fixtures(dir: impl AsRef<Path>) -> Self {
        let dir = dir.as_ref().to_path_buf();
        let mut store = Self {
            origin: Some(Origin::Fixture(dir.clone())),
            ..Self::default()
        };
        store.snapshot = read_json::<Snapshot>(&dir.join("snapshot.json"), &mut store.load_error);
        store.tasks = read_json::<TasksFile>(&dir.join("tasks.json"), &mut store.load_error);
        store.detail = read_json::<TaskDetail>(&dir.join("task-detail.json"), &mut store.load_error);
        store.session = read_json::<AgentSession>(&dir.join("agent-session.json"), &mut store.load_error);
        store.status = read_json::<AgentStatus>(&dir.join("agent-status.json"), &mut store.load_error);
        store
    }

    /// 从 `~/.pgh/` 读。`PGH_HOME` 可覆盖，测试与出图都不读真实目录（AGENTS.md §3.7）。
    pub fn from_home() -> Self {
        let home = std::env::var_os("PGH_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let user = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
                user.join(".pgh")
            });
        let mut store = Self {
            origin: Some(Origin::Home(home.clone())),
            ..Self::default()
        };
        store.snapshot = read_json::<Snapshot>(&home.join("snapshot.json"), &mut store.load_error);
        store.tasks = read_json::<TasksFile>(&home.join("agent/tasks.json"), &mut store.load_error);
        // 会话投影由 `pgh agent session` 落在 ~/.pgh/agent/session.json（不是事件流文件）
        store.session = read_json::<AgentSession>(&home.join("agent/session.json"), &mut store.load_error);
        // 握手状态由 `pgh agent status` 落在 ~/.pgh/agent/status.json；设置页读这一份
        store.status = read_json::<AgentStatus>(&home.join("agent/status.json"), &mut store.load_error);
        // 任务记录仍是 fixture：M2 还没有「任务存档」这条链路，详情面板会自己说明这一点
        store.detail = read_json::<TaskDetail>(&fixtures_dir().join("task-detail.json"), &mut store.load_error);
        store
    }

    pub fn has_snapshot(&self) -> bool {
        self.snapshot.is_some()
    }

    pub fn has_tasks(&self) -> bool {
        self.tasks.is_some()
    }

    /// 面板顶部的一句话来源说明。空状态与坏文件必须分得清（ui-ia.md §4.4）。
    pub fn provenance_line(&self) -> String {
        if let Some(error) = &self.load_error {
            return format!("读取失败：{error}");
        }
        match (&self.origin, &self.snapshot) {
            (_, None) => "尚无数据，点这里采集".to_string(),
            (Some(Origin::Fixture(_)), Some(s)) => {
                format!("出图基准 · fixture · {} 条 finding", s.finding_count())
            }
            (_, Some(s)) => match s.source.label.as_deref() {
                Some(label) => format!("{} · {} 条 finding", label, s.finding_count()),
                None => format!("{} 条 finding", s.finding_count()),
            },
        }
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path, error: &mut Option<String>) -> Option<T> {
    // 文件不存在是正常的空状态，不是错误
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            *error = Some(format!("{}：{e}", path.display()));
            return None;
        }
    };
    match serde_json::from_str::<T>(&text) {
        Ok(value) => Some(value),
        Err(e) => {
            *error = Some(format!("{}：{e}", path.display()));
            None
        }
    }
}

/// 仓库内 fixture 目录（相对 crate 根，编译期钉死，运行时与 cwd 无关）。
pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixtures_都能读全() {
        let store = Store::from_fixtures(fixtures_dir());
        assert!(store.load_error.is_none(), "{:?}", store.load_error);
        assert!(store.has_snapshot());
        assert!(store.has_tasks());
        assert!(store.detail.is_some());
        assert!(store.session.is_some(), "没有会话投影，任务详情只能显示空状态");
        assert!(store.status.is_some(), "没有握手报告，设置页只能显示空状态");
    }

    #[test]
    fn 没有文件时给空状态而不是错误() {
        let store = Store::from_fixtures("/nonexistent-pgh-fixtures");
        assert!(store.snapshot.is_none());
        assert!(store.load_error.is_none(), "缺文件不算坏文件");
        assert_eq!(store.provenance_line(), "尚无数据，点这里采集");
    }

    #[test]
    fn 文件坏了要报出路径() {
        let dir = std::env::temp_dir().join("pgh-store-broken");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("snapshot.json"), b"{ not json").unwrap();
        let store = Store::from_fixtures(&dir);
        let error = store.load_error.clone().expect("坏文件必须记错误");
        assert!(error.contains("snapshot.json"), "{error}");
        assert!(store.provenance_line().starts_with("读取失败"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
