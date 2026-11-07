// 适配器合规测试 —— 接新 agent 服务的人只需要让这几条过（agent-acl §9）。
//
// 这个文件刻意不读 UI、不读规则引擎：适配器的正确性只跟「事件流」有关。
// 一旦这里出现业务断言，接新服务的人就得理解整个系统才能加一个 provider。

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { Event, joinText, validateTimeline } from "../agent/contract.mjs"
import { listProviderIds, createProvider } from "../agent/providers/registry.mjs"
import { loadEvents } from "../agent/providers/replay.mjs"
import { translateLine, consumeLines } from "../agent/providers/claude-cli.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, "..", "agent", "fixtures")

/** 收集一个 provider 的完整事件流。 */
async function collect(provider, req = { prompt: "测试" }) {
  const events = []
  for await (const event of provider.start(req)) events.push(event)
  return events
}

/** 能在本地真实起一次会话的 provider —— 其余的只能测翻译层（见文件末尾）。 */
const RUNNABLE = ["remote", "replay"]

test("每个 provider 都有同名 fixture：不许「先上线再补样例」", () => {
  for (const id of listProviderIds()) {
    assert.doesNotThrow(() => readFileSync(join(FIXTURES, `${id}.jsonl`), "utf8"), `${id} 缺 fixture`)
  }
})

test("conformance 1：回放 fixture 的事件序列与文件一致", () => {
  const expected = loadEvents(join(FIXTURES, "replay.jsonl"))
  const provider = createProvider("replay")
  return collect(provider).then((events) => {
    assert.deepEqual(events, expected)
  })
})

test("conformance 4：每条事件流都不违反铁律，error 后面必须有 done", async () => {
  for (const id of RUNNABLE) {
    const events = await collect(createProvider(id))
    assert.deepEqual(validateTimeline(events), [], `${id} 的事件流违反契约`)
    assert.equal(events[0].kind, Event.STARTED, `${id} 的第一个事件必须是 started`)
    assert.equal(events.at(-1).kind, Event.DONE, `${id} 最后必须是 done`)
  }
})

test("conformance 3：缺字段走默认，不抛错", async () => {
  // replay 的 fixture 里 usage.costUsd 是 null —— 不能因此崩，也不能当 0
  const events = await collect(createProvider("replay"))
  const usage = events.find((e) => e.kind === Event.USAGE)
  assert.equal(usage.costUsd, null)

  // 工具结果缺 bytes / summary 也合法
  const state = { callIds: new Map(), nextId: () => "c1" }
  state.callIds.set("toolu_x", "c1")
  const out = translateLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_x" }] } }, state)
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, Event.TOOL_RESULT)
})

test("conformance 2：未知事件类型忽略并计数，不抛错", async () => {
  const state = { callIds: new Map(), nextId: () => "c1" }
  // 认不出的 type 返回空数组，绝不抛
  assert.deepEqual(translateLine({ type: "thinking_delta", text: "x" }, state), [])
  // 已知类型但结构残缺也不抛
  assert.deepEqual(translateLine({ type: "assistant" }, state), [])
  assert.deepEqual(translateLine({}, state), [])

  // 整条流里混进未知类型，只报 unknown_event，不影响其它判断
  const violations = validateTimeline([
    { kind: Event.STARTED, sessionId: "s", provider: "p", capabilities: {} },
    { kind: "heartbeat" },
    { kind: Event.DONE, reason: "ok" },
  ])
  assert.deepEqual(violations.map((v) => v.rule), ["unknown_event"])
})

test("conformance 5：取消 → done 的 reason 是 cancelled，且之后没有事件", async () => {
  const events = []
  const provider = createProvider("replay", { file: join(FIXTURES, "replay.jsonl"), delayMs: 1 })
  const iterator = provider.start({ prompt: "x" })[Symbol.asyncIterator]()

  // 拿两条就取消
  for (let i = 0; i < 2; i++) events.push((await iterator.next()).value)
  await provider.cancel()
  for (;;) {
    const { done, value } = await iterator.next()
    if (done) break
    events.push(value)
  }

  const doneEvents = events.filter((e) => e.kind === Event.DONE)
  assert.equal(doneEvents.length, 1, "收尾事件只许有一个")
  assert.equal(doneEvents[0].reason, "cancelled")
  assert.equal(events.at(-1).kind, Event.DONE)
})

// ── claude-cli：本机没有 claude，只能测翻译层 ──────────────────────────
// 这一段能证明的：给定适配器侧的逐行 JSON 输出，产出正确的事件序列。
// 它不能证明的：真实 claude 的输出一定长这样。后者要靠真实录制替换 fixture。

