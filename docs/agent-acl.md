# Agent 防腐层（ACL）

> 目标：**接入一个新的 agent 服务 = 加一个 provider 文件 + 一条配置 + 跑一次测试。**
> 上层（Swift UI、sidecar 业务、报告）永远不知道对面是 Claude CLI、公司自研网关，还是别家的 SSE。

## 1. 为什么需要这一层

deskbench 里 agent 是绑死 `claude -p` 的：`AgentKit` 直接解析 Claude Code 的 `stream-json`。
那套在单供应商时最省事，但一旦要换（公司统一网关、私有化模型、别的厂商），字段名、事件类型、
工具调用格式、计费口径全都不一样，改动会顺着 `AgentKit` 渗到 UI。

所以这里把「协议」和「能力」拆开：

```
        ┌──────────────────────────────────────────────┐
        │  AgentEvent（封闭枚举）  ← 全仓唯一的气泡格式  │
        └───────────────▲──────────────────────────────┘
                        │ 归一化（唯一允许翻译的地方）
        ┌───────────────┴──────────────────────────────┐
        │  Provider 适配器                              │
        │  ├ claude-cli.mjs   子进程 + stream-json      │
        │  ├ remote.mjs       HTTP / SSE（公司服务）     │
        │  └ replay.mjs       fixtures 回放（离线/降级） │
        └──────────────────────────────────────────────┘
```

**翻译只发生在适配器里。** 适配器上面，没有任何一个文件知道 `content_block_delta`、
`message_start`、`data: {...}` 这些词。

## 2. 内部事件模型（封闭集，7 种）

```js
// sidecar/agent/contract.mjs
export const CONTRACT_VERSION = 1;

export const Event = {
  STARTED: "started",     // { sessionId, provider, capabilities }
  TEXT:    "text",        // { delta }          流式增量，可多次
  TOOL_CALL: "tool_call", // { callId, name, args }
  TOOL_RESULT: "tool_result", // { callId, ok, summary, bytes }
  USAGE:   "usage",       // { inputTokens, outputTokens, costUsd, currency }
  ERROR:   "error",       // { code, message, retryable }
  DONE:    "done",        // { reason: "ok" | "cancelled" | "error" | "max_steps" }
};
```

五条铁律：

1. **只有这 7 种**。需要新语义时先问「能不能映射到已有种类」，映射不了才升 `CONTRACT_VERSION`（升版本 = 全部适配器一起改）。
2. **文本只有 `delta`**，没有「整段」。要整段由消费方自己拼。这样流式与非流式服务可以共用一套事件。
3. **`tool_call` 与 `tool_result` 必须配对**，`callId` 由适配器生成（不用外部 id，格式各异）。
4. **`usage` 允许缺失**。拿不到成本的 provider 就不发，UI 显示「—」，不显示 0。
5. **`error` 之后必须还有 `done`**。异常路径也要收尾，否则 UI 的转圈永远不停。

## 3. Provider 接口

```js
// sidecar/agent/provider.mjs —— 只有类型注释，没有实现
/**
 * @typedef {Object} Provider
 * @property {() => string}            id              // "remote" | "claude-cli" | "replay"
 * @property {() => Promise<Capabilities>} capabilities
 * @property {(req: StartRequest) => AsyncIterable<Event>} start
 * @property {() => Promise<void>}     cancel
 */
```

```swift
// AgentKit/Provider.swift
public protocol AgentProvider: Sendable {
    static var providerID: String { get }
    func capabilities() async -> AgentCapabilities
    func start(_ request: AgentRequest) -> AsyncThrowingStream<AgentEvent, Error>
    func cancel() async
}
```

`StartRequest` / `AgentRequest` 只含：`prompt`、`context`（当前选中的 finding / item）、
`toolAllowlist`（字符串数组）、`maxSteps`、`locale`。**不含**：模型名、temperature、max_tokens ——
这些属于 provider 的内部实现，公司网关的模型命名不一定和它一致。

## 4. 能力声明，不是名字判断

```json
{
  "streaming": true,
  "tools": true,
  "vision": false,
  "cost": true,
  "maxSteps": 8
}
```

UI 只按能力分支：

