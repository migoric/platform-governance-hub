// replay provider —— 回放录好的事件序列（agent-acl §6 降级阶梯的最底层）。
//
// 存在的理由：断网、没装 claude、公司网关没配好，这三种情况都真实存在。
// 这时助手仍然要能「用」——只是必须明说这是回放，不是真实分析。
//
// 它也是最诚实的一个 provider：产出完全确定，可以字节级断言，
// 所以 conformance 测试拿它当基准。

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { Event, normalizeCapabilities } from "../contract.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
/** 归一化后的事件序列放这里；原始录制（SSE / stream-json）放 test/fixtures/agent/。 */
export const FIXTURES_DIR = join(HERE, "..", "fixtures")

/**
 * 读一份 jsonl 事件文件。空行跳过；`//` 开头的行当注释（人工维护 fixture 时好用）。
 * @param {string} file
 * @returns {object[]}
 */
export function loadEvents(file) {
  const raw = readFileSync(file, "utf8")
  const events = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("//")) continue
    events.push(JSON.parse(trimmed))
  }
  return events
}

/**
 * 造一个 replay provider。
 *
 * @param {{ file?: string, delayMs?: number }} [options]
 *   `delayMs` 默认 0：测试要快，也避免「回放比真实还慢」的笑话。
 * @returns {import("../provider.mjs").Provider}
 */
export function createReplayProvider({ file, delayMs = 0 } = {}) {
  const filePath = file ?? join(FIXTURES_DIR, "replay.jsonl")
  const events = loadEvents(filePath)

  const started = events.find((e) => e.kind === Event.STARTED)
  const capabilities = normalizeCapabilities(started?.capabilities)

  let cancelled = false

  return {
    id: () => "replay",

    /**
     * 这份产出不是真实分析。UI 必须据此标注 —— 不标就是骗人（agent-acl §6 第 1 条）。
     * 由 provider 自己声明，而不是让上层按名字猜。
     */
    attribution() {
      return { real: false, label: "回放数据，不是真实分析" }
    },

    async capabilities() {
      return capabilities
    },

    /**
     * 逐条回放。已发出的 `done` 之后不再补事件 —— 收尾事件只许有一个。
     * 取消时若 fixture 还没发 done，补一条 `cancelled`（铁律 5 的另一半）。
     */
    async *start() {
      cancelled = false
      let sawDone = false
      for (const event of events) {
        if (cancelled) break
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
        yield event
        if (event.kind === Event.DONE) {
          sawDone = true
          break
        }
      }
      if (!sawDone) {
        yield { kind: Event.DONE, reason: cancelled ? "cancelled" : "ok" }
      }
    },

    async cancel() {
      cancelled = true
    },
  }
}
