//! 纯口径：所有「显示成一句话」的规则都在这一个文件里，视图不许自己拼。
//!
//! 同一个数字只能有一个计算处，同一句话也只能有一个拼法（docs/ui-ia.md §5）。

/// 耗时文案：`134000 -> "2 分 14 秒"`。
///
/// 只到「秒」为止：任务列表里的耗时是给人判断「卡住没有」用的，毫秒是噪音。
pub fn duration(ms: u64) -> String {
    let total_seconds = ms / 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    if hours > 0 {
        format!("{hours} 小时 {minutes} 分")
    } else if minutes > 0 {
        format!("{minutes} 分 {seconds} 秒")
    } else {
        format!("{seconds} 秒")
    }
}

/// 成本文案。拿不到成本时是「—」不是「0」——`agent-acl.md §2` 铁律 4。
pub fn cost(cost_usd: Option<f64>) -> String {
    match cost_usd {
        Some(v) => format!("${v:.2}"),
        None => "—".to_string(),
    }
}

/// 站点标记：`["US","DE"] -> "US · DE"`。
pub fn sites(sites: &[String]) -> String {
    if sites.is_empty() {
        return "—".to_string();
    }
    sites.join(" · ")
}

/// 大类计数的一句话摘要：`"阻断 3 · 必改 2 · 建议 2 · 留意 1"`。
pub fn severity_line(blocker: u32, required: u32, suggest: u32, observe: u32) -> String {
    format!("阻断 {blocker} · 必改 {required} · 建议 {suggest} · 留意 {observe}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 耗时按分秒与小时两种粒度() {
        assert_eq!(duration(134_000), "2 分 14 秒");
        assert_eq!(duration(0), "0 秒");
        assert_eq!(duration(59_999), "59 秒");
        assert_eq!(duration(3_600_000), "1 小时 0 分");
        assert_eq!(duration(7_380_000), "2 小时 3 分");
    }

    #[test]
    fn 拿不到成本时显示破折号() {
        assert_eq!(cost(None), "—");
        assert_eq!(cost(Some(0.0)), "$0.00");
        assert_eq!(cost(Some(1.234)), "$1.23");
    }

    #[test]
    fn 空站点列表不显示空串() {
        assert_eq!(sites(&[]), "—");
        assert_eq!(sites(&["US".to_string(), "DE".to_string()]), "US · DE");
    }

    #[test]
    fn 严重度摘要是固定顺序() {
        assert_eq!(severity_line(3, 2, 2, 1), "阻断 3 · 必改 2 · 建议 2 · 留意 1");
    }
}
