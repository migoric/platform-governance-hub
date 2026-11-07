# 路线图

> 每一档都有**可验证的出口**。没有验收标准的里程碑不是里程碑，是愿望。

## M0 — 骨架跑起来

**目标**：App 能打开、能看到一份假数据、能出图，且**第一入口（任务列表）的布局在 M0 就定型**。
证明架构成立，功能一条没有。

| 交付 | 内容 |
|---|---|
| `GovernanceHub/` | Cargo workspace（`crates/hub` + `crates/hub-agent`）、GPUI 钉版本、设计系统骨架（Panel / 玻璃 / 徽章 / 任务卡）、`--render` 出图 |
| 面板 | 任务列表（四状态静态数据）、任务详情（思考折叠条两态）、总览、风险清单（只读、无筛选） |
| `sidecar/` | `pgh.mjs` 路由、`snapshot/schema.mjs`、`tasks/schema.mjs`、`util/dates.mjs`、`util/redact.mjs`、`pgh snapshot --mock`、`pgh tasks --mock` |
| `scripts/check.sh` | 单测 + Swift 编译 + 契约校验 + 行数门禁 |

任务层在 M0 **只做视图，不接 provider**：`pgh tasks --mock` 写 `~/.pgh/agent/tasks.json`（紧凑单行），
App 只读渲染。这个文件是**投影**（`ui-ia.md §2.1` 的卡面四字段），不是会话事实源——
M2 的事件契约另行定义，**`tasks.json` 的字段形态不得作为反推 provider 事件的依据**。

**验收**

1. `pgh snapshot --mock > ~/.pgh/snapshot.json` 与 `pgh tasks --mock` 均通过各自 schema 校验
2. `cargo run -p hub -- --render fixtures/structure` 出 **8 份结构快照**（节点树 + 可见文本 + 数据源计数）：
   总览、风险清单、任务列表（进行中 / 等待确认 / 已完成 / 已中断 各一份）、
   任务详情（折叠条收起 / 展开 各一份）。总览数字与 mock 一致，任务卡耗时与 fixture 一致
   ——基准为什么是结构不是 PNG：gpui 0.2.2 没有离屏出图 API（`ui-ia.md §8` 已查源码确认）。
   基准随仓库提交在 `GovernanceHub/fixtures/structure/`，`--check-baseline` 做逐文件比对，
   已挂进 `scripts/check.sh rust`，所以「布局被误改」会在本地和 CI 同时红。
3. 两种空状态文案不同：删掉快照 → 「尚无数据，点这里采集」；
   删掉 `tasks.json` → 「还没有任务。任务要显式新建，点选列表不会自动开始」（`ui-ia.md §4.4`）
4. `bash scripts/check.sh` 一条命令全绿

**风险**：任务卡四字段在 M0 就固化，而真实事件流到 M2 才见到。若届时事件流给不出「耗时」或
「参与的 agent」，改的是 `tasks.json` 的投影逻辑，**不是卡面**——所以 M0 的出图基准不会因为 M2 返工。
这也是把任务列表放进 M0 的主要理由：布局定型一次，回归基准只建一次。

**换栈带来的三个风险（GPUI）**

1. **离屏出图不存在（已确认，不是风险是不存在）。** `gpui 0.2.2` 源码里没有 `render_to_image`
   一类 API，只有 `screen-capture`（截真实屏幕，要屏幕录制权限）。所以 M0 的回归基准已改成
   结构快照，PNG 只作人工核对——**别再按「8 张 PNG」去写验收**。
2. **AccessKit 覆盖未知。** 键盘可达我们能保证，读屏到什么程度要看实测，验证前不对外承诺。
3. **pre-1.0 会破坏 API。** `gpui` 钉死具体版本（不用 `^`），升级是单独一次提交，升完重跑结构快照。

**环境前置（本机已验过）**：`gpui` 的 build script 要编译 Metal 着色器，
缺 Metal Toolchain 会直接失败。修法是一条命令，但要下 838.9 MB：
`xcodebuild -downloadComponent MetalToolchain`。装完后 gpui 0.2.2 在本机 **10.6 秒编译通过**。

**不做**：真实采集、规则引擎、agent 事件流与 provider、报告。

---

## M1 — 规则引擎（核心价值）

**目标**：能对真实商品数据给出**可解释**的判定。

