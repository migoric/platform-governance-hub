// provider 注册表 —— 接新服务时只在这里追加一行（agent-acl §10 第 2 步）。
//
// 数组顺序就是降级阶梯的顺序：越靠前越强。阶梯不另写一份名字列表 ——
// 两处各写一遍，迟早对不上。
//
// `_template.mjs` 故意不注册：它是给人复制的骨架，注册进来会让
// 「每个 provider 都有 fixture」的门禁把它当成真 provider 查。

import { createClaudeCliProvider } from "./claude-cli.mjs"
import { createReplayProvider } from "./replay.mjs"
import { createRemoteProvider } from "./remote.mjs"

/** @typedef {{ id: string, create: (options?: object) => import("../provider.mjs").Provider }} Entry */

/** @type {Entry[]} */
export const PROVIDERS = [
  { id: "remote", create: createRemoteProvider },
  { id: "claude-cli", create: createClaudeCliProvider },
  { id: "replay", create: createReplayProvider },
]

/** @returns {string[]} 按阶梯顺序排列的 provider id */
export function listProviderIds() {
  return PROVIDERS.map((entry) => entry.id)
}

/**
 * 按 id 造 provider。不认识就抛错 —— 静默回退到 replay 会让人以为
 * 「配错了但能用」，排查成本远高于直接失败。
 * @param {string} id
 * @param {object} [options]
 */
export function createProvider(id, options = {}) {
  const entry = PROVIDERS.find((p) => p.id === id)
  if (!entry) {
    throw new Error(`不认识的 provider：${id}（可选：${listProviderIds().join(" / ")}）`)
  }
  return entry.create(options)
}
