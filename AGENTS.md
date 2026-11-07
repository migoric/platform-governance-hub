# AGENTS.md — 项目约束

> 给在本仓库里改代码的 agent 和人。每次动手前先读本文；细节以链接文档为准。
> 仓库由四部分组成：`GovernanceHub/`（Rust + GPUI 桌面 App，Cargo workspace）、`sidecar/`（Node 零依赖，
> `pgh` CLI / `pgh serve` / `pgh mcp`）、`browser/`（Chrome MV3 扩展，无构建）、`docs/`（设计文档）。

## 1. 必读文档

| 文档 | 什么时候读 |
|---|---|
| `docs/refactor-constraints.md` | **任何改动前**：不可变契约、数据边界 |
| `docs/architecture.md` | 碰进程模型、目录结构、依赖方向前 |
| `docs/snapshot-contract.md` | 改 `snapshot.json` 字段、加面板、改解码前 |
| `docs/rule-library.md` | 加规则、加 check 类型、改判定引擎前 |
| `docs/agent-acl.md` | 碰 `AgentKit`、provider、工具面、助手面板前 |
| `docs/ui-ia.md` | 加面板、改交互、改视觉前 |

## 2. 改完必须跑的验证

```bash
cd sidecar && node --test                        # 单测
cd GovernanceHub && cargo build --workspace      # 编译（macOS 上同时验 Windows 交叉编译见下）
cd GovernanceHub && cargo test --workspace       # 单测
cd GovernanceHub && cargo run -p hub -- --check-baseline   # 结构快照回归
bash scripts/check.sh                            # 全量（含门禁）
```

改了 UI 之后基准会红——**先确认变化是不是你想要的**，再 `cargo run -p hub -- --render fixtures/structure`
重生成基准并把 8 份 JSON 一起提交。

Windows 目标不要求本机可跑，但**每次改动 UI 层至少跑一次**
`cargo check --target x86_64-pc-windows-msvc`（需 `rustup target add`），否则「跨端」只是口号。

> 实测（2026-11-07）：在 macOS 上这条**会卡在依赖的 C 代码**，不是卡在我们的代码——
> `ring` 编译时需要 Windows SDK 的头文件（`fatal error: 'assert.h' file not found`），
> 本机没有。所以跨端验证由 CI 的 `windows` 作业兜底（`windows-latest` 上原生
> `cargo check`），本机只保证「不引入平台专有 API」。连续条件写在这里，免得下次
> 以为是自己写坏了。

**环境前置**（换机器或换 Xcode 版本后会重新需要）：

| 依赖 | 为什么 | 一条命令 |
|---|---|---|
| rustup + stable | 工具链 | 官方脚本（用户级，不需要 sudo） |
| `rustfmt` 组件 | `gpui` 的 build script 会调它 | `rustup component add rustfmt` |
| Metal Toolchain | `gpui` 编译 `.metal` 着色器要用 | `xcodebuild -downloadComponent MetalToolchain`（838.9 MB） |

缺 Metal Toolchain 时的报错很直白：`cannot execute tool 'metal' due to missing Metal Toolchain`。

没跑或跑不了，在交付说明里写明原因。**不能说「应该没问题」。**

`scripts/check.sh` 里必须有这五条：

1. 外部协议字段名（`stream-json` / `content_block` / `text/event-stream`）只允许出现在 `sidecar/agent/providers/`
2. 全仓搜不到 `provider ==` / `providerID ==` 形式的名字判断
3. 单文件行数：产品代码 ≤ 500 行（测试与 fixture 不限制）
4. 敏感信息：仓库内不得出现内网域名、真实平台名、凭据前缀（`AKIA` / `ghp_` / `sk-`）
5. 契约：跑真实 CLI，校验产物合法、紧凑单行、0600 / 0700、重复生成字节一致

## 3. 测试与覆盖率（强制）

1. **新增代码必须带单测。** 新函数 / 新规则 / 新 check 类型 / 新 provider，同一次提交里加用例；纯 View 布局除外。
2. **修 bug 先补一条能复现的回归用例**，修完转绿。
3. **不许删测试、不许改断言迁就实现。** 确需删除，在提交说明里写理由。
4. **覆盖率只升不降。** sidecar 必须带 `--test-coverage-exclude='test/**'`（不加会虚报约 5pt）。
5. **改动行覆盖 ≥ 80%。** 达不到要在提交说明里列出未覆盖的原因。
6. **规则必须有正例 + 反例 fixture。** 一条规则只有正例不算测过。
7. **测试不许碰真实数据**：`~/.pgh/`、应用偏好、`com.platformgovernance.hub` 的偏好域一律**注入**
   （临时目录 / 独立 store，测试前清空）。UI 测试读 `GovernanceHub/fixtures/` 的快照与 tasks，不读本机快照。
8. **Rust 侧 M0 只要求 `cargo test` 全绿。** 覆盖率阈值等 `cargo llvm-cov` 量出基线再进 `gates.env`，
   不先写一个没量过的数字。

## 4. 代码规模

1. 产品代码单文件超过 500 行必须拆分（`.rs` 与 `.mjs` 同一标准，测试与 fixture 不受限）。
2. 拆分母文件不改行为、不改对外接口，单独提交。
3. 函数超过 50 行考虑拆分。

## 5. 写代码前先问三个问题

1. **这条结论有出处吗？** 没有 `ruleId` + 条款 + 原文位置，就不要把它画到屏幕上。
2. **这个数字算了第二遍吗？** 面板数字只能在 sidecar `summary` 或 `DashboardSelector` 里算一次。
3. **这个判断依赖哪家 agent 服务？** 依赖了就必须走 `capabilities`，不许出现在业务分支里。

## 6. 提交

- 提交信息：`type(scope): 中文描述`，type ∈ `feat` / `fix` / `docs` / `test` / `build` / `refactor` / `chore`
- 一次提交只做一件事；规则口径变更单独提交，并在正文写清「影响多少条历史结论」
- 改契约的提交，正文必须列出受影响的文件清单

## 7. 当前阶段

**M0 进行中。** 已落地：`sidecar/` 的 mock 快照 + mock 任务列表（schema、CLI、单测）、五条门禁、
`GovernanceHub/` 的 Cargo workspace（`crates/hub` + `crates/hub-agent`）、设计系统骨架（面板 / 玻璃 /
严重度徽章 / 任务卡）、四个只读视图与 **8 份结构快照基准**；CI 已接 `scripts/check.sh`。
未开始：真实采集与规则引擎（M1）、provider（M2）。

开代码前先确认 `docs/roadmap.md` 里对应档的验收标准，不要提前实现 M2 的东西
（尤其是 remote provider，等真服务）。

远程 hub 的对端尚未存在，接入要求见 `docs/agent-acl.md §12`。那节是**带去谈的问询清单**，
不是已定契约：先确认它到底给的是流式 API 还是只有页面，再录 fixture 写 `remote.mjs`。