```swift
if caps.streaming { renderStreaming() } else { renderWhole() }
if caps.cost { showCostFootnote() }
if !caps.tools { hideToolTrace() }
```

**永远不写 `if provider == "claude"`。** 这条进 CI 门禁（见 §8），因为它一旦出现，适配器就白写了。

provider 不支持某个能力时：该功能**灰掉并注明原因**（「当前 agent 服务不提供图像分析」），
不是崩、不是静默降级成空结果。

## 5. 握手与版本

```
pgh agent handshake --provider remote
→ { ok, contractVersion: 1, provider: "remote", serverVersion: "2.3.1", capabilities: {...} }
```

- 适配器声明自己实现的是 `CONTRACT_VERSION` 几；与 sidecar 内核不一致 → 拒绝启动该 provider
- 远端服务版本号只**展示**（设置页），不参与分支判断
- 握手失败 → 走降级阶梯，并在 UI 顶部挂一条持久提示，不是弹一次就消失的 toast

## 6. 降级阶梯

```
remote（公司网关）
   ↓ 握手失败 / 超时 / 未配置
claude-cli（本机装了就用）
   ↓ 未安装 / 未登录
replay（fixtures 回放）
   ↓
none（隐藏助手入口，事实卡照常）
```

规则：

1. **降级要在 UI 上明说**。回放模式必须标「回放数据，不是真实分析」，否则等于骗人。
2. **不自动重试超过一次**。重试会掩盖服务故障，还会让成本翻倍。
3. **降级不影响事实卡**。inspector 的字段来自快照，不经过模型 —— 这条是 deskbench 的既有约定，必须保留。
4. **单次超时 30s，无首 token 45s**。超时进入降级，`DONE.reason = "error"`。

## 7. 工具面（只读闸门）

agent 能用的工具由 `sidecar/agent/tools.mjs` 注册表决定，与 provider 无关：

| 工具 | 读什么 | 只读 |
|---|---|---|
| `snapshot_query` | 快照的某个分区（items / findings / rulePacks） | 是 |
| `rule_lookup` | 规则详情与条款出处 | 是 |
| `evidence_get` | 证据条目的元信息（不返回二进制） | 是 |
| `impact_estimate` | 某条规则的改法会新增多少 finding | 是 |

- **写操作不进工具表**（处置、豁免、报告导出都只能人点）
- 工具返回值一律**脱敏 + 截断**（单次 ≤ 32KB），由 `util/redact.mjs` 与截断器统一处理
- 未来若要放开浏览器操作（像 Accio 的 `page_click`），必须声明为 `pageAction: true`，
  且只在人显式发起的会话里开放（环境变量 `HUB_AGENT_RUN`），并标 `destructiveHint`

## 8. 门禁：一个 grep 检查

```bash
# scripts/check.sh 里的一项
! grep -rn --include=*.mjs --include=*.swift \
    -E "stream-json|content_block|message_start|text/event-stream" \
    sidecar agent 2>/dev/null | grep -v "^sidecar/agent/providers/"
```

命中即失败。这条门禁的价值在于：它会强迫你把「翻译」写在正确的位置，而不是图省事在业务里判一下。

再加两条：

- `grep -rn "provider ==\|provider ===\|providerID ==" ` 应为空（能力代替名字）
- 每个 provider 必须有同名 fixture 与 conformance 测试

## 9. 适配器合规测试

```
sidecar/test/fixtures/agent/
├── claude-cli.stream.jsonl     录制的真实输出
├── remote.sse.txt              录制的 SSE 原文
└── expected.events.json        归一化后的期望事件序列
```

`test/agent-conformance.test.mjs` 对每个适配器跑同一套：

1. 回放 fixture → 归一化 → 断言事件序列等于 `expected.events.json`
2. 未知事件类型 → 忽略并计入 `unknown`，不抛错
3. 缺字段 → 走默认，不抛错
4. `error` 后必有 `done`
5. 取消 → `DONE.reason === "cancelled"` 且无后续事件

**接入新服务的人只需要让这 5 条过。** 不需要读 UI 代码，也不需要读规则引擎。

## 10. 接入 checklist（新 agent 服务）

