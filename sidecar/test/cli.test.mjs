import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { runSnapshot } from "../cli/commands/snapshot.mjs"
import { runTasks } from "../cli/commands/tasks.mjs"
import { validateTasks } from "../agent/tasks.mjs"
import { validateSnapshot } from "../snapshot/schema.mjs"
import { main } from "../pgh.mjs"

const NOW = "2026-11-07T01:12:00+08:00"

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "pgh-test-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const logs = []
  const io = { stdout: (s) => logs.push(s), stderr: (s) => logs.push(s), env: { PGH_HOME: dir } }
  return { dir, logs, io }
}

test("pgh snapshot --mock --out：写盘 0600、目录 0700、紧凑单行、合法", (t) => {
  const { dir, io } = sandbox(t)
  const out = join(dir, "nested", "snapshot.json")
  assert.equal(runSnapshot(["--mock", "--out", out, "--now", NOW], io), 0)

  const text = readFileSync(out, "utf8")
  assert.equal(text.includes("\n"), false)
  assert.equal(statSync(out).mode & 0o777, 0o600)
  assert.equal(statSync(join(dir, "nested")).mode & 0o777, 0o700)

  const snapshot = JSON.parse(text)
  assert.deepEqual(validateSnapshot(snapshot).errors, [])
  assert.equal(snapshot.generatedAt, NOW)
})

test("pgh snapshot：同一 --now 两次输出字节级一致", (t) => {
  const { dir, io } = sandbox(t)
  const a = join(dir, "a.json")
  const b = join(dir, "b.json")
  runSnapshot(["--mock", "--out", a, "--now", NOW], io)
  runSnapshot(["--mock", "--out", b, "--now", NOW], io)
  assert.equal(readFileSync(a, "utf8"), readFileSync(b, "utf8"))
})

test("pgh snapshot：默认写到 $PGH_HOME/.pgh/snapshot.json", (t) => {
  const { dir, io } = sandbox(t)
  assert.equal(runSnapshot(["--mock", "--now", NOW], io), 0)
  const snapshot = JSON.parse(readFileSync(join(dir, ".pgh", "snapshot.json"), "utf8"))
  assert.equal(validateSnapshot(snapshot).ok, true)
  assert.equal(statSync(join(dir, ".pgh", "snapshot.json")).mode & 0o777, 0o600)
})

test("pgh snapshot --pretty：只在 stdout，不落盘", (t) => {
  const { dir, logs, io } = sandbox(t)
  assert.equal(runSnapshot(["--mock", "--pretty", "--now", NOW], io), 0)
  const printed = logs.join("\n")
  assert.ok(printed.includes("\n  \"schemaVersion\": 1"))
  assert.throws(() => statSync(join(dir, ".pgh", "snapshot.json")))
})

test("pgh snapshot 缺 --mock → 退出码 2", (t) => {
  const { io, logs } = sandbox(t)
  assert.equal(runSnapshot([], io), 2)
  assert.ok(logs.join("\n").includes("只支持 --mock"))
})

test("pgh snapshot 未知参数 / 坏时间 → 退出码 2", (t) => {
  const { io } = sandbox(t)
  assert.equal(runSnapshot(["--mock", "--nope"], io), 2)
  assert.equal(runSnapshot(["--mock", "--now", "2026-02-30T00:00:00+08:00"], io), 2)
})

test("pgh tasks --mock --out：四条任务、四态齐全、合法", (t) => {
  const { dir, io } = sandbox(t)
  const out = join(dir, "agent", "tasks.json")
  assert.equal(runTasks(["--mock", "--out", out, "--now", NOW], io), 0)

  const payload = JSON.parse(readFileSync(out, "utf8"))
  assert.equal(validateTasks(payload).ok, true)
  assert.equal(payload.tasks.length, 4)
  assert.deepEqual(
    payload.tasks.map((x) => x.state).sort(),
    ["awaiting", "done", "interrupted", "running"],
  )
})

test("pgh tasks：默认写到 $PGH_HOME/.pgh/agent/tasks.json", (t) => {
  const { dir, io } = sandbox(t)
  assert.equal(runTasks(["--mock", "--now", NOW], io), 0)
  const payload = JSON.parse(readFileSync(join(dir, ".pgh", "agent", "tasks.json"), "utf8"))
  assert.equal(payload.tasks.length, 4)
})

test("pgh tasks 缺 --mock → 退出码 2", (t) => {
  const { io } = sandbox(t)
  assert.equal(runTasks([], io), 2)
})

test("main：help / version / 未知命令", (t) => {
  const { logs, io } = sandbox(t)
  assert.equal(main([], io), 0)
  assert.match(logs.join("\n"), /pgh 0\.2\.0-m1/)
  assert.equal(main(["--version"], io), 0)
  assert.match(logs.at(-1), /^0\.2\.0-m1$/)
  assert.equal(main(["nope"], io), 2)
  assert.equal(main(["snapshot", "--help"], io), 0)
})
