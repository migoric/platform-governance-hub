// 会话投影 —— 事件流 → 界面能直接摆的事实（agent-acl §2、§8）。
//
// 这个文件解决的是「界面读什么」这个问题。在此之前，任务详情的工具轨迹是手写的
// fixture（`GovernanceHub/fixtures/task-detail.json` 的 `thought.tools`）—— 也就是说，
// 界面上「AI 调了 4 次工具、其中 1 次失败」这句话跟真实发生过的事没有关系。
//
// 现在的关系是：**事件流是事实，投影是视图**。两者一起落盘，校验器再从 `events`
// 重算一遍 `timeline` 逐字段比对（`validateSession`）—— 手改投影会被抓出来。
// 这和快照里 findings 由 evaluate() 现算是同一个套路：算出来的东西不允许手写。
//
// 两条比契约校验更严的规矩，写在这里而不是 validateTimeline 里：
//   1. **不许丢事件。** validateTimeline 对未知类型是「忽略并计数」（流式场景必须如此，
//      否则一个多出来的心跳就能把整条流打断）。但落盘审计件不能这么办 —— 存档时
//      悄悄丢掉不认识的事件，等于交出一份「看起来完整、其实删过」的记录。
//   2. **必须有终点。** 没有 done 的流，界面转圈永远不停（铁律 5）。运行时可以等，
//      存档不行：存一个不知道结束没有的会话，下次打开还是转圈。

import { CONTRACT_VERSION, DONE_REASONS, Event, EVENT_KINDS, normalizeCapabilities, validateTimeline } from "./contract.mjs"

export const SESSION_SCHEMA_VERSION = 1

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v)
const isStr = (v) => typeof v === "string"
const isUint = (v) => Number.isInteger(v) && v >= 0
const nonEmpty = (v) => isStr(v) && v.trim() !== ""

const err = (errors, code, path, message) => errors.push({ code, path, message })

/** 投影失败：流不合法、没有终点、或调用方没给归属声明。一律拒绝落盘。 */
export class SessionProjectionError extends Error {
  constructor(message, details = []) {
    super(details.length > 0 ? `${message}（${details.length} 处）：${details.slice(0, 3).map((d) => `${d.rule ?? d.code}@${d.at ?? d.path}`).join("；")}` : message)
    this.name = "SessionProjectionError"
    this.details = details
  }
}

/**
 * 事件序列 → 时间线（纯函数，不校验）。
 *
 * 三条归一化规则，都是「界面要什么」而不是「事件长什么样」：
 *   · 相邻 text 合并成一段 —— 模型的输出是增量，人读的是整段（铁律 2 的消费方）；
 *   · tool_call 在**调用发生的位置**出一行，结果按 callId 回填 —— 结果可能晚到或乱序，
 *     但「先查了 A 又查了 B」这个顺序必须按调用顺序读，不能按返回顺序读；
 *   · usage / started / done 不出行：它们属于会话表头，混进时间线会让「几步」算不清。
 *
 * @param {unknown[]} events
 * @returns {Array<object>}
 */
export function projectTimeline(events) {
  if (!Array.isArray(events)) return []

  // 先扫一遍结果：结果晚于后续调用的情况真实存在（并行工具），一次遍历回填不了
  const results = new Map()
  for (const event of events) {
    if (isObj(event) && event.kind === Event.TOOL_RESULT && nonEmpty(event.callId)) {
      results.set(event.callId, event)
    }
  }

  const out = []
  let buffer = null // 正在累积的 text 段

  const flush = () => {
    if (buffer !== null) {
      out.push({ kind: "text", text: buffer })
      buffer = null
    }
  }

  for (const event of events) {
    if (!isObj(event)) continue
    switch (event.kind) {
      case Event.TEXT:
        if (isStr(event.delta)) buffer = (buffer ?? "") + event.delta
        break
      case Event.TOOL_CALL: {
        flush()
        const result = results.get(event.callId)
        out.push({
          kind: "tool",
          callId: isStr(event.callId) ? event.callId : "",
          name: isStr(event.name) ? event.name : "",
          // ok 缺失存 null 而不是 false：没见过结果和「失败了」是两件事
          ok: result === undefined ? null : result.ok === true,
          bytes: isUint(result?.bytes) ? result.bytes : null,
          summary: isStr(result?.summary) ? result.summary : "",
        })
        break
      }
      case Event.ERROR:
        flush()
        out.push({
          kind: "error",
          code: isStr(event.code) ? event.code : "",
          message: isStr(event.message) ? event.message : "",
          retryable: event.retryable === true,
        })
        break
      default:
        // started / tool_result / usage / done：不属于时间线（见上）
        break
    }
  }
  flush()
  return out
}

