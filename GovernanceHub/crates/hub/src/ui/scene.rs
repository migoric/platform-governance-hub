//! 场景树：一份声明式的节点树，**同时**驱动 gpui 渲染与结构快照。
//!
//! 为什么要这层：gpui 0.2.2 没有离屏出图 API（ui-ia.md §8 已查源码确认），
//! 所以回归基准只能是结构。如果快照靠另一套代码「描述」布局，它迟早和真实渲染分叉。
//! 这里让两边读同一棵树：`app::window` 把它翻译成 gpui 元素，`app::render` 把它序列化成 JSON。
//!
//! `data` 记的是**数据源条数**，不是渲染出的行数 —— `uniform_list` 是懒渲染，
//! 快照里数行数会永远只看到前几行（ui-ia.md §8 的坑）。

use serde::Serialize;

use super::tokens::{Paint, Weight};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Window,
    Sidebar,
    SidebarSection,
    SidebarItem,
    Main,
    Panel,
    PanelHeader,
    GlassCard,
    Row,
    Column,
    Text,
    Badge,
    KpiRow,
    Kpi,
    TaskList,
    TaskCard,
    TaskMeta,
    RiskTable,
    RiskRow,
    PreflightTable,
    PreflightRow,
    RulePackTable,
    RulePackRow,
    RuleStatTable,
    RuleStatRow,
    ReasonRow,
    ProviderList,
    ProviderRow,
    CapabilityRow,
    Inspector,
    InspectorCard,
    SectionTitle,
    Divider,
    EmptyState,
    Collapsible,
    Segment,
    SegmentItem,
    ToolTraceRow,
    Bullet,
    Spacer,
}

