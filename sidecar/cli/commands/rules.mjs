// `pgh rules` —— 看规则库，以及测一条新规则会炸出多少条。
//
// impact 的存在理由（rule-library §9 第 3 条）：规则库最常见的失败模式不是规则写错，
// 而是「加了一条规则，全站 800 条报警」——加完才发现，已经晚了。上线前先在现有快照上回放。

import { existsSync } from "node:fs"

import { evaluate, SEVERITY_RANK } from "../../domain/rules-engine.mjs"
import { defaultRuleSet } from "../../rules/default.mjs"
import { loadCandidateRules, loadRuleSet } from "../../rules/load.mjs"
import { RuleValidationError } from "../../rules/schema.mjs"
import { SnapshotValidationError } from "../../snapshot/schema.mjs"
import { toLocalIso } from "../../util/dates.mjs"
import { parseFlags, UsageError } from "../args.mjs"
import { snapshotPath, stringify } from "../fs.mjs"
import { readSnapshotFile } from "./check.mjs"

export const RULES_USAGE = `用法：pgh rules <list|impact> [参数]

  pgh rules list [--packs <目录>] [--json]
      列出规则包、条数与四档分布

  pgh rules impact <ruleId|文件.json> [--snapshot <文件>] [--packs <目录>] [--now <ISO时间>] [--json]
      在现有快照上回放，报告这条规则会新增多少条 finding

退出码：0 成功 / 1 输入不合法 / 2 用法错误`

const SEVERITIES = ["blocker", "required", "suggest", "observe"]