| 交付 | 内容 |
|---|---|
| 规则库 | `baseline` 包，16–20 条规则（标题/图片/属性/价格/类目资质） |
| 引擎 | `domain/rules-engine.mjs`，6 种 check 类型（字典、正则、长度、必填、枚举、关联） |
| 证据 | finding 组装 + `quote` 命中校验（对不上就丢弃并计入 `unjudged`） |
| 面板 | 上架前检查、规则库（只读浏览 + impact 预估） |
| CLI | `pgh rules list / impact <id>`、`pgh check --item <sku>` |

**验收**

1. 每条规则在 `test/fixtures/rules/` 有正例 + 反例，`node --test` 全绿
2. 同一份输入连跑 10 次，输出**字节级一致**（时间戳由参数注入）
3. 故意把一条规则的正则写成 `(a+)+$` 对长串攻击，引擎 20ms 内放弃并记 `unjudged`，不卡死
4. `pgh rules impact <新规则>` 能在现有快照上回放并报告新增条数

**风险**：规则口径没有权威出处 → 每条规则的 `source` 必须有人签字确认（M1 期间由你逐条过）。

**进度（2026-11-07）**

已落地：引擎六种 check + 证据三态 + 正则两道闸；规则库 3 个包 23 条规则（baseline 16 /
category-certs 4 / eu-market 3）+ 8 份词典；`pgh check` / `pgh rules list` / `pgh rules impact`；
面板「上架前检查」「规则与证据」（出图 8 份 → 10 份）；每条规则都有正例反例 fixture。
实测：mock 快照 8 个商品 → 7 条 finding + 6 条待判；sidecar 190 项测试、Rust 64 项测试全绿。

*（同日追加）* 出处状态机器化：`source.status` 强制 `draft` / `verified` 两档，
23 条规则与 3 个包全部标为 `draft`，`verified` 必须给链接与抓取日期、`draft` 挂链接直接拒绝；
快照带 `rulePacks[].sourceStatus`，规则库面板逐包标「出处未核实」并在标题栏计数。
测试 196 项（新增 6 项专盯这条），结构基准只有 `10-rule-library.json` 变化。

**没做到的三件事，写在这里**

1. **规则口径是虚构的。** 23 条规则的 `source.clause` 按常见平台规范的形状编的，不是任何真实条款。
   上线前必须逐条换成原文 —— 这是 M1 的出口条件，不是文档细节。
   *（2026-11-07 补）* 已经不再是「文档里承认一下」的状态：每条规则与每个包都强制带
   `source.status`，当前全部是 `draft`（`verified` 必须给 `http(s)` 链接与抓取日期，
   `draft` 挂链接会被拒），界面上逐包标「出处未核实」并在标题栏计数。
   但**出口条件没变**：机器只能保证「未核实这件事没被藏起来」，不能替你核实。
2. **check 只有 AND，没有条件。** 「有宣称但缺证书」这类跨字段条件表达不出来，只能降级成
   `semantic` 产待判占位，或拆成两条独立规则。
3. **`asset.meta` / `relation.exists` / `external.query` 未实现。** 写进规则会被校验器拒绝，
   所以图片尺寸、类目与证书的对应关系、外部查询这三类判定目前判不了。

---

## M2 — Agent 防腐层

**目标**：换 agent 服务不改上层。这一档的产出是**接口**，不是智能。

| 交付 | 内容 |
|---|---|
| `agent/contract.mjs` | 7 种事件 + 版本 + 校验 |
| providers | `claude-cli`（本机）、`replay`（fixtures）、`remote`（**空实现 + 模板**；对端就绪后按 [`agent-acl.md §12`](agent-acl.md) 接入） |
| 工具面 | `snapshot_query` / `rule_lookup` / `evidence_get` / `impact_estimate`，全只读 |
| `hub-agent`（Rust） | `crates/hub-agent`：内部事件模型、provider 协议、能力分支（`hub` 可依赖它，反向不行） |
| 面板 | 任务详情接真实事件流（替换 M0 的静态数据源，卡面与折叠条不动）、设置里的 provider 选择与握手结果 |
| 门禁 | grep 检查外部协议字段名只出现在 `providers/` |

**验收**

1. 三条门禁全过（外部字段名、`provider ==` 判断、每个 provider 有 fixture）
2. 把 `replay` 当主 provider 时，UI 明确标注「回放数据，不是真实分析」
3. 断网 + 只装 `replay` 时，助手仍可用（回放），事实卡不受影响
4. **接入演练**：照 checklist 现场加一个 `_template` provider，改动 ≤ 2 个文件，测试 15 分钟内跑绿

第 4 条是这一档的真正验收 —— 它模拟的就是「以后接新 agent 服务」那一天。

**进度（2026-11-07）**

