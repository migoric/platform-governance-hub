import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { runCheck } from "../cli/commands/check.mjs"
import { runRules } from "../cli/commands/rules.mjs"
import { runSnapshot } from "../cli/commands/snapshot.mjs"
import { main } from "../pgh.mjs"

const NOW = "2026-11-07T01:12:00+08:00"

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "pgh-rules-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const logs = []
  const io = { stdout: (s) => logs.push(s), stderr: (s) => logs.push(s), env: { PGH_HOME: dir } }
  return { dir, logs, io }
}

const CANDIDATE = {
  id: "listing.title.uppercase_ratio",
  title: "标题全大写词过多",
  message: "标题里全大写词过多，可读性差",
  severity: "suggest",
  kind: "deterministic",
  scope: { sites: ["*"] },
  checks: [{ type: "text.match", path: "title", pattern: "\\b[A-Z]{3,}\\b" }],
  evidence: { quote: true, locate: "offset" },
  remediation: { hint: "改成首字母大写", autoFixable: false },
  source: { clause: "3.1.6" },
}

test("pgh rules list：包、条数、四档分布都在", (t) => {
  const { logs, io } = sandbox(t)
  assert.equal(runRules(["list"], io), 0)
  const text = logs.join("\n")
  assert.match(text, /baseline@2026\.11\.1/)
  assert.match(text, /共 23 条规则/)
  assert.match(text, /deterministic 20 · semantic 2 · manual 1/)
  assert.match(text, /四档分布：blocker 5/)
})

test("pgh rules list --json：可被机器读，且规则数量与包一致", (t) => {
  const { logs, io } = sandbox(t)
  assert.equal(runRules(["list", "--json"], io), 0)
  const payload = JSON.parse(logs.join("\n"))
  assert.equal(payload.rules.length, 23)
  assert.equal(payload.packs.reduce((n, p) => n + p.ruleCount, 0), 23)
  assert.ok(payload.dicts.includes("absolutes.en"))
})

test("pgh rules impact <已有规则>：只算这条规则带来的增量", (t) => {
  const { io, logs } = sandbox(t)
  assert.equal(runSnapshot(["--mock", "--now", NOW], io), 0)
  logs.length = 0
  assert.equal(runRules(["impact", "listing.claim.organic", "--now", NOW], io), 0)
  const text = logs.join("\n")
  assert.match(text, /新增 finding 1 条（required 1）/)
  assert.match(text, /it_b204e/)
})

test("pgh rules impact <候选文件>：上线前就能看到会多几条", (t) => {
  const { dir, io, logs } = sandbox(t)
  assert.equal(runSnapshot(["--mock", "--now", NOW], io), 0)
  const file = join(dir, "candidate.json")
  writeFileSync(file, JSON.stringify(CANDIDATE), "utf8")
  logs.length = 0
  assert.equal(runRules(["impact", file, "--now", NOW], io), 0)
  assert.match(logs.join("\n"), /新增 finding 1 条（suggest 1）/)
})

test("pgh rules impact 未知规则 → 退出码 1，并说清不是文件", (t) => {
  const { io, logs } = sandbox(t)
  assert.equal(runSnapshot(["--mock", "--now", NOW], io), 0)
  assert.equal(runRules(["impact", "listing.nope.nope"], io), 1)
  assert.match(logs.join("\n"), /找不到规则/)
})

test("pgh rules impact 候选规则不合法 → 退出码 1，不静默当成通过", (t) => {
  const { dir, io, logs } = sandbox(t)
  assert.equal(runSnapshot(["--mock", "--now", NOW], io), 0)
  const file = join(dir, "bad.json")
  writeFileSync(file, JSON.stringify({ ...CANDIDATE, kind: "deterministic", checks: [] }), "utf8")
  assert.equal(runRules(["impact", file], io), 1)
  assert.match(logs.join("\n"), /checks/)
})

test("pgh rules 缺子命令 / 未知子命令 → 退出码 2", (t) => {
  const { io } = sandbox(t)
  assert.equal(runRules([], io), 2)
  assert.equal(runRules(["nope"], io), 2)
  assert.equal(runRules(["--help"], io), 0)
})

test("pgh check --mock：结论 + 判不了都报出来", (t) => {
  const { io, logs } = sandbox(t)
  assert.equal(runCheck(["--mock", "--now", NOW], io), 0)
  const text = logs.join("\n")
  assert.match(text, /判定 8 个商品 · 23 条规则 · 3 个规则包/)
  assert.match(text, /finding 9 条 · 判不了 7 条/)
  assert.match(text, /blocker {2}it_8f21a/)
})

test("pgh check --mock --json：机器可读，findings 与 summary 一致", (t) => {
  const { io, logs } = sandbox(t)
  assert.equal(runCheck(["--mock", "--json", "--now", NOW], io), 0)
  const payload = JSON.parse(logs.join("\n"))
  assert.equal(payload.findings.length, 9)
  assert.equal(payload.items, 8)
  assert.equal(payload.rulesEvaluated, 23)
  for (const finding of payload.findings) {
    assert.ok(["quote", "absence", "element"].includes(finding.evidence.kind))
  }
})

test("pgh check --item 支持按 sku 过滤", (t) => {
  const { io, logs } = sandbox(t)
  assert.equal(runCheck(["--mock", "--item", "sh2309-dress-001", "--json", "--now", NOW], io), 0)
  const payload = JSON.parse(logs.join("\n"))
  assert.equal(payload.items, 1)
  assert.deepEqual([...new Set(payload.findings.map((f) => f.itemId))], ["it_8f21a"])
})

test("pgh check --item 找不到商品 → 退出码 1", (t) => {
  const { io, logs } = sandbox(t)
  assert.equal(runCheck(["--mock", "--item", "nope", "--now", NOW], io), 1)
  assert.match(logs.join("\n"), /找不到商品/)
})

test("pgh check 没有快照时给出可执行的提示", (t) => {
  const { io, logs } = sandbox(t)
  assert.equal(runCheck(["--now", NOW], io), 1)
  assert.match(logs.join("\n"), /先跑 pgh snapshot --mock/)
})

test("pgh check --mock 与 --snapshot 同时给 → 退出码 2", (t) => {
  const { io } = sandbox(t)
  assert.equal(runCheck(["--mock", "--snapshot", "/tmp/x.json"], io), 2)
})

test("pgh check --packs 指向坏目录 → 退出码 1，不是崩溃", (t) => {
  const { dir, io, logs } = sandbox(t)
  assert.equal(runCheck(["--mock", "--packs", join(dir, "nope")], io), 1)
  assert.match(logs.join("\n"), /读不了目录/)
})

test("main 路由：rules / check 都接上了", (t) => {
  const { io } = sandbox(t)
  assert.equal(main(["rules", "list"], io), 0)
  assert.equal(main(["check", "--mock", "--now", NOW], io), 0)
})
