# 架构

> 状态：M0 进行中（sidecar 已落地；UI 栈定为 **Rust + GPUI**，见 §2.1）。
> 改动前先读 [`refactor-constraints`](refactor-constraints.md)。

## 1. 一句话

三个进程、一个契约文件、一条只读边界。

```
┌─────────────────────────────────────────────────────────┐
│  GovernanceHub.app  (Rust + GPUI)                       │
│  features ← state ← models                              │
│  进程本身不联网；唯一的出口是 SidecarClient 与 AgentSession │
└──────────┬───────────────────────┬──────────────────────┘
           │ ① CLI 子进程           │ ② snapshot.json（只读）
           │ ③ pgh mcp (stdio)      │
┌──────────▼───────────────────────▼──────────────────────┐
│  sidecar (Node，零依赖)                                  │
│  cli → snapshot → domain / sources → util                │
│                    │                                     │
│                    └── agent/（防腐层）→ 外部 agent 服务   │
└──────────┬───────────────────────────────────────────────┘
           │ 只读
    ┌──────┴───────┬──────────────┬───────────────┐
 平台导出      本地文件仓库    Chrome 扩展    公司 agent 服务
 (CSV/XLSX)    (证书/报告)    (商品页抓取)    (HTTP/SSE，可插拔)
```

## 2. 为什么是这个切法

**App 不采集。** 采集逻辑一旦进 UI 进程，就会和 Node 侧两套实现分叉；分叉之后「界面说没风险、命令行说有风险」会直接毁掉工具的可信度。所以采集与分析全部留在 sidecar，App 只做展示与人的操作。

**sidecar 零依赖。** 不是为了洁癖，是为了让「半年后还能跑起来」这件事成立。npm 生态半年能坏三轮，而这个工具的生命周期比依赖长。HTTP 用 `node:http`，规则引擎自己写（约 300 行），Excel 解析自己写，只认平台导出的那几种表头（表头映射由本机 pack 提供）。

### 2.1 UI 是 Rust + GPUI（跨端的代价已认）

**要 Windows。** 这不是性能决策，是部署决策：合规同事里用 Windows 的那部分人装不了 SwiftUI 应用，
也没有「让所有人换 Mac」这个选项。SwiftUI 在这条上没有解，所以 UI 栈用 GPUI
（Zed 的框架，macOS / Windows / Linux 三桌面同构）。

| 换来的 | 付出的 |
|---|---|
| 同一份 UI 代码出 macOS + Windows（+ Linux） | **deskbench 的 DesignSystem（1755 行 SwiftUI）不能复用**，控件全部重建 |
| Rust 的启动与滚动性能，长会话不吃力 | Liquid Glass（`glassEffect`）是 macOS 26 专有 API，跨平台要自己画 |
| 单一二进制分发，同事不用装运行时 | GPUI 仍是 **0.2.x pre-1.0**，升级会破坏 API，必须钉版本 |
| 不依赖 Xcode / Swift 工具链，CI 更轻 | 无障碍只能从 AccessKit 起步，VoiceOver 覆盖要自己验 |

**视觉目标不变，实现路径变了**：玻璃卡片、右侧 inspector 事实卡、分段控件这套视觉语言仍照
deskbench 的样子做，但 `ui-ia.md §3` 记的是「要在 GPUI 里重建的等价控件」，不再是「直接 import 的组件」。

**这条不影响 sidecar。** 契约是 `snapshot.json` / `pgh mcp` stdio / CLI 子进程，跟 UI 用什么语言无关：
`cli → snapshot → domain → util` 一行不用改。

**进程模型的语义。** `pgh serve` 常驻之后，「启动耗时」类优化就失去意义了，别为它重构。冷启动一次约 50ms，不需要预热。

## 3. 三个进程

| 进程 | 谁拉起 | 生命周期 | 职责 |
|---|---|---|---|
| `GovernanceHub.app` | 人 | 关窗不退出 | 展示、处置、报告导出 |
| `pgh serve` | launchd（KeepAlive）或 App | 常驻，单实例 | 本机 HTTP：规则库热更新、报告、扩展上报 |
| `pgh <cmd>` | App 或人 | 一次一个 | 采集、校验、快照生成 |

单实例靠 `~/.pgh/serve.json` + 文件锁；第二个实例直接退出并打印已有 pid/port。服务发现读 `serve.json`，不猜端口。

## 4. 三条通道（一条都不能删）

| 通道 | 方向 | 依赖方 | 改动代价 |
|---|---|---|---|
| CLI 子进程 | App → sidecar | `Services/SidecarClient.swift` | 改子命令名要同步改 Swift |
| `snapshot.json` | sidecar → App | `Models/`（Codable） | 改字段 = 改模型 + 兼容旧快照 |
| `pgh mcp` stdio JSON-RPC | agent → sidecar 工具 | agent 适配层 | 协议不能改，只能加工具 |

## 5. 依赖方向

```
cli / server  →  snapshot  →  domain  →  util
                    ↑
                 sources
```

- **domain 是纯函数**：给定 `(item, rules)` 返回 `findings`，不读文件、不发请求、不看时钟。所以 `node --test` 能直接跑，不需要桩。
- **sources 只取数**：输入外部世界，输出规范化对象。这一层是唯一允许 `fetch` / `fs.readFile` / `child_process` 的地方。
- **snapshot 只组装与校验**：写盘前过 `schema.mjs`，不合法就不写，宁可让 App 显示「上次的旧数据」也不写半截。
- **util 只有两个文件**：`dates.mjs`（东八区日期，唯一实现）、`redact.mjs`（token / 手机号脱敏，唯一实现）。

