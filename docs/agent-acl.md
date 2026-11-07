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

## 13. 实现进度（2026-11-07，M2 第一刀）

已落地（sidecar 侧）：

| 文件 | 内容 |
|---|---|
| `sidecar/agent/contract.mjs` | 7 种事件、`CONTRACT_VERSION`、结构校验、铁律校验（`validateTimeline`）、`joinText` / `sumCost` / `toolTrace` |
| `sidecar/agent/provider.mjs` | Provider / StartRequest / Handshake 的类型注释，**没有实现** |
| `sidecar/agent/providers/registry.mjs` | 注册表：数组顺序就是阶梯顺序 |
| `sidecar/agent/providers/replay.mjs` | 回放 `sidecar/agent/fixtures/replay.jsonl`；`attribution() = { real: false }` |
| `sidecar/agent/providers/claude-cli.mjs` | 本机 claude 的翻译层 + 进程层；**端到端未验证，见下** |
| `sidecar/agent/providers/remote.mjs` | 空实现：一律 `E_REMOTE_NOT_CONFIGURED` / `E_REMOTE_NOT_IMPLEMENTED` |
| `sidecar/agent/providers/_template.mjs` | 接入骨架，**故意不注册** |
| `sidecar/agent/ladder.mjs` | `handshake()` + `resolveAgent()`，产出「用了谁 + 为什么」 |
| `sidecar/agent/tools.mjs` | 4 个只读工具，统一脱敏 + 32KB 截断 |
| `sidecar/cli/commands/agent.mjs` | `pgh agent list / handshake / run / tool` |

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

1. **claude-cli 端到端未验证。** 开发机没装 `claude`，`translateLine` 的映射依据的是
   公开输出格式，`sidecar/test/fixtures/agent/claude-cli.stream.jsonl` 是**手写样例，
   不是真实录制**。它证明了「给定这样的行，翻译与收尾是对的」（进程层也用
   `fake-claude.mjs` 跑过真 spawn），**没有**证明真实 claude 输出长这样。
   验证路径：在有 claude 的机器上录一份真实交互替换该文件，再跑 conformance。
2. **remote 是空壳。** 对端不存在，所以它只会失败，理由分别是「未配置」与「协议未接入」。
   故意不发请求 —— 一个没有对端的 HTTP 客户端会把「服务没上线」伪装成「网络抖了一下」。
3. **工具面还没有接进 provider。** 4 个工具能通过 `pgh agent tool` 单独验证，
   但 provider 自己没有工具回路（模型请求工具 → 内核执行 → 回填）。
   现在的约定是「工具回路归 provider 自己」，`_template.mjs` 里写明了这条。
   接真实服务时若发现不适合，再改接口 —— 现在没有第二个实现，改了也无从验证。
4. **UI 没接。** 任务详情仍读 M0 的静态投影（`agent/tasks.mjs`），没有消费事件流。
   设置页的 provider 选择与握手结果也没做。这是 M2 的下一刀。

### 13.3 验证方式

```bash
pgh agent list                    # 三个 provider 各自的握手结论
pgh agent handshake               # 走阶梯，看降到了哪一层、为什么
pgh agent run --prompt "..."      # 跑一次，事件流打到 stdout（--json 逐行）
pgh agent tool rule_lookup --args '{"ruleId":"listing.title.absolute_terms"}'
```

本机实测：`remote` 与 `claude-cli` 都握手失败并给出原因，自动降到 `replay`，
`run` 输出 11 个事件 / 2 次工具 / 成本显示「—」（不是 0）。
