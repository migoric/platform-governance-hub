#!/usr/bin/env node
// 契约校验门禁 —— 跑真实的 CLI，把产物再校验一遍。
//
// 为什么不等单测：单测验的是函数，这里验的是「App 真正会读到的那个文件」——
// 紧凑单行、0600、目录 0700、schema 合法、重复生成字节一致。少一条，App 侧就可能读到半截数据。

import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { validateTasks } from "../sidecar/agent/tasks.mjs"
import { validateSnapshot } from "../sidecar/snapshot/schema.mjs"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const PGH = join(ROOT, "sidecar", "pgh.mjs")
const NOW = "2026-11-07T01:12:00+08:00"

const dir = mkdtempSync(join(tmpdir(), "pgh-contract-"))
const failures = []
const checks = []

const check = (name, fn) => {
  try {
    fn()
    checks.push(`  ✔ ${name}`)
  } catch (error) {
    failures.push(`  ✘ ${name}：${error.message}`)
  }
}

function run(args) {
  const result = spawnSync(process.execPath, [PGH, ...args], { encoding: "utf8", env: { ...process.env } })
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

const assertEqual = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label} 期望 ${expected}，实际 ${actual}`)
}

try {
  const snapshotFile = join(dir, "nested", "snapshot.json")
  const tasksFile = join(dir, "agent", "tasks.json")

  const snapshotRun = run(["snapshot", "--mock", "--out", snapshotFile, "--now", NOW])
  const tasksRun = run(["tasks", "--mock", "--out", tasksFile, "--now", NOW])

  check("pgh snapshot 退出码 0", () => assertEqual(snapshotRun.code, 0, "exit"))
  check("pgh tasks 退出码 0", () => assertEqual(tasksRun.code, 0, "exit"))

  check("快照是紧凑单行", () => {
    const text = readFileSync(snapshotFile, "utf8")
    if (text.includes("\n")) throw new Error("落盘内容包含换行")
  })

  check("快照通过 schema 校验", () => {
    const result = validateSnapshot(JSON.parse(readFileSync(snapshotFile, "utf8")))
    if (!result.ok) throw new Error(result.errors.map((e) => `${e.path}:${e.code}`).join(", "))
  })

  check("任务列表通过 schema 校验", () => {
    const result = validateTasks(JSON.parse(readFileSync(tasksFile, "utf8")))
    if (!result.ok) throw new Error(result.errors.map((e) => `${e.path}:${e.code}`).join(", "))
  })

  check("快照文件权限 0600", () => assertEqual(statSync(snapshotFile).mode & 0o777, 0o600, "mode"))
  check("数据目录权限 0700", () => assertEqual(statSync(join(dir, "nested")).mode & 0o777, 0o700, "mode"))

  check("同一 --now 重复生成字节一致", () => {
    const again = join(dir, "again.json")
    run(["snapshot", "--mock", "--out", again, "--now", NOW])
    assertEqual(readFileSync(again, "utf8"), readFileSync(snapshotFile, "utf8"), "内容")
  })

  check("缺 --mock 时拒绝执行（exit 2）", () => assertEqual(run(["snapshot"]).code, 2, "exit"))

  // 测试与运行依赖的文件必须在 git 里。`.gitignore` 的 `packs/` 曾经把整个内置规则库挡掉：
  // 本地测试全绿，新克隆一跑就是 ENOENT —— 这种「只在自己机器上成立的绿」最危险。
  check("测试依赖的文件都已入库", () => {
    const tracked = spawnSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8" })
    if (tracked.status !== 0) throw new Error("不是 git 仓库（归档导出？）——这条要在仓库内跑")
    const files = new Set(tracked.stdout.split("\n").filter(Boolean))
    const dirs = ["sidecar/rules/packs", "sidecar/rules/dicts", "GovernanceHub/fixtures"]
    const missing = []
    for (const dir of dirs) {
      for (const name of readdirSync(join(ROOT, dir), { recursive: true })) {
        const rel = `${dir}/${name}`.split("\\").join("/")
        if (name.includes(".") && !files.has(rel)) missing.push(rel)
      }
    }
    if (missing.length > 0) throw new Error(`未入库：${missing.slice(0, 5).join(", ")}`)
  })
  check("未知命令时拒绝执行（exit 2）", () => assertEqual(run(["nope"]).code, 2, "exit"))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log("契约校验门禁")
for (const line of checks) console.log(line)
if (failures.length === 0) {
  console.log("✔ 通过")
  process.exit(0)
}
for (const line of failures) console.log(line)
process.exit(1)
