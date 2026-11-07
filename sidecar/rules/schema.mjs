// 规则包 / 词典的校验器 —— 规则是数据，数据必须先过闸门才能被引擎读到。
//
// 校验的重点不是「字段类型对不对」，而是下面这几条会让规则**静默失效**的错：
//   · id 带平台前缀 → 换平台复用不了（rule-library §2）
//   · checks 为空但 kind 是 deterministic → 这条规则永远不会出结论
//   · 引用了不存在的词典 → 每条 item 都记 unjudged，看起来像「没问题」
//   · 正则长得像回溯炸弹 → 一次判定卡死整个 App
//   · 没有 source 条款 → 结论没有出处，等于没有结论

import { CHECK_MODES, CHECK_TYPES, IMPLEMENTED_CHECK_TYPES } from "../domain/checks.mjs"
import { staticRisk } from "../domain/regex-guard.mjs"

export const SEVERITIES = Object.freeze(["blocker", "required", "suggest", "observe"])
export const KINDS = Object.freeze(["deterministic", "semantic", "manual"])

/** 规则 id：`<域>.<字段>.<判据>`，至少三段，全小写蛇形，不许带平台前缀。 */
export const RULE_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$/
export const PACK_VERSION_RE = /^\d{4}\.\d{2}\.\d+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v)
const nonEmpty = (v) => typeof v === "string" && v.trim() !== ""
const isInt = (v) => Number.isInteger(v)

const err = (errors, code, path, message) => errors.push({ code, path, message })

function validateCheck(check, platform, path, errors) {
  if (!isObj(check)) {
    err(errors, "E_CHECK_SHAPE", path, "check 不是对象")
    return
  }
  if (!CHECK_TYPES.includes(check.type)) {
    err(errors, "E_CHECK_TYPE", `${path}.type`, `不认识的 check 类型：${check.type}`)
    return
  }
  if (!IMPLEMENTED_CHECK_TYPES.includes(check.type)) {
    err(errors, "E_CHECK_UNIMPLEMENTED", `${path}.type`, `${check.type} 尚未实现，M1 只支持前六种`)
    return
  }
  if (!nonEmpty(check.path)) err(errors, "E_CHECK_PATH", `${path}.path`, "缺 path")

  switch (check.type) {
    case "text.dictionary": {
      if (!nonEmpty(check.dict)) err(errors, "E_CHECK_DICT", `${path}.dict`, "缺 dict")
      const mode = check.mode ?? "any"
      if (!CHECK_MODES["text.dictionary"].includes(mode)) {
        err(errors, "E_CHECK_MODE", `${path}.mode`, `text.dictionary 的 mode 只能是 ${CHECK_MODES["text.dictionary"].join("/")}，实际是 ${mode}`)
      }
      break
    }
    case "text.match": {
      if (!nonEmpty(check.pattern)) err(errors, "E_CHECK_PATTERN", `${path}.pattern`, "缺 pattern")
      else {
        const risk = staticRisk(check.pattern)
        if (risk !== null) err(errors, "E_CHECK_PATTERN_RISK", `${path}.pattern`, risk)
      }
      break
    }
    case "text.length": {
      if (!isInt(check.min) && !isInt(check.max)) {
        err(errors, "E_CHECK_LENGTH", path, "text.length 至少要给 min 或 max")
      }
      for (const key of ["min", "max"]) {
        if (check[key] !== undefined && (!isInt(check[key]) || check[key] < 0)) {
          err(errors, "E_CHECK_LENGTH", `${path}.${key}`, `${key} 必须是非负整数`)
        }
      }
      if (isInt(check.min) && isInt(check.max) && check.min > check.max) {
        err(errors, "E_CHECK_LENGTH", path, `min=${check.min} 大于 max=${check.max}`)
      }
      break
    }
    case "field.required":
      break
    case "field.enum": {
      const values = check.values
      if (!Array.isArray(values) || values.length === 0 || !values.every(nonEmpty)) {
        err(errors, "E_CHECK_VALUES", `${path}.values`, "values 必须是非空字符串数组")
      }
      // 枚举值里写平台名，等于把规则绑死在某个平台上
      if (Array.isArray(values) && values.some((v) => typeof v === "string" && v.includes(platform))) {
        err(errors, "E_CHECK_PLATFORM_LEAK", `${path}.values`, `values 里出现了平台标识 ${platform}`)
      }
      break
    }
    case "list.contains": {
      const values = check.values
      if (!Array.isArray(values) || values.length === 0 || !values.every(nonEmpty)) {
        err(errors, "E_CHECK_VALUES", `${path}.values`, "values 必须是非空字符串数组")
      }
      const mode = check.mode ?? "any"
      if (!CHECK_MODES["list.contains"].includes(mode)) {
        err(errors, "E_CHECK_MODE", `${path}.mode`, `list.contains 的 mode 只能是 ${CHECK_MODES["list.contains"].join("/")}（白名单语义 M1 不支持）`)
      }
      break
    }
    default:
      break
  }
}