1. 复制 `providers/_template.mjs` → `providers/<name>.mjs`，实现 `id / capabilities / start / cancel`
2. 在 `providers/registry.mjs` 注册一行（数组追加，不改别的）
3. 录一份真实交互，存 `test/fixtures/agent/<name>.*`
4. `node --test test/agent-conformance.test.mjs` 全绿
5. 设置页能选中它，握手返回 `ok`

**合计改动：1 个新文件 + 1 行注册 + 1 份 fixture。** 上层零改动 —— 这就是这一层存在的全部理由。

## 11. 安全

- 外部 agent 服务的凭据走 `~/.pgh/config.json`（0600）或钥匙串，**不进代码、不进快照、不进日志**
- 请求体默认脱敏：手机号、邮箱、token 形似串一律打码后再发
- 远端返回的内容按**不可信**处理：进 UI 前转义，进报告前做 markdown 白名单过滤
- agent 输出一律带「AI 生成」标记，与规则引擎的结论（确定性）在视觉上可区分

## 12. 远程 hub 对接（对端最低要求）

> 状态：对端尚未存在。本节是**带去谈的清单**，不是已实现的契约。
> 真服务出现后按其实际事件流录 fixture 回填，再决定是否动 `CONTRACT_VERSION`。

### 12.1 拓扑：出站，不开入站

本机 hub 是**边缘节点**，主动连远程 hub；远程 hub 内部调度它自己的 agent。

```
GovernanceHub.app ──▶ sidecar ──出站──▶ 远程 hub ──▶ agent A / B / C
                         └─ agent/remote.mjs（唯一接入缝）
```

因此 `pgh serve` 保持绑 `127.0.0.1`、单实例（architecture.md §3），**不为远程开入站端口**。
入站端口只服务本机 App 与 Chrome 扩展。

反向调用（远程 hub 要读本机快照 / 证据）不开通道。做法是**上行带事实、下行只要结论**：
`StartRequest.context` 承载本次会话相关的脱敏事实包，远程读不到本机磁盘也不影响判定。

### 12.2 对端最低要求

| 要求 | 为什么要 | 不满足的后果 |
|---|---|---|
| 流式返回（SSE 或 chunked JSONL） | `text` 只有 delta（§2 铁律 2） | 只能等整段，UI 无流式，且无法实现「无首 token 45s」超时（§6） |
| 每事件带会话标识 | 会话归属与取消 | 无法多会话，`cancel` 不知道停哪条 |
| 每事件带单调序号（`seq`） | 断线续传、去重（UI 侧见 `ui-ia.md §4` 第 6 条） | 长任务断线只能从头跑，重复 `tool_call`、重复计费 |
| 错误带机器可读码 | `error.code` 要判 `retryable` | 只能整条降级到 `claude-cli` |
| 成本可上报，或明确声明不支持 | `usage` 允许缺失，不允许假 0（§2 铁律 4） | 成本脚注只能显示「—」，做不了预算告警 |
| 可取消（显式端点，或断开连接即中止） | 远端跑着时要能停 | 断线后远端继续跑，重试即重复计费（§6 第 2 条） |
| 稳定 endpoint + 明确鉴权 | 凭据要进 `config.json`（§11） | 临时 demo 链接无法作为 provider 配置项 |

对端只要能吐出 §2 那 7 种事件的对应物，适配器就是纯翻译，不涉及业务判断。

### 12.3 对接前要问清的六件事

1. **是流式 API，还是只有给人看的页面？** 只有页面的话防腐层无从对接——provider 需要一个可编程的流，不是 HTML。
2. endpoint 是长期地址还是临时 demo？demo 下线后 provider 指向哪里。
3. 协议是 SSE、WebSocket、还是 JSONL 分块？有没有心跳与保活。
4. 鉴权方式（token / cookie / 网关透传）？凭据由谁发、多久失效。
5. 一次请求是**单会话**，还是会在远端派生多个 agent？后者才需要考虑 12.4。
6. 取消与超时怎么定义？断开连接是否等于中止远端任务。

### 12.4 多 agent 的增量：先不改 [硬] 契约

如果对端只在一条流里回一个会话，**7 种事件完全够，不要升版本**。
`refactor-constraints.md §1.3` 把事件集列为 [硬] 契约，没有真实事件流作依据就去改，等于用想象换一次全量适配。

