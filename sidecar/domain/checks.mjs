// 六种 check —— 引擎的判据原子。纯函数，无 IO、无时钟、无随机。
//
// 统一约定：**返回「是否违规」**，不是「是否通过」。
//   { status: "pass" }                          没违规
//   { status: "violation", field, evidence }    违规，且能指出证据
//   { status: "unjudged", reason, detail }      判不了（缺字段、值不是字符串、正则熔断…）
//
// 「判不了」永远不折成「通过」：说不清楚的事，宁可显示成待判，也不要假装干净。
// 证据三态见 docs/snapshot-contract.md §4：quote（字符串定位）/ absence（字段未填）/ element（数组元素）。

import { getPath } from "../util/paths.mjs"

/** 规则里允许出现的 check 类型（封闭集）。后三种 M1 不实现，见 docs/rule-library.md §5。 */
export const CHECK_TYPES = Object.freeze([
  "text.dictionary",
  "text.match",
  "text.length",
  "field.required",
  "field.enum",
  "list.contains",
  "asset.meta",
  "relation.exists",
  "external.query",
])

/** M1 真正实现的六种。其余类型出现在规则里 → 该条规则记 unjudged，不是静默跳过。 */
export const IMPLEMENTED_CHECK_TYPES = Object.freeze(CHECK_TYPES.slice(0, 6))

/** 每种类型允许的 mode 取值；不在表里的类型没有 mode。 */
export const CHECK_MODES = Object.freeze({
  "text.dictionary": ["any", "all", "exclude"],
  "list.contains": ["any"],
})

const ASCII_ONLY = /^[\x20-\x7E]+$/

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * 在一个字符串里找词典命中。
 * ASCII 词按词边界匹配（`best` 不该命中 `bestseller`），中文词直接找子串。
 * 结果按「位置升序 → 长度降序 → 字典序」排列，保证同一份输入永远同一个答案。
 * @param {string} text
 * @param {string[]} terms
 * @returns {Array<{ term: string, index: number, quote: string }>}
 */
export function findTermHits(text, terms) {
  const haystack = text.toLowerCase()
  const hits = []
  for (const term of terms) {
    const needle = term.toLowerCase()
    if (needle === "") continue
    if (ASCII_ONLY.test(term)) {
      const pattern = new RegExp(`(?:^|[^a-z0-9])(${escapeRegExp(needle)})(?=$|[^a-z0-9])`, "i")
      const match = pattern.exec(text)
      if (match === null) continue
      const index = match.index + match[0].length - match[1].length
      hits.push({ term, index, quote: text.slice(index, index + match[1].length) })
    } else {
      const index = haystack.indexOf(needle)
      if (index === -1) continue
      hits.push({ term, index, quote: text.slice(index, index + term.length) })
    }
  }
  hits.sort((a, b) => a.index - b.index || b.quote.length - a.quote.length || (a.term < b.term ? -1 : 1))
  return hits
}

/** 字符串在字段里的位置证据。 */
export function quoteEvidence(field, text, index, quote) {
  return { kind: "quote", field, quote, offset: index, length: quote.length, sourceRef: "" }
}

/** 字段未填的证据 —— 没有原文可引，这是唯一诚实的表达。 */
export function absenceEvidence(field) {
  return { kind: "absence", field, quote: "", offset: 0, length: 0, sourceRef: "" }
}

/** 数组字段里某个元素的证据。 */
export function elementEvidence(field, elementIndex, quote) {
  return { kind: "element", field, elementIndex, quote, offset: 0, length: quote.length, sourceRef: "" }
}

const pass = () => ({ status: "pass" })
const violation = (field, evidence) => ({ status: "violation", field, evidence })
const unjudged = (reason, detail) => ({ status: "unjudged", reason, detail })

function readString(item, path) {
  const value = getPath(item, path)
  if (typeof value === "string") return { ok: true, value }
  if (value === undefined) return { ok: false, detail: `${path} 不存在` }
  return { ok: false, detail: `${path} 不是字符串（${Array.isArray(value) ? "array" : typeof value}）` }
}

