# PLATFORM GOVERNANCE HUB

本机的 agent 工作台。第一个落地场景是**电商平台合规管理**。

> 仓库本身**不含任何具体平台**。平台字段映射、规则包、导出样例都以「pack」的形式放在本机
> `~/.pgh/packs/` 下，不进 git。见 [§平台是外挂](./docs/architecture.md#8-平台是外挂pack)。

它不是一个「合规台账系统」。台账要人填报，填报就会失真，失真之后所有统计都不可信。
这里走的是反方向：**证据从本机文件、平台导出、页面抓取里来，人只做判断和处置。**

```
GovernanceHub.app  ──只读──▶  ~/.pgh/snapshot.json  ◀──写入──  sidecar (Node)
     │                                                              │
     └── 只读工具 ──▶ pgh mcp (stdio) ──▶ agent 服务（可插拔）        └──▶ 平台导出 / 本地仓库 / 浏览器扩展
```

## 三条设计约定（继承自 deskbench）

1. **只读优先。** 采集端只 GET、只解析，不改上游任何状态。写操作（处置结论、豁免理由）只落在本机。
2. **不确定就明说。** 没算过的写「需人工确认」，没证据的那条不出现。**宁可空，也不填假数。**
3. **每条结论必须有出处。** 一个 finding 里没有 `ruleId` + 原文位置 + 规则来源，它就不该被画到屏幕上。

第四条是可选的审美约定：语义色只出现在内容里，侧栏与导航一律中性（玻璃被染色后深色模式白字会消失）。

## 组成

| 目录 | 内容 | 语言 / 运行时 |
|---|---|---|
| `GovernanceHub/` | 桌面应用，**macOS + Windows 同一份代码**（GPUI） | Rust（Cargo workspace） |
| `sidecar/` | 采集、规则引擎、本机 HTTP、agent 适配 | Node ≥ 20，零依赖 |
| `browser/` | Chrome MV3 扩展 + 页面 SDK（抓商品页 / listing） | 纯 JS，无构建 |
| `docs/` | 架构、契约、规则库、防腐层、信息架构、路线图 | Markdown |

## 现在到哪一步

**M0 进行中。** `sidecar/` 已有 mock 快照与 mock 任务列表（schema + CLI + 单测）；
`GovernanceHub/` 已有 GPUI 骨架（四个只读视图 + 8 份结构快照基准）；五条门禁 + CI 已接。
真实采集、规则引擎、provider 分别在 M1 / M2。文档顺序阅读：

1. [`docs/architecture.md`](docs/architecture.md) — 三层怎么切、进程怎么跑、边界在哪、**为什么 UI 用 GPUI**
2. [`docs/snapshot-contract.md`](docs/snapshot-contract.md) — App 与 sidecar 之间唯一的数据契约
3. [`docs/rule-library.md`](docs/rule-library.md) — 规则是数据不是代码，以及判定引擎的形状
4. [`docs/agent-acl.md`](docs/agent-acl.md) — 换一个 agent 服务要改几个文件
5. [`docs/ui-ia.md`](docs/ui-ia.md) — 任务层与事实层怎么分、哪些控件要在 GPUI 里重建
6. [`docs/roadmap.md`](docs/roadmap.md) — M0–M3 与验收标准

## 跑起来

```bash
# 侧车：造一份 mock 数据（M0 唯一数据源）
node sidecar/pgh.mjs snapshot --mock --out ~/.pgh/snapshot.json
node sidecar/pgh.mjs tasks --mock

# 桌面应用（需要 rustup + rustfmt + Metal Toolchain，见 AGENTS.md §2）
cd GovernanceHub && cargo run -p hub

# 结构快照：出图 / 与基准比对
cargo run -p hub -- --render fixtures/structure
cargo run -p hub -- --check-baseline

# 全量门禁（本地与 CI 同一条命令）
bash scripts/check.sh
```

出图为什么是结构不是 PNG：`gpui 0.2.2` 没有离屏出图 API，带权限的屏幕抓图进不了 CI
（[`ui-ia.md §8`](docs/ui-ia.md)）。所以「改版前后比结构」——**比 JSON 比 PNG 更抗字体差异**。

## 命名

| 项 | 取值 | 说明 |
|---|---|---|
| 产品名 | PLATFORM GOVERNANCE HUB | |
| bundle id | `com.platformgovernance.hub` | ad-hoc 签名，本地用 |
| CLI | `pgh` | 避开已存在的 `hub`（git 工具）与 `tl`（deskbench） |
| 数据目录 | `~/.pgh/` | 0700 / 0600 |
| 快照 | `~/.pgh/snapshot.json` | 唯一契约 |

## 平台是外挂（pack）

仓库里没有真实平台的名字、域名、字段名或规则。平台相关的一切都在本机：

```
~/.pgh/packs/<packId>/
├── meta.json        平台标识、站点、导出表头 → 内部字段的映射
├── rules/*.json     规则包
├── dict/*.json      词典
└── samples/         脱敏导出样例（只用于表头指纹匹配，可选）
```

两个原因：换平台不用改代码；这个仓库可以安全地公开 —— 里面没有公司的规则、域名和数据。

`.gitignore` 必须挡住：`packs/`、`evidence/`、`*.xlsx`、`*.csv`、`config.json`、`renders/`、`.env`。
CI 里加一条检查：仓库内不得出现内网域名或真实平台名（见 `scripts/check.sh`）。

## 如果要把仓库公开

这个仓库从设计上就是可以公开的 —— 不含平台、规则、数据、内网地址。但历史里的东西不会自己消失，
推之前按这六条过一遍：

1. **扫 git 历史**，不只看当前文件：`git log -p | grep -iE "公司域名|内网地址|内部系统名"`。
   历史里出现过一次就等于公开了，得用 `git filter-repo` 重写，不是删文件能解决的。
2. **提交邮箱**。用公司邮箱提交，读者一眼就知道你在哪家公司（即使仓库名无关）。
   建议在本仓库单独设 `user.email`，或用 GitHub 的 noreply 邮箱。
3. **样例数据脱敏**。SKU、商品名、供应商、价格一律换成假的；图片去掉 EXIF（含拍摄地点和设备）。
4. **pack 不在仓库**。`packs/`、`config.json`、`evidence/` 全部被 `.gitignore` 挡住，确认 `git status` 干净。
5. **规则原文不抄进文档**。条款出处写「见本机 pack」，示例只保留抽象形状。
6. **LICENSE**。没想好就先用 `MIT` 或 `Apache-2.0`；不写 license 默认保留所有权利，别人没法用。

CI 里加一条敏感词扫描（`scripts/check.sh` 的一项）：仓库内出现内网域名、真实平台名、`AKIA` / `ghp_` 这类
凭据前缀就失败。这条比人工 review 可靠，因为它不会看累。

## 与 deskbench 的关系

同一套骨架，换掉判定层；UI 栈则整个换掉：

- **原样继承**：三层架构、三条通道、离屏出图回归的做法、覆盖率门禁、AGENTS.md 的硬约束、视觉语言的目标
- **换掉**：`domain/` 从「趋势统计」变成「规则引擎」；`Snapshot` 多了 `findings` 与 `evidence`
- **不能继承的**：deskbench 那 1755 行 SwiftUI DesignSystem。UI 栈改用 Rust + GPUI（要 Windows），
  玻璃/折叠/分段/出图全部重建，代价与理由见 [`architecture.md §2.1`](docs/architecture.md)
- **新增**：agent 服务的防腐层（deskbench 直接绑死 `claude -p`，这里不允许）

继承而来的经验，别重新踩：对旧快照宽容解码、面板数字只有一个计算处、sidecar 不引第三方包、
测试不许碰真实用户数据。
