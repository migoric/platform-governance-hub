// `pgh tasks` —— M0 只有 --mock。
//
// 与 snapshot 的差别只有数据源；落盘、校验、退出码规则完全一致（tasks/schema.mjs 的封闭集更少：
// 四态 + 两个来源标记，没有业务字段可放宽）。

import { buildMockTasks } from "../../agent/tasks-mock.mjs"
import { assertValidTasks, TasksValidationError } from "../../agent/tasks.mjs"
import { parseLocalIso } from "../../util/dates.mjs"
import { parseFlags, UsageError } from "../args.mjs"
import { stringify, tasksPath, writeAtomic } from "../fs.mjs"

export const TASKS_USAGE = `用法：pgh tasks --mock [--out <文件>] [--pretty] [--now <ISO 时间>]

  --mock            生成四条 mock 任务（进行中 / 等待确认 / 已完成 / 已中断 各一条）
  --out <文件>       写到指定路径（默认写到 ~/.pgh/agent/tasks.json）
  --pretty          JSON 缩进输出到 stdout（落盘永远是紧凑单行）
  --now <ISO8601>   固定生成时间，用于出图与回归对比`

/**
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, stdout?: (s: string) => void, stderr?: (s: string) => void }} [io]
 * @returns {number} 退出码
 */
export function runTasks(argv, { env = process.env, stdout = console.log, stderr = console.error } = {}) {
  let parsed
  try {
    parsed = parseFlags(argv, { booleans: ["mock", "pretty", "help"], strings: ["out", "now"] })
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(error.message)
      stderr(TASKS_USAGE)
      return 2
    }
    throw error
  }
  const { flags } = parsed

  if (flags.help) {
    stdout(TASKS_USAGE)
    return 0
  }
  if (!flags.mock) {
    stderr("M0 只支持 --mock（真实会话在 M2）。")
    stderr(TASKS_USAGE)
    return 2
  }

  let now = new Date()
  if (typeof flags.now === "string") {
    try {
      now = parseLocalIso(flags.now)
    } catch (error) {
      stderr(`--now 不是合法时间：${error.message}`)
      return 2
    }
  }

  let tasks
  try {
    tasks = assertValidTasks(buildMockTasks({ now }))
  } catch (error) {
    if (error instanceof TasksValidationError) {
      stderr(error.message)
      for (const e of error.errors) stderr(`  · ${e.path || "<root>"}  ${e.code}  ${e.message}`)
      return 1
    }
    throw error
  }

  const compact = stringify(tasks, false)
  const counts = tasks.tasks.reduce((acc, t) => ({ ...acc, [t.state]: (acc[t.state] ?? 0) + 1 }), {})

  if (typeof flags.out === "string") {
    writeAtomic(flags.out, compact)
    stderr(`已写入 ${flags.out}（${describe(tasks.tasks.length, counts)}）`)
    return 0
  }
  if (flags.pretty === true) {
    stdout(stringify(tasks, true))
    return 0
  }
  const target = tasksPath(env)
  writeAtomic(target, compact)
  stderr(`已写入 ${target}（${describe(tasks.tasks.length, counts)}）`)
  return 0
}

function describe(total, counts) {
  const parts = Object.entries(counts).map(([state, n]) => `${state} ${n}`)
  return `${total} 条任务：${parts.join(" / ")}`
}