/**
 * 事件序列 → 会话投影。
 *
 * `attribution` **必须由 provider 给**（provider 自己声明产出是不是真实分析，
 * ladder 不按名字猜，见 provider.mjs）。这里不接受「不给」—— 缺归属声明的会话
 * 在界面上会被默认当成真实分析，那是这一层唯一不能出的错。
 *
 * @param {unknown[]} events
 * @param {{ prompt?: string, attribution: { real: boolean, label: string } }} options
 * @returns {object} 可直接落盘的会话
 */
export function projectSession(events, { prompt = "", attribution } = {}) {
  if (!isObj(attribution) || typeof attribution.real !== "boolean") {
    throw new SessionProjectionError("projectSession 需要 provider 给出 attribution{real}")
  }
  const violations = validateTimeline(events)
  if (violations.length > 0) {
    throw new SessionProjectionError("事件流违反契约，拒绝投影", violations)
  }

  const started = events.find((e) => isObj(e) && e.kind === Event.STARTED)
  const done = [...events].reverse().find((e) => isObj(e) && e.kind === Event.DONE)
  // started 必须第一个（铁律 1）；但 validateTimeline 只在 text / tool_call 之前才查这一条，
  // 一条只有 done 的流它不会拦。会话要落盘，没有身份的会话等于没有出处，这里补上。
  if (started === undefined) {
    throw new SessionProjectionError("事件流没有 started，拿不到会话身份", [{ rule: "missing_started", at: -1 }])
  }
  if (done === undefined) {
    throw new SessionProjectionError("事件流没有 done，拒绝存档（转圈永远不停的那种会话）", [{ rule: "missing_done", at: -1 }])
  }

  const timeline = projectTimeline(events)
  const usages = events.filter((e) => isObj(e) && e.kind === Event.USAGE)
  const toolItems = timeline.filter((item) => item.kind === "tool")

  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    sessionId: isStr(started?.sessionId) ? started.sessionId : "",
    provider: isStr(started?.provider) ? started.provider : "",
    attribution: { real: attribution.real, label: attribution.label ?? "" },
    prompt,
    capabilities: normalizeCapabilities(started?.capabilities),
    eventCount: events.length,
    // 原始事件要和投影一起存：投影只留「界面要的」，审计要的是「发生过的」。
    // 两者的关系由 validateSession 从这份 events 重算 timeline 来保证。
    events,
    timeline,
    toolCount: toolItems.length,
    stepCount: timeline.length,
    // 事件契约里没有时间戳（加了就得升契约版本）。所以耗时是「不知道」，
    // 不是 0、也不是 fixture 里那种编出来的 2 分 14 秒。
    durationMs: null,
    usage:
      usages.length === 0
        ? null
        : {
            inputTokens: usages.reduce((sum, u) => sum + (isUint(u.inputTokens) ? u.inputTokens : 0), 0),
            outputTokens: usages.reduce((sum, u) => sum + (isUint(u.outputTokens) ? u.outputTokens : 0), 0),
            // 拿不到成本就是 null：显示「—」，不许显示 0（铁律 4）
            costUsd: usages.some((u) => typeof u.costUsd === "number") ? usages.reduce((sum, u) => sum + (typeof u.costUsd === "number" ? u.costUsd : 0), 0) : null,
          },
    doneReason: done.reason,
  }
}

/**
 * 校验一份会话文件。除了结构，还**从 events 重算 timeline 比对** ——
 * 这是「投影不许手写」那条规矩的执行点。
 *
 * @param {unknown} input
 * @returns {{ ok: boolean, errors: Array<{ code: string, path: string, message: string }> }}
 */
