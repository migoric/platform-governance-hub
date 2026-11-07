// 工具面测试 —— 只读、脱敏、截断这三条是硬约束，不是「注意一下」。
//
// 断言的落点：agent 能拿到什么、拿到的有没有被加工过、加工有没有被说出来。

import assert from "node:assert/strict"
import test from "node:test"

import { MAX_PAYLOAD_BYTES, SNAPSHOT_SECTIONS, TOOLS, invokeTool, listTools } from "../agent/tools.mjs"

const SNAPSHOT = {
  summary: { items: 2, findings: 1 },
  items: [
    { id: "it_a", itemId: "it_a", title: "正常标题" },
    { id: "it_b", itemId: "it_b", title: "联系 13812345678 或 a@b.com" },
  ],
  findings: [
    { id: "fd_1", itemId: "it_a", ruleId: "listing.title.absolute_terms", severity: "blocker", evidence: { kind: "quote", offset: 0, length: 4 } },
  ],
  rulePacks: [{ id: "baseline", sourceStatus: "draft" }],
  unjudged: [{ ruleId: "listing.claim.organic", reason: "requires_semantic" }],
}

const RULE = {
  id: "listing.title.absolute_terms",
  title: "标题不得使用绝对化用语",
  severity: "blocker",
  source: { status: "draft", clause: "3.2.1" },
}

const ruleSet = { byId: new Map([[RULE.id, { packId: "baseline", packVersion: "2026.11.1", rule: RULE }]]) }
const ctx = () => ({ snapshot: structuredClone(SNAPSHOT), ruleSet })

test("工具表只有只读工具，且都写了说明", () => {
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    ["snapshot_query", "rule_lookup", "evidence_get", "impact_estimate"],
  )
  for (const tool of TOOLS) {
    assert.equal(tool.readOnly, true, `${tool.name} 必须是只读`)
    assert.ok(tool.description.length > 8, `${tool.name} 说明太短，模型看不出能干什么`)
  }
  assert.deepEqual(
    listTools().map((t) => t.name),
    TOOLS.map((t) => t.name),
  )
})

test("快照分区名是封闭集，写错就报错而不是返回空", () => {
  assert.deepEqual([...SNAPSHOT_SECTIONS], ["items", "findings", "rulePacks", "unjudged", "summary"])
  const result = invokeTool("snapshot_query", { section: "orders" }, ctx())
  assert.equal(result.ok, false)
  assert.match(result.summary, /封闭集/)
})

test("snapshot_query 能按 itemId 过滤", () => {
  const result = invokeTool("snapshot_query", { section: "items", itemId: "it_a" }, ctx())
  assert.equal(result.ok, true)
  assert.equal(result.data.length, 1)
  assert.equal(result.data[0].id, "it_a")
})

test("返回值一律脱敏：手机号与邮箱不原样出去", () => {
  const result = invokeTool("snapshot_query", { section: "items", itemId: "it_b" }, ctx())
  const text = JSON.stringify(result.data)
  assert.ok(!text.includes("13812345678"), `手机号没打码：${text}`)
  assert.ok(!text.includes("a@b.com"), `邮箱没打码：${text}`)
})

test("超上限按条裁剪，并且明说被截断了", () => {
  const big = {
    snapshot: { items: Array.from({ length: 400 }, (_, i) => ({ id: `it_${i}`, title: "x".repeat(200) })) },
    ruleSet,
  }
  const result = invokeTool("snapshot_query", { section: "items" }, big)
  assert.equal(result.ok, true)
  assert.equal(result.truncated, true)
  assert.ok(result.bytes > MAX_PAYLOAD_BYTES)
  assert.ok(result.data.length < 400, "应该只返回装得下的那部分")
  assert.match(result.summary, /已截断/, "截断必须写在 summary 里，不能瞒着模型")
  assert.match(result.note, /前 \d+ 条/)
})

test("工具不修改事实层：ctx 前后一致", () => {
  const base = ctx()
  const before = JSON.stringify(base)
  invokeTool("snapshot_query", { section: "findings" }, base)
  invokeTool("rule_lookup", { ruleId: RULE.id }, base)
  invokeTool("impact_estimate", { ruleId: RULE.id }, base)
  assert.equal(JSON.stringify(base), before)
})

test("rule_lookup 会如实说明出处是否核实", () => {
  const result = invokeTool("rule_lookup", { ruleId: RULE.id }, ctx())
  assert.equal(result.ok, true)
  assert.equal(result.data.sourceVerified, false)
  assert.match(result.summary, /未核实/)
})

test("evidence_get 只给元信息，不给二进制", () => {
  const result = invokeTool("evidence_get", { findingId: "fd_1" }, ctx())
  assert.equal(result.ok, true)
  assert.equal(result.data.evidence.kind, "quote")
  assert.ok(!("binary" in result.data))
})

test("impact_estimate 数的是现状，不重跑引擎", () => {
  const result = invokeTool("impact_estimate", { ruleId: RULE.id }, ctx())
  assert.equal(result.ok, true)
  assert.equal(result.data.currentFindings, 1)
  assert.equal(result.data.unjudged, 0)
})

test("缺参数、不存在的 id、未注册的工具都返回 ok:false，不抛异常", () => {
  for (const [name, args] of [
    ["snapshot_query", {}],
    ["rule_lookup", {}],
    ["rule_lookup", { ruleId: "nope.nope.nope" }],
    ["evidence_get", { findingId: "ghost" }],
    ["not_a_tool", {}],
  ]) {
    const result = invokeTool(name, args, ctx())
    assert.equal(result.ok, false, `${name} 应当失败`)
    assert.ok(result.summary.length > 0, `${name} 失败也要有话说`)
  }
})

test("超限且无法按条裁剪时，宁可不给也不给半截对象", () => {
  const huge = { snapshot: { summary: { note: "x".repeat(MAX_PAYLOAD_BYTES + 100) } }, ruleSet }
  const result = invokeTool("snapshot_query", { section: "summary" }, huge)
  assert.equal(result.ok, true)
  assert.equal(result.truncated, true)
  assert.equal(result.data, null, "对象裁一半会变成假数据")
  assert.match(result.note, /缩小查询范围/)
})

test("summary 是对象也能查（不是数组的分支）", () => {
  const result = invokeTool("snapshot_query", { section: "summary" }, ctx())
  assert.equal(result.ok, true)
  assert.equal(result.data.items, 2)
})

test("快照缺失时工具报「没有这个分区」，而不是返回空数组当没事", () => {
  const result = invokeTool("snapshot_query", { section: "items" }, { snapshot: null, ruleSet })
  assert.equal(result.ok, false)
  assert.match(result.summary, /没有 items/)
})