function validateRule(rule, platform, path, errors) {
  if (!isObj(rule)) {
    err(errors, "E_RULE_SHAPE", path, "规则不是对象")
    return
  }
  if (nonEmpty(rule.id) && nonEmpty(platform) && rule.id.startsWith(`${platform}.`)) {
    err(errors, "E_RULE_ID_PLATFORM", `${path}.id`, `id 不许带平台前缀 ${platform}（同一套规则要能跨平台复用）`)
  } else if (!RULE_ID_RE.test(rule.id ?? "")) {
    err(errors, "E_RULE_ID", `${path}.id`, `id 必须形如 a.b.c（全小写蛇形，至少三段）：${rule.id}`)
  }
  if (!nonEmpty(rule.title)) err(errors, "E_RULE_TITLE", `${path}.title`, "缺 title")
  if (!SEVERITIES.includes(rule.severity)) {
    err(errors, "E_RULE_SEVERITY", `${path}.severity`, `severity 必须是四档之一：${rule.severity}`)
  }
  if (!KINDS.includes(rule.kind)) {
    err(errors, "E_RULE_KIND", `${path}.kind`, `kind 必须是 ${KINDS.join("/")}：${rule.kind}`)
  }

  const checks = rule.checks
  if (!Array.isArray(checks)) {
    err(errors, "E_RULE_CHECKS", `${path}.checks`, "checks 必须是数组")
  } else if (rule.kind === "deterministic" && checks.length === 0) {
    err(errors, "E_RULE_CHECKS_EMPTY", `${path}.checks`, "deterministic 规则必须至少有一条 check，否则永远不会出结论")
  } else if (rule.kind !== "deterministic" && checks.length > 0) {
    err(errors, "E_RULE_CHECKS_SEMANTIC", `${path}.checks`, `${rule.kind} 规则不许有 checks（引擎只产占位，不猜）`)
  } else {
    checks.forEach((check, i) => validateCheck(check, platform, `${path}.checks[${i}]`, errors))
  }

  if (!isObj(rule.evidence)) {
    err(errors, "E_RULE_EVIDENCE", `${path}.evidence`, "缺 evidence")
  } else {
    if (rule.evidence.quote !== true) {
      err(errors, "E_RULE_EVIDENCE", `${path}.evidence.quote`, "M1 的所有结论都必须带原文引用（quote 必须为 true）")
    }
    if (rule.evidence.locate !== undefined && rule.evidence.locate !== "offset") {
      err(errors, "E_RULE_EVIDENCE", `${path}.evidence.locate`, `locate 只支持 offset：${rule.evidence.locate}`)
    }
  }

  if (!isObj(rule.source) || !nonEmpty(rule.source.clause)) {
    err(errors, "E_RULE_SOURCE", `${path}.source.clause`, "缺条款出处（没有出处的规则不许入库）")
  }
  if (rule.scope !== undefined) {
    if (!isObj(rule.scope)) err(errors, "E_RULE_SCOPE", `${path}.scope`, "scope 必须是对象")
    else {
      for (const key of ["sites", "categories", "status"]) {
        const list = rule.scope[key]
        if (list !== undefined && (!Array.isArray(list) || !list.every(nonEmpty))) {
          err(errors, "E_RULE_SCOPE", `${path}.scope.${key}`, `${key} 必须是非空字符串数组`)
        }
      }
    }
  }
  if (rule.message !== undefined && !nonEmpty(rule.message)) {
    err(errors, "E_RULE_MESSAGE", `${path}.message`, "message 给了就必须是非空字符串")
  }
  if (rule.remediation !== undefined) {
    if (!isObj(rule.remediation)) err(errors, "E_RULE_REMEDIATION", `${path}.remediation`, "remediation 必须是对象")
    else if (rule.remediation.hint !== undefined && typeof rule.remediation.hint !== "string") {
      err(errors, "E_RULE_REMEDIATION", `${path}.remediation.hint`, "hint 必须是字符串")
    }
  }
}

/**
 * @param {unknown} pack
 * @returns {{ ok: boolean, errors: Array<{ code: string, path: string, message: string }> }}
 */
