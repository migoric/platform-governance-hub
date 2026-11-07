// 会话投影的测试（agent/session.mjs）。
//
// 这一组测试守的是「界面读到的数字必须有出处」：
//   · 投影只能从事件流算出来，不能手写（validateSession 从 events 重算比对）
//   · 拿不到的（耗时 / 成本 / 工具结果）必须保持「不知道」，不能被默认值填成 0 或 false
//   · 契约不合法的流一律拒绝落盘 —— 存档时没有「先忽略、以后再看」

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { Event } from "../agent/contract.mjs"
import { createProvider } from "../agent/providers/registry.mjs"
import {
  SessionProjectionError,
  SessionValidationError,
  assertValidSession,
  projectSession,
  projectTimeline,
  validateSession,
} from "../agent/session.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, "..", "..", "GovernanceHub", "fixtures", "agent-session.json")

const REPLAY_ATTRIBUTION = { real: false, label: "回放数据，不是真实分析" }

async function collect(provider, prompt = "x") {
  const events = []
  for await (const event of provider.start({ prompt })) events.push(event)
  return events
}

/** 一份最小合规流，用来逐条破坏某一处。 */
function baseEvents() {
  return [
    { kind: Event.STARTED, sessionId: "s1", provider: "fixture", capabilities: { tools: true } },
    { kind: Event.TEXT, delta: "甲" },
    { kind: Event.TEXT, delta: "乙" },
    { kind: Event.TOOL_CALL, callId: "c1", name: "snapshot_query", args: {} },
    { kind: Event.TOOL_RESULT, callId: "c1", ok: true, summary: "1 个 item", bytes: 10 },
    { kind: Event.TEXT, delta: "丙" },
    { kind: Event.USAGE, inputTokens: 10, outputTokens: 2, costUsd: null },
    { kind: Event.DONE, reason: "ok" },
  ]
}

const codes = (session) => validateSession(session).errors.map((e) => e.code)

// ── 投影 ────────────────────────────────────────────────────────────

test("相邻增量合并成一段，工具行留在调用发生的位置", () => {
  const timeline = projectTimeline(baseEvents())
  assert.deepEqual(
    timeline.map((i) => i.kind),
    ["text", "tool", "text"],
    "甲乙 应合成一段，丙 单独一段",
  )
  assert.equal(timeline[0].text, "甲乙")
  assert.equal(timeline[1].name, "snapshot_query")
  assert.equal(timeline[1].ok, true)
})

test("工具结果晚到也回填到调用那一行，顺序按调用而不是按返回", () => {
  const events = [
    { kind: Event.STARTED, sessionId: "s", provider: "p", capabilities: {} },
    { kind: Event.TOOL_CALL, callId: "a", name: "first" },
    { kind: Event.TOOL_CALL, callId: "b", name: "second" },
    { kind: Event.TOOL_RESULT, callId: "b", ok: true, summary: "B 回来了", bytes: 2 },
    { kind: Event.TOOL_RESULT, callId: "a", ok: false, summary: "A 失败了", bytes: 0 },
    { kind: Event.DONE, reason: "ok" },
  ]
  const timeline = projectTimeline(events)
  assert.deepEqual(timeline.map((i) => i.name), ["first", "second"]);
  assert.equal(timeline[0].ok, false);
  assert.equal(timeline[1].ok, true);
})

test("没等到结果时 ok 是 null，不是 false", () => {
  const item = projectTimeline([{ kind: Event.TOOL_CALL, callId: "c", name: "n" }])[0]
  assert.equal(item.ok, null, "「没见过结果」和「失败了」不是一回事")
  assert.equal(item.bytes, null)
})

test("usage 累加，成本拿不到保持 null", () => {
  const events = baseEvents()
  events.splice(7, 0, { kind: Event.USAGE, inputTokens: 5, outputTokens: 1, costUsd: null })
  const session = projectSession(events, { prompt: "p", attribution: REPLAY_ATTRIBUTION })
  assert.equal(session.usage.inputTokens, 15)
  assert.equal(session.usage.outputTokens, 3)
  assert.equal(session.usage.costUsd, null, "全是 null 就是拿不到，不是 0")
})

test("没有 usage 事件时会话不编一份用量", () => {
  const events = baseEvents().filter((e) => e.kind !== Event.USAGE)
  assert.equal(projectSession(events, { attribution: REPLAY_ATTRIBUTION }).usage, null)
})

test("耗时一律未知：契约里没有时间戳就不许编", () => {
  const session = projectSession(baseEvents(), { attribution: REPLAY_ATTRIBUTION })
  assert.equal(session.durationMs, null)
})

// ── 拒绝落盘 ────────────────────────────────────────────────────────

