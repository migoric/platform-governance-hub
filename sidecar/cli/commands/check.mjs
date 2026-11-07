// `pgh check` —— 对一份快照跑判定，是「规则引擎」对外的第一张脸。
//
// 数据和口径只有一处：与 `pgh snapshot` / `pgh rules impact` / App 用的是同一个 evaluate()。
// 这里只负责三件事：找数据、挑 item、把结果排版。

import { readFileSync } from "node:fs"

import { evaluate } from "../../domain/rules-engine.mjs"
import { buildMockSnapshot } from "../../snapshot/build.mjs"
import { SnapshotValidationError, validateSnapshot } from "../../snapshot/schema.mjs"
import { defaultRuleSet } from "../../rules/default.mjs"
import { loadRuleSet } from "../../rules/load.mjs"
import { RuleValidationError } from "../../rules/schema.mjs"
import { toLocalIso } from "../../util/dates.mjs"
import { parseFlags, UsageError } from "../args.mjs"
import { snapshotPath, stringify } from "../fs.mjs"

export const CHECK_USAGE = `用法：pgh check [--mock | --snapshot <文件>] [--packs <目录>] [--item <id|sku>] [--now <ISO 时间>] [--json]

  --mock             对内置 mock 数据跑（不需要先有快照）
  --snapshot <文件>   对指定快照跑（缺省 ~/.pgh/snapshot.json）
  --packs <目录>      用本机规则目录替代内置包（结构：packs/ + dicts/）
  --item <id|sku>    只判这一个商品
  --now <ISO8601>    固定判定时间，用于回归
  --json             输出机器可读结果

退出码：0 跑完（有没有 finding 都是 0）/ 1 输入不合法 / 2 用法错误
—— 判定结论不该让 shell 脚本当成「命令失败」，要卡等级请用 --json 自己判。`

/**
 * 读一份快照并做一次宽松校验：读不懂就报错，不猜。
 * @param {string} file
 * @returns {object}
 */
export function readSnapshotFile(file) {
  let text
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    throw new SnapshotValidationError([{ code: "E_READ", path: file, message: `读不了快照：${error.message}（先跑 pgh snapshot --mock）` }])
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new SnapshotValidationError([{ code: "E_JSON", path: file, message: `不是合法 JSON：${error.message}` }])
  }
  const result = validateSnapshot(data)
  if (!result.ok) throw new SnapshotValidationError(result.errors)
  return data
}

function formatTable(findings, io) {
  if (findings.length === 0) {
    io.stdout("没有 finding。注意这不等于「全都判过了」——判不了的条数见下面。")
    return
  }
  for (const f of findings) {
    const quote = f.evidence.kind === "absence" ? "（字段未填）" : `「${f.evidence.quote}」`
    io.stdout(`${f.severity.padEnd(8)} ${f.itemId.padEnd(10)} ${f.ruleId.padEnd(34)} ${quote}`)
  }
}

/**
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, stdout?: (s: string) => void, stderr?: (s: string) => void }} [io]
 * @returns {number}
 */
export function runCheck(argv, { env = process.env, stdout = console.log, stderr = console.error } = {}) {
  let flags
  try {
    flags = parseFlags(argv, { booleans: ["mock", "json", "help"], strings: ["snapshot", "packs", "item", "now"] }).flags
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(error.message)
      stderr(CHECK_USAGE)
      return 2
    }
    throw error
  }
  if (flags.help) {
    stdout(CHECK_USAGE)
    return 0
  }
  if (flags.mock === true && typeof flags.snapshot === "string") {
    stderr("--mock 与 --snapshot 只能选一个")
    return 2
  }

  const now = typeof flags.now === "string" ? new Date(flags.now) : new Date()
  if (Number.isNaN(now.getTime())) {
    stderr(`--now 不是合法时间：${flags.now}`)
    return 2
  }

  let ruleSet
  try {
    ruleSet = typeof flags.packs === "string" ? loadRuleSet(flags.packs) : defaultRuleSet()
  } catch (error) {
    if (error instanceof RuleValidationError) {
      stderr(error.message)
      for (const e of error.errors) stderr(`  · ${e.path || "<root>"}  ${e.code}  ${e.message}`)
      return 1
    }
    throw error
  }

  let items
  let unjudgedFromSnapshot = 0
  try {
    if (flags.mock === true) {
      const snapshot = buildMockSnapshot({ now, ruleSet })
      items = snapshot.items
    } else {
      const file = typeof flags.snapshot === "string" ? flags.snapshot : snapshotPath(env)
      const snapshot = readSnapshotFile(file)
      items = snapshot.items
      unjudgedFromSnapshot = snapshot.summary?.unjudged ?? 0
    }
  } catch (error) {
    if (error instanceof SnapshotValidationError) {
      stderr(error.message)
      for (const e of error.errors.slice(0, 10)) stderr(`  · ${e.path || "<root>"}  ${e.code}  ${e.message}`)
      return 1
    }
    throw error
  }

  const target = typeof flags.item === "string" ? flags.item : null
  if (target !== null) {
    items = items.filter((item) => item.id === target || item.sku === target)
    if (items.length === 0) {
      stderr(`找不到商品 ${target}（按 id 或 sku 匹配）`)
      return 1
    }
  }

  const judgedAt = toLocalIso(now)
  const { findings, unjudged } = evaluate({ items, rules: ruleSet.rules, dicts: ruleSet.dicts, judgedAt })

  if (flags.json === true) {
    stdout(
      stringify(
        {
          generatedAt: judgedAt,
          items: items.length,
          rulesEvaluated: ruleSet.rules.length,
          rulePacks: ruleSet.packMeta,
          findings,
          unjudged,
        },
        true,
      ).trimEnd(),
    )
    return 0
  }

  stdout(`判定 ${items.length} 个商品 · ${ruleSet.rules.length} 条规则 · ${ruleSet.packMeta.length} 个规则包`)
  formatTable(findings, { stdout })
  stdout("")
  stdout(`finding ${findings.length} 条 · 判不了 ${unjudged.length} 条` + (unjudgedFromSnapshot > 0 ? `（快照里记的是 ${unjudgedFromSnapshot} 条）` : ""))
  if (unjudged.length > 0) {
    const reasons = new Map()
    for (const u of unjudged) reasons.set(u.reason, (reasons.get(u.reason) ?? 0) + 1)
    stdout(`判不了的原因：${[...reasons].map(([r, n]) => `${r}×${n}`).join(" · ")}`)
  }
  return 0
}
