// 正则预算守卫 —— 规则是数据，数据里的正则可能是坑。
//
// 为什么不是「20ms 就中断」：JavaScript 的正则跑在同一个线程上，同步执行期间没有抢占点。
// 任何「超时后放弃」的写法都只能在**跑完之后**才发现超时，那时卡顿已经发生。
// 真正能保证不卡死的只有两件事，这里都做了：
//
//   1. **静态拒绝**：嵌套量词（`(a+)+`）、重复的 `.*.*`、超长 pattern 一律不编译，直接记 unjudged。
//      这是确定性的、0 耗时的，也是唯一能在执行前拦住回溯爆炸的办法。
//   2. **熔断**：静态检查漏过的，第一次执行若超过预算，这条 pattern 在本次判定里被标记为熔断，
//      后续 item 不再执行（直接记 unjudged）——慢一次，不会慢 N 次。
//
// 已知限度：单次就能卡死的 pattern 拦不住（同步 JS 无解）。所以规则入库时静态检查是**必过项**，
// 不是「建议」。见 docs/rule-library.md §5。

/** 单条 pattern 的执行预算（毫秒）。超了只影响这一条规则，不影响整次判定。 */
export const REGEX_BUDGET_MS = 20

/** pattern 长度上限。超过这个长度的正则，人写不对，机器也读不懂。 */
export const MAX_PATTERN_LENGTH = 200

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000

// 嵌套量词：一个组内部带量词，组本身又被量词修饰 —— 经典的回溯爆炸形状
const NESTED_QUANTIFIER = /\((?:[^()]|\([^()]*\))*[*+][^()]*\)\s*(?:[*+]|\{\d*,?\d*\})/
// 并列的 .* 让回溯空间相乘：`.*a.*b.*c` 在长串上是灾难
const MANY_DOT_STAR = /(?:\.\*){3,}/
// 量词叠加在同一字符上：`a**`、`a+*`
const DOUBLE_QUANTIFIER = /(?:[*+]|\{\d*,?\d*\})\s*[*+]/

/**
 * 静态体检：能确定有风险就返回原因，返回 null 表示「可以编译」。
 * @param {unknown} source
 * @returns {string | null}
 */
export function staticRisk(source) {
  if (typeof source !== "string") return "pattern 必须是字符串"
  if (source === "") return "pattern 为空"
  if (source.length > MAX_PATTERN_LENGTH) return `pattern 超过 ${MAX_PATTERN_LENGTH} 字符`
  if (NESTED_QUANTIFIER.test(source)) return "嵌套量词，回溯可能爆炸"
  if (MANY_DOT_STAR.test(source)) return "连续 .* 过多，回溯空间相乘"
  if (DOUBLE_QUANTIFIER.test(source)) return "量词叠加，语法上等价于无意义重复"
  return null
}

/**
 * 编译一条规则里的正则。
 * @param {unknown} source
 * @returns {{ ok: true, regex: RegExp } | { ok: false, reason: string }}
 */
export function compilePattern(source) {
  const risk = staticRisk(source)
  if (risk !== null) return { ok: false, reason: risk }
  try {
    // 不带 g 标志：一次判定只要第一个命中，带 g 会因 lastIndex 让结果依赖调用顺序
    return { ok: true, regex: new RegExp(source) }
  } catch (error) {
    return { ok: false, reason: `正则语法错误：${error.message}` }
  }
}

/**
 * 带预算的单次执行。返回命中区间，或一个「判不了」的原因。
 * @param {{ ok: true, regex: RegExp } | { ok: false, reason: string }} compiled
 * @param {string} text
 * @returns {{ ok: true, hit: null | { index: number, quote: string } } | { ok: false, reason: string }}
 */
export function execBudgeted(compiled, text) {
  if (!compiled.ok) return { ok: false, reason: compiled.reason }
  const startedAt = now()
  const match = compiled.regex.exec(text)
  const elapsed = now() - startedAt
  if (elapsed > REGEX_BUDGET_MS) {
    return { ok: false, reason: `正则耗时 ${elapsed.toFixed(1)}ms，超过 ${REGEX_BUDGET_MS}ms 预算` }
  }
  if (match === null) return { ok: true, hit: null }
  return { ok: true, hit: { index: match.index, quote: match[0] } }
}

/**
 * 每条规则的 pattern 只编译一次，并记住是否已经熔断。
 * 熔断的 pattern 在本次判定里不再执行 —— 慢一次可以，慢 N 次不行。
 */
export class PatternCache {
  constructor() {
    /** @type {Map<string, { compiled: ReturnType<typeof compilePattern>, poisoned: null | string }>} */
    this.entries = new Map()
  }

  /**
   * @param {string} source
   * @param {string} text
   * @returns {{ ok: true, hit: null | { index: number, quote: string } } | { ok: false, reason: string }}
   */
  run(source, text) {
    const key = String(source)
    let entry = this.entries.get(key)
    if (entry === undefined) {
      entry = { compiled: compilePattern(source), poisoned: null }
      this.entries.set(key, entry)
    }
    if (entry.poisoned !== null) return { ok: false, reason: entry.poisoned }
    const result = execBudgeted(entry.compiled, text)
    if (!result.ok) entry.poisoned = result.reason
    return result
  }
}
