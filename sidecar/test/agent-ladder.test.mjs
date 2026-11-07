// 握手与降级阶梯 —— 重点不是「选了谁」，而是「为什么没选更前面那个」。
//
// 这些测试不假设测试机装了什么：断言的是**行为性质**
// （选中的一定是 registry 里的、一定有握手结果、降级一定有理由），
// 而不是「本机一定没有 claude」这种会随机器变化的结论。

import assert from "node:assert/strict"
import test from "node:test"

import { CONTRACT_VERSION, CAPABILITIES_FLOOR } from "../agent/contract.mjs"
import { handshake, resolveAgent } from "../agent/ladder.mjs"
import { createProvider, listProviderIds } from "../agent/providers/registry.mjs"

test("注册表顺序就是阶梯顺序，越靠前越强", () => {
  assert.deepEqual(listProviderIds(), ["remote", "claude-cli", "replay"])
})

test("阶梯：选中的 provider 一定握手通过，且不被静默替换", async () => {
  const result = await resolveAgent()
  if (result.provider === null) {
    // 全都不行时也要有解释，不能返回一个空壳
    assert.equal(result.handshake.provider, "none")
    assert.ok(result.reason.length > 0)
    return
  }
  assert.equal(result.handshake.ok, true)
  assert.ok(listProviderIds().includes(result.provider.id()))
  // attempts 记录了试过谁、为什么不行 —— 排查全靠它
  assert.ok(result.attempts.length >= 1)
  for (const attempt of result.attempts) {
    assert.equal(typeof attempt.ok, "boolean")
    if (!attempt.ok) assert.ok(attempt.reason, `${attempt.provider} 失败却没给理由`)
  }
})

test("指定 provider 时只试它，不静默退到别的", async () => {
  const result = await resolveAgent({ preferred: "replay" })
  assert.equal(result.provider?.id(), "replay")
  assert.equal(result.attempts.length, 1, "指定了就不该去试别人")
  assert.equal(result.attempts[0].provider, "replay")
})

test("只剩回放时必须标成降级并说清是回放", async () => {
  const result = await resolveAgent({ preferred: "replay" })
  assert.equal(result.degraded, true)
  assert.match(result.reason ?? "", /回放/)
})

test("不认识的 provider 报错，而不是退回默认", async () => {
  const result = await resolveAgent({ preferred: "gpt-9" })
  assert.equal(result.provider, null)
  assert.match(result.attempts[0].reason ?? "", /不认识的 provider/)
})

test("握手：契约版本不一致直接拒绝，并说明各自版本", async () => {
  const fake = {
    id: () => "fake",
    contractVersion: () => CONTRACT_VERSION + 1,
    capabilities: async () => ({ ...CAPABILITIES_FLOOR }),
  }
  const result = await handshake(fake)
  assert.equal(result.ok, false)
  assert.match(result.reason, /v\d+/)
  assert.equal(result.contractVersion, CONTRACT_VERSION + 1)
})

test("握手：探测抛错也要变成结论，不能把异常抛给调用方", async () => {
  const fake = {
    id: () => "boom",
    probe: async () => {
      throw new Error("网络挂了")
    },
    capabilities: async () => ({ ...CAPABILITIES_FLOOR }),
  }
  const result = await handshake(fake)
  assert.equal(result.ok, false)
  assert.match(result.reason, /网络挂了/)
})

test("握手：能力查询抛错同样不抛出去", async () => {
  const fake = {
    id: () => "boom2",
    capabilities: async () => {
      throw new Error("握手后崩了")
    },
  }
  const result = await handshake(fake)
  assert.equal(result.ok, false)
  assert.match(result.reason, /握手后崩了/)
})

test("remote 没配置时握手失败，理由点名缺什么", async () => {
  const result = await handshake(createProvider("remote", {}))
  assert.equal(result.ok, false)
  assert.match(result.reason ?? "", /endpoint|未配置/)
})

test("remote 配了 endpoint 但协议未接入时，失败理由要说清是哪一步", async () => {
  const provider = createProvider("remote", { config: { endpoint: "https://hub.example" } })
  const result = await handshake(provider)
  assert.equal(result.ok, false)
  assert.match(result.reason ?? "", /协议尚未接入|对端未就绪/)

  // 直接起会话也要失败得合规：先 started，再 error，最后 done
  const events = []
  for await (const event of provider.start({ prompt: "x" })) events.push(event)
  assert.deepEqual(events.map((e) => e.kind), ["started", "error", "done"])
  assert.equal(events[1].code, "E_REMOTE_NOT_IMPLEMENTED")
  assert.equal(events[2].reason, "error")
})

test("remote 未配置时，直接起会话也先发 started（失败也要失败得合规）", async () => {
  const events = []
  for await (const event of createProvider("remote", {}).start({ prompt: "x" })) events.push(event)
  assert.deepEqual(events.map((e) => e.kind), ["started", "error", "done"])
  assert.equal(events[1].code, "E_REMOTE_NOT_CONFIGURED")
})

test("provider 的 cancel 与 attribution 都能调（接口完整性）", async () => {
  for (const id of listProviderIds()) {
    const provider = createProvider(id, {})
    assert.doesNotThrow(() => provider.id())
    if (typeof provider.attribution === "function") {
      const attr = provider.attribution()
      assert.equal(typeof attr.real, "boolean")
      assert.equal(typeof attr.label, "string")
    }
    await provider.cancel()
  }
  // 回放必须自认不是真实分析
  assert.equal(createProvider("replay").attribution().real, false)
  // 真实服务自认真实
  assert.equal(createProvider("claude-cli").attribution().real, true)
})
