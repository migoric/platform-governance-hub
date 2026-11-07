// `pgh snapshot` —— M0 只有 --mock。
//
// 落盘规则（snapshot-contract §1.5）：默认紧凑单行；`--pretty` 给人看，但仍走同一条校验。
// 校验不过一律非零退出且**不写盘**：App 宁可继续读上一份合法快照，也不要读半截。

import { assertValidSnapshot, buildMockSnapshot } from "../../snapshot/build.mjs"
import { SnapshotValidationError } from "../../snapshot/schema.mjs"
import { parseLocalIso } from "../../util/dates.mjs"
import { parseFlags, UsageError } from "../args.mjs"
import { snapshotPath, stringify, writeAtomic } from "../fs.mjs"

export const SNAPSHOT_USAGE = `用法：pgh snapshot --mock [--out <文件>] [--pretty] [--now <ISO 时间>]

  --mock            生成一份虚构的 mock 快照（M0 唯一支持的数据源）
  --out <文件>       写到指定路径（默认写到 stdout）
  --pretty          JSON 缩进输出（落盘仍是紧凑单行，除非也给了 --out）
  --now <ISO8601>   固定生成时间，用于出图与回归对比`

/**
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, stdout?: (s: string) => void, stderr?: (s: string) => void }} [io]
 * @returns {number} 退出码
 */
export function runSnapshot(argv, { env = process.env, stdout = console.log, stderr = console.error } = {}) {
  let parsed
  try {
    parsed = parseFlags(argv, { booleans: ["mock", "pretty", "help"], strings: ["out", "now"] })
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(error.message)
      stderr(SNAPSHOT_USAGE)
      return 2
    }
    throw error
  }
  const { flags } = parsed

  if (flags.help) {
    stdout(SNAPSHOT_USAGE)
    return 0
  }
  if (!flags.mock) {
    stderr("M0 只支持 --mock（真实采集在 M3）。")
    stderr(SNAPSHOT_USAGE)
    return 2
  }

  let now = new Date()
  if (typeof flags.now === "string") {
    try {
      now = parseLocalIso(flags.now)
    } catch (error) {
      stderr(`--now 不是合法时间：${error.message}`)
      return 2
    }
  }

  let snapshot
  try {
    snapshot = assertValidSnapshot(buildMockSnapshot({ now }))
  } catch (error) {
    if (error instanceof SnapshotValidationError) {
      stderr(error.message)
      for (const e of error.errors) stderr(`  · ${e.path || "<root>"}  ${e.code}  ${e.message}`)
      return 1
    }
    throw error
  }

  // 落盘永远紧凑单行（snapshot-contract §1.5）：--pretty 只影响 stdout，不影响写进文件的内容
  const compact = stringify(snapshot, false)
  const summary = `${snapshot.items.length} 个 item / ${snapshot.findings.length} 条 finding`

  if (typeof flags.out === "string") {
    writeAtomic(flags.out, compact)
    stderr(`已写入 ${flags.out}（${summary}）`)
    return 0
  }
  if (flags.pretty === true) {
    stdout(stringify(snapshot, true))
    return 0
  }
  const target = snapshotPath(env)
  writeAtomic(target, compact)
  stderr(`已写入 ${target}（${summary}）`)
  return 0
}
