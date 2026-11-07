import assert from "node:assert/strict"
import test from "node:test"

import {
  CAPABILITIES_FLOOR,
  CONTRACT_VERSION,
  DONE_REASONS,
  EVENT_KINDS,
  Event,
  joinText,
  normalizeCapabilities,
  sumCost,
  toolTrace,
  validateEvent,
  validateTimeline,
} from "../agent/contract.mjs"

const started = (over = {}) => ({
  kind: Event.STARTED,
  sessionId: "s1",
  provider: "replay",
  capabilities: { ...CAPABILITIES_FLOOR },
  ...over,
})

const rules = (events) => validateTimeline(events).map((v) => v.rule)

test("事件种类是封闭集，就这 7 种", () => {
  assert.deepEqual([...EVENT_KINDS].sort(), [
    "done",
    "error",
    "started",
    "text",
    "tool_call",
    "tool_result",
    "usage",
  ])
  assert.equal(CONTRACT_VERSION, 1)
  // 升版本意味着全部适配器一起改，这条测试是提醒，不是限制
  assert.deepEqual([...DONE_REASONS].sort(), ["cancelled", "error", "max_steps", "ok"])
})

test("契约版本是契约的一部分，改它要有意识", () => {
  assert.equal(typeof CONTRACT_VERSION, "number")
  assert.ok(CONTRACT_VERSION >= 1)
})

test("不在封闭集里的类型被指出，而不是静默丢弃", () => {
  const violations = validateTimeline([started(), { kind: "thinking", delta: "x" }])
  assert.deepEqual(violations.map((v) => v.rule), ["unknown_event"])
  assert.match(violations[0].detail, /thinking/)
})

test("文本只有 delta：拼接由消费方做", () => {
  const events = [started(), { kind: Event.TEXT, delta: "你" }, { kind: Event.TEXT, delta: "好" }]
  assert.equal(joinText(events), "你好")
  // 事件里没有整段字段，只有 delta
  assert.equal(validateEvent({ kind: Event.TEXT, text: "整段" }).length, 1)
})

test("tool_call 与 tool_result 必须按 callId 配对", () => {
  const ok = [
    started(),
    { kind: Event.TOOL_CALL, callId: "c1", name: "snapshot_query", args: {} },
    { kind: Event.TOOL_RESULT, callId: "c1", ok: true, summary: "", bytes: 1 },
  ]
  assert.deepEqual(rules(ok), [])

  const orphanResult = [started(), { kind: Event.TOOL_RESULT, callId: "c9", ok: true }]
  assert.deepEqual(rules(orphanResult), ["tool_result_paired"])

  const danglingCall = [started(), { kind: Event.TOOL_CALL, callId: "c1", name: "x" }]
  assert.deepEqual(rules(danglingCall), ["tool_call_paired"])
})

test("拿不到成本时是 null，不是 0", () => {
  const events = [
    started(),
    { kind: Event.USAGE, inputTokens: 10, outputTokens: 20, costUsd: null },
  ]
  assert.equal(sumCost(events), null, "不知道花了多少，不能显示成没花钱")

  events.push({ kind: Event.USAGE, inputTokens: 1, outputTokens: 2, costUsd: 0.25 })
  assert.equal(sumCost(events), 0.25)

  // 完全没有 usage 事件也是 null
  assert.equal(sumCost([started()]), null)
})

test("error 之后必须还有 done，否则转圈永远不停", () => {
  const bad = [started(), { kind: Event.ERROR, code: "E_X", message: "断线", retryable: true }]
  assert.deepEqual(rules(bad), ["error_needs_done"])

  bad.push({ kind: Event.DONE, reason: "error" })
  assert.deepEqual(rules(bad), [])
})

test("started 必须第一个，且只能有一个", () => {
  assert.deepEqual(rules([{ kind: Event.TEXT, delta: "x" }]), ["started_first"])
  assert.deepEqual(rules([started(), started()]), ["started_once"])
})

test("空时间线不算违规：还没开始不等于错", () => {
  assert.deepEqual(validateTimeline([]), [])
})

test("违规标识与 Rust 侧同名：两边对同一条时间线要给同一份诊断", () => {
  // 这组名字镜像 crates/hub-agent/src/event.rs 里的 rule 字面量
  const expected = new Set(["started_first", "started_once", "tool_call_paired", "tool_result_paired", "error_needs_done"])
  const produced = new Set(
    rules([
      { kind: Event.TEXT, delta: "x" },
      started(),
      started(),
      { kind: Event.TOOL_CALL, callId: "c1", name: "n" },
      { kind: Event.TOOL_RESULT, callId: "c2", ok: true },
      { kind: Event.ERROR, code: "E", message: "m", retryable: false },
    ]).filter((name) => name !== "unknown_event"),
  )
  assert.deepEqual([...produced].sort(), [...expected].sort())
})

test("能力声明缺键走地板值，多余的键丢掉", () => {
  assert.deepEqual(normalizeCapabilities(undefined), { ...CAPABILITIES_FLOOR })
  assert.deepEqual(normalizeCapabilities({ streaming: true, maxSteps: 4, 秘密字段: 1 }), {
    ...CAPABILITIES_FLOOR,
    streaming: true,
    maxSteps: 4,
  })
  // 不猜：没声明 tools 就是没有，不能当「大概是支持」
  assert.equal(normalizeCapabilities({ streaming: true }).tools, false)
})