test("违反契约的流拒绝投影，并说清是哪条铁律", () => {
  const events = baseEvents()
  delete events[0] // 去掉 started
  assert.throws(
    () => projectSession(events, { attribution: REPLAY_ATTRIBUTION }),
    (error) => {
      assert.ok(error instanceof SessionProjectionError)
      assert.ok(error.details.some((d) => d.rule === "started_first"), JSON.stringify(error.details))
      return true
    },
  )
})

test("没有 done 的流拒绝存档", () => {
  const events = baseEvents().filter((e) => e.kind !== Event.DONE)
  assert.throws(
    () => projectSession(events, { attribution: REPLAY_ATTRIBUTION }),
    /没有 done/,
  )
})

test("没给归属声明就拒绝：界面会默认把它当真实分析", () => {
  assert.throws(() => projectSession(baseEvents(), {}), SessionProjectionError)
  assert.throws(() => projectSession(baseEvents(), { attribution: { real: "no" } }), SessionProjectionError)
})

// ── 校验：投影不许手写 ──────────────────────────────────────────────

test("手改 timeline 会被重算比对抓出来", () => {
  const session = projectSession(baseEvents(), { attribution: REPLAY_ATTRIBUTION })
  session.timeline[0].text = "我改过的结论"
  assert.ok(codes(session).includes("E_SESSION_TIMELINE_DRIFT"))
})

test("删掉一段 timeline 也会被抓出来", () => {
  const session = projectSession(baseEvents(), { attribution: REPLAY_ATTRIBUTION })
  session.timeline.pop()
  session.stepCount = session.timeline.length // 计数改对也没用
  assert.ok(codes(session).includes("E_SESSION_TIMELINE_DRIFT"))
})

test("计数、契约版本、归属标签都要自洽", () => {
  const session = projectSession(baseEvents(), { attribution: REPLAY_ATTRIBUTION })

  const wrongCount = { ...session, eventCount: 99 }
  assert.ok(codes(wrongCount).includes("E_SESSION_EVENT_COUNT"))

  const staleContract = { ...session, contractVersion: 0 }
  assert.ok(codes(staleContract).includes("E_SESSION_CONTRACT_VERSION"))

  const noLabel = { ...session, attribution: { real: false, label: "" } }
  assert.ok(codes(noLabel).includes("E_SESSION_ATTRIBUTION_LABEL"), "回放必须自报家门")
})

test("工具计数与时间线不符要报出来", () => {
  const session = projectSession(baseEvents(), { attribution: REPLAY_ATTRIBUTION })
  assert.ok(codes({ ...session, toolCount: 7 }).includes("E_SESSION_TOOL_COUNT"))
})

test("合法会话通过校验，且校验函数不修改输入", () => {
  const session = projectSession(baseEvents(), { attribution: REPLAY_ATTRIBUTION })
  const before = JSON.stringify(session)
  assert.deepEqual(validateSession(session).errors, [])
  assert.doesNotThrow(() => assertValidSession(session))
  assert.equal(JSON.stringify(session), before)
})

// ── 落盘的 fixture 必须真的是 replay 跑出来的 ────────────────────────
//
// 这是「界面接入事件」这条需求的硬保证：fixture 不是手写的，而是这条命令的产物。
// 谁把它改成手写，这条测试就红。注意必须显式指定 replay —— 走阶梯的话，
// 机器上装了 claude 的同事会得到另一份结果，测试就变成「谁的机器」。

test("提交的 agent-session.json 等于 replay 现跑的结果", async () => {
  const committed = JSON.parse(readFileSync(FIXTURE, "utf8"))
  const provider = createProvider("replay")
  const events = await collect(provider, committed.prompt)
  const fresh = projectSession(events, { prompt: committed.prompt, attribution: provider.attribution() })
  assert.deepEqual(committed, fresh, "fixture 与重跑结果不一致：它被手改过，或者 replay.jsonl 变了")
})

test("提交的会话文件本身必须通过校验", () => {
  const committed = JSON.parse(readFileSync(FIXTURE, "utf8"))
  assert.deepEqual(validateSession(committed).errors, [])
})

test("fixture 的归属是回放，且成本是未知", () => {
  const committed = JSON.parse(readFileSync(FIXTURE, "utf8"))
  assert.equal(committed.attribution.real, false)
  assert.match(committed.attribution.label, /回放/)
  assert.equal(committed.usage.costUsd, null)
})

// ── 结构校验的每条错误分支 ───────────────────────────────────────────
//
// 这些分支平时跑不到，但一旦契约外的文件被读进来，它们就是唯一挡在
// 「界面拿半截数据渲染」前面的东西。