function countBy(list, key) {
  const out = {}
  for (const item of list) {
    const k = key(item)
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

function loadSet(flags, stderr) {
  try {
    return typeof flags.packs === "string" ? loadRuleSet(flags.packs) : defaultRuleSet()
  } catch (error) {
    if (error instanceof RuleValidationError) {
      stderr(error.message)
      for (const e of error.errors) stderr(`  · ${e.path || "<root>"}  ${e.code}  ${e.message}`)
      return null
    }
    throw error
  }
}

function listRules(flags, { stdout, stderr }) {
  const ruleSet = loadSet(flags, stderr)
  if (ruleSet === null) return 1
  const flat = ruleSet.rules.map((entry) => entry.rule)

  if (flags.json === true) {
    stdout(
      stringify(
        {
          packs: ruleSet.packMeta,
          rules: ruleSet.rules.map(({ packId, packVersion, rule }) => ({
            id: rule.id,
            packId,
            packVersion,
            severity: rule.severity,
            kind: rule.kind,
            checks: rule.checks.map((c) => c.type),
            clause: rule.source?.clause ?? "",
          })),
          dicts: [...ruleSet.dicts.keys()],
        },
        true,
      ).trimEnd(),
    )
    return 0
  }

  stdout("规则包")
  for (const pack of ruleSet.packMeta) {
    const range = pack.effectiveTo === null ? `${pack.effectiveFrom} 起` : `${pack.effectiveFrom} → ${pack.effectiveTo}`
    stdout(`  ${`${pack.id}@${pack.version}`.padEnd(30)} ${String(pack.ruleCount).padStart(3)} 条   ${range}   ${pack.platform}`)
  }
  const byKind = countBy(flat, (r) => r.kind)
  stdout("")
  stdout(`共 ${flat.length} 条规则 · deterministic ${byKind.deterministic} · semantic ${byKind.semantic} · manual ${byKind.manual}`)
  const bySeverity = countBy(flat, (r) => r.severity)
  stdout(`四档分布：${SEVERITIES.map((s) => `${s} ${bySeverity[s] ?? 0}`).join(" · ")}`)
  stdout(`词典 ${ruleSet.dicts.size} 份：${[...ruleSet.dicts.keys()].join("、")}`)
  return 0
}

function describeDelta(delta) {
  const bySeverity = countBy(delta, (f) => f.severity)
  return SEVERITIES.filter((s) => bySeverity[s] > 0).map((s) => `${s} ${bySeverity[s]}`).join(" · ") || "无"
}

function impact(target, flags, { env, stdout, stderr }) {
  const now = typeof flags.now === "string" ? new Date(flags.now) : new Date()
  if (Number.isNaN(now.getTime())) {
    stderr(`--now 不是合法时间：${flags.now}`)
    return 2
  }
  const judgedAt = toLocalIso(now)
  const ruleSet = loadSet(flags, stderr)
  if (ruleSet === null) return 1

  let items
  let snapshotLabel
  try {
    const file = typeof flags.snapshot === "string" ? flags.snapshot : snapshotPath(env)
    const snapshot = readSnapshotFile(file)
    items = snapshot.items
    snapshotLabel = `${file}（${items.length} 个商品）`
  } catch (error) {
    if (error instanceof SnapshotValidationError) {
      stderr(error.message)
      return 1
    }
    throw error
  }

  const isFile = existsSync(target) && /\.json$/i.test(target)
  let afterRules
  let label
  try {
    if (isFile) {
      const candidates = loadCandidateRules(target, ruleSet.packs[0]?.platform ?? "marketplace-a")
      afterRules = [...ruleSet.rules, ...candidates.map((rule) => ({ packId: "candidate", packVersion: "9999.12.31", rule }))]
      label = `候选规则文件 ${target}（${candidates.length} 条）`
    } else {
      const entry = ruleSet.byId.get(target)
      if (entry === undefined) {
        stderr(`找不到规则 ${target}，也不是存在的 .json 文件`)
        return 1
      }
      afterRules = ruleSet.rules
      label = `${target}@${entry.packVersion}`
    }
  } catch (error) {
    if (error instanceof RuleValidationError) {
      stderr(error.message)
      for (const e of error.errors) stderr(`  · ${e.path || "<root>"}  ${e.code}  ${e.message}`)
      return 1
    }
    throw error
  }

  // 基线：不含候选（文件）或暂时摘掉这条规则（id），两份结果之差才是「这条规则的影响」
  const beforeRules = isFile ? ruleSet.rules : ruleSet.rules.filter((entry) => entry.rule.id !== target)
  const before = evaluate({ items, rules: beforeRules, dicts: ruleSet.dicts, judgedAt })
  const after = evaluate({ items, rules: afterRules, dicts: ruleSet.dicts, judgedAt })
  const beforeIds = new Set(before.findings.map((f) => f.id))
  const delta = after.findings.filter((f) => !beforeIds.has(f.id))
  const lost = before.findings.filter((f) => !after.findings.some((g) => g.id === f.id))

  if (flags.json === true) {
    stdout(stringify({ rule: label, snapshot: snapshotLabel, added: delta.length, removed: lost.length, bySeverity: countBy(delta, (f) => f.severity), findings: delta }, true).trimEnd())
    return 0
  }

  stdout(`规则：${label}`)
  stdout(`快照：${snapshotLabel}`)
  stdout(`新增 finding ${delta.length} 条（${describeDelta(delta)}）${lost.length > 0 ? ` · 消失 ${lost.length} 条` : ""}`)
  const top = [...delta].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).slice(0, 10)
  for (const f of top) {
    const quote = f.evidence.kind === "absence" ? "（字段未填）" : `「${f.evidence.quote}」`
    stdout(`  ${f.severity.padEnd(8)} ${f.itemId.padEnd(10)} ${quote}`)
  }
  if (delta.length > top.length) stdout(`  …… 还有 ${delta.length - top.length} 条，加 --json 看全量`)
  const blocker = delta.filter((f) => f.severity === "blocker").length
  if (blocker > 0) stdout(`提醒：其中 ${blocker} 条是 blocker，上线前先确认这些商品真的该被拦。`)
  return 0
}

/**
 * @param {string[]} argv
 * @param {{ stdout?: (s: string) => void, stderr?: (s: string) => void }} [io]
 * @returns {number}
 */
export function runRules(argv, { env = process.env, stdout = console.log, stderr = console.error } = {}) {
  const [sub, ...rest] = argv
  if (sub === undefined || sub === "--help" || sub === "help") {
    stdout(RULES_USAGE)
    return sub === undefined ? 2 : 0
  }
  if (sub !== "list" && sub !== "impact") {
    stderr(`不认识的子命令：${sub}`)
    stderr(RULES_USAGE)
    return 2
  }

  let parsed
  try {
    const spec = sub === "list" ? { booleans: ["json", "help"], strings: ["packs"] } : { booleans: ["json", "help"], strings: ["snapshot", "packs", "now"] }
    parsed = parseFlags(rest, spec)
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(error.message)
      stderr(RULES_USAGE)
      return 2
    }
    throw error
  }
  if (parsed.flags.help === true) {
    stdout(RULES_USAGE)
    return 0
  }

  if (sub === "list") {
    if (parsed.positional.length > 0) {
      stderr(`rules list 不接受位置参数：${parsed.positional.join(" ")}`)
      return 2
    }
    return listRules(parsed.flags, { stdout, stderr })
  }

  if (parsed.positional.length !== 1) {
    stderr("rules impact 需要一个规则 id 或 .json 文件路径")
    stderr(RULES_USAGE)
    return 2
  }
  return impact(parsed.positional[0], parsed.flags, { env, stdout, stderr })
}
