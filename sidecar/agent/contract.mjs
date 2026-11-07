// 内部事件契约 —— 封闭集 7 种（agent-acl §2）。
//
// 这一层的存在理由只有一个：换 agent 服务时上层不改。所以契约必须比任何
// 具体服务都窄。窄到能映射，才谈得上「换个实现照旧能用」。
//
// 五条铁律里，能在本地校验的是第 1、3、5 条（加上两条位置约束）：
//   · 只有这 7 种                        → unknown_event
//   · tool_call / tool_result 按 callId 配对 → tool_call_paired / tool_result_paired
//   · usage 允许缺失，缺失不能当 0         → sumCost() 返回 null
//   · error 之后必须还有 done             → error_needs_done
//   · started 必须第一个且只有一个         → started_first / started_once
//
// 违规标识与 crates/hub-agent/src/event.rs 完全同名 —— 两边对同一条时间线
// 必须给出同一份诊断，否则「同一套契约」就是句空话。

/** 加一种新事件语义才允许升版本，升版本 = 全部适配器一起改（铁律 1）。 */
export const CONTRACT_VERSION = 1

export const Event = Object.freeze({
  STARTED: "started",
  TEXT: "text",
  TOOL_CALL: "tool_call",
  TOOL_RESULT: "tool_result",
  USAGE: "usage",
  ERROR: "error",
  DONE: "done",
})

export const EVENT_KINDS = Object.freeze(Object.values(Event))
export const DONE_REASONS = Object.freeze(["ok", "cancelled", "error", "max_steps"])

/** 能力声明的封闭集。UI 只按这些分支，永不按 provider 名字（agent-acl §4）。 */
export const CAPABILITY_KEYS = Object.freeze(["streaming", "tools", "vision", "cost", "maxSteps"])

export const CAPABILITIES_FLOOR = Object.freeze({
  streaming: false,
  tools: false,
  vision: false,
  cost: false,
  maxSteps: 0,
})

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v)
const isStr = (v) => typeof v === "string"
const nonEmpty = (v) => isStr(v) && v.trim() !== ""
const isUint = (v) => Number.isInteger(v) && v >= 0

/**
 * 能力声明归一化：缺的键走地板值，多余的键丢掉。
 *
 * 为什么宽容：远端服务多给几个字段是常态，为这个拒绝握手等于把兼容性做死。
 * 但**不猜**——缺 tools 就是 false，不能假设「没声明大概是支持」。
 * @param {unknown} raw
 * @returns {{ streaming: boolean, tools: boolean, vision: boolean, cost: boolean, maxSteps: number }}
 */
export function normalizeCapabilities(raw) {
  const caps = { ...CAPABILITIES_FLOOR }
  if (!isObj(raw)) return caps
  for (const key of ["streaming", "tools", "vision", "cost"]) {
    if (typeof raw[key] === "boolean") caps[key] = raw[key]
  }
  if (isUint(raw.maxSteps)) caps.maxSteps = raw.maxSteps
  return caps
}

/**
 * 单条事件的结构校验。返回错误数组，空数组表示合法。
 *
 * `unknown` 类型的处理交给调用方（conformance 要求「忽略并计数，不抛错」），
 * 这里只负责「是不是 7 种之一」。
 * @param {unknown} event
 * @param {number} at
 * @returns {Array<{ at: number, code: string, detail: string }>}
 */
export function validateEvent(event, at = 0) {
  const out = []
  const fail = (code, detail) => out.push({ at, code, detail })

  if (!isObj(event)) {
    fail("shape", "事件不是对象")
    return out
  }
  if (!EVENT_KINDS.includes(event.kind)) {
    fail("unknown_event", `不在封闭集里的事件类型：${event.kind}`)
    return out
  }

  switch (event.kind) {
    case Event.STARTED:
      if (!nonEmpty(event.sessionId)) fail("field", "started 缺 sessionId")
      if (!nonEmpty(event.provider)) fail("field", "started 缺 provider")
      if (!isObj(event.capabilities)) fail("field", "started 缺 capabilities")
      break
    case Event.TEXT:
      // 只有增量，没有整段（铁律 2）。空串是合法的（适配器可能发心跳），但必须给 delta 键
      if (!isStr(event.delta)) fail("field", "text 缺 delta 字符串")
      break
    case Event.TOOL_CALL:
      if (!nonEmpty(event.callId)) fail("field", "tool_call 缺 callId")
      if (!nonEmpty(event.name)) fail("field", "tool_call 缺 name")
      if (event.args !== undefined && !isObj(event.args)) fail("field", "tool_call 的 args 若不是对象就别给")
      break
    case Event.TOOL_RESULT:
      if (!nonEmpty(event.callId)) fail("field", "tool_result 缺 callId")
      if (typeof event.ok !== "boolean") fail("field", "tool_result 缺 ok 布尔值")
      if (event.summary !== undefined && !isStr(event.summary)) fail("field", "tool_result 的 summary 必须是字符串")
      if (event.bytes !== undefined && !isUint(event.bytes)) fail("field", "tool_result 的 bytes 必须是非负整数")
      break
    case Event.USAGE:
      if (!isUint(event.inputTokens)) fail("field", "usage 缺 inputTokens")
      if (!isUint(event.outputTokens)) fail("field", "usage 缺 outputTokens")
      // costUsd 允许 null / 缺失 —— 拿不到成本是真实现状，不是数据错误（铁律 4）
      if (event.costUsd !== undefined && event.costUsd !== null && typeof event.costUsd !== "number") {
        fail("field", "usage 的 costUsd 只能是数字或 null")
      }
      break
    case Event.ERROR:
      if (!nonEmpty(event.code)) fail("field", "error 缺 code")
      if (!nonEmpty(event.message)) fail("field", "error 缺 message")
      if (typeof event.retryable !== "boolean") fail("field", "error 缺 retryable 布尔值")
      break
    case Event.DONE:
      if (!DONE_REASONS.includes(event.reason)) {
        fail("field", `done.reason 不在封闭集：${event.reason}`)
      }
      break
    default:
      break
  }
  return out
}

