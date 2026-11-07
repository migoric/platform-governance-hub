// 握手状态报告 —— 设置页读的就是这份，所以它自相矛盾的地方必须在这里拦住。
//
// 这个文件不测「本机装没装 claude」：那取决于开发机。测的是**关系**——
// 选中的那条必须握手成功、回放必须自报家门、失败必须给原因。

import assert from "node:assert/strict"
import test from "node:test"

import {
  buildAgentStatus,
  StatusValidationError,
  assertValidAgentStatus,
  providerConfigOf,
  validateAgentStatus,
} from "../agent/status.mjs"
import { listProviderIds } from "../agent/providers/registry.mjs"

function provider(overrides) {
  return {
    id: "p",
    ok: true,
    contractVersion: 1,
    serverVersion: null,
    capabilities: { streaming: true, tools: true, vision: false, cost: false, maxSteps: 8 },
    attribution: { real: true, label: "" },
    reason: null,
    selected: true,
    ...overrides,
  }
}

function report(overrides) {
  return {
    schemaVersion: 1,
    contractVersion: 1,
    preferred: null,
    selected: "p",
    degraded: false,
    reason: null,
    providers: [provider()],
    ...overrides,
  }
}

test("状态报告覆盖注册表里的每个 provider，且恰好选中一个", async () => {
  const status = await buildAgentStatus()
  assert.deepEqual(
    status.providers.map((entry) => entry.id),
    listProviderIds(),
    "顺序就是阶梯顺序，UI 按这个顺序摆",
  )
  assert.equal(status.providers.filter((entry) => entry.selected).length, 1)
  assert.ok(status.selected !== null, `本机至少 replay 可用：${status.reason}`)
  assert.equal(status.providers.find((entry) => entry.selected).id, status.selected)
})

test("回放必须自报家门，不能只说「可用」", async () => {
  const status = await buildAgentStatus({ preferred: "replay" })
  const replay = status.providers.find((entry) => entry.id === "replay")
  assert.equal(replay.attribution.real, false)
  assert.match(replay.attribution.label, /回放/)
  // 指定了 replay 之后不再退让，报告要老实说这次产出不是真实分析
  assert.equal(status.selected, "replay")
  assert.equal(status.degraded, true)
  assert.ok(status.reason && status.reason.length > 0, "降级必须给原因")
})

test("指定不可用的 provider 时不静默换人", async () => {
  const status = await buildAgentStatus({ preferred: "remote" })
  const remote = status.providers.find((entry) => entry.id === "remote")
  assert.equal(remote.ok, false)
  assert.ok(remote.reason && remote.reason.length > 0)
  assert.equal(status.selected, null, "preferred 失败就是没有可用服务，不是「退到 replay」")
  assert.match(status.reason, /没有可用的 agent 服务/)
})

test("配置里的 provider 配置节既认 agent.<id> 也认旧的顶层写法", () => {
  assert.deepEqual(providerConfigOf({ agent: { remote: { endpoint: "https://x" } } }, "remote"), {
    endpoint: "https://x",
  })
  assert.deepEqual(providerConfigOf({ remote: { endpoint: "https://y" } }, "remote"), { endpoint: "https://y" })
  assert.equal(providerConfigOf({}, "remote"), undefined)
})

test("合法的报告校验通过", () => {
  assert.deepEqual(validateAgentStatus(report()), [])
  const degraded = report({
    selected: "replay",
    degraded: true,
    reason: "回放数据，不是真实分析",
    providers: [provider({ id: "replay", attribution: { real: false, label: "回放数据，不是真实分析" } })],
  })
  assert.deepEqual(validateAgentStatus(degraded), [])
})

test("选中一个握手失败的 provider 是硬错误", () => {
  const bad = report({
    selected: "remote",
    providers: [provider({ id: "remote", ok: false, reason: "没配置" })],
  })
  const codes = validateAgentStatus(bad).map((e) => e.code)
  assert.ok(codes.includes("E_STATUS_SELECTED_UNAVAILABLE"), codes.join(","))
})

test("失败不给原因、回放不自报家门、降级不给理由都会被拦", () => {
  const bad = report({
    degraded: true,
    providers: [
      provider({ id: "remote", ok: false, reason: null }),
      provider({ id: "replay", selected: false, attribution: { real: false, label: "" } }),
    ],
  })
  const codes = validateAgentStatus(bad).map((e) => e.code)
  // 只断言这三条都在：这份构造故意同时带着别的毛病，全等会把它们一起锁死
  for (const code of ["E_STATUS_NO_REASON", "E_STATUS_NO_LABEL", "E_STATUS_DEGRADED_NO_REASON"]) {
    assert.ok(codes.includes(code), `${code} 没被拦：${codes.join(",")}`)
  }
})

test("重复的 provider id 与缺失的 providers 都拦", () => {
  assert.ok(
    validateAgentStatus(report({ providers: [provider(), provider()] })).some((e) => e.code === "E_STATUS_DUPLICATE"),
  )
  assert.ok(validateAgentStatus(report({ providers: [] })).some((e) => e.code === "E_STATUS_EMPTY"))
  assert.ok(validateAgentStatus(null).some((e) => e.code === "E_STATUS_TYPE"))
})

test("没有可用服务时必须解释，不能只给一个空 selected", () => {
  const bad = report({ selected: null, degraded: true, reason: null, providers: [provider({ ok: false, reason: "没装" })] })
  const codes = validateAgentStatus(bad).map((e) => e.code)
  assert.ok(codes.includes("E_STATUS_NO_PROVIDER"), codes.join(","))
})

test("assertValidAgentStatus 抛的是带明细的错误", () => {
  assert.throws(
    () => assertValidAgentStatus(report({ providers: [provider({ ok: false, reason: null })] })),
    (error) => error instanceof StatusValidationError && error.errors.length > 0,
  )
})

test("版本、类型、条目形状不对时都能定位到字段", () => {
  assert.ok(validateAgentStatus(report({ schemaVersion: 2 })).some((e) => e.code === "E_STATUS_SCHEMA"))

  const typed = validateAgentStatus(report({ selected: 42 }))
  assert.ok(typed.some((e) => e.code === "E_STATUS_SELECTED_TYPE"), typed.map((e) => e.code).join(","))

  const shape = validateAgentStatus(report({ providers: ["replay"] }))
  assert.ok(
    shape.some((e) => e.code === "E_STATUS_PROVIDER_TYPE" && e.path === "providers[0]"),
    shape.map((e) => `${e.code}@${e.path}`).join(","),
  )
})

test("selected 字段与各行的 selected 标记必须一致", () => {
  const bad = report({ selected: "p", providers: [provider({ selected: false })] })
  assert.ok(validateAgentStatus(bad).some((e) => e.code === "E_STATUS_SELECTED_FLAG"))
})
