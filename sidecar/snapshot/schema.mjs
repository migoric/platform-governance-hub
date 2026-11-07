// snapshot.json 的校验器 —— 写盘前唯一的闸门（snapshot-contract §6、refactor-constraints §1.1）。
//
// 这里只做「能不能落盘」的结构校验，不做业务判断，也不做宽容解码：
// 宽容解码是 App 侧的事（旧快照缺字段要能读），写盘侧必须严格，否则半截数据会被当成合法数据。

import { parseLocalIso } from "../util/dates.mjs"
import { getPath } from "../util/paths.mjs"
// 出处状态是规则侧的定义，快照侧只引用不另立一套 —— 两处枚举一旦分叉，UI 会显示成第三态
import { SOURCE_STATUSES } from "../rules/schema.mjs"

export const SNAPSHOT_SCHEMA_VERSION = 1

/** 四档严重度是封闭集，不许加第五档（refactor-constraints §1.1）。 */
export const SEVERITIES = Object.freeze(["blocker", "required", "suggest", "observe"])
export const KINDS = Object.freeze(["deterministic", "semantic", "manual"])
export const FINDING_STATUSES = Object.freeze(["open", "fixed", "waived", "stale"])
export const SOURCE_KINDS = Object.freeze(["export", "browser", "mock", "local"])
export const ITEM_STATUSES = Object.freeze(["on_sale", "off_sale", "draft", "blocked"])
/** 证据三态：quote 指字符串位置，absence 指字段没填，element 指数组里的一个元素。 */
export const EVIDENCE_KINDS = Object.freeze(["quote", "absence", "element"])

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v)
const isStr = (v) => typeof v === "string"
const isInt = (v) => Number.isInteger(v)
const nonEmpty = (v) => isStr(v) && v.trim() !== ""
// 「填了没有」只有一个判断处：field.required check 与 absence 证据都用它
const isFilled = (v) =>
  v !== undefined && v !== null && v !== "" && !(isStr(v) && v.trim() === "") && !(Array.isArray(v) && v.length === 0)

const err = (errors, code, path, message) => errors.push({ code, path, message })

// 路径读取复用 util/paths.mjs：规则、引擎、校验三处必须读同一份实现，
// 否则会出现「校验通过但规则读不到」这种对不上的错。
export { getPath }


function isIso(value) {
  if (!isStr(value)) return false
  try {
    parseLocalIso(value)
    return true
  } catch {
    return false
  }
}

// JSON 表达不了的东西（undefined / NaN / Infinity / bigint / 函数）如果在内存里混进来，
// JSON.stringify 会悄悄变成 null 或直接崩 —— 落盘前先拦掉。
function scanUnsafe(value, path, errors, seen = new Set()) {
  if (typeof value === "undefined") {
    err(errors, "E_UNSAFE_VALUE", path, "出现 undefined（JSON 无法表达）")
    return
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    err(errors, "E_UNSAFE_VALUE", path, `出现非有限数：${value}`)
    return
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    err(errors, "E_UNSAFE_VALUE", path, `出现 ${typeof value}（JSON 无法表达）`)
    return
  }
  if (value === null || typeof value !== "object") return
  if (seen.has(value)) {
    err(errors, "E_UNSAFE_VALUE", path, "出现循环引用")
    return
  }
  seen.add(value)
  const walk = Array.isArray(value) ? value.entries() : Object.entries(value)
  for (const [key, child] of walk) scanUnsafe(child, `${path}${path ? "." : ""}${key}`, errors, seen)
  seen.delete(value)
}

function validateItem(item, path, errors) {
  if (!isObj(item)) {
    err(errors, "E_ITEM_SHAPE", path, "item 不是对象")
    return
  }
  if (!nonEmpty(item.id)) err(errors, "E_ITEM_ID", `${path}.id`, "缺 id")
  if (!nonEmpty(item.title)) err(errors, "E_ITEM_TITLE", `${path}.title`, "缺 title")
  if (item.site !== undefined && !nonEmpty(item.site)) err(errors, "E_ITEM_SITE", `${path}.site`, "site 必须是非空字符串")
  if (item.status !== undefined && !ITEM_STATUSES.includes(item.status)) {
    err(errors, "E_ITEM_STATUS", `${path}.status`, `status 不在封闭集：${item.status}`)
  }
  if (item.category !== undefined && !Array.isArray(item.category)) {
    err(errors, "E_ITEM_CATEGORY", `${path}.category`, "category 必须是数组")
  }
  const listing = item.listing
  if (listing !== undefined && !isObj(listing)) {
    err(errors, "E_ITEM_LISTING", `${path}.listing`, "listing 必须是对象")
    return
  }
  // titleLen 是冗余字段，必须与 title 一致：一个数字只能有一个计算处（ui-ia §5）
  if (isObj(listing) && listing.titleLen !== undefined) {
    if (!isInt(listing.titleLen) || listing.titleLen < 0) {
      err(errors, "E_TITLE_LEN", `${path}.listing.titleLen`, "titleLen 必须是非负整数")
    } else if (isStr(item.title) && listing.titleLen !== item.title.length) {
      err(
        errors,
        "E_TITLE_LEN_DRIFT",
        `${path}.listing.titleLen`,
        `titleLen=${listing.titleLen} 与 title.length=${item.title.length} 不一致`,
      )
    }
  }
}

