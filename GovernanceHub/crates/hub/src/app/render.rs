//! 结构快照输出（`--render`）。
//!
//! 为什么不是 PNG：gpui 0.2.2 没有离屏出图 API（ui-ia.md §8 已查源码）。唯一的截屏能力
//! `screen-capture` 抓的是真实屏幕、要屏幕录制权限，不能进 CI。
//! 所以回归基准是**同一棵场景树序列化出来的 JSON**：节点类型 / 层级 / 关键样式 / 可见文本 / 数据源条数。

use std::io;
use std::path::{Path, PathBuf};

use crate::features::{shell, View, ViewCtx};
use crate::state::Store;
use crate::ui::{Appearance, Palette};

#[derive(Clone, Debug)]
pub struct Rendered {
    pub path: PathBuf,
    pub nodes: usize,
    pub texts: usize,
}

/// 出全部视图的结构快照，返回写入清单（顺序即 `View::all`）。
pub fn render_all(store: &Store, dir: &Path, appearance: Appearance) -> io::Result<Vec<Rendered>> {
    std::fs::create_dir_all(dir)?;
    let palette = Palette::for_appearance(appearance);
    let ctx = ViewCtx::new(store, palette);
    let mut out = Vec::new();
    for view in View::all() {
        let tree = shell::build(view, &ctx);
        let body = serde_json::to_string_pretty(&tree.to_json())
            .map_err(|e| io::Error::other(e.to_string()))?;
        let path = dir.join(view.snapshot_file());
        // 末尾换行：diff 工具喜欢，且手改后不会显示 "\ No newline"
        std::fs::write(&path, format!("{body}\n"))?;
        out.push(Rendered {
            path,
            nodes: tree.node_count(),
            texts: tree.visible_text().len(),
        });
    }
    Ok(out)
}

/// 基准对比：把当前渲染结果与已提交的基准做逐文件字节比较。
/// 不一致就返回差异清单（改版是自己想要的 → 重新生成基准；不是 → 说明布局被误改）。
pub fn compare_with(store: &Store, baseline: &Path, appearance: Appearance) -> io::Result<Vec<String>> {
    let scratch = std::env::temp_dir().join(format!("pgh-render-{}", std::process::id()));
    let rendered = render_all(store, &scratch, appearance)?;
    let mut diffs = Vec::new();
    for item in rendered {
        let name = item.path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let base = baseline.join(&name);
        let current = std::fs::read_to_string(&item.path)?;
        match std::fs::read_to_string(&base) {
            Ok(expected) if expected == current => {}
            Ok(_) => diffs.push(format!("{name}：内容与基准不一致")),
            Err(_) => diffs.push(format!("{name}：基准缺失")),
        }
    }
    let _ = std::fs::remove_dir_all(&scratch);
    Ok(diffs)
}

/// 基准目录：`GovernanceHub/fixtures/structure/`（随仓库提交，跨平台可比）。
pub fn baseline_dir() -> PathBuf {
    crate::state::store::fixtures_dir().join("structure")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 出图恰好十份且文件名固定() {
        let store = Store::from_fixtures(crate::state::store::fixtures_dir());
        let dir = std::env::temp_dir().join("pgh-render-test-8");
        let _ = std::fs::remove_dir_all(&dir);
        let rendered = render_all(&store, &dir, Appearance::Light).unwrap();
        assert_eq!(rendered.len(), 10);
        let names: Vec<String> = rendered
            .iter()
            .map(|r| r.path.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            names,
            vec![
                "01-overview.json",
                "02-risk-list.json",
                "03-tasks-running.json",
                "04-tasks-awaiting.json",
                "05-tasks-done.json",
                "06-tasks-interrupted.json",
                "07-task-detail-collapsed.json",
                "08-task-detail-expanded.json",
                "09-preflight.json",
                "10-rule-library.json",
            ]
        );
        assert!(rendered.iter().all(|r| r.nodes > 10 && r.texts > 3));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 同一份数据两次出图字节一致() {
        let store = Store::from_fixtures(crate::state::store::fixtures_dir());
        let a = std::env::temp_dir().join("pgh-render-a");
        let b = std::env::temp_dir().join("pgh-render-b");
        render_all(&store, &a, Appearance::Dark).unwrap();
        render_all(&store, &b, Appearance::Dark).unwrap();
        for view in View::all() {
            let name = view.snapshot_file();
            let left = std::fs::read_to_string(a.join(&name)).unwrap();
            let right = std::fs::read_to_string(b.join(&name)).unwrap();
            assert_eq!(left, right, "{name} 两次出图不一致");
        }
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn 没有快照时每个视图都能出图且给空状态() {
        let store = Store::empty();
        let dir = std::env::temp_dir().join("pgh-render-empty");
        let rendered = render_all(&store, &dir, Appearance::Light).unwrap();
        assert_eq!(rendered.len(), 10);
        let overview = std::fs::read_to_string(dir.join("01-overview.json")).unwrap();
        assert!(overview.contains("尚无数据"), "空状态文案要写清为什么空");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 快照里出现 `null` 只有一个来源：某处写了 `f32::INFINITY` 之类 JSON 表达不了的数，
    /// serde 会静默写成 null —— 布局信息就此丢失。这条测试守住它。
    #[test]
    fn 快照里不许出现_null() {
        let store = Store::from_fixtures(crate::state::store::fixtures_dir());
        let dir = std::env::temp_dir().join("pgh-render-null");
        let rendered = render_all(&store, &dir, Appearance::Light).unwrap();
        for item in rendered {
            let text = std::fs::read_to_string(&item.path).unwrap();
            assert!(
                !text.contains(": null"),
                "{} 里出现了 null（检查是否有 INFINITY / NaN）",
                item.path.display()
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