export function validatePack(pack) {
  const errors = []
  if (!isObj(pack)) {
    err(errors, "E_PACK_SHAPE", "", "规则包不是对象")
    return { ok: false, errors }
  }
  if (!nonEmpty(pack.packId)) err(errors, "E_PACK_ID", "packId", "缺 packId")
  if (!nonEmpty(pack.platform)) err(errors, "E_PACK_PLATFORM", "platform", "缺 platform")
  if (!PACK_VERSION_RE.test(pack.version ?? "")) {
    err(errors, "E_PACK_VERSION", "version", `version 必须形如 2026.11.1：${pack.version}`)
  }
  if (!DATE_RE.test(pack.effectiveFrom ?? "")) err(errors, "E_PACK_FROM", "effectiveFrom", "effectiveFrom 必须是 YYYY-MM-DD")
  if (pack.effectiveTo !== null && pack.effectiveTo !== undefined) {
    if (!DATE_RE.test(pack.effectiveTo)) err(errors, "E_PACK_TO", "effectiveTo", "effectiveTo 必须是 YYYY-MM-DD 或 null")
    else if (typeof pack.effectiveFrom === "string" && pack.effectiveTo < pack.effectiveFrom) {
      err(errors, "E_PACK_RANGE", "effectiveTo", `effectiveTo=${pack.effectiveTo} 早于 effectiveFrom=${pack.effectiveFrom}`)
    }
  }
  if (!isObj(pack.source) || !nonEmpty(pack.source.doc) || !nonEmpty(pack.source.clause)) {
    err(errors, "E_PACK_SOURCE", "source", "pack 必须写清 source.doc 与 source.clause")
  }
  if (!Array.isArray(pack.rules)) {
    err(errors, "E_PACK_RULES", "rules", "rules 必须是数组")
    return { ok: false, errors }
  }
  pack.rules.forEach((rule, i) => validateRule(rule, pack.platform ?? "", `rules[${i}]`, errors))
  return { ok: errors.length === 0, errors }
}

/**
 * @param {unknown} dict
 * @returns {{ ok: boolean, errors: Array<{ code: string, path: string, message: string }> }}
 */
export function validateDict(dict) {
  const errors = []
  if (!isObj(dict)) {
    err(errors, "E_DICT_SHAPE", "", "词典不是对象")
    return { ok: false, errors }
  }
  if (!nonEmpty(dict.name)) err(errors, "E_DICT_NAME", "name", "缺 name")
  if (!Array.isArray(dict.terms) || dict.terms.length === 0) {
    err(errors, "E_DICT_TERMS", "terms", "terms 必须是非空数组")
    return { ok: false, errors }
  }
  const seen = new Set()
  dict.terms.forEach((term, i) => {
    if (!nonEmpty(term)) {
      err(errors, "E_DICT_TERM", `terms[${i}]`, "词条必须是非空字符串")
      return
    }
    const key = term.toLowerCase()
    if (seen.has(key)) err(errors, "E_DICT_DUP", `terms[${i}]`, `词条重复（忽略大小写）：${term}`)
    seen.add(key)
  })
  return { ok: errors.length === 0, errors }
}

/**
 * 跨文件的校验：rule id 全局唯一、词典引用存在、包之间不互相引用规则。
 * @param {Array<object>} packs
 * @param {Map<string, { name: string, terms: string[] }>} dicts
 */
export function validateRuleSet(packs, dicts) {
  const errors = []
  const ids = new Map()
  for (const pack of packs) {
    const result = validatePack(pack)
    errors.push(...result.errors)
    for (const rule of Array.isArray(pack?.rules) ? pack.rules : []) {
      if (!nonEmpty(rule?.id)) continue
      if (ids.has(rule.id)) {
        err(errors, "E_RULE_ID_DUP", `${pack.packId}.${rule.id}`, `规则 id 在 ${ids.get(rule.id)} 与 ${pack.packId} 里重复`)
      } else {
        ids.set(rule.id, pack.packId)
      }
      for (const check of Array.isArray(rule.checks) ? rule.checks : []) {
        if (check?.type === "text.dictionary" && !dicts.has(check.dict)) {
          err(errors, "E_DICT_REF", `${pack.packId}.${rule.id}`, `引用了不存在的词典：${check.dict}`)
        }
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 校验失败带全部错误抛出 —— 只报第一条会让人改一轮跑一轮。
 */
export class RuleValidationError extends Error {
  constructor(errors) {
    const head = errors.slice(0, 3).map((e) => `${e.path || "<root>"}: ${e.message}`).join("; ")
    super(`规则校验失败（${errors.length} 处）：${head}`)
    this.name = "RuleValidationError"
    this.errors = errors
  }
}
