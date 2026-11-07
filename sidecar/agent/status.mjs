// 握手状态报告 —— 设置页的**唯一**数据源（agent-acl §5、§10 第 5 步）。
//
// 为什么不让 UI 自己跑 `pgh agent list`：那样「哪个能用、为什么不能用、产出算不算
// 真实分析」会在终端与窗口里各算一遍。设置页要答的正是这三个问题，所以答案必须
// 由 sidecar 算一次、落成一份文件（`~/.pgh/agent/status.json`），UI 只摆。
//
// 这一层不判断 provider 名字：能不能用问 `probe()`，产出是不是真实分析问
// `attribution()`。加第四个服务时这里一行都不用改。

import { CAPABILITIES_FLOOR, CONTRACT_VERSION } from "./contract.mjs"
import { handshake, resolveAgent } from "./ladder.mjs"
import { createProvider, listProviderIds } from "./providers/registry.mjs"

export const STATUS_SCHEMA_VERSION = 1

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v)
const nonEmpty = (v) => typeof v === "string" && v.trim() !== ""
const message = (error) => (error instanceof Error ? error.message : String(error))

/**
 * provider 自己的配置节：`config.agent.<id>`，兼容旧写法 `config.<id>`。
 * 阶梯与 CLI 必须用同一套取法，否则「设置页显示已配置、实际没读到」。
 *
 * @param {Record<string, unknown>} config
 * @param {string} id
 */
export function providerConfigOf(config, id) {
  const agent = isObj(config?.agent) ? config.agent : undefined
  return agent?.[id] ?? config?.[id]
}

/**
 * 造一个「这条 provider 现在什么样」的记录。
 *
 * 失败也要有记录：只列出能用的 provider，等于把「你配过但配错了」从界面上删掉。
 *
 * @param {import("./provider.mjs").Provider} provider
 */
async function describe(provider) {
  const result = await handshake(provider)
  // 没实现 attribution 的适配器一律按「不是真实分析」算。默认成 true 才是真的危险。
  const attribution =
    typeof provider.attribution === "function"
      ? provider.attribution()
      : { real: false, label: "未声明产出归属" }

  return {
    id: provider.id(),
    ok: result.ok,
    contractVersion: result.contractVersion,
    serverVersion: result.serverVersion ?? null,
    capabilities: { ...CAPABILITIES_FLOOR, ...(result.capabilities ?? {}) },
    attribution: { real: attribution?.real === true, label: attribution?.label ?? "" },
    reason: result.reason ?? null,
    selected: false,
  }
}

/**
 * 探一遍所有注册的 provider，并说明当前会用谁。
 *
 * `preferred` 来自配置。指定了就只试它 —— 和 `resolveAgent` 的语义一致：
 * 静默换成别的服务会让人以为配好的那个在跑。
 *
 * 注意这里会握手两次（列表一次、`resolveAgent` 一次）。刻意不复用：复用就得把
 * 阶梯的选择逻辑抄一份到这里，而那正是「两处各写一遍，迟早对不上」。
 * 多探一次的代价只是几十毫秒，`probe()` 本身不做网络请求。
 *
 * @param {{ config?: Record<string, unknown>, preferred?: string | null }} [options]
 */
export async function buildAgentStatus({ config = {}, preferred = null } = {}) {
  const providers = []
  for (const id of listProviderIds()) {
    try {
      providers.push(await describe(createProvider(id, { config: providerConfigOf(config, id) })))
    } catch (error) {
      // 造不出来（注册表写错、构造抛错）也要占一行，不能从列表里消失
      providers.push({
        id,
        ok: false,
        contractVersion: CONTRACT_VERSION,
        serverVersion: null,
        capabilities: { ...CAPABILITIES_FLOOR },
        attribution: { real: false, label: "未声明产出归属" },
        reason: message(error),
        selected: false,
      })
    }
  }

  const resolved = await resolveAgent({ config, preferred: preferred ?? undefined })
  const selected = resolved.provider?.id() ?? null
  for (const provider of providers) provider.selected = provider.id === selected

  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    preferred: preferred ?? null,
    selected,
    // degraded 的意思只有一个：**产出不能当真实分析用**（不表示「发生过降级」）。
    // 阶梯跳过了别人但选中的是真服务时，degraded 为 false，跳过原因在 reason 里。
    degraded: resolved.degraded,
    reason: resolved.reason ?? null,
    providers,
  }
}

