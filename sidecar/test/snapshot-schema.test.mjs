import assert from "node:assert/strict"
import test from "node:test"

import { assertValidSnapshot, buildMockSnapshot } from "../snapshot/build.mjs"
import { getPath, SnapshotValidationError, validateSnapshot } from "../snapshot/schema.mjs"

const NOW = new Date("2026-11-06T17:12:00Z")

const codes = (result) => result.errors.map((e) => e.code)

test("mock 快照本身合法", () => {
  const snapshot = buildMockSnapshot({ now: NOW })
  const result = validateSnapshot(snapshot)
  assert.deepEqual(result.errors, [])
  assert.equal(result.ok, true)
})

test("同一 now 两次生成字节级一致", () => {
  assert.equal(JSON.stringify(buildMockSnapshot({ now: NOW })), JSON.stringify(buildMockSnapshot({ now: NOW })))
})

test("mock 的 summary 与实际数组一致（一个数字一个计算处）", () => {
  const snapshot = buildMockSnapshot({ now: NOW })
  assert.equal(snapshot.summary.items, snapshot.items.length)
  assert.equal(snapshot.summary.findings, snapshot.findings.length)
  const total = Object.values(snapshot.summary.bySeverity).reduce((a, b) => a + b, 0)
  assert.equal(total, snapshot.findings.length)
})

test("每个 finding 的 quote 都能按 offset 命中原文", () => {
  const snapshot = buildMockSnapshot({ now: NOW })
  for (const finding of snapshot.findings) {
    const item = snapshot.items.find((it) => it.id === finding.itemId)
    const value = getPath(item, finding.evidence.field)
    assert.equal(value.slice(finding.evidence.offset, finding.evidence.offset + finding.evidence.length), finding.evidence.quote)
  }
})

test("quote 与 offset 不符 → 硬失败", () => {
  const snapshot = buildMockSnapshot({ now: NOW })
  snapshot.findings[0].evidence.offset += 1
  const result = validateSnapshot(snapshot)
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes("E_EVIDENCE_QUOTE_MISS"))
})

test("severity 加第五档 → 拒绝", () => {
  const snapshot = buildMockSnapshot({ now: NOW })
  snapshot.findings[0].severity = "critical"
  assert.ok(codes(validateSnapshot(snapshot)).includes("E_SEVERITY"))
})

test("kind 不在三档 → 拒绝", () => {
  const snapshot = buildMockSnapshot({ now: NOW })
  snapshot.findings[0].kind = "llm"
  assert.ok(codes(validateSnapshot(snapshot)).includes("E_KIND"))
})

test("sourceRef 不以 rule:/doc: 开头 → 拒绝", () => {
  const snapshot = buildMockSnapshot({ now: NOW })
  snapshot.findings[0].evidence.sourceRef = "somewhere"
  assert.ok(codes(validateSnapshot(snapshot)).includes("E_EVIDENCE_SOURCE"))
})

test("finding 指向不存在的 item → 拒绝", () => {
  const snapshot = buildMockSnapshot({ now: NOW })
  snapshot.findings[0].itemId = "it_missing"
  assert.ok(codes(validateSnapshot(snapshot)).includes("E_FINDING_ITEM"))
})

test("summary.bySeverity 与实际条数不符 → 拒绝", () => {
  const snapshot = buildMockSnapshot({ now: NOW })
  snapshot.summary.bySeverity.blocker += 1
  assert.ok(codes(validateSnapshot(snapshot)).includes("E_SUMMARY_SEVERITY"))
})

test("summary.findings 与实际条数不符 → 拒绝", () => {
  const snapshot = buildMockSnapshot({ now: NOW })
  snapshot.summary.findings += 1
  assert.ok(codes(validateSnapshot(snapshot)).includes("E_SUMMARY_COUNT"))
})

test("titleLen 与 title.length 漂移 → 拒绝", () => {
  const snapshot = buildMockSnapshot({ now: NOW })
  snapshot.items[0].listing.titleLen += 1
  assert.ok(codes(validateSnapshot(snapshot)).includes("E_TITLE_LEN_DRIFT"))
})

test("schemaVersion 不对 → 拒绝", () => {
  const snapshot = buildMockSnapshot({ now: NOW })
  snapshot.schemaVersion = 2
  assert.ok(codes(validateSnapshot(snapshot)).includes("E_SCHEMA_VERSION"))
})

test("source.kind 不在封闭集 → 拒绝", () => {
  const snapshot = buildMockSnapshot({ now: NOW })
  snapshot.source.kind = "scrape"
  assert.ok(codes(validateSnapshot(snapshot)).includes("E_SOURCE_KIND"))
})

test("出现 undefined / 非有限数 → 拒绝", () => {
  const snapshot = buildMockSnapshot({ now: NOW })
  snapshot.items[0].attrs.material = Number.POSITIVE_INFINITY
  snapshot.extra = undefined
  assert.ok(codes(validateSnapshot(snapshot)).includes("E_UNSAFE_VALUE"))
})

test("rulePack 声明了 rules 时，finding.ruleId 必须在其中", () => {
  const snapshot = buildMockSnapshot({ now: NOW })
  snapshot.rulePacks = [{ ...snapshot.rulePacks[0], rules: ["listing.title.absolute_terms"] }]
  const result = validateSnapshot(snapshot)
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes("E_FINDING_RULE"))
})

test("item id 重复 → 拒绝", () => {
  const snapshot = buildMockSnapshot({ now: NOW })
  snapshot.items.push({ ...snapshot.items[0] })
  assert.ok(codes(validateSnapshot(snapshot)).includes("E_ITEM_DUP"))
})

test("assertValidSnapshot 失败时抛带全部错误的异常", () => {
  const snapshot = buildMockSnapshot({ now: NOW })
  snapshot.findings[0].severity = "critical"
  snapshot.schemaVersion = 9
  try {
    assertValidSnapshot(snapshot)
    assert.fail("应当抛错")
  } catch (error) {
    assert.ok(error instanceof SnapshotValidationError)
    assert.ok(error.errors.length >= 2)
    assert.match(error.message, /校验失败/)
  }
})

test("getPath: 点号路径与缺失键", () => {
  const item = { title: "x", listing: { price: { current: 1 } } }
  assert.equal(getPath(item, "listing.price.current"), 1)
  assert.equal(getPath(item, "listing.missing.deep"), undefined)
  assert.equal(getPath(item, ""), undefined)
})