function validateEvidence(item, finding, path, errors) {
  const ev = finding.evidence
  if (!isObj(ev)) {
    err(errors, "E_EVIDENCE_SHAPE", `${path}.evidence`, "缺 evidence")
    return
  }
  if (!nonEmpty(ev.field)) err(errors, "E_EVIDENCE_FIELD", `${path}.evidence.field`, "缺 field")
  if (!isStr(ev.quote)) err(errors, "E_EVIDENCE_QUOTE", `${path}.evidence.quote`, "quote 必须是字符串")
  if (!isInt(ev.offset) || ev.offset < 0) err(errors, "E_EVIDENCE_OFFSET", `${path}.evidence.offset`, "offset 必须是非负整数")
  if (!isInt(ev.length) || ev.length < 0) err(errors, "E_EVIDENCE_LENGTH", `${path}.evidence.length`, "length 必须是非负整数")
  if (!nonEmpty(ev.sourceRef)) err(errors, "E_EVIDENCE_SOURCE", `${path}.evidence.sourceRef`, "缺 sourceRef")
  else if (!/^(rule|doc):/.test(ev.sourceRef)) {
    err(errors, "E_EVIDENCE_SOURCE", `${path}.evidence.sourceRef`, `sourceRef 必须以 rule: 或 doc: 开头：${ev.sourceRef}`)
  }
  if (isStr(ev.quote) && isInt(ev.length) && ev.length !== ev.quote.length) {
    err(errors, "E_EVIDENCE_LENGTH", `${path}.evidence.length`, `length=${ev.length} 与 quote.length=${ev.quote.length} 不一致`)
  }
  const kind = ev.kind === undefined ? "quote" : ev.kind
  if (!EVIDENCE_KINDS.includes(kind)) {
    err(errors, "E_EVIDENCE_KIND", `${path}.evidence.kind`, `kind 只能是 ${EVIDENCE_KINDS.join("/")}：${kind}`)
    return
  }
  if (!isObj(item)) return // item 不存在时上面已报 E_FINDING_ITEM，别再叠一条 quote 错误
  const value = getPath(item, ev.field)

  if (kind === "absence") {
    // 字段没填才允许 absence：拿它给「有值的字段」开脱，等于把证据链改成了口头承诺
    if (ev.quote !== "" || ev.offset !== 0 || ev.length !== 0) {
      err(errors, "E_EVIDENCE_ABSENCE", `${path}.evidence`, "absence 证据的 quote 必须为空、offset 与 length 必须为 0")
    } else if (isFilled(value)) {
      err(errors, "E_EVIDENCE_ABSENCE", `${path}.evidence`, `${ev.field} 实际有值，不能用 absence 证据`)
    }
    return
  }

  if (kind === "element") {
    if (!Array.isArray(value)) {
      err(errors, "E_EVIDENCE_ELEMENT", `${path}.evidence`, `${ev.field} 不是数组，无法指向元素`)
    } else if (!isInt(ev.elementIndex) || ev.elementIndex < 0 || ev.elementIndex >= value.length) {
      err(errors, "E_EVIDENCE_ELEMENT", `${path}.evidence.elementIndex`, `elementIndex 越界：${ev.elementIndex}`)
    } else if (value[ev.elementIndex] !== ev.quote) {
      err(errors, "E_EVIDENCE_ELEMENT", `${path}.evidence`, `元素 [${ev.elementIndex}] 实际是「${value[ev.elementIndex]}」，不是「${ev.quote}」`)
    } else if (ev.offset !== 0 || ev.length !== ev.quote.length) {
      err(errors, "E_EVIDENCE_ELEMENT", `${path}.evidence`, "element 证据的 offset 必须为 0，length 必须等于 quote 长度")
    }
    return
  }

  // kind === "quote"：硬失败，quote 必须能在 field 的值里按 offset/length 命中（snapshot-contract §4）
  if (!isStr(value)) {
    err(errors, "E_EVIDENCE_QUOTE_MISS", `${path}.evidence`, `${ev.field} 不是字符串，无法命中 quote`)
    return
  }
  if (isInt(ev.offset) && isInt(ev.length) && isStr(ev.quote)) {
    const hit = value.slice(ev.offset, ev.offset + ev.length)
    if (hit !== ev.quote) {
      err(
        errors,
        "E_EVIDENCE_QUOTE_MISS",
        `${path}.evidence`,
        `quote「${ev.quote}」在 ${ev.field}[${ev.offset},${ev.length}] 处实际是「${hit}」`,
      )
    }
  }
}