只有在「远程内部派生多个 agent，且 UI 要显示层级」被确认为需求时，才评估下列增量：

| 增量 | 形态 | 用途 |
|---|---|---|
| 事件归属 | `agentId` / `parentAgentId` 加到 text / tool_* / usage / error | 工具轨迹不再平铺，能看出父子 |
| 成本归属 | `usage.scope: "step" \| "agent" \| "session"` | 定位「这次会话的钱花在哪个 agent」 |
| 能力细化 | `capabilities.tools` 从 `boolean` 扩成 `boolean \| string[]` | §4 的「不支持就灰掉并注明原因」才有数据支撑 |

（`seq` 不在这张表里：它属于流式会话的基础要求，已在 §12.2 列出。）

这四项都是**加可选字段、不加新种类**，按 §2 铁律 1 的字面不需要升版本——旧消费者忽略未知字段即可。

真正需要升版本的是「加新事件种类」。例如想让 UI 直接看到 `agent_start` / `agent_end`，而不是从
`tool_call` 里猜出子 agent 生命周期：那要先按铁律 1 问「能不能映射到已有种类」。映射成
`tool_call{ name: "hub_agent_spawn" }` 是能跑的，但它把「工具」和「agent 边界」混成一件事，
UI 得特判某个工具名——这正是 §4 禁止的「按名字分支」，只是换了个位置。这种就属于映射不了。

一旦确认要升，同步放宽 §5：从「版本不一致就拒绝启动」改成「主版本不同才拒绝，次版本增量忽略」。
这一条现在不改，因为对端都还是 v1，改了也没有被测到的机会。

### 12.5 对接步骤

与 §10 完全一致，不额外发明流程：

1. 录一份真实交互 → `test/fixtures/agent/remote.sse.txt`
2. 复制 `providers/_template.mjs` → `remote.mjs`
3. 归一化后与 `expected.events.json` 对齐
4. `node --test test/agent-conformance.test.mjs` 全绿（§9 那 5 条）
5. 设置页能选中、握手返回 `ok`

改动量仍是「1 个新文件 + 1 行注册 + 1 份 fixture」，上层零改动。

---

## 13. 实现进度（2026-11-07）

已落地（sidecar 侧）：

| 文件 | 内容 |
|---|---|
| `sidecar/agent/contract.mjs` | 7 种事件、`CONTRACT_VERSION`、结构校验、铁律校验（`validateTimeline`）、`joinText` / `sumCost` / `toolTrace` |
| `sidecar/agent/provider.mjs` | Provider / StartRequest / Handshake 的类型注释，**没有实现** |
| `sidecar/agent/providers/registry.mjs` | 注册表：数组顺序就是阶梯顺序 |
| `sidecar/agent/providers/replay.mjs` | 回放 `sidecar/agent/fixtures/replay.jsonl`；`attribution() = { real: false }` |
| `sidecar/agent/providers/claude-cli.mjs` | 本机 claude 的翻译层 + 进程层；**只验到错误路径，见下** |
| `sidecar/agent/providers/remote.mjs` | 空实现：一律 `E_REMOTE_NOT_CONFIGURED` / `E_REMOTE_NOT_IMPLEMENTED` |
| `sidecar/agent/providers/_template.mjs` | 接入骨架，**故意不注册** |
| `sidecar/agent/ladder.mjs` | `handshake()` + `resolveAgent()`，产出「用了谁 + 为什么」 |
| `sidecar/agent/tools.mjs` | 4 个只读工具，统一脱敏 + 32KB 截断 |
| `sidecar/agent/session.mjs` | **会话投影**：事件流 → 界面可直接摆的事实；`validateSession` 从 `events` 重算比对 |
| `sidecar/agent/status.mjs` | **握手状态报告**：每个 provider 能否用、为什么不能、归属是什么；`validateAgentStatus` 拦「选中了不可用的」 |
| `sidecar/cli/config.mjs` | `~/.pgh/config.json` 的唯一读写入口；写偏好只动一个键 |
| `sidecar/cli/commands/agent.mjs` | `pgh agent list / handshake / status / use / run / session / tool` |

