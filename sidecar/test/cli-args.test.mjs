import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { parseFlags, UsageError } from "../cli/args.mjs"
import { SNAPSHOT_USAGE, runSnapshot } from "../cli/commands/snapshot.mjs"
import { TASKS_USAGE, runTasks } from "../cli/commands/tasks.mjs"
import { stringify } from "../cli/fs.mjs"

const NOW = "2026-11-07T01:12:00+08:00"

test("parseFlags：布尔、取值、内联取值", () => {
  const { flags, positional } = parseFlags(["--mock", "--out", "a.json", "--now=" + NOW, "extra"], {
    booleans: ["mock"],
    strings: ["out", "now"],
  })
  assert.equal(flags.mock, true)
  assert.equal(flags.out, "a.json")
  assert.equal(flags.now, NOW)
  assert.deepEqual(positional, ["extra"])
})

test("parseFlags：错误用法抛 UsageError", () => {
  assert.throws(() => parseFlags(["--nope"]), UsageError)
  assert.throws(() => parseFlags(["--out"], { strings: ["out"] }), UsageError)
  assert.throws(() => parseFlags(["--mock=1"], { booleans: ["mock"] }), UsageError)
})

test("stringify：紧凑 vs pretty", () => {
  assert.equal(stringify({ a: 1 }), '{"a":1}')
  assert.equal(stringify({ a: 1 }, true), '{\n  "a": 1\n}\n')
})

test("runTasks --help：打印用法并返回 0", () => {
  const logs = []
  assert.equal(runTasks(["--help"], { stdout: (s) => logs.push(s), stderr: (s) => logs.push(s) }), 0)
  assert.equal(logs.join("\n"), TASKS_USAGE)
})

test("runSnapshot --help：打印用法并返回 0", () => {
  const logs = []
  assert.equal(runSnapshot(["--help"], { stdout: (s) => logs.push(s), stderr: (s) => logs.push(s) }), 0)
  assert.equal(logs.join("\n"), SNAPSHOT_USAGE)
})

test("runTasks --pretty：只打 stdout，不写盘", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pgh-args-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const logs = []
  const code = runTasks(["--mock", "--pretty", "--now", NOW], {
    stdout: (s) => logs.push(s),
    stderr: (s) => logs.push(s),
    env: { PGH_HOME: dir },
  })
  assert.equal(code, 0)
  assert.ok(logs.join("\n").includes('"schemaVersion": 1'))
})

test("runTasks 错误路径：未知参数 / 坏时间 / 缺 --mock", () => {
  const io = { stdout: () => {}, stderr: () => {} }
  assert.equal(runTasks(["--mock", "--nope"], io), 2)
  assert.equal(runTasks(["--mock", "--now", "2026-11-07"], io), 2)
  assert.equal(runTasks([], io), 2)
})

test("runSnapshot 错误路径：缺 --mock / 坏时间", () => {
  const io = { stdout: () => {}, stderr: () => {} }
  assert.equal(runSnapshot([], io), 2)
  assert.equal(runSnapshot(["--mock", "--now", "nope"], io), 2)
})
