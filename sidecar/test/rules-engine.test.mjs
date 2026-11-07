import assert from "node:assert/strict"
import test from "node:test"

import { evaluate, matchesScope } from "../domain/rules-engine.mjs"
import { defaultRuleSet } from "../rules/default.mjs"

const NOW = "2026-11-07T01:12:00+08:00"
const ruleSet = defaultRuleSet()

const ITEM = {
  id: "it_t1",
  title: "Plain Cotton T Shirt",
  category: ["女装"],
  site: "US",
  status: "on_sale",
  attrs: { material: "Cotton", origin: "CN", ageGroup: "adult" },
  listing: { description: "daily wear", price: { current: 9.9, currency: "USD" } },
}

const run = (items, rules = ruleSet.rules) => evaluate({ items, rules, dicts: ruleSet.dicts, judgedAt: NOW })

test("同一份输入连跑十次，输出字节级一致", () => {
  const first = JSON.stringify(run([ITEM]))
  for (let i = 0; i < 10; i++) assert.equal(JSON.stringify(run([ITEM])), first)
})

test("遍历顺序不影响结果：规则与商品都倒序，输出仍相同", () => {
  const forward = JSON.stringify(run([ITEM]))
  const backward = JSON.stringify(run([ITEM], [...ruleSet.rules].reverse()))
  assert.equal(backward, forward)
})

test("blocker 排在最前，四档按权重降序", () => {
  const items = [
    { ...ITEM, id: "it_a", title: "Best Cotton Tee" },
    { ...ITEM, id: "it_b", title: "Cotton Tee -20%" },
  ]
  const { findings } = run(items)
  assert.ok(findings.length >= 2)
  const ranks = findings.map((f) => ["blocker", "required", "suggest", "observe"].indexOf(f.severity))
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b))
})

test("输入不可变：判定不往 item / rule 上写东西", () => {
  const items = [{ ...ITEM }]
  const before = JSON.stringify({ items, rules: ruleSet.rules })
  run(items)
  assert.equal(JSON.stringify({ items, rules: ruleSet.rules }), before)
})

test("缺字段用 absence 证据，且 quote 为空、offset 与 length 为 0", () => {
  const item = { ...ITEM, listing: { price: { current: 9.9, currency: "USD" } } }
  const { findings } = run([item])
  const finding = findings.find((f) => f.ruleId === "listing.description.required")
  assert.ok(finding, "缺描述应该出结论")
  assert.equal(finding.evidence.kind, "absence")
  assert.equal(finding.evidence.quote, "")
  assert.equal(finding.evidence.offset, 0)
  assert.equal(finding.evidence.length, 0)
})

test("数组字段用 element 证据，指向出问题的那个元素", () => {
  const item = { ...ITEM, category: ["武器", "仿真枪"] }
  const { findings } = run([item])
  const finding = findings.find((f) => f.ruleId === "category.region.blocked")
  assert.ok(finding)
  assert.equal(finding.evidence.kind, "element")
  assert.equal(finding.evidence.elementIndex, 0)
  assert.equal(finding.evidence.quote, "武器")
})

test("语义 / 人工规则只产待判占位，不产结论", () => {
  const { findings, unjudged } = run([ITEM])
  assert.equal(findings.some((f) => f.ruleId.startsWith("eu.")), false)
  const semantic = unjudged.find((u) => u.ruleId === "listing.description.efficacy_claim")
  assert.equal(semantic, undefined, "女装商品不在美妆 scope 里，不该有待判")
  const watermark = unjudged.find((u) => u.ruleId === "listing.image.watermark")
  assert.equal(watermark.reason, "requires_semantic")
})

test("词典不存在 → 记 unjudged，不是静默通过", () => {
  const rule = {
    id: "test.dict.missing",
    title: "词典缺失",
    severity: "required",
    kind: "deterministic",
    checks: [{ type: "text.dictionary", path: "title", dict: "nope", mode: "any" }],
    evidence: { quote: true },
  }
  const { findings, unjudged } = run([ITEM], [{ packId: "test", packVersion: "1.0.0", rule }])
  assert.equal(findings.length, 0)
  assert.equal(unjudged[0].reason, "dict_missing")
  assert.match(unjudged[0].detail, /nope/)
})

test("正则回溯炸弹：静态拒绝 + 20ms 内放弃 + 记 unjudged", () => {
  const rule = {
    id: "test.regex.bomb",
    title: "会被拒绝的正则",
    severity: "required",
    kind: "deterministic",
    checks: [{ type: "text.match", path: "title", pattern: "(a+)+$" }],
    evidence: { quote: true },
  }
  const item = { ...ITEM, title: "a".repeat(2000) + "!" }
  const startedAt = process.hrtime.bigint()
  const { findings, unjudged } = run([item], [{ packId: "test", packVersion: "1.0.0", rule }])
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6

  assert.equal(findings.length, 0)
  assert.equal(unjudged[0].reason, "pattern_rejected")
  assert.match(unjudged[0].detail, /嵌套量词/)
  assert.ok(elapsedMs < 20, `必须在 20ms 内放弃，实际 ${elapsedMs.toFixed(1)}ms`)
})

test("一条 check 抛异常不影响其他规则", () => {
  const broken = {
    id: "test.check.broken",
    title: "会抛异常的规则",
    severity: "blocker",
    kind: "deterministic",
    checks: [null],
    evidence: { quote: true },
  }
  const good = {
    id: "test.check.good",
    title: "正常规则",
    severity: "blocker",
    kind: "deterministic",
    checks: [{ type: "text.dictionary", path: "title", dict: "absolutes.en", mode: "any" }],
    evidence: { quote: true },
  }
  const item = { ...ITEM, title: "Best Cotton T Shirt" }
  const { findings, unjudged } = run([item], [broken, good].map((rule) => ({ packId: "t", packVersion: "1.0.0", rule })))
  assert.equal(unjudged[0].reason, "check_threw")
  assert.equal(findings.length, 1)
  assert.equal(findings[0].ruleId, "test.check.good")
})

test("judgedAt 必须由调用方注入且带时区", () => {
  assert.throws(() => evaluate({ items: [ITEM], rules: [], dicts: new Map() }), /judgedAt/)
  assert.throws(() => evaluate({ items: [ITEM], rules: [], dicts: new Map(), judgedAt: "2026-11-07" }), /judgedAt/)
})

test("scope：缺省与空数组都算全匹配，通配符不是字面量", () => {
  const item = { ...ITEM, site: "FR", category: ["家电"] }
  assert.equal(matchesScope(undefined, item), true)
  assert.equal(matchesScope({}, item), true)
  assert.equal(matchesScope({ sites: [] }, item), true)
  assert.equal(matchesScope({ sites: ["*"] }, item), true)
  assert.equal(matchesScope({ sites: ["US"] }, item), false)
  assert.equal(matchesScope({ sites: ["*"], categories: ["家电"] }, item), true)
  assert.equal(matchesScope({ categories: ["女装"], sites: ["*"] }, item), false)
})

test("finding id 由 ruleId 与 itemId 组成，重复调用不漂移", () => {
  const item = { ...ITEM, title: "Best Cotton T Shirt" }
  const a = run([item]).findings[0]
  const b = run([item]).findings[0]
  assert.equal(a.id, b.id)
  assert.equal(a.id, `fd_${a.ruleId}@${a.itemId}`)
})
