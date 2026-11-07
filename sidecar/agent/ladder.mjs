// 握手与降级阶梯 —— remote → claude-cli → replay → none（agent-acl §5、§6）。
//
// 铁律：**永远不写「如果 provider 是 X」**。谁能用由 provider 自己的 `probe()` 回答，
// 「产出是不是真实分析」由它自己的 `attribution()` 回答。这一层只做排队，
// 做判断的是 provider 自己 —— 这样加第四个服务时，这里一行都不用改。
//
// 另一个约束：降级必须留下**为什么**。只返回一个「用了 replay」而不说
// 「因为 claude 没装」，用户会以为自己的服务配好了。

import { CONTRACT_VERSION, CAPABILITIES_FLOOR, normalizeCapabilities } from "./contract.mjs"
import { PROVIDERS, createProvider } from "./providers/registry.mjs"

/**
 * 握手一个 provider。
 *
 * 三种失败都要能被解释：契约版本不匹配、自我探测失败、能力查询抛错。
 * 任何一种失败都不会抛出去 —— 调用方要的是「能不能用 + 为什么」，不是异常。
 *
 * @param {import("./provider.mjs").Provider} provider
 * @returns {Promise<import("./provider.mjs").Handshake>}
 */
export async function handshake(provider) {
  const id = provider.id()
  const declared = typeof provider.contractVersion === "function" ? provider.contractVersion() : CONTRACT_VERSION

  if (declared !== CONTRACT_VERSION) {
    return {
      ok: false,
      contractVersion: declared,
      provider: id,
      capabilities: { ...CAPABILITIES_FLOOR },
      reason: `适配器实现的是契约 v${declared}，内核是 v${CONTRACT_VERSION}`,
    }
  }

  let probe = { ok: true }
  if (typeof provider.probe === "function") {
    try {
      probe = await provider.probe()
    } catch (error) {
      probe = { ok: false, reason: `探测抛错：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  if (!probe.ok) {
    return {
      ok: false,
      contractVersion: declared,
      provider: id,
      capabilities: { ...CAPABILITIES_FLOOR },
      reason: probe.reason ?? "自我探测未通过",
    }
  }

  let capabilities
  try {
    capabilities = normalizeCapabilities(await provider.capabilities())
  } catch (error) {
    return {
      ok: false,
      contractVersion: declared,
      provider: id,
      capabilities: { ...CAPABILITIES_FLOOR },
      reason: `能力查询抛错：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return {
    ok: true,
    contractVersion: declared,
    provider: id,
    serverVersion: typeof provider.serverVersion === "function" ? provider.serverVersion() : undefined,
    capabilities,
  }
}

/**
 * 沿阶梯找一个能用的 provider，并给出降级说明。
 *
 * @param {{ config?: object, preferred?: string }} [options]
 * @returns {Promise<{
 *   provider: import("./provider.mjs").Provider | null,
 *   handshake: import("./provider.mjs").Handshake,
 *   degraded: boolean,
 *   reason: string | null,
 *   attempts: Array<{ provider: string, ok: boolean, reason?: string }>,
 * }>}
 */
export async function resolveAgent({ config = {}, preferred } = {}) {
  // 指定了 preferred 就只试它，不退让：静默换成别的 provider 会让人以为配好的那个在跑
  const order = preferred ? [preferred] : PROVIDERS.map((entry) => entry.id)
  const attempts = []

  for (const id of order) {
    let provider
    try {
      provider = createProvider(id, { config: config.agent?.[id] ?? config[id] })
    } catch (error) {
      attempts.push({ provider: id, ok: false, reason: error instanceof Error ? error.message : String(error) })
      continue
    }

    const result = await handshake(provider)
    attempts.push({ provider: id, ok: result.ok, reason: result.reason })

    if (result.ok) {
      const attribution = typeof provider.attribution === "function" ? provider.attribution() : { real: true, label: "" }
      const degraded = attribution.real !== true
      return {
        provider,
        handshake: result,
        degraded,
        // 降级的理由要具体：说清「用的是谁」和「为什么不是更前面的那个」
        reason: degraded
          ? attribution.label || "回放数据，不是真实分析"
          : attempts.length > 1
            ? `已按阶梯降级：${attempts.filter((a) => !a.ok).map((a) => `${a.provider} 不可用（${a.reason}）`).join("；")}`
            : null,
        attempts,
      }
    }
  }

  return {
    provider: null,
    handshake: {
      ok: false,
      contractVersion: CONTRACT_VERSION,
      provider: "none",
      capabilities: { ...CAPABILITIES_FLOOR },
      reason: "没有可用的 agent 服务",
    },
    degraded: true,
    reason: "没有可用的 agent 服务：助手面板禁用，事实层（快照 + 规则）照常可用",
    attempts,
  }
}
