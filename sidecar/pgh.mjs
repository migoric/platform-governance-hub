#!/usr/bin/env node
// pgh —— 命令路由，只做分发（architecture.md §6：pgh.mjs 只路由）。
// 业务逻辑一律在 cli/commands/* 或 snapshot/ domain/ 里，这里不做任何计算。

import { runAgent, AGENT_USAGE } from "./cli/commands/agent.mjs"
import { runCheck, CHECK_USAGE } from "./cli/commands/check.mjs"
import { runRules, RULES_USAGE } from "./cli/commands/rules.mjs"
import { runSnapshot, SNAPSHOT_USAGE } from "./cli/commands/snapshot.mjs"
import { runTasks, TASKS_USAGE } from "./cli/commands/tasks.mjs"

const VERSION = "0.2.0-m2"

const USAGE = `pgh ${VERSION} — platform governance hub sidecar

用法：pgh <命令> [参数]

  snapshot  生成 / 校验快照（--mock）
  tasks     生成 / 校验任务列表投影（--mock）
  rules     看规则库、测一条新规则的影响（list / impact）
  check     对快照跑判定（引擎唯一入口）
  agent     provider 握手、状态报告、选用服务、跑会话、调只读工具
            （list / handshake / status / use / run / session / tool）

  pgh <命令> --help   看该命令的参数
  pgh --version       版本

退出码：0 成功 / 1 校验失败（未写盘）/ 2 用法错误`

/**
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, stdout?: (s: string) => void, stderr?: (s: string) => void }} [io]
 * @returns {number | Promise<number>} `agent` 子命令是异步的，其余同步返回。
 *   混合返回是刻意的：既有命令与测试都按同步断言，为一处异步把它们全改成 await 不划算。
 */
export function main(argv, io = {}) {
  const stdout = io.stdout ?? console.log
  const stderr = io.stderr ?? console.error
  const [command, ...rest] = argv

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    stdout(USAGE)
    return 0
  }
  if (command === "--version" || command === "-v" || command === "version") {
    stdout(VERSION)
    return 0
  }

  switch (command) {
    case "snapshot":
      return runSnapshot(rest, { env: io.env ?? process.env, stdout, stderr })
    case "tasks":
      return runTasks(rest, { env: io.env ?? process.env, stdout, stderr })
    case "rules":
      return runRules(rest, { env: io.env ?? process.env, stdout, stderr })
    case "check":
      return runCheck(rest, { env: io.env ?? process.env, stdout, stderr })
    case "agent":
      return runAgent(rest, { env: io.env ?? process.env, stdout, stderr })
    default:
      stderr(`不认识的命令：${command}`)
      stderr(USAGE)
      return 2
  }
}

// 只在直接执行时读 argv；被测试 import 时不产生副作用
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) {
  settle(main(process.argv.slice(2)))
}

/**
 * 把 `main` 的结果落到进程退出码上。
 *
 * 同步命令直接返回数字，异步命令（`agent`）返回 Promise —— 后者若 reject
 * 而没人接，Node 会以 0 退出，CI 就会把「崩了」当成功。所以这里必须接 rejection。
 *
 * @param {number | Promise<number>} result
 * @param {{ error?: (e: unknown) => void }} [io]
 */
export function settle(result, io = {}) {
  const logError = io.error ?? ((error) => console.error(error))
  if (typeof result === "number") {
    process.exitCode = result
    return
  }
  result.then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      logError(error)
      process.exitCode = 1
    },
  )
}

export { AGENT_USAGE, CHECK_USAGE, RULES_USAGE, SNAPSHOT_USAGE, TASKS_USAGE }
