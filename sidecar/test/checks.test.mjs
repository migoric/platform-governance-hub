import assert from "node:assert/strict"
import test from "node:test"

import { findTermHits, runCheck } from "../domain/checks.mjs"
import { PatternCache } from "../domain/regex-guard.mjs"

const dicts = new Map([
  ["absolutes", { name: "absolutes", terms: ["best", "no.1"] }],
  ["pair", { name: "pair", terms: ["repair", "cure"] }],
  ["allow", { name: "allow", terms: ["cotton", "linen"] }],
])
const ctx = () => ({ dicts, patterns: new PatternCache() })

const item = {
  id: "it_c1",
  title: "Best Cotton T Shirt",
  category: ["女装", "T恤"],
  attrs: { material: "100% Cotton", empty: "", zeros: [] },
  listing: { price: { current: 9.9 } },
  status: "on_sale",
  count: 3,
}

test("词典命中：ASCII 词按词边界，英文大小写不敏感", () => {
  assert.deepEqual(findTermHits("Best shirt", ["best"]), [{ term: "best", index: 0, quote: "Best" }])
  assert.deepEqual(findTermHits("bestseller shirt", ["best"]), [], "bestseller 不该命中 best")
  assert.deepEqual(findTermHits("BEST shirt", ["best"]), [{ term: "best", index: 0, quote: "BEST" }])
})

test("词典命中：中文按子串，同位置取更长的词", () => {
  const hits = findTermHits("史上最贵的裙子", ["最", "史上最"])
  assert.equal(hits[0].term, "史上最")
  assert.equal(hits[0].index, 0)
  assert.equal(hits[0].quote, "史上最")
})

test("text.dictionary mode=all：全部命中才算违规", () => {
  const check = { type: "text.dictionary", path: "title", dict: "pair", mode: "all" }
  assert.equal(runCheck(check, { title: "repair only" }, ctx()).status, "pass")
  const hit = runCheck(check, { title: "repair and cure" }, ctx())
  assert.equal(hit.status, "violation")
  assert.equal(hit.evidence.quote, "repair")
})

test("text.dictionary mode=exclude：白名单，一个词都没有才违规", () => {
  const check = { type: "text.dictionary", path: "attrs.material", dict: "allow", mode: "exclude" }
  assert.equal(runCheck(check, item, ctx()).status, "pass")
  const miss = runCheck(check, { attrs: { material: "polyester" } }, ctx())
  assert.equal(miss.status, "violation")
  assert.equal(miss.evidence.kind, "absence")
})

test("text.length：过短与过长都违规，长度按码点算", () => {
  const check = (over) => ({ type: "text.length", path: "title", ...over })
  assert.equal(runCheck(check({ min: 10 }), { title: "short" }, ctx()).status, "violation")
  assert.equal(runCheck(check({ max: 3 }), { title: "a long title" }, ctx()).status, "violation")
  assert.equal(runCheck(check({ min: 3, max: 80 }), { title: "ok title" }, ctx()).status, "pass")
  // emoji 算 1 个字：4 个字符，不是 7 个 UTF-16 单元
  const emoji = runCheck({ type: "text.length", path: "title", min: 4, max: 4 }, { title: "👗👗👗👗" }, ctx())
  assert.equal(emoji.status, "pass")
})

test("字段不是字符串 / 不存在 → unjudged，不当成通过", () => {
  assert.equal(runCheck({ type: "text.length", path: "count", min: 1 }, item, ctx()).status, "unjudged")
  assert.equal(runCheck({ type: "text.length", path: "nope", min: 1 }, item, ctx()).status, "unjudged")
  assert.equal(runCheck({ type: "text.match", path: "count", pattern: "3" }, item, ctx()).status, "unjudged")
  assert.equal(runCheck({ type: "text.dictionary", path: "nope", dict: "absolutes" }, item, ctx()).status, "unjudged")
})

test("field.required：空串、纯空白、空数组、缺失都算未填", () => {
  const check = { type: "field.required", path: "attrs.empty" }
  assert.equal(runCheck(check, item, ctx()).status, "violation")
  assert.equal(runCheck({ ...check, path: "attrs.zeros" }, item, ctx()).status, "violation")
  assert.equal(runCheck({ ...check, path: "attrs.nope" }, item, ctx()).status, "violation")
  assert.equal(runCheck({ ...check, path: "attrs.material" }, item, ctx()).status, "pass")
  assert.equal(runCheck({ ...check, path: "attrs" }, { attrs: { a: "   " } }, ctx()).status, "pass")
})

test("field.enum：不在集合里违规；值缺失或不是字符串 → 判不了", () => {
  const check = { type: "field.enum", path: "status", values: ["on_sale"] }
  assert.equal(runCheck(check, item, ctx()).status, "pass")
  assert.equal(runCheck({ ...check, values: ["draft"] }, item, ctx()).status, "violation")
  assert.equal(runCheck({ ...check, path: "nope" }, item, ctx()).status, "unjudged")
  const numeric = runCheck({ ...check, path: "count" }, item, ctx())
  assert.equal(numeric.status, "unjudged")
  assert.equal(numeric.reason, "value_not_string")
})

test("list.contains：命中数组元素才违规，非数组判不了", () => {
  const check = { type: "list.contains", path: "category", values: ["禁售"], mode: "any" }
  assert.equal(runCheck(check, item, ctx()).status, "pass")
  const hit = runCheck(check, { category: ["女装", "禁售"] }, ctx())
  assert.equal(hit.status, "violation")
  assert.equal(hit.evidence.elementIndex, 1)
  assert.equal(hit.evidence.quote, "禁售")
  assert.equal(runCheck({ ...check, path: "title" }, item, ctx()).reason, "field_not_array")
  assert.equal(runCheck({ ...check, path: "nope" }, item, ctx()).reason, "field_missing")
})

test("未实现的 check 类型直接判不了，不是崩溃也不是通过", () => {
  const result = runCheck({ type: "asset.meta", path: "assets" }, item, ctx())
  assert.equal(result.status, "unjudged")
  assert.equal(result.reason, "check_type_unsupported")
})

test("词典不存在 / 正则被拒绝 → unjudged 且带原因", () => {
  const noDict = runCheck({ type: "text.dictionary", path: "title", dict: "ghost" }, item, ctx())
  assert.equal(noDict.reason, "dict_missing")
  const bomb = runCheck({ type: "text.match", path: "title", pattern: "(a+)+$" }, item, ctx())
  assert.equal(bomb.reason, "pattern_rejected")
})
