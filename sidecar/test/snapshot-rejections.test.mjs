import assert from "node:assert/strict"
import test from "node:test"

import { buildMockSnapshot } from "../snapshot/build.mjs"
import { validateSnapshot } from "../snapshot/schema.mjs"

const NOW = new Date("2026-11-06T17:12:00Z")

const cases = [
  ["顶层不是对象", (s) => null, "E_SHAPE"],
  ["items 不是数组", (s) => ({ ...s, items: {} }), "E_ITEMS"],
  ["findings 不是数组", (s) => ({ ...s, findings: {} }), "E_FINDINGS"],
  ["scope 不是对象", (s) => ({ ...s, scope: [] }), "E_SCOPE"],
  ["rulePacks 不是数组", (s) => ({ ...s, rulePacks: {} }), "E_RULE_PACKS"],
  ["source 缺失", (s) => ({ ...s, source: null }), "E_SOURCE"],
  ["generatedAt 不合法", (s) => ({ ...s, generatedAt: "2026-11-07" }), "E_GENERATED_AT"],
  ["durationMs 为负", (s) => ({ ...s, durationMs: -1 }), "E_DURATION"],
  ["summary 缺失", (s) => ({ ...s, summary: null }), "E_SUMMARY_SHAPE"],
  ["summary 计数类型错", (s) => ({ ...s, summary: { ...s.summary, items: "8" } }), "E_SUMMARY_COUNT"],
  ["bySeverity 缺一档", (s) => {
    const bySeverity = { ...s.summary.bySeverity }
    delete bySeverity.observe
    return { ...s, summary: { ...s.summary, bySeverity } }
  }, "E_SUMMARY_SEVERITY"],
  ["bySeverity 多一档", (s) => ({
    ...s,
    summary: { ...s.summary, bySeverity: { ...s.summary.bySeverity, critical: 0 } },
  }), "E_SUMMARY_SEVERITY"],
  ["item 不是对象", (s) => ({ ...s, items: ["x", ...s.items.slice(1)] }), "E_ITEM_SHAPE"],
  ["item 缺 id", (s) => ({ ...s, items: [{ ...s.items[0], id: "" }, ...s.items.slice(1)] }), "E_ITEM_ID"],
  ["item 缺 title", (s) => ({ ...s, items: [{ ...s.items[0], title: "" }, ...s.items.slice(1)] }), "E_ITEM_TITLE"],
  ["item site 为空", (s) => ({ ...s, items: [{ ...s.items[0], site: "" }, ...s.items.slice(1)] }), "E_ITEM_SITE"],
  ["item status 不在封闭集", (s) => ({ ...s, items: [{ ...s.items[0], status: "live" }, ...s.items.slice(1)] }), "E_ITEM_STATUS"],
  ["item category 不是数组", (s) => ({ ...s, items: [{ ...s.items[0], category: "女装" }, ...s.items.slice(1)] }), "E_ITEM_CATEGORY"],
  ["item listing 不是对象", (s) => ({ ...s, items: [{ ...s.items[0], listing: "x" }, ...s.items.slice(1)] }), "E_ITEM_LISTING"],
  ["titleLen 类型错", (s) => ({
    ...s,
    items: [{ ...s.items[0], listing: { ...s.items[0].listing, titleLen: "8" } }, ...s.items.slice(1)],
  }), "E_TITLE_LEN"],
  ["finding 不是对象", (s) => ({ ...s, findings: ["x", ...s.findings.slice(1)] }), "E_FINDING_SHAPE"],
  ["finding 缺 id", (s) => ({ ...s, findings: [{ ...s.findings[0], id: "" }, ...s.findings.slice(1)] }), "E_FINDING_ID"],
  ["finding 缺 ruleVersion", (s) => ({ ...s, findings: [{ ...s.findings[0], ruleVersion: "" }, ...s.findings.slice(1)] }), "E_FINDING_RULE_VERSION"],
  ["finding 缺 message", (s) => ({ ...s, findings: [{ ...s.findings[0], message: "" }, ...s.findings.slice(1)] }), "E_FINDING_MESSAGE"],
  ["finding status 不在封闭集", (s) => ({ ...s, findings: [{ ...s.findings[0], status: "openx" }, ...s.findings.slice(1)] }), "E_FINDING_STATUS"],
  ["finding judgedAt 缺时区", (s) => ({ ...s, findings: [{ ...s.findings[0], judgedAt: "2026-11-07" }, ...s.findings.slice(1)] }), "E_FINDING_TIME"],
  ["evidence 缺失", (s) => ({ ...s, findings: [{ ...s.findings[0], evidence: null }, ...s.findings.slice(1)] }), "E_EVIDENCE_SHAPE"],
  ["evidence.field 为空", (s) => ({ ...s, findings: [{ ...s.findings[0], evidence: { ...s.findings[0].evidence, field: "" } }, ...s.findings.slice(1)] }), "E_EVIDENCE_FIELD"],
  ["evidence.quote 类型错", (s) => ({ ...s, findings: [{ ...s.findings[0], evidence: { ...s.findings[0].evidence, quote: 1 } }, ...s.findings.slice(1)] }), "E_EVIDENCE_QUOTE"],
  ["evidence.offset 为负", (s) => ({ ...s, findings: [{ ...s.findings[0], evidence: { ...s.findings[0].evidence, offset: -1 } }, ...s.findings.slice(1)] }), "E_EVIDENCE_OFFSET"],
  ["evidence.length 为负", (s) => ({ ...s, findings: [{ ...s.findings[0], evidence: { ...s.findings[0].evidence, length: -1 } }, ...s.findings.slice(1)] }), "E_EVIDENCE_LENGTH"],
  ["evidence.length 与 quote 不等", (s) => ({ ...s, findings: [{ ...s.findings[0], evidence: { ...s.findings[0].evidence, length: 99 } }, ...s.findings.slice(1)] }), "E_EVIDENCE_LENGTH"],
  ["evidence 指向非字符串字段", (s) => ({ ...s, findings: [{ ...s.findings[0], evidence: { ...s.findings[0].evidence, field: "listing.price.current", offset: 0, length: 2, quote: "12" } }, ...s.findings.slice(1)] }), "E_EVIDENCE_QUOTE_MISS"],
  ["finding 缺 sourceRef", (s) => ({ ...s, findings: [{ ...s.findings[0], evidence: { ...s.findings[0].evidence, sourceRef: "" } }, ...s.findings.slice(1)] }), "E_EVIDENCE_SOURCE"],
  ["finding 缺 ruleId", (s) => ({ ...s, findings: [{ ...s.findings[0], ruleId: "" }, ...s.findings.slice(1)] }), "E_FINDING_RULE"],
  ["finding 缺 itemId 对应 item", (s) => ({ ...s, findings: [{ ...s.findings[0], itemId: undefined }, ...s.findings.slice(1)] }), "E_FINDING_ITEM"],
]

for (const [name, mutate, expected] of cases) {
  test(`拒绝：${name} → ${expected}`, () => {
    const base = buildMockSnapshot({ now: NOW })
    const mutated = mutate(structuredClone(base))
    const result = validateSnapshot(mutated)
    assert.equal(result.ok, false)
    assert.ok(
      result.errors.some((e) => e.code === expected),
      `期望 ${expected}，实际 ${result.errors.map((e) => e.code).join(", ")}`,
    )
  })
}