## 6. 目录

```
platform-governance-hub/
├── GovernanceHub/                 Rust + GPUI 应用（Cargo workspace）
│   ├── Cargo.toml                 workspace 成员：hub / hub-agent
│   ├── build.sh                   出包（.app bundle、图标、Info.plist、签名）
│   ├── crates/hub/
│   │   ├── src/main.rs            入口 + CLI 参数（--render / --self-check）
│   │   ├── src/app/               窗口、事件循环、离屏出图
│   │   ├── src/state/             Store / Selector（面板数字唯一计算处）/ Prefs
│   │   ├── src/models/            快照反序列化（serde）+ 纯口径
│   │   ├── src/services/          SidecarClient / AgentSession / ReportExporter
│   │   ├── src/ui/                设计系统（等价重建 deskbench，见 ui-ia.md §3）
│   │   └── src/features/          见 ui-ia.md
│   ├── crates/hub-agent/          agent 内核：事件模型 + provider 协议
│   ├── tests/                     口径、解码、适配器合规（fixture 回放）
│   └── fixtures/                  snapshot.json / tasks.json / 任务详情静态夹具
├── sidecar/
│   ├── pgh.mjs                    命令路由，只做分发
│   ├── cli/commands/              scan / collect / check / rules / snapshot / serve / report / mcp
│   ├── sources/                   listing-export / local-docs / browser-capture / rulefeed
│   ├── domain/                    rules-engine / severity / evidence / summary / report
│   ├── snapshot/                  schema.mjs / build.mjs
│   ├── agent/                     防腐层（见 agent-acl.md）
│   ├── server/                    http.mjs + routes/*
│   ├── util/                      dates.mjs / redact.mjs
│   └── test/                      node --test
├── browser/                       Chrome MV3 扩展（抓 listing / 商品页）
├── docs/
└── scripts/check.sh               一条命令跑全量
```

## 7. 数据边界

| 数据 | 位置 | 禁止 |
|---|---|---|
| 一致性快照 | `~/.pgh/snapshot.json` | 不得掺入抓包 / 调试数据 |
| 平台 pack（字段映射 / 规则 / 词典） | `~/.pgh/packs/<id>/` | 不进 git、不进快照，快照只存 packId 与 packVersion |
| 证据原件（证书 PDF、截图） | `~/.pgh/evidence/<hash>/` | 不进 git、不进报告附件之外的任何地方 |
| 处置记录 | `~/.pgh/actions.jsonl` | 只追加，不覆写（审计要） |
| 会话状态 | `~/.pgh/agent/` | 30 天滚动清理 |

目录 0700、文件 0600。原子写一律 `tmp` + `rename`。

## 8. 平台是外挂（pack）

仓库里不出现任何真实平台名、域名、字段名、规则原文。平台相关的东西全部落在本机：

```
~/.pgh/packs/<packId>/
├── meta.json      platform 标识、站点、导出表头 → 内部字段映射、类目字典
├── rules/         规则包（见 rule-library.md）
├── dict/          词典
└── samples/       脱敏导出样例，只用于表头指纹匹配
```

| 关注点 | 在哪 | 为什么 |
|---|---|---|
| 字段映射（`商品标题` → `title`） | `meta.json` 的 `fieldMap` | 换平台/改表头只改数据 |
| 规则与条款出处 | `rules/*.json` | 规则是数据，不是代码 |
| 平台 API / 抓取选择器 | `meta.json` 的 `selectors` | 页面改版不改代码 |

**没有 pack 时**：`pgh` 能跑 `--mock` 与规则引擎，采集源报「未配置平台 pack」。
**pack 不进 git、不进报告、不进快照。** 快照里只有 `packId` 与 `packVersion`。

这条不只是安全考虑：它同时解决了「规则半年后要改」和「别人想用但平台不同」两个问题。
代价是第一次接入要写一份 `meta.json`（约 60 行），值得。

## 9. 不做的事（明确划掉）

- **不做多租户 / 不上服务端。** 换来的代价是「团队共享状态」这件事没有解，先认。
  这条指**本机不跑服务端**；本机仍会出站连远程 hub（见 [`agent-acl.md §12`](agent-acl.md)），两者不冲突。
- **不做写回平台。** 不能代替人去平台后台改 listing；结论只在本机，导出成给人看的报告。
- **不做插件系统。** 合规是唯一领域包（domain pack），留扩展点但不实现注册机制（第 YAGNI 条）。
- **不做实时监听。** 采集是人或定时触发的批处理，不做文件监视器。
- **不在仓库里放任何真实平台资产。** 规则原文、导出样例、域名、截图一律不进 git。

## 10. 验收（架构层）

1. `cd sidecar && node --test` 全绿，且 `grep -r "require(" sidecar --include=*.mjs` 查不到第三方包
2. App 在断网、sidecar 不存在、快照不存在三种情况下都能打开并给出人话提示（不是 crash）
3. 删掉 `~/.pgh/` 整个目录后，`pgh collect --mock` 能重建出一份合法快照
4. `bash scripts/check.sh` 一条命令覆盖：单测、Rust 编译、行数门禁、契约校验、敏感信息扫描