test("工具轨迹按调用顺序给出，且能看出没有收尾的那次", () => {
  const trace = toolTrace([
    started(),
    { kind: Event.TOOL_CALL, callId: "c1", name: "snapshot_query", args: {} },
    { kind: Event.TOOL_RESULT, callId: "c1", ok: true, bytes: 12 },
    { kind: Event.TOOL_CALL, callId: "c2", name: "rule_lookup", args: {} },
  ])
  assert.deepEqual(trace, [
    { callId: "c1", name: "snapshot_query", ok: true, bytes: 12 },
    { callId: "c2", name: "rule_lookup", ok: null, bytes: null },
  ])
})

// ── 结构校验的每条错误分支 ───────────────────────────────────────────
//
// 这些分支平时跑不到，但一旦适配器发来残缺事件，它们就是唯一挡在
// 「UI 拿半截数据渲染」前面的东西。逐条测，别靠「大概不会发生」。

const fieldErrors = (event) => validateEvent(event).map((e) => e.code)

test("started 缺 sessionId / provider / capabilities 都要报", () => {
  assert.deepEqual(fieldErrors({ kind: Event.STARTED, provider: "p", capabilities: {} }), ["field"])
  assert.deepEqual(fieldErrors({ kind: Event.STARTED, sessionId: "s", capabilities: {} }), ["field"])
  assert.deepEqual(fieldErrors({ kind: Event.STARTED, sessionId: "s", provider: "p" }), ["field"])
})

test("text 必须带 delta 字符串（text 键不算）", () => {
  assert.deepEqual(fieldErrors({ kind: Event.TEXT, text: "整段" }), ["field"])
  assert.deepEqual(fieldErrors({ kind: Event.TEXT, delta: "" }), [], "空串合法：适配器可以发心跳")
})

test("tool_call 缺 callId / name、args 非对象都报", () => {
  assert.deepEqual(fieldErrors({ kind: Event.TOOL_CALL, name: "n" }), ["field"])
  assert.deepEqual(fieldErrors({ kind: Event.TOOL_CALL, callId: "c" }), ["field"])
  assert.deepEqual(fieldErrors({ kind: Event.TOOL_CALL, callId: "c", name: "n", args: "x" }), ["field"])
})

test("tool_result 的 ok 必须是布尔，bytes 必须是非负整数", () => {
  assert.deepEqual(fieldErrors({ kind: Event.TOOL_RESULT, callId: "c" }), ["field"])
  assert.deepEqual(fieldErrors({ kind: Event.TOOL_RESULT, callId: "c", ok: true, bytes: -1 }), ["field"])
  assert.deepEqual(fieldErrors({ kind: Event.TOOL_RESULT, callId: "c", ok: true, summary: 1 }), ["field"])
})

test("usage 的 token 必须是非负整数，costUsd 只能是数字或 null", () => {
  assert.deepEqual(fieldErrors({ kind: Event.USAGE, outputTokens: 1 }), ["field"])
  assert.deepEqual(fieldErrors({ kind: Event.USAGE, inputTokens: 1 }), ["field"])
  assert.deepEqual(fieldErrors({ kind: Event.USAGE, inputTokens: 1, outputTokens: 1, costUsd: "免费" }), ["field"])
  assert.deepEqual(fieldErrors({ kind: Event.USAGE, inputTokens: 1, outputTokens: 1, costUsd: null }), [])
})

test("error 三个字段缺一不可", () => {
  assert.deepEqual(fieldErrors({ kind: Event.ERROR, message: "m", retryable: true }), ["field"])
  assert.deepEqual(fieldErrors({ kind: Event.ERROR, code: "E", retryable: true }), ["field"])
  assert.deepEqual(fieldErrors({ kind: Event.ERROR, code: "E", message: "m" }), ["field"])
})

test("done 的 reason 必须在封闭集里", () => {
  assert.deepEqual(fieldErrors({ kind: Event.DONE, reason: "finished" }), ["field"])
  for (const reason of DONE_REASONS) assert.deepEqual(fieldErrors({ kind: Event.DONE, reason }), [], reason)
})

test("非对象事件与未知类型都走独立的错误码", () => {
  assert.deepEqual(validateEvent("不是对象").map((e) => e.code), ["shape"])
  assert.deepEqual(validateEvent({ kind: "thinking" }).map((e) => e.code), ["unknown_event"])
  assert.deepEqual(validateTimeline("不是数组").map((v) => v.rule), ["shape"])
})

test("结构残缺的 started 不会把后面的铁律判断带崩", () => {
  // started 缺 capabilities：报一条 field，但仍算「见过 started」，后续 text 不重复报 started_first
  const violations = validateTimeline([{ kind: Event.STARTED, sessionId: "s", provider: "p" }, { kind: Event.TEXT, delta: "x" }])
  assert.deepEqual(violations.map((v) => v.rule), ["field"])
})
