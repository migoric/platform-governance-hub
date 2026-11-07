// M0 的任务列表 mock —— 四种状态各一条，用来给出图基准（ui-ia.md §8 要求四态各一张 PNG）。
//
// 耗时由这里算好再写进文件（`diffMs`），UI 只显示不重算：一个数字只能有一个计算处（ui-ia.md §5）。

import { diffMs, toLocalIso } from "../util/dates.mjs"
import { TASKS_SCHEMA_VERSION } from "./tasks.mjs"

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * 造一份合法的任务列表 mock。
 * @param {{ now?: Date }} [options]
 * @returns {object}
 */
export function buildMockTasks({ now = new Date() } = {}) {
  if (!(now instanceof Date)) throw new TypeError("buildMockTasks: now 必须是 Date")
  const at = (offsetMs) => toLocalIso(new Date(now.getTime() - offsetMs))

  const runningStart = at(2 * MINUTE + 14_000)
  const awaitingStart = at(8 * MINUTE)
  const doneStart = at(1 * HOUR)
  const doneEnd = at(40 * MINUTE)
  const interruptedStart = at(3 * HOUR)
  const interruptedEnd = at(3 * HOUR - 5 * MINUTE)

  return {
    schemaVersion: TASKS_SCHEMA_VERSION,
    generatedAt: toLocalIso(now),
    source: { kind: "mock" },
    tasks: [
      {
        id: "tk_8c31",
        title: "把上周新增的 12 条 blocker 逐条解释一遍",
        state: "running",
        agents: ["条款研究员"],
        origin: "replay",
        startedAt: runningStart,
        endedAt: null,
        durationMs: diffMs(runningStart, toLocalIso(now)),
        stepCount: 12,
      },
      {
        id: "tk_2f47",
        title: "这批童鞋的电池资质要不要先下架",
        state: "awaiting",
        agents: ["风险审阅员"],
        origin: "replay",
        startedAt: awaitingStart,
        endedAt: null,
        durationMs: diffMs(awaitingStart, toLocalIso(now)),
        stepCount: 21,
      },
      {
        id: "tk_9b05",
        title: "生成 10 月合规报告草稿",
        state: "done",
        agents: ["报告撰写员"],
        origin: "replay",
        startedAt: doneStart,
        endedAt: doneEnd,
        durationMs: diffMs(doneStart, doneEnd),
        stepCount: 34,
      },
      {
        id: "tk_4e1a",
        title: "核对 DE 站点的容量单位要求",
        state: "interrupted",
        agents: ["条款研究员"],
        origin: "replay",
        startedAt: interruptedStart,
        endedAt: interruptedEnd,
        durationMs: diffMs(interruptedStart, interruptedEnd),
        stepCount: 7,
      },
    ],
  }
}
