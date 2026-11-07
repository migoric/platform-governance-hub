import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { loadCandidateRules, loadRuleSet } from "../rules/load.mjs"
import { RuleValidationError } from "../rules/schema.mjs"

const RULE = {
  id: "demo.title.required",
  title: "标题必填",
  severity: "required",
  kind: "deterministic",
  checks: [{ type: "field.required", path: "title" }],
  evidence: { quote: true, locate: "offset" },
  source: { clause: "1.1" },
}

const PACK = {
  packId: "demo",
  platform: "marketplace-a",
  version: "2026.11.1",
  effectiveFrom: "2026-11-01",
  effectiveTo: null,
  source: { doc: "《演示规范》", clause: "第 1 章" },
  rules: [RULE],
}

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "pgh-ruleset-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, "packs"), { recursive: true })
  mkdirSync(join(dir, "dicts"), { recursive: true })
  return dir
}

test("内置规则集：3 个包 23 条规则，byId 能按 id 反查", () => {
  const ruleSet = loadRuleSet()
  assert.equal(ruleSet.packs.length, 3)
  assert.equal(ruleSet.rules.length, 23)
  assert.equal(ruleSet.dicts.size, 8)
  assert.deepEqual(ruleSet.packMeta.map((p) => p.ruleCount), [16, 4, 3])
  assert.equal(ruleSet.byId.get("listing.claim.organic").packVersion, "2026.11.1")
})

test("自建目录：只读 packs/ 与 dicts/，词条顺序保留", (t) => {
  const dir = sandbox(t)
  writeFileSync(join(dir, "packs", "demo@2026.11.1.json"), JSON.stringify(PACK), "utf8")
  writeFileSync(join(dir, "dicts", "words.json"), JSON.stringify({ name: "words", terms: ["b", "a"] }), "utf8")
  const ruleSet = loadRuleSet(dir)
  assert.equal(ruleSet.rules.length, 1)
  assert.deepEqual(ruleSet.dicts.get("words").terms, ["b", "a"])
})

test("坏 JSON 带文件名报错，不静默跳过", (t) => {
  const dir = sandbox(t)
  writeFileSync(join(dir, "packs", "broken.json"), "{ nope", "utf8")
  assert.throws(() => loadRuleSet(dir), (error) => {
    assert.ok(error instanceof RuleValidationError)
    assert.match(error.message, /不是合法 JSON/)
    return true
  })
})

test("词典 name 与文件名不一致 → 拒绝（引用靠 name，改名等于引用失效）", (t) => {
  const dir = sandbox(t)
  writeFileSync(join(dir, "packs", "demo@2026.11.1.json"), JSON.stringify(PACK), "utf8")
  writeFileSync(join(dir, "dicts", "file-name.json"), JSON.stringify({ name: "other-name", terms: ["x"] }), "utf8")
  assert.throws(() => loadRuleSet(dir), /不一致/)
})

test("目录不存在 → 报错而不是当成空规则集", (t) => {
  const dir = sandbox(t)
  rmSync(join(dir, "packs"), { recursive: true, force: true })
  assert.throws(() => loadRuleSet(dir), /读不了目录/)
})

test("候选规则：单条对象 / 数组 / {rules:[]} 三种写法都认", (t) => {
  const dir = sandbox(t)
  const single = join(dir, "single.json")
  writeFileSync(single, JSON.stringify(RULE), "utf8")
  assert.equal(loadCandidateRules(single).length, 1)

  const many = join(dir, "many.json")
  writeFileSync(many, JSON.stringify([RULE, { ...RULE, id: "demo.title.length" }]), "utf8")
  assert.equal(loadCandidateRules(many).length, 2)

  const wrapped = join(dir, "wrapped.json")
  writeFileSync(wrapped, JSON.stringify({ rules: [RULE] }), "utf8")
  assert.equal(loadCandidateRules(wrapped).length, 1)
})

test("候选规则不合法 → 抛错，不会悄悄上线一条坏规则", (t) => {
  const dir = sandbox(t)
  const bad = join(dir, "bad.json")
  writeFileSync(bad, JSON.stringify({ ...RULE, severity: "critical" }), "utf8")
  assert.throws(() => loadCandidateRules(bad), /severity/)

  const notJson = join(dir, "notjson.json")
  writeFileSync(notJson, "nope", "utf8")
  assert.throws(() => loadCandidateRules(notJson), /不是合法 JSON/)
})
