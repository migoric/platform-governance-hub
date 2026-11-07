//! 设计令牌：颜色、间距、圆角、字号、快捷键标签。**唯一一份**，视图不许写死数字。
//!
//! 玻璃材质的取舍（ui-ia.md §3）：真模糊要平台 backdrop，macOS vibrancy 不跨平台，
//! 所以 M0 只做「半透明底色 + 1px 高光边框」，不做真 blur —— 跨端一致性比观感重要。

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// 一个颜色：`token` 是设计令牌名（diff 时能看出是哪个语义变了），`rgba` 是解析后的值。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Paint {
    pub token: &'static str,
    pub rgba: u32,
}

impl Paint {
    /// `#RRGGBBAA`，结构快照里用它，人眼可读且能直接比。
    pub fn hex(self) -> String {
        format!("#{:08X}", self.rgba)
    }
}

/// 快照里写「令牌名 + 解析后的值」：只看 `#RRGGBBAA` 不知道是哪个语义变了，
/// 只看令牌名又看不出深浅色是否真的不同。
impl Serialize for Paint {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut out = serializer.serialize_struct("Paint", 2)?;
        out.serialize_field("token", self.token)?;
        out.serialize_field("hex", &self.hex())?;
        out.end()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Appearance {
    Light,
    Dark,
}

impl Appearance {
    pub fn parse(raw: &str) -> Appearance {
        match raw {
            "dark" => Appearance::Dark,
            _ => Appearance::Light,
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            Appearance::Light => "light",
            Appearance::Dark => "dark",
        }
    }
}

const fn paint(token: &'static str, rgba: u32) -> Paint {
    Paint { token, rgba }
}

/// 一套配色。深浅两套必须都满足正文对比度 ≥ 4.5:1（ui-ia.md §7）。
#[derive(Clone, Copy, Debug)]
pub struct Palette {
    pub app_bg: Paint,
    pub panel_bg: Paint,
    pub glass_fill: Paint,
    pub glass_stroke: Paint,
    pub glass_highlight: Paint,
    pub divider: Paint,
    pub text_primary: Paint,
    pub text_secondary: Paint,
    pub text_tertiary: Paint,
    pub accent: Paint,
    pub accent_soft: Paint,
    pub severity_blocker: Paint,
    pub severity_required: Paint,
    pub severity_suggest: Paint,
    pub severity_observe: Paint,
    pub state_awaiting: Paint,
    pub state_done: Paint,
    pub state_interrupted: Paint,
    pub real_data: Paint,
    pub replay_data: Paint,
}

pub const LIGHT: Palette = Palette {
    app_bg: paint("app_bg", 0xF5F6F8FF),
    panel_bg: paint("panel_bg", 0xFFFFFFFF),
    // 白 72%：不是真模糊，但能让底层花纹透出一点
    glass_fill: paint("glass_fill", 0xFFFFFFB8),
    glass_stroke: paint("glass_stroke", 0x0B12201F),
    glass_highlight: paint("glass_highlight", 0xFFFFFFE0),
    divider: paint("divider", 0x0B122014),
    text_primary: paint("text_primary", 0x14181FFF),
    text_secondary: paint("text_secondary", 0x4C5666FF),
    text_tertiary: paint("text_tertiary", 0x6B7480FF),
    accent: paint("accent", 0x2A5BD7FF),
    accent_soft: paint("accent_soft", 0x2A5BD71F),
    severity_blocker: paint("severity_blocker", 0xB3261EFF),
    severity_required: paint("severity_required", 0x8A5A00FF),
    severity_suggest: paint("severity_suggest", 0x1F5FA8FF),
    severity_observe: paint("severity_observe", 0x556070FF),
    state_awaiting: paint("state_awaiting", 0x8A5A00FF),
    state_done: paint("state_done", 0x2C6E49FF),
    state_interrupted: paint("state_interrupted", 0x8C2F39FF),
    real_data: paint("real_data", 0x2C6E49FF),
    replay_data: paint("replay_data", 0x556070FF),
};

pub const DARK: Palette = Palette {
    app_bg: paint("app_bg", 0x14171CFF),
    panel_bg: paint("panel_bg", 0x1B1F26FF),
    glass_fill: paint("glass_fill", 0xFFFFFF0F),
    glass_stroke: paint("glass_stroke", 0xFFFFFF24),
    glass_highlight: paint("glass_highlight", 0xFFFFFF33),
    divider: paint("divider", 0xFFFFFF17),
    text_primary: paint("text_primary", 0xECEEF2FF),
    text_secondary: paint("text_secondary", 0xA8B0BEFF),
    text_tertiary: paint("text_tertiary", 0x8A93A2FF),
    accent: paint("accent", 0x7AA2F7FF),
    accent_soft: paint("accent_soft", 0x7AA2F72E),
    severity_blocker: paint("severity_blocker", 0xFF7A6BFF),
    severity_required: paint("severity_required", 0xF0B45AFF),
    severity_suggest: paint("severity_suggest", 0x7FB3F0FF),
    severity_observe: paint("severity_observe", 0x9AA4B2FF),
    state_awaiting: paint("state_awaiting", 0xF0B45AFF),
    state_done: paint("state_done", 0x76C893FF),
    state_interrupted: paint("state_interrupted", 0xE8798AFF),
    real_data: paint("real_data", 0x76C893FF),
    replay_data: paint("replay_data", 0x9AA4B2FF),
};

impl Palette {
    pub fn for_appearance(appearance: Appearance) -> Palette {
        match appearance {
            Appearance::Light => LIGHT,
            Appearance::Dark => DARK,
        }
    }

