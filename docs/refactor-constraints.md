# 不可变契约清单

> 改动前逐条对照。标 **[硬]** 的改了要两侧同时发版并回滚旧数据；标 **[软]** 的只是约定，可以商量。

## 1. 数据契约

### 1.1 `snapshot.json`（App ↔ sidecar）[硬]

- 顶层 `schemaVersion` 是整型；不认识的 major → App 拒读并提示「sidecar 版本过旧」
- `severity` 只有四档：`blocker` / `required` / `suggest` / `observe`。**不许加第五档**
- `kind` 只有三档：`deterministic` / `semantic` / `manual`
- `finding.evidence.quote` 必须能在 `item[evidence.field]` 里按 `offset/length` 命中；
  **对不上就丢弃该 finding**，不降级成模糊描述
- 字段只增不删；删字段要升 major

### 1.2 规则库 [硬]

- `rule.id` 一旦发布**永不改名**。改名 = 新规则，历史 finding 会全部失去依据
- `rule.source` 必填。没有条款出处的规则不许入库（校验器拒收）
- `rule.kind == "deterministic"` 时 `checks` 不能为空
- check 类型是封闭集，新增类型要同时改引擎与 Swift 侧的能力展示

### 1.3 Agent 事件 [硬]

- 只有 7 种事件：`started` / `text` / `tool_call` / `tool_result` / `usage` / `error` / `done`
- `tool_call` 与 `tool_result` 必须配对，`callId` 由适配器生成
- `error` 之后必须还有 `done`
- `text` 只有 `delta`，没有整段

### 1.4 `pgh mcp` 协议 [硬]

换行分隔的 JSON-RPC 2.0，工具表只增不删不改名（agent 侧的会话记录依赖工具名）。

## 2. 架构契约 [硬]

1. **App 不采集、不联网。** 唯一的出口是 `SidecarClient`（子进程）与 `AgentSession`（sidecar 转发的 agent 服务）。
2. **sidecar 零第三方依赖。** 包括 `lodash`、`xlsx`、`express`。HTTP 用 `node:http`，Excel 自己解析。
3. **domain 是纯函数。** 不读文件、不发请求、不看时钟、不读环境变量。这几样由 cli 层注入。
4. **三条通道一条都不能删**：CLI 子进程、`snapshot.json`、`pgh mcp`。
5. **外部协议字段名只能出现在 `sidecar/agent/providers/`。**
6. **UI 不许按 provider 名字分支**，只按 `capabilities`。

## 3. 进程与文件 [硬]

| 项 | 取值 |
|---|---|
| 单实例 | `~/.pgh/serve.json` + 文件锁 |
| 端口 | 固定 `38019`（避开 deskbench 的 38017） |
| 原子写 | `tmp` + `rename` |
| 权限 | 目录 `0700`，文件 `0600` |
| 单次 body | ≤ 8MB，超出 413 |
| 数据目录 | `~/.pgh/`，不散落在别处 |

## 4. 只读边界 [硬]

- 采集端只有 GET / 只读文件
- 写操作（处置、豁免、报告导出、规则更新）**只能由人触发**，不进 agent 工具表
- 唯一例外是未来的浏览器操作（`page_click`），必须声明 `pageAction: true` + `destructiveHint`，
  且只在人显式发起的会话里开放（`HUB_AGENT_RUN`）

## 5. 可以自由动 [软]

- `hub` crate 的模块划分、视图层级、命名、设计系统里的魔数（换 GPUI 后这一条范围更大：
  整个 `src/ui/` 都是新的，只有观感目标是约定）
- sidecar 的 `cli/` 拆分、测试文件组织、内部数据结构
- 面板顺序、图标、文案（只要不改变「一个数字一个计算处」）
- 规则包的组织方式（按站点 / 按类目 / 按法规都行，只要 id 稳定）

## 6. 改之前先确认没有外部依赖

| 接口 | 谁依赖 | 代价 |
|---|---|---|
| `pgh` 子命令名 | `hub` 的进程参数 | 要同步改 Rust |
| `snapshot.json` 字段 | `src/models/` 的 serde 结构 | 改模型 + 兼容旧快照 |
| `pgh mcp` 工具名 | agent 会话 | 工具名进历史记录，改名等于断档 |
| 规则 `id` | 历史 finding / 报告 | 旧结论失联，报告不可回溯 |