/// 点了会发生什么。
///
/// 只记**标识**，不记 `features::View`：ui 层不认识 features 层，翻译放在 `app::window`。
/// 进快照是有意的 —— 「哪些位置可点、指向哪里」和文案一样是可回归的事实，
/// 把某处改成不可点、或者指错地方，基准要拦得住。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    /// 切视图，值是 `features::View::action()` 给出的那个 slug
    Nav(&'static str),
    /// 打开某个任务的详情
    OpenTask(String),
    /// 展开 / 收起详情里的会话时间线
    ToggleTimeline,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Axis {
    Row,
    Column,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Align {
    Start,
    Center,
    End,
    SpaceBetween,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Stroke {
    pub width: f32,
    pub paint: Paint,
}

/// 只写非默认值：快照是拿来 diff 的，每个节点都写 `"grow": false` 会把真正的改动埋掉。
/// （体积也从 109 KB/份 降到约 30 KB/份。）
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Style {
    pub axis: Axis,
    #[serde(skip_serializing_if = "is_zero")]
    pub gap: f32,
    #[serde(skip_serializing_if = "pad_is_zero")]
    pub pad: [f32; 4],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f32>,
    #[serde(skip_serializing_if = "is_false")]
    pub grow: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<Paint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke: Option<Stroke>,
    #[serde(skip_serializing_if = "is_zero")]
    pub radius: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_size: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_color: Option<Paint>,
    #[serde(skip_serializing_if = "is_regular")]
    pub weight: Weight,
    #[serde(skip_serializing_if = "is_false")]
    pub mono: bool,
    #[serde(skip_serializing_if = "is_start")]
    pub align: Align,
}

fn is_zero(value: &f32) -> bool {
    *value == 0.0
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn pad_is_zero(pad: &[f32; 4]) -> bool {
    pad.iter().all(|v| *v == 0.0)
}

fn is_regular(weight: &Weight) -> bool {
    matches!(weight, Weight::Regular)
}

fn is_start(align: &Align) -> bool {
    matches!(align, Align::Start)
}

impl Default for Style {
    fn default() -> Self {
        Self {
            axis: Axis::Column,
            gap: 0.0,
            pad: [0.0; 4],
            width: None,
            height: None,
            grow: false,
            fill: None,
            stroke: None,
            radius: 0.0,
            text_size: None,
            text_color: None,
            weight: Weight::Regular,
            mono: false,
            align: Align::Start,
        }
    }
}

/// 数据源元信息：哪个数据、总共几条。四态任务列表永远只渲染 3 行时，这个数字才说得清事实。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DataMeta {
    pub source: String,
    pub total: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Node {
    pub kind: Kind,
    pub style: Style,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<DataMeta>,
    /// 没有就是不可点（还没做的入口、纯展示的行）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<Action>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Node>,
}

impl Node {
    pub fn new(kind: Kind) -> Self {
        Self {
            kind,
            style: Style::default(),
            text: None,
            data: None,
            action: None,
            children: Vec::new(),
        }
    }

    pub fn row(kind: Kind) -> Self {
        Self::new(kind).axis(Axis::Row)
    }

    pub fn label(text: impl Into<String>) -> Self {
        Self::new(Kind::Text).text(Some(text.into()))
    }

    pub fn text(mut self, text: Option<String>) -> Self {
        self.text = text;
        self
    }

    pub fn axis(mut self, axis: Axis) -> Self {
        self.style.axis = axis;
        self
    }

    pub fn gap(mut self, gap: f32) -> Self {
        self.style.gap = gap;
        self
    }

    pub fn pad(mut self, all: f32) -> Self {
        self.style.pad = [all; 4];
        self
    }

    pub fn pad_xy(mut self, x: f32, y: f32) -> Self {
        self.style.pad = [y, x, y, x];
        self
    }

    pub fn pad_top(mut self, top: f32) -> Self {
        self.style.pad[0] = top;
        self
    }

    pub fn pad_bottom(mut self, bottom: f32) -> Self {
        self.style.pad[2] = bottom;
        self
    }

    pub fn width(mut self, width: f32) -> Self {
        self.style.width = Some(width);
        self
    }

    pub fn height(mut self, height: f32) -> Self {
        self.style.height = Some(height);
        self
    }

    pub fn grow(mut self) -> Self {
        self.style.grow = true;
        self
    }

    pub fn fill(mut self, paint: Paint) -> Self {
        self.style.fill = Some(paint);
        self
    }

    pub fn stroke(mut self, width: f32, paint: Paint) -> Self {
        self.style.stroke = Some(Stroke { width, paint });
        self
    }

    pub fn radius(mut self, radius: f32) -> Self {
        self.style.radius = radius;
        self
    }

    pub fn size(mut self, size: f32) -> Self {
        self.style.text_size = Some(size);
        self
    }

    pub fn color(mut self, paint: Paint) -> Self {
        self.style.text_color = Some(paint);
        self
    }

    pub fn weight(mut self, weight: Weight) -> Self {
        self.style.weight = weight;
        self
    }

    pub fn mono(mut self) -> Self {
        self.style.mono = true;
        self
    }

    pub fn align(mut self, align: Align) -> Self {
        self.style.align = align;
        self
    }

    pub fn data(mut self, source: impl Into<String>, total: usize) -> Self {
        self.data = Some(DataMeta {
            source: source.into(),
            total,
        });
        self
    }

    /// 挂一个点击意图。没有 action 的节点点不动 —— 这是判断「能不能点」的唯一依据。
    pub fn action(mut self, action: Action) -> Self {
        self.action = Some(action);
        self
    }

    pub fn child(mut self, node: Node) -> Self {
        self.children.push(node);
        self
    }

    pub fn children(mut self, nodes: impl IntoIterator<Item = Node>) -> Self {
        self.children.extend(nodes);
        self
    }

    /// 节点总数：结构快照的规模指标，改版时数量级变化应该看得出来。
    pub fn node_count(&self) -> usize {
        1 + self.children.iter().map(Node::node_count).sum::<usize>()
    }

    /// 可见文本清单（深度优先）。文案被误改时这份清单会直接 diff 出来。
    pub fn visible_text(&self) -> Vec<String> {
        let mut out = Vec::new();
        self.collect_text(&mut out);
        out
    }

    fn collect_text(&self, out: &mut Vec<String>) {
        if let Some(text) = &self.text {
            if !text.is_empty() {
                out.push(text.clone());
            }
        }
        for child in &self.children {
            child.collect_text(out);
        }
    }

    /// 序列化成结构快照的一节。字段顺序固定，重复出图字节一致。
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("场景树只含可序列化数据")
    }
}

#[cfg(test)]
mod tests {
    use super::super::tokens::LIGHT;
    use super::*;

    fn sample() -> Node {
        Node::new(Kind::Panel)
            .child(Node::label("风险清单").size(19.0).color(LIGHT.text_primary))
            .child(
                Node::row(Kind::RiskRow)
                    .gap(8.0)
                    .child(Node::label("阻断"))
                    .data("findings", 8),
            )
    }

    #[test]
    fn 节点计数与可见文本是深度优先() {
        let node = sample();
        assert_eq!(node.node_count(), 4);
        assert_eq!(node.visible_text(), vec!["风险清单", "阻断"]);
    }

    #[test]
    fn 空文本不进快照() {
        let node = Node::new(Kind::Row).child(Node::label(""));
        assert!(node.visible_text().is_empty());
    }

    #[test]
    fn 序列化保留数据源条数() {
        let json = sample().to_json();
        let row = &json["children"][1];
        assert_eq!(row["data"]["total"], 8);
        assert_eq!(row["data"]["source"], "findings");
        assert_eq!(row["style"]["axis"], "row");
    }

    #[test]
    fn 同一棵树两次序列化字节一致() {
        let a = serde_json::to_string(&sample()).unwrap();
        let b = serde_json::to_string(&sample()).unwrap();
        assert_eq!(a, b);
    }

    /// 可点与不可点必须能从快照里看出来：`action` 是「这里点了会怎样」的唯一记录。
    #[test]
    fn 动作进快照而不可点的节点不写字() {
        let clickable = Node::new(Kind::SidebarItem).action(Action::Nav("overview"));
        let plain = Node::new(Kind::SidebarItem);
        assert_eq!(
            clickable.to_json()["action"],
            serde_json::json!({ "nav": "overview" })
        );
        assert!(plain.to_json().get("action").is_none());
        let task = Node::new(Kind::TaskCard).action(Action::OpenTask("tk_8c31".into()));
        assert_eq!(
            task.to_json()["action"],
            serde_json::json!({ "open_task": "tk_8c31" })
        );
    }

    #[test]
    fn 颜色带令牌名而不是裸数字() {
        let json = sample().to_json();
        let text = &json["children"][0];
        assert_eq!(text["style"]["text_color"]["token"], "text_primary");
        assert_eq!(text["style"]["text_color"]["hex"], LIGHT.text_primary.hex());
    }
}
