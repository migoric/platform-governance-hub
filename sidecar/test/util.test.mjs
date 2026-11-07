import assert from "node:assert/strict"
import test from "node:test"

import { diffMs, formatDuration, parseLocalIso, toLocalIso } from "../util/dates.mjs"
import { hasSensitive, redact, redactDeep } from "../util/redact.mjs"

test("toLocalIso: UTC → 东八区", () => {
  assert.equal(toLocalIso(new Date("2026-11-06T17:12:00Z")), "2026-11-07T01:12:00+08:00")
})

test("toLocalIso: 负偏移", () => {
  assert.equal(toLocalIso(new Date("2026-11-06T17:12:00Z"), -300), "2026-11-06T12:12:00-05:00")
})

test("toLocalIso: 非法输入抛错", () => {
  assert.throws(() => toLocalIso(new Date("nope")), TypeError)
  assert.throws(() => toLocalIso(new Date("2026-11-06T00:00:00Z"), 15 * 60), RangeError)
})

test("parseLocalIso: 往返一致", () => {
  const text = "2026-11-07T01:12:00+08:00"
  assert.equal(toLocalIso(parseLocalIso(text)), text)
})

test("parseLocalIso: 格式不对与不存在的日期都抛错", () => {
  assert.throws(() => parseLocalIso("2026-11-07 01:12:00"), TypeError)
  assert.throws(() => parseLocalIso("2026-02-30T00:00:00+08:00"), RangeError)
})

test("diffMs: 后减前", () => {
  assert.equal(diffMs("2026-11-07T00:00:00+08:00", "2026-11-07T00:02:14+08:00"), 134_000)
})

test("formatDuration: 三档", () => {
  assert.equal(formatDuration(45_000), "45 秒")
  assert.equal(formatDuration(134_000), "2 分 14 秒")
  assert.equal(formatDuration(120_000), "2 分")
  assert.equal(formatDuration(3_720_000), "1 时 2 分")
  assert.throws(() => formatDuration(-1), RangeError)
})

test("redact: 手机号 / 邮箱", () => {
  const { text, hits } = redact("联系 13812345678 或 a.b@example.com")
  assert.equal(text, "联系 138****5678 或 a***@example.com")
  assert.deepEqual(
    hits.map((h) => h.id).sort(),
    ["email", "phone"],
  )
})

test("redact: 凭据串（按片段拼，仓库里不留字面前缀）", () => {
  const fake = ["gh", "p_"].join("") + "A".repeat(24)
  const { text, hits } = redact(`token=${fake}`)
  assert.ok(!text.includes(fake))
  assert.equal(hits[0].id, "credential")
})

test("redact: 纯文本不动", () => {
  const { text, hits } = redact("标题含绝对化用词")
  assert.equal(text, "标题含绝对化用词")
  assert.equal(hits.length, 0)
})

test("redactDeep: 递归处理字符串，键名不动", () => {
  const input = { email: "a@b.com", nested: { list: ["13812345678"] }, n: 3, ok: true, nil: null }
  const out = redactDeep(input)
  assert.equal(out.email, "a***@b.com")
  assert.deepEqual(out.nested.list, ["138****5678"])
  assert.equal(out.n, 3)
  assert.equal(out.ok, true)
  assert.equal(out.nil, null)
})

test("hasSensitive: 脱敏前后", () => {
  assert.equal(hasSensitive("a.b@example.com"), true)
  assert.equal(hasSensitive("没有敏感信息"), false)
})
