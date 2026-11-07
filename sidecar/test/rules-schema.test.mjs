import assert from "node:assert/strict"
import test from "node:test"

import { validateDict, validatePack, validateRuleSet } from "../rules/schema.mjs"

const rule = (over = {}) => ({
  id: "listing.title.demo",
  title: "示例规则",
  severity: "required",
  kind: "deterministic",
  checks: [{ type: "field.required", path: "title" }],
  evidence: { quote: true, locate: "offset" },
  source: { status: "draft", clause: "3.1.1" },
  ...over,
})

const pack = (over = {}) => ({
  packId: "demo",
  platform: "marketplace-a",
  version: "2026.11.1",
  effectiveFrom: "2026-11-01",
  effectiveTo: null,
  source: { status: "draft", doc: "《演示规范》", clause: "第 1 章" },
  rules: [rule()],
  ...over,
})

const codes = (result) => result.errors.map((e) => e.code)

test("合法规则包通过校验", () => {
  assert.deepEqual(validatePack(pack()).errors, [])
})

test("id 带平台前缀被拒绝（换平台要能复用）", () => {
  const result = validatePack(pack({ rules: [rule({ id: "marketplace-a.title.demo" })] }))
  assert.ok(codes(result).includes("E_RULE_ID_PLATFORM"))
})

test("id 不足三段被拒绝", () => {
  assert.ok(codes(validatePack(pack({ rules: [rule({ id: "listing.title" })] }))).includes("E_RULE_ID"))
})

test("deterministic 空 checks 被拒绝：那条规则永远不会出结论", () => {
  assert.ok(codes(validatePack(pack({ rules: [rule({ checks: [] })] }))).includes("E_RULE_CHECKS_EMPTY"))
})

test("semantic 带 checks 被拒绝：引擎只产占位，不猜", () => {
  const result = validatePack(pack({ rules: [rule({ kind: "semantic" })] }))
  assert.ok(codes(result).includes("E_RULE_CHECKS_SEMANTIC"))
})

test("没有 source 条款的规则不许入库", () => {
  assert.ok(codes(validatePack(pack({ rules: [rule({ source: {} })] }))).includes("E_RULE_SOURCE"))
})

test("出处状态必须显式表态：缺 status 不许默认成已核实", () => {
  const bad = rule({ source: { clause: "3.1.1" } })
  assert.ok(codes(validatePack(pack({ rules: [bad] }))).includes("E_SOURCE_STATUS"))
  // 包级同样强制
  const badPack = pack({ source: { doc: "《演示规范》", clause: "第 1 章" } })
  assert.ok(codes(validatePack(badPack)).includes("E_SOURCE_STATUS"))
})

test("出处状态只有 draft / verified 两档", () => {
  const bad = rule({ source: { status: "ok", clause: "3.1.1" } })
  assert.ok(codes(validatePack(pack({ rules: [bad] }))).includes("E_SOURCE_STATUS"))
})

test("draft 不许挂链接：占位链接看着能点，就没人去核实了", () => {
  const bad = rule({ source: { status: "draft", clause: "3.1.1", url: "https://example.com/x" } })
  const result = validatePack(pack({ rules: [bad] }))
  assert.ok(codes(result).includes("E_SOURCE_DRAFT_URL"))
})

test("verified 必须给 http(s) 链接与抓取日期，缺一不可", () => {
  const noUrl = rule({ source: { status: "verified", clause: "3.1.1", retrievedAt: "2026-11-06" } })
  assert.ok(codes(validatePack(pack({ rules: [noUrl] }))).includes("E_SOURCE_URL"))

  const fakeUrl = rule({ source: { status: "verified", clause: "3.1.1", url: "待补", retrievedAt: "2026-11-06" } })
  assert.ok(codes(validatePack(pack({ rules: [fakeUrl] }))).includes("E_SOURCE_URL"))

  const noDate = rule({ source: { status: "verified", clause: "3.1.1", url: "https://example.com/x" } })
  assert.ok(codes(validatePack(pack({ rules: [noDate] }))).includes("E_SOURCE_RETRIEVED"))
})

test("verified 三件齐了才放行", () => {
  const good = rule({
    source: { status: "verified", clause: "3.1.1", url: "https://example.com/x", retrievedAt: "2026-11-06" },
  })
  assert.deepEqual(validatePack(pack({ rules: [good] })).errors, [])
})

test("四档之外的 severity 被拒绝", () => {
  assert.ok(codes(validatePack(pack({ rules: [rule({ severity: "critical" })] }))).includes("E_RULE_SEVERITY"))
})

test("回溯炸弹在入库时就被拒绝", () => {
  const bad = rule({ checks: [{ type: "text.match", path: "title", pattern: "(a+)+$" }] })
  assert.ok(codes(validatePack(pack({ rules: [bad] }))).includes("E_CHECK_PATTERN_RISK"))
})

test("未实现的 check 类型被拒绝，而不是跑起来才发现没实现", () => {
  const bad = rule({ checks: [{ type: "asset.meta", kind: "main_image", assert: {} }] })
  assert.ok(codes(validatePack(pack({ rules: [bad] }))).includes("E_CHECK_UNIMPLEMENTED"))
  const unknown = rule({ checks: [{ type: "text.vibes", path: "title" }] })
  assert.ok(codes(validatePack(pack({ rules: [unknown] }))).includes("E_CHECK_TYPE"))
})

test("text.length 的 min 大于 max 被拒绝", () => {
  const bad = rule({ checks: [{ type: "text.length", path: "title", min: 80, max: 10 }] })
  assert.ok(codes(validatePack(pack({ rules: [bad] }))).includes("E_CHECK_LENGTH"))
})

test("枚举值里掺平台名被拒绝", () => {
  const bad = rule({ checks: [{ type: "field.enum", path: "status", values: ["marketplace-a"] }] })
  assert.ok(codes(validatePack(pack({ rules: [bad] }))).includes("E_CHECK_PLATFORM_LEAK"))
})

test("包版本、生效期格式不对被拒绝", () => {
  assert.ok(codes(validatePack(pack({ version: "v1" }))).includes("E_PACK_VERSION"))
  assert.ok(codes(validatePack(pack({ effectiveFrom: "2026/11/01" }))).includes("E_PACK_FROM"))
  assert.ok(codes(validatePack(pack({ effectiveTo: "2026-10-01" }))).includes("E_PACK_RANGE"))
})

test("词典：重复词条（忽略大小写）与空词条被拒绝", () => {
  assert.ok(codes(validateDict({ name: "d", terms: ["Best", "best"] })).includes("E_DICT_DUP"))
  assert.ok(codes(validateDict({ name: "d", terms: ["ok", "  "] })).includes("E_DICT_TERM"))
  assert.ok(codes(validateDict({ name: "d", terms: [] })).includes("E_DICT_TERMS"))
})

test("跨包：规则 id 重复、引用不存在的词典都会被拒绝", () => {
  const dicts = new Map([["known", { name: "known", terms: ["x"] }]])
  const dup = validateRuleSet([pack(), pack({ packId: "other" })], dicts)
  assert.ok(codes(dup).includes("E_RULE_ID_DUP"))

  const missingDict = validateRuleSet(
    [pack({ rules: [rule({ checks: [{ type: "text.dictionary", path: "title", dict: "ghost" }] })] })],
    dicts,
  )
  assert.ok(codes(missingDict).includes("E_DICT_REF"))
})