/**
 * 整条时间线的铁律校验。返回违规列表，空数组表示合规。
 *
 * 与 Rust `SessionTimeline::validate` 同一套规则、同一套 rule 名。
 * 空时间线不算违规（还没开始）。
 * @param {unknown[]} events
 * @returns {Array<{ at: number, rule: string, detail: string }>}
 */
export function validateTimeline(events) {
  const out = []
  if (!Array.isArray(events)) {
    return [{ at: 0, rule: "shape", detail: "时间线不是数组" }]
  }

  const openCalls = []
  let sawStarted = false
  let errorAt = null
  // 未知事件不参与铁律判断，但要数出来并记住是什么：忽略 ≠ 没发生
  const unknownKinds = new Map()

  events.forEach((event, at) => {
    if (!isObj(event) || !EVENT_KINDS.includes(event.kind)) {
      const label = isObj(event) ? String(event.kind) : "<非对象>"
      unknownKinds.set(label, (unknownKinds.get(label) ?? 0) + 1)
      return
    }
    const structural = validateEvent(event, at)
    if (structural.length > 0) {
      for (const e of structural) out.push({ at, rule: e.code, detail: e.detail })
      // 结构都不完整就不再往下推铁律，否则一个错会连带报一串
      if (event.kind === Event.STARTED) sawStarted = true
      return
    }

    switch (event.kind) {
      case Event.STARTED:
        if (sawStarted) {
          out.push({ at, rule: "started_once", detail: "同一条时间线出现第二个 started" })
        }
        sawStarted = true
        break
      case Event.TEXT:
        if (!sawStarted) out.push({ at, rule: "started_first", detail: "第一个事件必须是 started" })
        break
      case Event.TOOL_CALL:
        if (!sawStarted) out.push({ at, rule: "started_first", detail: "第一个事件必须是 started" })
        openCalls.push({ callId: event.callId, at })
        break
      case Event.TOOL_RESULT: {
        const idx = openCalls.findIndex((c) => c.callId === event.callId)
        if (idx === -1) {
          out.push({
            at,
            rule: "tool_result_paired",
            detail: `tool_result 找不到对应的 tool_call：${event.callId}`,
          })
        } else {
          openCalls.splice(idx, 1)
        }
        break
      }
      case Event.ERROR:
        errorAt = at
        break
      case Event.DONE:
        errorAt = null
        break
      default:
        break
    }
  })

  for (const call of openCalls) {
    out.push({
      at: call.at,
      rule: "tool_call_paired",
      detail: `tool_call 没有收尾的 tool_result：${call.callId}`,
    })
  }
  if (errorAt !== null) {
    out.push({
      at: errorAt,
      rule: "error_needs_done",
      detail: "error 之后必须还有 done，否则 UI 的转圈永远不停",
    })
  }
  if (unknownKinds.size > 0) {
    const detail = [...unknownKinds].map(([kind, count]) => `${kind}×${count}`).join("、")
    out.push({ at: -1, rule: "unknown_event", detail: `不在封闭集里的事件（已忽略）：${detail}` })
  }
  return out
}

/**
 * 拼接正文 —— 唯一的「整段」来源（铁律 2 的消费方一侧）。
 * @param {unknown[]} events
 * @returns {string}
 */
export function joinText(events) {
  if (!Array.isArray(events)) return ""
  let text = ""
  for (const event of events) {
    if (isObj(event) && event.kind === Event.TEXT && isStr(event.delta)) text += event.delta
  }
  return text
}

/**
 * 成本合计。拿不到成本时返回 `null`，UI 显示「—」而不是 0（铁律 4）。
 *
 * 只要有一条 usage 带了成本就算「拿得到」；全是 null 就等于拿不到 ——
 * 这时返回 0 会把「不知道花了多少」伪装成「没花钱」。
 * @param {unknown[]} events
 * @returns {number | null}
 */
export function sumCost(events) {
  if (!Array.isArray(events)) return null
  let seen = false
  let sum = 0
  for (const event of events) {
    if (isObj(event) && event.kind === Event.USAGE && typeof event.costUsd === "number") {
      seen = true
      sum += event.costUsd
    }
  }
  return seen ? sum : null
}

/**
 * 工具调用轨迹 —— 任务详情面板的折叠条要用它（不含工具返回内容）。
 * @param {unknown[]} events
 * @returns {Array<{ callId: string, name: string, ok: boolean | null, bytes: number | null }>}
 */
export function toolTrace(events) {
  if (!Array.isArray(events)) return []
  const byCall = new Map()
  const order = []
  for (const event of events) {
    if (!isObj(event)) continue
    if (event.kind === Event.TOOL_CALL && nonEmpty(event.callId)) {
      if (!byCall.has(event.callId)) order.push(event.callId)
      byCall.set(event.callId, { callId: event.callId, name: event.name, ok: null, bytes: null })
    } else if (event.kind === Event.TOOL_RESULT && byCall.has(event.callId)) {
      const row = byCall.get(event.callId)
      row.ok = event.ok === true
      row.bytes = isUint(event.bytes) ? event.bytes : null
    }
  }
  return order.map((id) => byCall.get(id))
}