const validSession = () => projectSession(baseEvents(), { attribution: REPLAY_ATTRIBUTION })

test("顶层不是对象、schema 版本不对、缺 provider / sessionId 都要报", () => {
  assert.deepEqual(codes("不是对象"), ["E_SESSION_SHAPE"])

  const session = validSession()
  assert.ok(codes({ ...session, schemaVersion: 2 }).includes("E_SESSION_SCHEMA_VERSION"))
  assert.ok(codes({ ...session, provider: "" }).includes("E_SESSION_PROVIDER"))
  assert.ok(codes({ ...session, sessionId: "" }).includes("E_SESSION_ID"))
})

test("归属声明缺失或类型不对都要报", () => {
  const session = validSession()
  assert.ok(codes({ ...session, attribution: undefined }).includes("E_SESSION_ATTRIBUTION"))
  assert.ok(codes({ ...session, attribution: { real: "true" } }).includes("E_SESSION_ATTRIBUTION"))
})

test("events 不是数组时直接停：没有事实就无法重算投影", () => {
  const session = validSession()
  const { errors } = validateSession({ ...session, events: "坏了" })
  assert.deepEqual(errors.map((e) => e.code), ["E_SESSION_EVENTS"])
})

test("events 内部违约会带到校验结果里", () => {
  const session = validSession()
  const broken = [session.events[1], ...session.events.slice(2)] // 去掉 started
  const codesOut = codes({ ...session, events: broken, eventCount: broken.length })
  assert.ok(codesOut.includes("E_SESSION_EVENTS_INVALID"), JSON.stringify(codesOut))
})

test("doneReason 必须在封闭集里", () => {
  assert.ok(codes({ ...validSession(), doneReason: "finished" }).includes("E_SESSION_DONE"))
})

test("timeline 不是数组要报", () => {
  assert.ok(codes({ ...validSession(), timeline: "坏了" }).includes("E_SESSION_TIMELINE"))
})

test("耗时只能是 null 或非负整数", () => {
  assert.ok(codes({ ...validSession(), durationMs: -1 }).includes("E_SESSION_DURATION"))
})

test("usage 的形状与 token 类型都要校验", () => {
  const session = validSession()
  assert.ok(codes({ ...session, usage: "免费" }).includes("E_SESSION_USAGE"))
  assert.ok(codes({ ...session, usage: { inputTokens: -1, outputTokens: 0, costUsd: null } }).includes("E_SESSION_USAGE"))
  assert.ok(codes({ ...session, usage: { inputTokens: 0, outputTokens: 0, costUsd: "免费" } }).includes("E_SESSION_USAGE_COST"))
})

test("拿得到成本时累加，不把数字吞成 null", () => {
  const events = baseEvents()
  events.splice(7, 0, { kind: Event.USAGE, inputTokens: 1, outputTokens: 1, costUsd: 0.25 })
  const session = projectSession(events, { attribution: { real: true, label: "本机" } })
  assert.equal(session.usage.costUsd, 0.25)
  assert.equal(session.attribution.real, true)
  assert.deepEqual(validateSession(session).errors, [], "真实分析不需要免责标签")
})

test("残缺事件与非字符串字段不会把投影带崩", () => {
  // 直接调 projectTimeline（不经过铁律校验）：畸形输入只能被忽略，不能抛
  const timeline = projectTimeline([
    null,
    "字符串不是事件",
    { kind: Event.TEXT, delta: 42 },
    { kind: Event.TOOL_CALL },
    { kind: Event.TOOL_RESULT, callId: "no-such-call", ok: true },
    { kind: Event.ERROR },
  ])
  assert.deepEqual(timeline.map((i) => i.kind), ["tool", "error"])
  assert.equal(timeline[0].callId, "", "缺 callId 落成空串，不是 undefined")
  assert.equal(timeline[0].ok, null)
  assert.equal(timeline[1].code, "")
  assert.equal(timeline[1].retryable, false)
  assert.deepEqual(projectTimeline("不是数组"), [])
})

test("没有 started 的流拒绝存档：会话没有身份就没有出处", () => {
  // 一条只有 done 的流是「合法但无用」：铁律不拦，投影必须拦
  assert.throws(
    () => projectSession([{ kind: Event.DONE, reason: "ok" }], { attribution: REPLAY_ATTRIBUTION }),
    /没有 started/,
  )
})

test("空流的报错说清缺哪一段，而不是「格式不对」", () => {
  assert.throws(() => projectSession([], { attribution: REPLAY_ATTRIBUTION }), /没有 started/)
  assert.throws(
    () => projectSession([baseEvents()[0]], { attribution: REPLAY_ATTRIBUTION }),
    /没有 done/,
  )
})
