import assert from "node:assert/strict"
import test from "node:test"

import { compilePattern, execBudgeted, PatternCache, REGEX_BUDGET_MS, staticRisk } from "../domain/regex-guard.mjs"

test("嵌套量词在编译前就被拒绝", () => {
  assert.match(staticRisk("(a+)+$"), /嵌套量词/)
  assert.match(staticRisk("(\\w*)*x"), /嵌套量词/)
  assert.match(staticRisk("(.*){2,}"), /嵌套量词/)
})

test("正常 pattern 不被误伤", () => {
  for (const ok of ["\\b100\\s?%", "-\\s?\\d{1,2}\\s?%", "\\b\\d+(?:\\.\\d+)?\\s?(?:L|ml|oz)\\b", "^[a-z]{2}\\d{4}$"]) {
    assert.equal(staticRisk(ok), null, ok)
  }
})

test("超长 pattern 与空 pattern 都拒绝", () => {
  assert.match(staticRisk("a".repeat(201)), /超过/)
  assert.match(staticRisk(""), /为空/)
  assert.match(staticRisk(undefined), /必须是字符串/)
})

test("语法错误在编译期暴露，不等到调用", () => {
  const compiled = compilePattern("(unclosed")
  assert.equal(compiled.ok, false)
  assert.match(compiled.reason, /语法错误/)
})

test("execBudgeted 返回命中区间与原文", () => {
  const compiled = compilePattern("\\b100\\s?%")
  const hit = execBudgeted(compiled, "100% Cotton Tee")
  assert.deepEqual(hit, { ok: true, hit: { index: 0, quote: "100%" } })
  assert.deepEqual(execBudgeted(compiled, "Cotton Tee"), { ok: true, hit: null })
})

test("执行超过预算就报失败，而不是把慢当正常", () => {
  const slow = {
    ok: true,
    regex: {
      exec: () => {
        const until = Date.now() + REGEX_BUDGET_MS + 15
        while (Date.now() < until) {
          // 故意忙等：模拟一条跑超预算的正则
        }
        return null
      },
    },
  }
  const result = execBudgeted(slow, "x")
  assert.equal(result.ok, false)
  assert.match(result.reason, /超过 20ms 预算/)
})

test("熔断：同一条坏 pattern 只跑一次，之后不再执行", () => {
  const cache = new PatternCache()
  const first = cache.run("(a+)+$", "aaaa")
  assert.equal(first.ok, false)
  // 第二次不会再编译或执行 —— 直接返回上一次的失败原因
  const second = cache.run("(a+)+$", "aaaa")
  assert.equal(second.ok, false)
  assert.equal(second.reason, first.reason)
  assert.equal(cache.entries.size, 1)
})

test("熔断只针对坏 pattern：好 pattern 反复可用", () => {
  const cache = new PatternCache()
  assert.deepEqual(cache.run("L", "1L"), { ok: true, hit: { index: 1, quote: "L" } })
  assert.deepEqual(cache.run("L", "1L"), { ok: true, hit: { index: 1, quote: "L" } })
})