    pub fn severity(&self, severity: crate::models::Severity) -> Paint {
        use crate::models::Severity;
        match severity {
            Severity::Blocker => self.severity_blocker,
            Severity::Required => self.severity_required,
            Severity::Suggest => self.severity_suggest,
            Severity::Observe => self.severity_observe,
        }
    }
}

/// 间距刻度。取 4 的倍数，够用且不会临时拍脑袋写 13 这种数。
pub mod space {
    pub const XS: f32 = 4.0;
    pub const SM: f32 = 8.0;
    pub const MD: f32 = 12.0;
    pub const LG: f32 = 16.0;
    pub const XL: f32 = 24.0;
    pub const XXL: f32 = 32.0;
}

pub mod radius {
    pub const SM: f32 = 6.0;
    pub const MD: f32 = 10.0;
    pub const LG: f32 = 14.0;
}

pub mod text {
    pub const DISPLAY: f32 = 30.0;
    pub const TITLE: f32 = 19.0;
    pub const BODY: f32 = 14.0;
    pub const CAPTION: f32 = 12.0;

    /// 等宽（证据原文、工具名）用 12.5 而不是 12：中文注释与代码混排时更齐。
    pub const MONO: f32 = 12.5;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Weight {
    Regular,
    Medium,
    Semibold,
}

impl Weight {
    pub fn slug(self) -> &'static str {
        match self {
            Weight::Regular => "regular",
            Weight::Medium => "medium",
            Weight::Semibold => "semibold",
        }
    }
}

/// 快捷键标签按平台换（ui-ia.md §7）：代码里绝不出现硬编码的 `⌘`。
pub fn shortcut(key: &str) -> String {
    if cfg!(target_os = "macos") {
        format!("⌘{key}")
    } else {
        format!("Ctrl+{key}")
    }
}

pub const SIDEBAR_WIDTH: f32 = 196.0;
pub const INSPECTOR_WIDTH: f32 = 300.0;
pub const WINDOW_WIDTH: f32 = 1180.0;
pub const WINDOW_HEIGHT: f32 = 760.0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 深浅两套配色令牌一一对应() {
        let l = LIGHT;
        let d = DARK;
        // 令牌名必须一致：两套配色只换值不换语义，否则 diff 会全是噪音
        assert_eq!(l.text_primary.token, d.text_primary.token);
        assert_eq!(l.severity_blocker.token, d.severity_blocker.token);
        assert_ne!(l.text_primary.rgba, d.text_primary.rgba);
    }

    #[test]
    fn 玻璃底色在两套里都不是全不透明() {
        assert_eq!(LIGHT.glass_fill.rgba & 0xFF, 0xB8);
        assert_eq!(DARK.glass_fill.rgba & 0xFF, 0x0F);
    }

    #[test]
    fn 十六进制是八位含透明度() {
        assert_eq!(Paint { token: "x", rgba: 0x11223344 }.hex(), "#11223344");
    }

    #[test]
    fn 快捷键标签按平台生成() {
        let label = shortcut("1");
        if cfg!(target_os = "macos") {
            assert_eq!(label, "⌘1");
        } else {
            assert_eq!(label, "Ctrl+1");
        }
    }

    #[test]
    fn 未知外观参数退到浅色() {
        assert_eq!(Appearance::parse("weird"), Appearance::Light);
        assert_eq!(Appearance::parse("dark"), Appearance::Dark);
    }
}
