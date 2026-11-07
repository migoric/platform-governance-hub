// 规则质量的硬约束（docs/rule-library.md §9）：每条规则必须有正例与反例。
//
// 没有反例的规则，测试只证明「它有时会响」，证明不了「它不乱响」。
// 这个文件遍历**规则库本身**，缺 fixture 直接失败 —— 加规则的人没法偷懒。

import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import test from "node:test"

import { evaluate } from "../domain/rules-engine.mjs"
import { defaultRuleSet } from "../rules/default.mjs"

const NOW = "2026-11-07T01:12:00+08:00"
const ruleSet = defaultRuleSet()
const FIXTURE_DIR = new URL("./fixtures/rules/", import.meta.url)

function fixtureFor(ruleId) {
  const file = new URL(`${ruleId}.json`, FIXTURE_DIR)
  return JSON.parse(readFileSync(file, "utf8"))
}

test("每条规则都有 fixtures/rules/<id>.json", () => {
  const present = new Set(readdirSync(FIXTURE_DIR).map((name) => name.replace(/\.json$/, "")))
  const missing = ruleSet.rules.map(({ rule }) => rule.id).filter((id) => !present.has(id))
  assert.deepEqual(missing, [], `缺正例/反例的规则：${missing.join(", ")}`)
})

for (const { rule } of ruleSet.rules) {
  test(`正反例：${rule.id}`, () => {
    const fixture = fixtureFor(rule.id)
    assert.equal(fixture.ruleId, rule.id)
    assert.ok(fixture.positive.length > 0, "必须有正例")
    assert.ok(fixture.negative.length > 0, "必须有反例")

    const single = { packId: "fixture", packVersion: "2099.01.01", rule }
    const run = (items) => evaluate({ items, rules: [single], dicts: ruleSet.dicts, judgedAt: NOW })

    const onPositive = run(fixture.positive)
    const onNegative = run(fixture.negative)

    if (rule.kind === "deterministic") {
      assert.equal(onPositive.findings.length >= 1, true, `${rule.id} 正例没出结论`)
      assert.equal(onNegative.findings.length, 0, `${rule.id} 反例被误判`)
      // 有结论就必须带得上证据：对不上等于没有证据
      for (const finding of onPositive.findings) {
        assert.notEqual(finding.evidence.kind, undefined)
        assert.equal(finding.ruleId, rule.id)
      }
    } else {
      assert.equal(onPositive.findings.length, 0, `${rule.kind} 规则不该产结论`)
      assert.equal(onPositive.unjudged.length, 1, `${rule.kind} 规则应产且只产一条待判占位`)
      assert.equal(onNegative.unjudged.length, 0, "反例不在 scope 内，不该有待判")
    }
  })
}