### 13.1 两条设计选择的理由

**违规标识与 Rust 同名。** `contract.mjs` 的 `started_first` / `started_once` /
`tool_call_paired` / `tool_result_paired` / `error_needs_done` 与
`crates/hub-agent/src/event.rs` 的 `rule` 字面量逐字相同。同一份事件流，两边必须
给出同一份诊断 —— 否则「同一套契约」只是说法。`agent-contract.test.mjs` 里有一条
测试专门盯这个集合。

**谁能用由 provider 自己说。** `probe()` 回答「我能不能用」，`attribution()` 回答
「我产出的是不是真实分析」。`ladder.mjs` 不判断名字，`check-boundaries.mjs` 的
「不许 `provider === "x"`」门禁因此仍然漂亮地通过 —— 加第四个 provider 时，
阶梯与门禁都不用改。

### 13.2 没做到的事，写在这里

1. **claude-cli 只验到错误路径。** 开发机装了 `claude`（v2.1.319）但**没登录**，
   于是真实跑出来的流是「`Not logged in · Please run /login` + usage(0/0) + done(error)」——
   这段是真的端到端，翻译层与收尾都没问题（`pgh agent session` 走阶梯时实际跑过）。
   缺的是**成功路径**：`sidecar/test/fixtures/agent/claude-cli.stream.jsonl` 仍是
   按公开格式**手写**的样例，不是真实录制。验证路径：登录后跑一次
   `pgh agent session --provider claude-cli --prompt "..." --json`，用它替换该 fixture。
2. **remote 是空壳。** 对端不存在，所以它只会失败，理由分别是「未配置」与「协议未接入」。
   故意不发请求 —— 一个没有对端的 HTTP 客户端会把「服务没上线」伪装成「网络抖了一下」。
3. **工具面还没有接进 provider。** 4 个工具能通过 `pgh agent tool` 单独验证，
   但 provider 自己没有工具回路（模型请求工具 → 内核执行 → 回填）。
   现在的约定是「工具回路归 provider 自己」，`_template.mjs` 里写明了这条。
   接真实服务时若发现不适合，再改接口 —— 现在没有第二个实现，改了也无从验证。
4. **设置页只读。** provider 状态、握手结果与「为什么不是更前面的那个」都做了（§13.5），
   但窗口里没有可点的切换控件 —— M2 的 UI 层只有「画树」一条路径。切换入口现在是
   `pgh agent use <id|auto>`。任务列表仍读 `agent/tasks.mjs` 的投影，没有按会话回填耗时/步数
   （事件契约没有时间戳，回填不了耗时；这一层要在契约 v2 讨论）。

### 13.3 验证方式

```bash
pgh agent list                    # 三个 provider 各自的握手结论
pgh agent handshake               # 按配置/阶梯握手，看降到了哪一层、为什么
pgh agent status                  # 探一遍全部并落盘 ~/.pgh/agent/status.json（设置页读这份）
pgh agent use replay              # 写偏好；不可用的 provider 默认拒绝，--force 才写
pgh agent run --prompt "..."      # 跑一次，事件流打到 stdout（--json 逐行）
pgh agent session --prompt "..."  # 跑一次并落盘会话投影（UI 读这份）
pgh agent tool rule_lookup --args '{"ruleId":"listing.title.absolute_terms"}'
```

本机实测：`remote` 与 `claude-cli` 都握手失败并给出原因，自动降到 `replay`，
`run` 输出 11 个事件 / 2 次工具 / 成本显示「—」（不是 0）。

---

## 13.4 会话投影：UI 到底读什么（2026-11-07 第二刀）

### 为什么需要这一层

界面上「AI 调了 4 次工具、其中 1 次失败、花了 $0.02」这句话，在此之前来自
`fixtures/task-detail.json` 里手写的 `thought.tools` —— 它写得像真的，但没有任何东西量过它。
这比「没有数据」更糟：用户会拿它做判断。

现在分成两件东西：

| | 是什么 | 谁产生 | 谁读 |
|---|---|---|---|
| `events` | 发生过什么（7 种封闭事件，原样） | provider 的事件流 | 校验器、审计 |
| `timeline` | 界面怎么摆（合并后的段落 / 工具行 / 错误行） | `projectSession()` 从 events 算 | UI |