/**
 * 一条 check 跑在一个 item 上。
 * @param {object} check 规则里的 check 定义
 * @param {object} item
 * @param {{ dicts: Map<string, { name: string, terms: string[] }>, patterns: import("./regex-guard.mjs").PatternCache }} ctx
 * @returns {{ status: "pass" } | { status: "violation", field: string, evidence: object } | { status: "unjudged", reason: string, detail: string }}
 */
export function runCheck(check, item, ctx) {
  const type = check.type
  if (!IMPLEMENTED_CHECK_TYPES.includes(type)) {
    return unjudged("check_type_unsupported", `${type} 不在 M1 实现的六种之内`)
  }

  switch (type) {
    case "field.required": {
      const value = getPath(item, check.path)
      const filled =
        value !== undefined &&
        value !== null &&
        value !== "" &&
        !(typeof value === "string" && value.trim() === "") &&
        !(Array.isArray(value) && value.length === 0)
      return filled ? pass() : violation(check.path, absenceEvidence(check.path))
    }

    case "text.length": {
      const read = readString(item, check.path)
      if (!read.ok) return unjudged("field_not_string", read.detail)
      // 字符数按码点算：一个 emoji 算 1 个字，别让「长度」随代理对漂移
      const length = Array.from(read.value).length
      const tooShort = Number.isInteger(check.min) && length < check.min
      const tooLong = Number.isInteger(check.max) && length > check.max
      if (!tooShort && !tooLong) return pass()
      const quote = read.value.slice(0, 40)
      return violation(check.path, quoteEvidence(check.path, read.value, 0, quote))
    }

    case "text.match": {
      const read = readString(item, check.path)
      if (!read.ok) return unjudged("field_not_string", read.detail)
      const result = ctx.patterns.run(check.pattern, read.value)
      if (!result.ok) return unjudged("pattern_rejected", result.reason)
      if (result.hit === null) return pass()
      return violation(check.path, quoteEvidence(check.path, read.value, result.hit.index, result.hit.quote))
    }

    case "text.dictionary": {
      const read = readString(item, check.path)
      if (!read.ok) return unjudged("field_not_string", read.detail)
      const dict = ctx.dicts.get(check.dict)
      if (dict === undefined) return unjudged("dict_missing", `找不到词典 ${check.dict}`)
      const hits = findTermHits(read.value, dict.terms)
      const mode = check.mode ?? "any"

      if (mode === "any") {
        if (hits.length === 0) return pass()
        const first = hits[0]
        return violation(check.path, quoteEvidence(check.path, read.value, first.index, first.quote))
      }
      if (mode === "all") {
        const hitTerms = new Set(hits.map((h) => h.term.toLowerCase()))
        const all = dict.terms.every((t) => hitTerms.has(t.toLowerCase()))
        if (!all) return pass()
        const first = hits[0]
        return violation(check.path, quoteEvidence(check.path, read.value, first.index, first.quote))
      }
      // exclude：白名单。一个词典词都没出现才算违规 —— 这种情况没有原文可引
      if (hits.length > 0) return pass()
      return violation(check.path, absenceEvidence(check.path))
    }

    case "field.enum": {
      const value = getPath(item, check.path)
      if (value === undefined) return unjudged("field_missing", `${check.path} 不存在`)
      if (typeof value !== "string") {
        // 枚举值以字符串呈现；非字符串无法在大字段里定位证据，交给人判
        return unjudged("value_not_string", `${check.path} 的值不是字符串，无法定位证据`)
      }
      if (check.values.includes(value)) return pass()
      return violation(check.path, quoteEvidence(check.path, value, 0, value))
    }

    case "list.contains": {
      const value = getPath(item, check.path)
      if (value === undefined) return unjudged("field_missing", `${check.path} 不存在`)
      if (!Array.isArray(value)) return unjudged("field_not_array", `${check.path} 不是数组`)
      const index = value.findIndex((entry) => typeof entry === "string" && check.values.includes(entry))
      if (index === -1) return pass()
      return violation(check.path, elementEvidence(check.path, index, value[index]))
    }

    default:
      return unjudged("check_type_unsupported", `${type} 不在 M1 实现的六种之内`)
  }
}