export function validateSession(input) {
  const errors = []
  if (!isObj(input)) {
    err(errors, "E_SESSION_SHAPE", "", "会话不是对象")
    return { ok: false, errors }
  }
  if (input.schemaVersion !== SESSION_SCHEMA_VERSION) {
    err(errors, "E_SESSION_SCHEMA_VERSION", "schemaVersion", `schemaVersion 必须是 ${SESSION_SCHEMA_VERSION}`)
  }
  if (input.contractVersion !== CONTRACT_VERSION) {
    err(errors, "E_SESSION_CONTRACT_VERSION", "contractVersion", `contractVersion 必须是 ${CONTRACT_VERSION}（旧会话要重新录，不能按新契约读）`)
  }
  if (!nonEmpty(input.provider)) err(errors, "E_SESSION_PROVIDER", "provider", "缺 provider")
  if (!nonEmpty(input.sessionId)) err(errors, "E_SESSION_ID", "sessionId", "缺 sessionId")

  // 归属：不是真实分析就必须有话说。空白标签等于没标。
  if (!isObj(input.attribution) || typeof input.attribution.real !== "boolean") {
    err(errors, "E_SESSION_ATTRIBUTION", "attribution", "缺 attribution.real 布尔值")
  } else if (input.attribution.real === false && !nonEmpty(input.attribution.label)) {
    err(errors, "E_SESSION_ATTRIBUTION_LABEL", "attribution.label", "非真实分析必须写明是什么（回放/模拟），不能留空")
  }

  if (!Array.isArray(input.events)) {
    err(errors, "E_SESSION_EVENTS", "events", "events 必须是数组（会话的事实来源）")
    return { ok: false, errors }
  }
  const violations = validateTimeline(input.events)
  for (const v of violations) {
    err(errors, "E_SESSION_EVENTS_INVALID", `events[${v.at}]`, `${v.rule}：${v.detail}`)
  }
  if (input.eventCount !== input.events.length) {
    err(errors, "E_SESSION_EVENT_COUNT", "eventCount", `eventCount 与 events 长度不符（${input.eventCount} vs ${input.events.length}）`)
  }
  if (!DONE_REASONS.includes(input.doneReason)) {
    err(errors, "E_SESSION_DONE", "doneReason", `doneReason 不在封闭集：${input.doneReason}`)
  }

  // 核心：投影必须等于「从 events 重算出来的东西」
  const expected = projectTimeline(input.events)
  if (!Array.isArray(input.timeline)) {
    err(errors, "E_SESSION_TIMELINE", "timeline", "timeline 必须是数组")
  } else if (JSON.stringify(input.timeline) !== JSON.stringify(expected)) {
    err(
      errors,
      "E_SESSION_TIMELINE_DRIFT",
      "timeline",
      `timeline 与 events 重算结果不一致（文件写的是 ${input.timeline.length} 段，重算是 ${expected.length} 段）—— 投影不许手写`,
    )
  }
  if (input.toolCount !== expected.filter((i) => i.kind === "tool").length) {
    err(errors, "E_SESSION_TOOL_COUNT", "toolCount", "toolCount 与时间线里的工具行数不符")
  }
  if (input.stepCount !== (Array.isArray(input.timeline) ? input.timeline.length : -1)) {
    err(errors, "E_SESSION_STEP_COUNT", "stepCount", "stepCount 必须等于时间线长度")
  }
  if (input.durationMs !== null && !isUint(input.durationMs)) {
    err(errors, "E_SESSION_DURATION", "durationMs", "durationMs 只能是 null（未知）或非负整数")
  }
  if (input.usage !== null && input.usage !== undefined) {
    if (!isObj(input.usage)) {
      err(errors, "E_SESSION_USAGE", "usage", "usage 只能是 null 或对象")
    } else {
      if (!isUint(input.usage.inputTokens) || !isUint(input.usage.outputTokens)) {
        err(errors, "E_SESSION_USAGE", "usage", "inputTokens / outputTokens 必须是非负整数")
      }
      if (input.usage.costUsd !== null && typeof input.usage.costUsd !== "number") {
        err(errors, "E_SESSION_USAGE_COST", "usage.costUsd", "costUsd 只能是 number 或 null（未知）")
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

export class SessionValidationError extends Error {
  constructor(errors) {
    const head = errors.slice(0, 3).map((e) => `${e.path || "<root>"}: ${e.message}`).join("; ")
    super(`会话校验失败（${errors.length} 处）：${head}`)
    this.name = "SessionValidationError"
    this.errors = errors
  }
}

/** 校验并返回同一份会话；不合法直接抛（调用方据此不写盘）。 */
export function assertValidSession(session) {
  const { ok, errors } = validateSession(session)
  if (!ok) throw new SessionValidationError(errors)
  return session
}

export { EVENT_KINDS }