function packRuleIds(rulePacks) {
  const ids = new Set()
  let declared = false
  for (const pack of Array.isArray(rulePacks) ? rulePacks : []) {
    if (!isObj(pack) || !Array.isArray(pack.rules)) continue
    declared = true
    for (const rule of pack.rules) {
      if (isStr(rule)) ids.add(rule)
      else if (isObj(rule) && nonEmpty(rule.id)) ids.add(rule.id)
    }
  }
  return { ids, declared }
}

function validateFinding(finding, index, { byItemId, ruleIds, ruleIdsDeclared }, errors) {
  const path = `findings[${index}]`
  if (!isObj(finding)) {
    err(errors, "E_FINDING_SHAPE", path, "finding 不是对象")
    return
  }
  if (!nonEmpty(finding.id)) err(errors, "E_FINDING_ID", `${path}.id`, "缺 id")
  if (!nonEmpty(finding.ruleId)) err(errors, "E_FINDING_RULE", `${path}.ruleId`, "缺 ruleId")
  if (!nonEmpty(finding.ruleVersion)) err(errors, "E_FINDING_RULE_VERSION", `${path}.ruleVersion`, "缺 ruleVersion")
  if (!nonEmpty(finding.message)) err(errors, "E_FINDING_MESSAGE", `${path}.message`, "缺 message")
  if (!SEVERITIES.includes(finding.severity)) {
    err(errors, "E_SEVERITY", `${path}.severity`, `severity 不在四档封闭集：${finding.severity}`)
  }
  if (!KINDS.includes(finding.kind)) err(errors, "E_KIND", `${path}.kind`, `kind 不在封闭集：${finding.kind}`)
  if (finding.status !== undefined && !FINDING_STATUSES.includes(finding.status)) {
    err(errors, "E_FINDING_STATUS", `${path}.status`, `status 不在封闭集：${finding.status}`)
  }
  if (!isIso(finding.judgedAt)) err(errors, "E_FINDING_TIME", `${path}.judgedAt`, "judgedAt 必须是带时区的 ISO 时间")

  const item = byItemId.get(finding.itemId)
  if (!item) err(errors, "E_FINDING_ITEM", `${path}.itemId`, `找不到对应 item：${finding.itemId}`)

  // 规则集只在 pack 显式声明了 rules 时才校验（M0 的 pack 只有计数，规则库在 M1 落盘）
  if (ruleIdsDeclared && nonEmpty(finding.ruleId) && !ruleIds.has(finding.ruleId)) {
    err(errors, "E_FINDING_RULE", `${path}.ruleId`, `ruleId 不在任何 rulePack 里：${finding.ruleId}`)
  }

  validateEvidence(item, finding, path, errors)
}

function validateSummary(summary, findings, errors) {
  if (!isObj(summary)) {
    err(errors, "E_SUMMARY_SHAPE", "summary", "缺 summary")
    return
  }
  for (const key of ["items", "findings", "unjudged", "rulesEvaluated", "rulePacks"]) {
    if (!isInt(summary[key]) || summary[key] < 0) {
      err(errors, "E_SUMMARY_COUNT", `summary.${key}`, `${key} 必须是非负整数`)
    }
  }
  if (summary.findings !== findings.length) {
    err(errors, "E_SUMMARY_COUNT", "summary.findings", `summary.findings=${summary.findings} 与 findings.length=${findings.length} 不一致`)
  }
  const bySeverity = summary.bySeverity
  if (!isObj(bySeverity)) {
    err(errors, "E_SUMMARY_SEVERITY", "summary.bySeverity", "缺 bySeverity")
    return
  }
  let total = 0
  for (const severity of SEVERITIES) {
    const n = bySeverity[severity]
    if (!isInt(n) || n < 0) {
      err(errors, "E_SUMMARY_SEVERITY", `summary.bySeverity.${severity}`, `${severity} 必须是非负整数`)
      continue
    }
    total += n
    const actual = findings.filter((f) => isObj(f) && f.severity === severity).length
    if (n !== actual) {
      err(errors, "E_SUMMARY_SEVERITY", `summary.bySeverity.${severity}`, `${severity}=${n} 与实际 ${actual} 条不一致`)
    }
  }
  const unknownKeys = Object.keys(bySeverity).filter((k) => !SEVERITIES.includes(k))
  if (unknownKeys.length > 0) {
    err(errors, "E_SUMMARY_SEVERITY", "summary.bySeverity", `出现四档之外的键：${unknownKeys.join(", ")}`)
  }
  if (total !== findings.length) {
    err(errors, "E_SUMMARY_SEVERITY", "summary.bySeverity", `四档之和 ${total} 与 findings.length ${findings.length} 不一致`)
  }
}

