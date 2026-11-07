// 数据目录与原子写 —— 进程与文件契约（refactor-constraints §3、architecture.md §7）。
// 目录 0700、文件 0600、tmp + rename，一条都不能省：半截快照比没有快照更糟。

import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const DIR_MODE = 0o700
export const FILE_MODE = 0o600

/**
 * 数据目录 `~/.pgh/`。`PGH_HOME` 用于测试注入（AGENTS.md §3.7：测试不许碰真实目录）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function dataDir(env = process.env) {
  const base = typeof env.PGH_HOME === "string" && env.PGH_HOME.trim() !== "" ? env.PGH_HOME : homedir()
  return join(base, ".pgh")
}

/** @param {NodeJS.ProcessEnv} [env] */
export function snapshotPath(env = process.env) {
  return join(dataDir(env), "snapshot.json")
}

/** 会话状态目录（architecture.md §7：`~/.pgh/agent/`）。 */
export function agentDir(env = process.env) {
  return join(dataDir(env), "agent")
}

/** M0 的任务列表投影（不是事件契约，见 sidecar/agent/tasks.mjs 文件头）。 */
export function tasksPath(env = process.env) {
  return join(agentDir(env), "tasks.json")
}

/** 会话投影（界面读这份，不读事件流；见 sidecar/agent/session.mjs 文件头）。 */
export function agentSessionPath(env = process.env) {
  return join(agentDir(env), "session.json")
}

/**
 * 建目录并保证 0700。已存在也重新 chmod —— 之前被别的 umask 建过就补回来。
 * @param {string} dir
 */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  chmodSync(dir, DIR_MODE)
  return dir
}

/**
 * 原子写：先写同目录 tmp，chmod 0600，再 rename。失败时清掉 tmp，不留垃圾。
 * @param {string} path
 * @param {string} text
 * @returns {string} 写入的路径
 */
export function writeAtomic(path, text) {
  if (typeof text !== "string") throw new TypeError("writeAtomic: 需要字符串")
  ensureDir(dirname(path))
  const tmp = `${path}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, text, { mode: FILE_MODE })
    chmodSync(tmp, FILE_MODE)
    renameSync(tmp, path)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw error
  }
  chmodSync(path, FILE_MODE)
  return path
}

/**
 * 紧凑单行落盘（snapshot-contract §1.5：落盘永远 `JSON.stringify(x)`，格式化只走 --pretty）。
 * @param {unknown} value
 * @param {boolean} [pretty]
 * @returns {string}
 */
export function stringify(value, pretty = false) {
  return pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value)
}