两者一起落盘到 `~/.pgh/agent/session.json`（fixture 是 `GovernanceHub/fixtures/agent-session.json`）。
`validateSession()` 会**从 `events` 重算一遍 `timeline` 逐字段比对**，不一致就报
`E_SESSION_TIMELINE_DRIFT` —— 所以「投影手写」这件事有机器拦着，不靠自觉。
这和快照里 `findings` 由 `evaluate()` 现算是同一个套路。

### 三条比契约校验更严的规矩

1. **不许丢事件。** `validateTimeline` 对未知类型是「忽略并计数」（流式场景必须如此，
   否则一个多余心跳就能打断整条流）。但存档时把不认识的事件悄悄丢掉，等于交出一份
   「看起来完整、其实删过」的记录，所以投影层直接拒绝。
2. **必须有起点和终点。** 没有 `started` 拿不到会话身份（`validateTimeline` 只在
   text / tool_call 之前才查这条，一条只有 `done` 的流它不拦）；没有 `done` 的流
   存下来下次打开还是转圈。
3. **不知道的要保持不知道。** 三处：`durationMs: null`（契约 v1 没有时间戳）、
   `usage: null`（provider 没上报）、`costUsd: null`（拿不到成本）。UI 分别显示
   「耗时未记录 / 用量未上报 / 成本 —」，**不许**落成 0。工具行的 `ok: null` 同理，
   表示「没见过结果」，不是「失败」。

### UI 侧

| 文件 | 改动 |
|---|---|
| `crates/hub/src/models/session.rs` | 会话模型。`Step` 把 `kind` 收成四种语义，未知类型落到 `Unknown` 并**显示出来** |
| `crates/hub/src/state/store.rs` | 多读一份 `agent-session.json`；读不到就是 `None`，不是错误 |
| `crates/hub/src/features/task_detail.rs` | 折叠条改读 `timeline`；没有会话时给空状态，**不回落到旧的手写轨迹** |
| `crates/hub/src/ui/kit.rs` | `tool_trace_row` 的 `ok` 改成三态（成功 / 失败 / 未返回） |

归属行是这一屏最容易看错的地方：`[回放] 回放数据，不是真实分析 · replay · 正常结束 ·
输入 1280 / 输出 96 token · 成本 — · 契约 v1`。徽章带文字，不靠颜色；
免责原话**照抄 provider 的 `attribution().label`**，不改写成「模拟」之类的委婉说法。

还有一个发现：`claude-cli` 未登录时给出 `done(error)` 却**没有 error 事件**。
契约没禁止（`error_needs_done` 只规定 error 之后必须有 done），但界面不能只显示
「错误结束」了事 —— 所以 `has_unexplained_error()` 会在这种情况下明说
「适配器没给原因，排查只能看上游日志」。要不要把「done(error) 必须配 error 事件」
写进契约 v2，等接第二个真实服务时再定。

---

## 13.5 设置页：状态报告与配置链（2026-11-07 第三刀）

### 为什么是一份文件，不是一次调用

设置页要答三个问题：**现在用的是谁 / 为什么不是更前面的那个 / 这次产出算不算真实分析。**

如果让窗口去跑 `pgh agent list`，这三件事就会在终端与窗口里各算一遍 —— 和
「面板数字只能算一次」（`ui-ia.md §5`）是同一条规矩，只是对象换成了判断而不是数字。

所以新增 `pgh agent status`：探一遍注册表里的每个 provider，把结论落成
`~/.pgh/agent/status.json`（0600）。UI 读这份，**不探测、不判断名字**。

```json
{
  "schemaVersion": 1,
  "contractVersion": 1,
  "preferred": null,
  "selected": "replay",
  "degraded": true,
  "reason": "回放数据，不是真实分析",
  "providers": [
    { "id": "remote", "ok": false, "reason": "远程 hub 未配置（…）", "selected": false },
    { "id": "claude-cli", "ok": false, "reason": "本机没有 claude 命令（…）", "selected": false },
    { "id": "replay", "ok": true, "attribution": { "real": false, "label": "回放数据，不是真实分析" }, "selected": true }
  ]
}
```

