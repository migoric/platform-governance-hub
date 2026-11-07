// 判定引擎 —— 纯函数：不碰文件、网络、时钟、随机数、process.env（docs/rule-library.md §6）。
//
// 五条硬规矩，每一条都有对应的单测：
//   1. 输入不可变：不往 item / rule 上写任何东西
//   2. 顺序无关：结果按 (severity, itemId, ruleId) 排序，跟遍历顺序无关
//   3. 单条规则失败不影响其他：check 异常只记 unjudged，带上 ruleId
//   4. 可复算：时间由调用方注入，同一份输入跑一百次字节级一致
//   5. 纯同步：异步的外部查询在引擎外面跑完再传进来

import { runCheck } from "./checks.mjs"
import { PatternCache } from "./regex-guard.mjs"

/** 严重度排序权重：数值小的排前面（blocker 置顶）。 */
export const SEVERITY_RANK = Object.freeze({ blocker: 0, required: 1, suggest: 2, observe: 3 })

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}:\d{2}$/
const STAR = "*"

/**
 * scope 匹配。缺省或 `["*"]` 表示全匹配；**空数组也按全匹配算** ——
 * 写错 scope 导致规则静默失效，比规则多报几条更危险（多报看得见，不报看不见）。
 * @param {{ sites?: string[], categories?: string[], status?: string[] } | undefined} scope
 * @param {object} item
 */
export function matchesScope(scope, item) {
  if (scope === undefined || scope === null) return true
  const hit = (list, value) => {
    if (!Array.isArray(list) || list.length === 0 || list.includes(STAR)) return true
    if (typeof value === "string") return list.includes(value)
    if (Array.isArray(value)) return value.some((v) => list.includes(v))
    return false
  }
  return hit(scope.sites, item.site) && hit(scope.categories, item.category) && hit(scope.status, item.status)
}

function findingId(ruleId, itemId) {
  return `fd_${ruleId}@${itemId}`
}

/**
 * @param {object} rule
 * @param {object} item
 * @param {object} evidence 由 checks 产出，缺 sourceRef
 * @param {string} judgedAt
 */
function buildFinding(rule, item, evidence, judgedAt) {
  return {
    id: findingId(rule.id, item.id),
    itemId: item.id,
    ruleId: rule.id,
    ruleVersion: rule.packVersion,
    severity: rule.severity,
    kind: rule.kind,
    message: rule.message ?? rule.title,
    evidence: { ...evidence, sourceRef: `rule:${rule.id}` },
    remediation: { hint: rule.remediation?.hint ?? "", autoFixable: rule.remediation?.autoFixable === true },
    judgedAt,
    status: "open",
  }
}

/**
 * 跑一次判定。
 * @param {{
 *   items: object[],
 *   rules: Array<{ packId: string, packVersion: string, rule: object }>,
 *   dicts: Map<string, { name: string, terms: string[] }>,
 *   judgedAt: string,
 * }} input
 * @returns {{ findings: object[], unjudged: Array<{ ruleId: string, itemId: string, reason: string, detail: string }> }}
 */
export function evaluate({ items, rules, dicts, judgedAt }) {
  if (!Array.isArray(items)) throw new TypeError("evaluate: items 必须是数组")
  if (!Array.isArray(rules)) throw new TypeError("evaluate: rules 必须是数组")
  if (!(dicts instanceof Map)) throw new TypeError("evaluate: dicts 必须是 Map")
  if (typeof judgedAt !== "string" || !ISO_RE.test(judgedAt)) {
    throw new TypeError("evaluate: judgedAt 必须是带时区的 ISO 时间（时间由调用方注入）")
  }

  const patternCache = new PatternCache()
  const ctx = { dicts, patterns: patternCache }
  const findings = []
  const unjudged = []

  for (const item of items) {
    if (typeof item !== "object" || item === null || typeof item.id !== "string") continue
    for (const entry of rules) {
      const rule = entry?.rule
      if (typeof rule !== "object" || rule === null) continue
      if (!matchesScope(rule.scope, item)) continue

      const base = { ruleId: rule.id, itemId: item.id, packId: entry.packId, severity: rule.severity }

      // 语义 / 人工判定：引擎不猜，只留「待判」占位（§7）
      if (rule.kind !== "deterministic") {
        unjudged.push({
          ...base,
          reason: rule.kind === "semantic" ? "requires_semantic" : "requires_manual",
          detail: `${rule.title}：${rule.kind} 判定不在引擎职责内`,
        })
        continue
      }

      let decided = null
      for (const [index, check] of (rule.checks ?? []).entries()) {
        let outcome
        try {
          outcome = runCheck(check, item, ctx)
        } catch (error) {
          // 单条规则炸了不能拖垮整次判定
          outcome = { status: "unjudged", reason: "check_threw", detail: `${check?.type ?? "?"}: ${error.message}` }
        }
        if (outcome.status === "pass") continue
        if (outcome.status === "violation") {
          const ruleWithPack = { ...rule, packVersion: entry.packVersion }
          decided = buildFinding(ruleWithPack, item, outcome.evidence, judgedAt)
        } else {
          unjudged.push({ ...base, reason: outcome.reason, detail: `checks[${index}] ${outcome.detail}` })
        }
        break
      }
      if (decided !== null) findings.push(decided)
    }
  }

  findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0) ||
      (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0),
  )
  unjudged.sort(
    (a, b) =>
      (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0) ||
      (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0) ||
      (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0),
  )

  return { findings, unjudged }
}
