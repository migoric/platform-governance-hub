#!/usr/bin/env node
// pgh —— 命令路由，只做分发（architecture.md §6：pgh.mjs 只路由）。
// 业务逻辑一律在 cli/commands/* 或 snapshot/ domain/ 里，这里不做任何计算。

import { runSnapshot, SNAPSHOT_USAGE } from "./cli/commands/snapshot.mjs"
import { runTasks, TASKS_USAGE } from "./cli/commands/tasks.mjs"

const VERSION = "0.1.0-m0"

const USAGE = `pgh ${VERSION} — platform governance hub sidecar

用法：pgh <命令> [参数]

  snapshot  生成 / 校验快照（M0 只有 --mock）
  tasks     生成 / 校验任务列表投影（M0 只有 --mock）

  pgh <命令> --help   看该命令的参数
  pgh --version       版本

退出码：0 成功 / 1 校验失败（未写盘）/ 2 用法错误`

/**
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, stdout?: (s: string) => void, stderr?: (s: string) => void }} [io]
 * @returns {number}
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
    default:
      stderr(`不认识的命令：${command}`)
      stderr(USAGE)
      return 2
  }
}

// 只在直接执行时读 argv；被测试 import 时不产生副作用
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2))
}

export { SNAPSHOT_USAGE, TASKS_USAGE }