四条校验（`validateAgentStatus`，落盘前跑），每条都对应一个会被用户看见的谎：

1. 握手失败的 provider **必须给原因** —— 只画一个叉等于没解释；
2. `attribution.real === false` 的**必须给 label** —— 回放不许装成默认值；
3. `selected` 指向的那条**必须握手成功**，且与各行的 `selected` 标记一致；
4. `degraded === true` 时**必须有 reason**。

### `degraded` 不是「发生过降级」

它只表示**这次产出不能当真实分析**。阶梯跳过了 remote 但选中的是 claude-cli（真服务）时，
`degraded` 是 `false`，跳过原因在 `reason` 里。这两个信息界面分开摆：

- 顶部徽章：`真实分析` / `回放` / `未声明`（三态，未声明不借用回放的颜色）
- 原因行：sidecar 的结论 + 逐条「X 不可用：…」

原因行与 headline 去重：replay 的 `reason` 就是它的 `label`，同一句话说两遍会被读成
两个独立的问题（CLI 的 `runSession` 早就是这么处理的，这里保持一致）。

### 配置链：在这一刀之前其实没接上

`pgh agent` 的 `config` 一直是硬编码的 `{}` —— 也就是说 `agent.remote.endpoint` 永远读不到，
`~/.pgh/config.json` 写了等于没写。现在：

| 动作 | 落点 |
|---|---|
| 读 | `cli/config.mjs` 的 `readConfig`：文件不存在算正常，坏 JSON **报错**（当空配置会让偏好悄悄失效） |
| 偏好 | `agent.preferred`；`pgh agent use <id>` 写，`use auto` 删键（不是写 `null`） |
| 保留 | 写偏好只动这一个键；`agent.remote` 的 endpoint 与凭据原样不动 |

`use` 默认**拒绝**写入握不上手的 provider：指定 preferred 之后阶梯不退让
（`ladder.mjs` 开头写明了理由），选一个连不上的服务等于把助手配成不可用。
要硬写就 `--force`，终端会说清「会话会直接报错，不会降级到别的服务」。

配置坏掉或 preferred 指向不存在的 id 时，`agent` 子命令退出码 2 并给出改法
（`pgh agent use auto`）—— 不让阶梯报一句「没有可用服务」了事。

### UI 侧

| 文件 | 改动 |
|---|---|
| `crates/hub/src/models/agent_status.rs` | 宽容解码 + 文案；`attribution` 是 `Option`，缺了就写「未声明」 |
| `crates/hub/src/state/store.rs` | 多读一份 `agent-status.json`（真窗口读 `~/.pgh/agent/status.json`） |
| `crates/hub/src/features/settings.rs` | 设置面板：headline / provider 列表 / 两条限制 |
| `crates/hub/src/features/mod.rs` | `View::Settings`，快照 `11-settings.json`（10 份 → 11 份） |
| `crates/hub/src/ui/kit.rs` | 拆出 `panel_with_note`：设置页的角标是「只读 · 切换走 CLI」，不是 `只读` |

三条渲染规矩：

1. **握手失败的 provider 不展开能力行。** 那时的 `capabilities` 是地板值（全 false），
   显示出来等于说「它不支持」，而事实是「不知道」。
2. **归属三态**：真实 / 回放 / 未声明。`attribution` 缺失时报「未声明产出归属」，
   不替适配器说「回放」。
3. **两条限制写在界面上**：握手通过只说明适配器与命令可用、**不代表账号已登录**；
   指定 provider 之后阶梯不退让。不写这两句，设置页就会让人以为「绿灯 = 能用」。

### 仍然没做到的

- **握手 ≠ 登录。** `claude-cli` 的 `probe()` 只查 PATH（不执行 `--version`，避免副作用），
  所以「装了但没登录」在设置页是绿灯。真实失败只能从会话事件流里看 ——
  这是 `probe()` 的设计代价，写在界面上而不是藏起来。
- **窗口里没有可点的切换控件。** 切换入口是 `pgh agent use`。等 UI 有交互层再补，
  现在画一个点了没反应的分段控件比不画更糟。
