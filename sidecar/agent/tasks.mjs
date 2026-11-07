// 任务列表的**视图投影**，不是会话事实源。
//
// 为什么单独说明：M0 还没有 provider，也没有事件流，但 `ui-ia.md §2.1` 要求任务列表是
// 第一入口、布局在 M0 定型。所以这里先定义「任务卡要显示什么」，由 mock 直接投影出来。
//
// 边界（重要）：
//   · 本文件的字段**不能**反过来定义 agent 事件契约。事件契约只在 `refactor-constraints §1.3`
//     那 7 种里定，M2 见到真实事件流后再写 `agent/contract.mjs`。
//   · M2 接上 provider 后，这个文件由 `AgentSession` 从事件流**投影**生成，字段形态保持不变，
//     变的只是数据来源（静态 fixture → 事件聚合）。这正是 M0 定型卡面、M2 不返工的原因。

import { parseLocalIso } from "../util/dates.mjs"

export const TASKS_SCHEMA_VERSION = 1

/** 四态是封闭集：进行中 / 等待确认 / 已完成 / 已中断（ui-ia.md §2.1）。 */
export const TASK_STATES = Object.freeze(["running", "awaiting", "done", "interrupted"])

/** 来源标记：真实数据 / 回放（回放必须在界面上写明，见 roadmap M2 验收 2）。 */
export const TASK_ORIGINS = Object.freeze(["real", "replay"])

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v)
const isStr = (v) => typeof v === "string"
const isInt = (v) => Number.isInteger(v)
const nonEmpty = (v) => isStr(v) && v.trim() !== ""

const err = (errors, code, path, message) => errors.push({ code, path, message })

function isIso(value) {
  if (!isStr(value)) return false
  try {
    parseLocalIso(value)
    return true
  } catch {
    return false
  }
}

const TITLE_MAX = 120

function validateTask(task, index, errors) {
  const path = `tasks[${index}]`
  if (!isObj(task)) {
    err(errors, "E_TASK_SHAPE", path, "task 不是对象")
    return
  }
  if (!nonEmpty(task.id)) err(errors, "E_TASK_ID", `${path}.id`, "缺 id")
  if (!nonEmpty(task.title)) err(errors, "E_TASK_TITLE", `${path}.title`, "缺 title")
  else if (task.title.length > TITLE_MAX) {
    // 卡面是「用户原话首句」，不是标题党；超长一律截断，不许在 UI 里偷偷裁
    err(errors, "E_TASK_TITLE_LEN", `${path}.title`, `title 超过 ${TITLE_MAX} 字（实际 ${task.title.length}）`)
  }
  if (!TASK_STATES.includes(task.state)) {
    err(errors, "E_TASK_STATE", `${path}.state`, `state 不在封闭集：${task.state}`)
  }
  if (!TASK_ORIGINS.includes(task.origin)) {
    err(errors, "E_TASK_ORIGIN", `${path}.origin`, `origin 必须是 real / replay：${task.origin}`)
  }
  if (!Array.isArray(task.agents)) {
    err(errors, "E_TASK_AGENTS", `${path}.agents`, "agents 必须是数组")
  } else {
    task.agents.forEach((agent, i) => {
      if (!nonEmpty(agent)) err(errors, "E_TASK_AGENTS", `${path}.agents[${i}]`, "agent 名必须是非空字符串")
    })
  }
  if (!isIso(task.startedAt)) err(errors, "E_TASK_TIME", `${path}.startedAt`, "startedAt 必须是带时区的 ISO 时间")
  if (task.endedAt !== null && task.endedAt !== undefined && !isIso(task.endedAt)) {
    err(errors, "E_TASK_TIME", `${path}.endedAt`, "endedAt 必须是 null 或带时区的 ISO 时间")
  }
  if (!isInt(task.durationMs) || task.durationMs < 0) {
    err(errors, "E_TASK_DURATION", `${path}.durationMs`, "durationMs 必须是非负整数（由 sidecar 算好，UI 不重算）")
  }
  if (task.stepCount !== undefined && (!isInt(task.stepCount) || task.stepCount < 0)) {
    err(errors, "E_TASK_STEPS", `${path}.stepCount`, "stepCount 必须是非负整数")
  }

  // 状态与时间戳必须自洽：否则「已中断但还在跑」「已完成但没有结束时间」会一路带到界面上
  const ended = task.endedAt !== null && task.endedAt !== undefined
  if ((task.state === "running" || task.state === "awaiting") && ended) {
    err(errors, "E_TASK_STATE_TIME", `${path}.endedAt`, `${task.state} 状态不应有 endedAt`)
  }
  if ((task.state === "done" || task.state === "interrupted") && !ended) {
    err(errors, "E_TASK_STATE_TIME", `${path}.endedAt`, `${task.state} 状态必须有 endedAt`)
  }
}

/**
 * 校验任务列表文件。
 * @param {unknown} input
 * @returns {{ ok: boolean, errors: Array<{ code: string, path: string, message: string }> }}
 */
export function validateTasks(input) {
  const errors = []
  if (!isObj(input)) {
    err(errors, "E_SHAPE", "", "任务列表不是对象")
    return { ok: false, errors }
  }
  if (input.schemaVersion !== TASKS_SCHEMA_VERSION) {
    err(errors, "E_SCHEMA_VERSION", "schemaVersion", `schemaVersion 必须是 ${TASKS_SCHEMA_VERSION}`)
  }
  if (!isIso(input.generatedAt)) err(errors, "E_GENERATED_AT", "generatedAt", "generatedAt 必须是带时区的 ISO 时间")
  if (!isObj(input.source) || !nonEmpty(input.source.kind)) err(errors, "E_SOURCE", "source", "缺 source.kind")
  if (!Array.isArray(input.tasks)) {
    err(errors, "E_TASKS", "tasks", "tasks 必须是数组（空数组合法：还没有任务）")
    return { ok: errors.length === 0, errors }
  }
  const seen = new Set()
  input.tasks.forEach((task, i) => {
    validateTask(task, i, errors)
    if (isObj(task) && nonEmpty(task.id)) {
      if (seen.has(task.id)) err(errors, "E_TASK_DUP", `tasks[${i}].id`, `task id 重复：${task.id}`)
      else seen.add(task.id)
    }
  })
  return { ok: errors.length === 0, errors }
}

export class TasksValidationError extends Error {
  constructor(errors) {
    const head = errors.slice(0, 3).map((e) => `${e.path || "<root>"}: ${e.message}`).join("; ")
    super(`任务列表校验失败（${errors.length} 处）：${head}`)
    this.name = "TasksValidationError"
    this.errors = errors
  }
}

/**
 * 校验并返回；不合法直接抛，调用方据此不写盘。
 * @param {unknown} tasks
 * @returns {object}
 */
export function assertValidTasks(tasks) {
  const { ok, errors } = validateTasks(tasks)
  if (!ok) throw new TasksValidationError(errors)
  return tasks
}