sidecar 侧已落地：事件契约（7 种 + 铁律校验，违规标识与 Rust `event.rs` 逐字同名）、
Provider 接口注释、注册表、三个 provider（`replay` 可用 / `claude-cli` 翻译层写好、端到端只验到错误路径 /
`remote` 空壳且只失败）、`_template` 接入骨架、握手与降级阶梯、4 个只读工具、
`pgh agent list / handshake / run / session / tool`。

**UI 侧已接入事件流**（2026-11-07 第二刀）：任务详情不再读手写的 `thought.tools`，
改读 `agent/session.mjs` 从事件流聚合出的会话投影（`~/.pgh/agent/session.json`）。
投影里同时带 `events`，校验器从 events 重算 `timeline` 逐字段比对 —— 投影手改会被抓出来，
提交的 fixture 也有一条「重跑 replay 必须字节相等」的测试盯着。

验收对照：

| 条目 | 状态 |
|---|---|
| 1. 三条门禁全过 | ✅ 外部字段名与 `provider ==` 两条是 M0 预埋的 `check-boundaries.mjs`，新代码天然通过；每个 provider 有同名 fixture 由 conformance 测试保证 |
| 2. replay 当主 provider 时 UI 明确标注 | ✅ CLI 进 stderr；UI 在归属行打「回放」徽章 + 照抄 provider 的免责原话，收起态也看得到 |
| 3. 断网 + 只装 replay 仍可用 | ✅ 本机实测就是这条路（claude 没装、remote 没配），`run` 正常出事件 |
| 4. 接入演练（≤2 文件，15 分钟绿） | ⏳ 未做。`_template.mjs` 在，但还没真按 checklist 走一遍计时 |

**没做到的**：工具面没接进 provider 回路；设置页的 provider 选择与握手结果还没做；
`claude-cli` 只验到「未登录」这条错误路径，成功路径没有真实录制 —— 详见 [`agent-acl.md §13`](agent-acl.md)。

---

## M3 — 接真实数据与产出物

**目标**：从「能判」到「能交差」。

| 交付 | 内容 |
|---|---|
| 采集 | 平台后台导出解析（CSV/XLSX，自研解析器；表头映射来自本机 pack）、`browser/` 扩展抓 listing |
| 在售巡检 | 规则新旧 diff → 只重判受影响的 SKU → 差异视图 |
| 报告 | PDF / DOCX 导出（合规声明、整改说明），带证据附录与签署栏 |
| `pgh serve` | 规则热更新端点、报告生成端点、扩展上报端点 |
| 处置 | 整改单、豁免理由、时间线（`actions.jsonl` 只追加） |

**验收**

1. 一份真实导出（脱敏后）能完整跑通：采集 → 判定 → 报告，全程 ≤ 2 分钟
2. 报告里每一条结论都能点回原文位置
3. 规则更新后巡检只重判受影响的 SKU，且能说清「为什么这批受影响」
4. `pgh serve` 单实例、崩溃自动重启、`serve.json` 可发现

---

## 明确不做（至少在 M3 之前）

| 不做 | 理由 |
|---|---|
| 写回平台后台 | 越权、且平台没有稳定 API；结论只在本机 |
| 多用户 / 共享基线 | 与「不上服务端」冲突，先认这个缺口 |
| 插件系统 / 第三方规则市场 | 只有一个领域包时不值得抽象 |
| 实时文件监听 | 批处理足够，实时只带来抖动 |
| 移动端 / Web 版 | UI 的价值一半在原生材质，砍掉就只剩表格 |

## 三个我会持续盯的风险

1. **规则数量膨胀 → 没人处理。** 对策：`rules impact` 门禁 + 每条规则必须有 owner。
   规则库的可用性不取决于条数，取决于处理率。
2. **导出格式漂移。** 平台后台改列名是常态。对策：`sources/listing-export` 里做表头指纹匹配，
   解析失败时明确报「表头变了，缺哪几列」，绝不部分解析后静默产出半份数据。
3. **agent 回答像结论。** 对策：视觉分区（§ui-ia 6）+ 证据必须可点回原文 + 默认折叠。

## 时间（粗估，按我一个人的节奏）

| 档 | 工作量 |
|---|---|
| M0 | 4–6 天（换 GPUI 后没有现成设计系统：玻璃/折叠/分段/出图全部自建，原 1.5 天的估算作废） |
| M1 | 3–4 天（规则口径的确认是主要成本，不是写代码） |
| M2 | 2 天 |
| M3 | 5–7 天（报告导出与扩展最耗时） |