/** 报告自相矛盾的地方。设置页照着显示，所以「选中了一个握手失败的」必须拦下。 */
export class StatusValidationError extends Error {
  constructor(message, errors = []) {
    super(message)
    this.name = "StatusValidationError"
    this.errors = errors
  }
}

/**
 * 校验状态报告。规则只有四条，都对应一个会被用户看见的谎：
 * 失败没原因、回放没自报家门、选中了不可用的、降级了不说为什么。
 *
 * @param {unknown} report
 * @returns {Array<{ code: string, path: string, message: string }>}
 */
export function validateAgentStatus(report) {
  const errors = []
  const err = (code, path, text) => errors.push({ code, path, message: text })

  if (!isObj(report)) {
    err("E_STATUS_TYPE", "", "状态报告必须是对象")
    return errors
  }
  if (report.schemaVersion !== STATUS_SCHEMA_VERSION) {
    err("E_STATUS_SCHEMA", "schemaVersion", `版本应为 ${STATUS_SCHEMA_VERSION}，实际是 ${report.schemaVersion}`)
  }
  const providers = Array.isArray(report.providers) ? report.providers : []
  if (providers.length === 0) err("E_STATUS_EMPTY", "providers", "至少要列出注册表里的 provider")

  const seen = new Set()
  providers.forEach((provider, index) => {
    const at = `providers[${index}]`
    if (!isObj(provider)) {
      err("E_STATUS_PROVIDER_TYPE", at, "provider 记录必须是对象")
      return
    }
    if (!nonEmpty(provider.id)) err("E_STATUS_ID", `${at}.id`, "provider 必须有 id")
    else if (seen.has(provider.id)) err("E_STATUS_DUPLICATE", `${at}.id`, `重复的 provider：${provider.id}`)
    else seen.add(provider.id)

    if (provider.ok !== true && !nonEmpty(provider.reason)) {
      err("E_STATUS_NO_REASON", `${at}.reason`, `${provider.id ?? "?"} 不可用，但没给原因`)
    }
    // 回放/模拟必须自报家门（agent-acl §6 第 1 条）：只画一个灰点不算说明
    if (provider.attribution?.real === false && !nonEmpty(provider.attribution?.label)) {
      err("E_STATUS_NO_LABEL", `${at}.attribution.label`, `${provider.id ?? "?"} 不是真实分析，但没说是什么`)
    }
  })

  if (report.selected === null) {
    if (!nonEmpty(report.reason)) err("E_STATUS_NO_PROVIDER", "reason", "没有任何可用 provider 时必须说明")
  } else if (typeof report.selected !== "string") {
    err("E_STATUS_SELECTED_TYPE", "selected", "selected 只能是 provider id 或 null")
  } else {
    const hit = providers.find((provider) => isObj(provider) && provider.id === report.selected)
    if (!hit) err("E_STATUS_SELECTED_UNKNOWN", "selected", `选中的 ${report.selected} 不在列表里`)
    else if (hit.ok !== true) err("E_STATUS_SELECTED_UNAVAILABLE", "selected", `选中的 ${report.selected} 握手失败`)
    else if (hit.selected !== true) err("E_STATUS_SELECTED_FLAG", "selected", "selected 字段与各行的 selected 标记不一致")
  }

  if (report.degraded === true && !nonEmpty(report.reason)) {
    err("E_STATUS_DEGRADED_NO_REASON", "reason", "降级必须给原因，否则用户以为服务配好了")
  }
  return errors
}

/**
 * 校验不过就抛。落盘前调用 —— 设置页不该展示一份自相矛盾的报告。
 * @param {unknown} report
 */
export function assertValidAgentStatus(report) {
  const errors = validateAgentStatus(report)
  if (errors.length > 0) {
    throw new StatusValidationError(
      `状态报告不合法（${errors.length} 处）：${errors.slice(0, 3).map((e) => `${e.code}@${e.path}`).join("；")}`,
      errors,
    )
  }
  return report
}
