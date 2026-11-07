// 内置规则集的单例 —— 只读、确定性，读一次缓存起来。
import { loadRuleSet } from "./load.mjs"

let cached = null

/** @returns {ReturnType<typeof loadRuleSet>} */
export function defaultRuleSet() {
  if (cached === null) cached = loadRuleSet()
  return cached
}

/** 测试用：换掉内置目录或改完文件后强制重读。 */
export function resetDefaultRuleSet() {
  cached = null
}