/**
 * 校验一份快照能否落盘。
 * @param {unknown} input
 * @returns {{ ok: boolean, errors: Array<{ code: string, path: string, message: string }> }}
 */
export function validateSnapshot(input) {
  const errors = []
  if (!isObj(input)) {
    err(errors, "E_SHAPE", "", "快照不是对象")
    return { ok: false, errors }
  }
  scanUnsafe(input, "", errors)

  if (input.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    err(errors, "E_SCHEMA_VERSION", "schemaVersion", `schemaVersion 必须是 ${SNAPSHOT_SCHEMA_VERSION}，实际是 ${input.schemaVersion}`)
  }
  if (!isIso(input.generatedAt)) err(errors, "E_GENERATED_AT", "generatedAt", "generatedAt 必须是带时区的 ISO 时间")
  if (input.durationMs !== undefined && (!isInt(input.durationMs) || input.durationMs < 0)) {
    err(errors, "E_DURATION", "durationMs", "durationMs 必须是非负整数")
  }
  if (!isObj(input.source)) err(errors, "E_SOURCE", "source", "缺 source")
  else if (!SOURCE_KINDS.includes(input.source.kind)) {
    err(errors, "E_SOURCE_KIND", "source.kind", `source.kind 不在封闭集：${input.source.kind}`)
  }
  if (input.scope !== undefined && !isObj(input.scope)) err(errors, "E_SCOPE", "scope", "scope 必须是对象")
  if (input.rulePacks !== undefined && !Array.isArray(input.rulePacks)) {
    err(errors, "E_RULE_PACKS", "rulePacks", "rulePacks 必须是数组")
  }
  if (Array.isArray(input.rulePacks)) {
    input.rulePacks.forEach((pack, i) => {
      const path = `rulePacks[${i}]`
      if (!isObj(pack)) {
        err(errors, "E_RULE_PACKS", path, "规则包必须是对象")
        return
      }
      // 出处状态必须随快照走：UI 靠它决定要不要标「未核实」，
      // 漏带的话 UI 会静默当成无事发生，所以这里当成契约的一部分。
      if (!SOURCE_STATUSES.includes(pack.sourceStatus)) {
        err(errors, "E_RULE_PACK_SOURCE_STATUS", `${path}.sourceStatus`, `sourceStatus 必须是 ${SOURCE_STATUSES.join("/")}，实际是 ${pack.sourceStatus}`)
      }
    })
  }

  const items = Array.isArray(input.items) ? input.items : []
  if (!Array.isArray(input.items)) err(errors, "E_ITEMS", "items", "items 必须是数组")
  const byItemId = new Map()
  items.forEach((item, i) => {
    validateItem(item, `items[${i}]`, errors)
    if (isObj(item) && nonEmpty(item.id)) {
      if (byItemId.has(item.id)) err(errors, "E_ITEM_DUP", `items[${i}].id`, `item id 重复：${item.id}`)
      else byItemId.set(item.id, item)
    }
  })

  const findings = Array.isArray(input.findings) ? input.findings : []
  if (!Array.isArray(input.findings)) err(errors, "E_FINDINGS", "findings", "findings 必须是数组")
  const { ids: ruleIds, declared: ruleIdsDeclared } = packRuleIds(input.rulePacks)
  findings.forEach((finding, i) => validateFinding(finding, i, { byItemId, ruleIds, ruleIdsDeclared }, errors))

  validateSummary(input.summary, findings, errors)
  if (input.unjudged !== undefined) {
    if (!Array.isArray(input.unjudged)) {
      err(errors, "E_UNJUDGED", "unjudged", "unjudged 必须是数组")
    } else if (isObj(input.summary) && isInt(input.summary.unjudged) && input.unjudged.length !== input.summary.unjudged) {
      err(errors, "E_UNJUDGED_COUNT", "unjudged", `明细 ${input.unjudged.length} 条与 summary.unjudged=${input.summary.unjudged} 不一致`)
    }
  }

  return { ok: errors.length === 0, errors }
}

/** 校验失败要带全部错误抛出，别只报第一条 —— 修一个跑一次的循环最浪费时间。 */
export class SnapshotValidationError extends Error {
  constructor(errors) {
    const head = errors.slice(0, 3).map((e) => `${e.path || "<root>"}: ${e.message}`).join("; ")
    super(`快照校验失败（${errors.length} 处）：${head}`)
    this.name = "SnapshotValidationError"
    this.errors = errors
  }
}