test("claude-cli 翻译层：样例 stream 归一化后事件序列正确", async () => {
  const raw = readFileSync(join(HERE, "fixtures", "agent", "claude-cli.stream.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("//"))
    .map((line) => JSON.parse(line))

  const state = { callIds: new Map(), nextId: () => `call-${state.callIds.size + 1}` }
  const events = [{ kind: Event.STARTED, sessionId: "s", provider: "claude-cli", capabilities: {} }]
  for (const line of raw) events.push(...translateLine(line, state))

  assert.deepEqual(
    events.map((e) => e.kind),
    [Event.STARTED, Event.TEXT, Event.TOOL_CALL, Event.TOOL_RESULT, Event.TEXT, Event.USAGE, Event.DONE],
  )
  assert.equal(joinText(events), "先把这个 SKU 读出来。标题里有 Best，命中绝对化用语。")
  // 外部 tool id 不许透出到事件里（铁律 3）
  assert.equal(events[2].callId, "call-1")
  assert.ok(!JSON.stringify(events).includes("toolu_sample_01"))
  // 成本来自 result 事件
  assert.equal(events.find((e) => e.kind === Event.USAGE).costUsd, 0.0031)
})

// ── claude-cli 的收尾逻辑 ─────────────────────────────────────────────
//
// 三条退出路径（正常 / 超时 / 取消）都必须有 done。少了任意一条，
// UI 的转圈就永远不停 —— 这是这一层最容易漏的错，所以逐条测。

async function* lineStream(...lines) {
  for (const line of lines) yield line
}

const freshState = () => ({ callIds: new Map(), nextId: (() => { let n = 0; return () => `call-${++n}` })() })

test("收尾：正常结束且已有 done 时，不再补第二条 done", async () => {
  const input = lineStream('{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":1,"output_tokens":1}}')
  const events = []
  for await (const e of consumeLines(input, freshState(), { isCancelled: () => false, failure: () => null })) events.push(e)
  assert.deepEqual(events.map((e) => e.kind), [Event.USAGE, Event.DONE])
})

test("收尾：进程没发 result 就断了，必须补 error + done", async () => {
  const input = lineStream('{"type":"assistant","message":{"content":[{"type":"text","text":"半句话"}]}}')
  const events = []
  for await (const e of consumeLines(input, freshState(), { isCancelled: () => false, failure: () => null })) events.push(e)
  assert.deepEqual(events.map((e) => e.kind), [Event.TEXT, Event.ERROR, Event.DONE])
  assert.equal(events[1].code, "E_NO_DONE")
  assert.deepEqual(validateTimeline([{ kind: Event.STARTED, sessionId: "s", provider: "claude-cli", capabilities: {} }, ...events]), [])
})

test("收尾：取消时补 done(cancelled)", async () => {
  const events = []
  let cancelled = false
  const input = (async function* () {
    yield '{"type":"assistant","message":{"content":[{"type":"text","text":"a"}]}}'
    cancelled = true
    yield '{"type":"assistant","message":{"content":[{"type":"text","text":"b"}]}}'
  })()
  for await (const e of consumeLines(input, freshState(), { isCancelled: () => cancelled, failure: () => null })) events.push(e)
  assert.equal(events.at(-1).kind, Event.DONE)
  assert.equal(events.at(-1).reason, "cancelled")
})

test("收尾：超时命中要给可重试的 error", async () => {
  const events = []
  for await (const e of consumeLines(lineStream(), freshState(), { isCancelled: () => false, failure: () => "timeout" })) events.push(e)
  assert.equal(events[0].code, "E_TIMEOUT")
  assert.equal(events[0].retryable, true)
  assert.equal(events.at(-1).reason, "error")
})

test("非 JSON 行与空行被跳过，不当成事件", async () => {
  const events = []
  const input = lineStream("", "  ", "正在思考…", '{"type":"result","subtype":"success","is_error":false}')
  for await (const e of consumeLines(input, freshState(), { isCancelled: () => false, failure: () => null })) events.push(e)
  // 只有 done，没有别的
  assert.deepEqual(events.map((e) => e.kind), [Event.DONE])
})

// ── claude-cli 的进程层：用假 CLI 跑真 spawn ──────────────────────────
//
// 这条测的是 start() 里的 spawn / readline / 收尾，不是翻译规则。
// 假 CLI 的 shebang 依赖 POSIX，Windows 上跳过（CI 的 windows 作业也不跑 sidecar）。

test("claude-cli 进程层：跑真进程也能产出合规事件流", { skip: process.platform === "win32" }, async () => {
  const { createClaudeCliProvider } = await import("../agent/providers/claude-cli.mjs")
  const provider = createClaudeCliProvider({
    command: join(HERE, "fixtures", "agent", "fake-claude.mjs"),
    timeoutMs: 20_000,
    firstTokenMs: 10_000,
  })

  const events = []
  for await (const event of provider.start({ prompt: "测试" })) events.push(event)

  assert.equal(events[0].kind, Event.STARTED)
  assert.equal(events.at(-1).kind, Event.DONE)
  assert.deepEqual(validateTimeline(events), [])
  assert.equal(joinText(events), "先看看数据。结论如上。")
  assert.equal(events.find((e) => e.kind === Event.USAGE).costUsd, 0.0002)
})

test("claude-cli 的探测：命令不存在时说清原因，存在时认得出来", async () => {
  const { createClaudeCliProvider, isInstalled } = await import("../agent/providers/claude-cli.mjs")

  const ghost = createClaudeCliProvider({ command: "definitely-not-a-real-command-xyz" })
  assert.equal(ghost.isInstalled(), false)
  const probe = await ghost.probe()
  assert.equal(probe.ok, false)
  assert.match(probe.reason, /definitely-not-a-real-command-xyz/)

  // 反过来的路径：node 自己一定在（否则这个测试跑不起来）
  assert.equal(isInstalled(process.execPath), true)

  const caps = await ghost.capabilities()
  assert.equal(caps.streaming, true)
  assert.equal(ghost.attribution().real, true)
  await ghost.cancel()
})
