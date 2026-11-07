// 规则包加载 —— 唯一读盘的地方。引擎只吃东西，不碰文件。
//
// 内置包在 sidecar/rules/{packs,dicts}/，随仓库走；`--packs <目录>` 可指向本机的
// `~/.pgh/packs/<platform>/`（结构相同）。两处用的是同一套校验，没有「家里的规则松一点」这回事。

import { readdirSync, readFileSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { RuleValidationError, validateDict, validateRuleSet, validatePack } from "./schema.mjs"

/** 仓库内置规则目录（= 本文件所在目录）。 */
export const RULES_DIR = fileURLToPath(new URL(".", import.meta.url))

function readJsonDir(dir, onError) {
  let names
  try {
    names = readdirSync(dir).filter((name) => extname(name) === ".json").sort()
  } catch (error) {
    onError(`读不了目录 ${dir}：${error.message}`)
    return []
  }
  return names.map((name) => {
    const file = join(dir, name)
    try {
      return { name, data: JSON.parse(readFileSync(file, "utf8")) }
    } catch (error) {
      onError(`${file} 不是合法 JSON：${error.message}`)
      return null
    }
  }).filter((entry) => entry !== null)
}

/**
 * 加载一份规则集。
 * @param {string} [dir] 规则根目录（下面要有 packs/ 与 dicts/）
 * @returns {{
 *   dir: string,
 *   packs: object[],
 *   packMeta: Array<{ id: string, version: string, ruleCount: number, effectiveFrom: string }>,
 *   rules: Array<{ packId: string, packVersion: string, rule: object }>,
 *   dicts: Map<string, { name: string, terms: string[] }>,
 *   byId: Map<string, { packId: string, packVersion: string, rule: object }>,
 * }}
 */
export function loadRuleSet(dir = RULES_DIR) {
  const errors = []
  const push = (message) => errors.push({ code: "E_LOAD", path: dir, message })

  const dictEntries = readJsonDir(join(dir, "dicts"), push)
  const dicts = new Map()
  for (const { name, data } of dictEntries) {
    const result = validateDict(data)
    errors.push(...result.errors.map((e) => ({ ...e, path: `dicts/${name}.${e.path}` })))
    if (!result.ok) continue
    const stem = basename(name, ".json")
    if (data.name !== stem) {
      errors.push({ code: "E_DICT_FILENAME", path: `dicts/${name}`, message: `name「${data.name}」与文件名「${stem}」不一致` })
      continue
    }
    // 词条顺序即命中优先级（同位置取更长的词），所以保留原始顺序，不排序
    dicts.set(data.name, { name: data.name, terms: [...data.terms] })
  }

  const packs = readJsonDir(join(dir, "packs"), push).map((entry) => entry.data)
  const crossCheck = validateRuleSet(packs, dicts)
  errors.push(...crossCheck.errors)

  if (errors.length > 0) throw new RuleValidationError(errors)

  const rules = []
  const byId = new Map()
  for (const pack of packs) {
    for (const rule of pack.rules) {
      const entry = { packId: pack.packId, packVersion: pack.version, rule }
      rules.push(entry)
      byId.set(rule.id, entry)
    }
  }

  return {
    dir,
    packs,
    packMeta: packs.map((pack) => ({
      id: pack.packId,
      platform: pack.platform,
      version: pack.version,
      ruleCount: pack.rules.length,
      effectiveFrom: pack.effectiveFrom,
      effectiveTo: pack.effectiveTo ?? null,
    })),
    rules,
    dicts,
    byId,
  }
}

/**
 * 从一份 JSON 文件里读一条「候选规则」——`pgh rules impact` 用它回放上线前的影响。
 * 文件内容可以是单条规则，也可以是 `{ "rules": [...] }`。
 * @param {string} file
 * @param {string} platform 用来校验「id 不带平台前缀」
 * @returns {object[]}
 */
export function loadCandidateRules(file, platform = "marketplace-a") {
  let data
  try {
    data = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    throw new RuleValidationError([{ code: "E_LOAD", path: file, message: `不是合法 JSON：${error.message}` }])
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.rules) ? data.rules : [data]
  const errors = []
  list.forEach((rule, i) => {
    const pack = { packId: "candidate", platform, version: "9999.12.31", effectiveFrom: "1970-01-01", source: { doc: file, clause: "candidate" }, rules: [rule] }
    const result = validatePack(pack)
    for (const e of result.errors) errors.push({ ...e, path: `[${i}]${e.path ? `.${e.path}` : ""}` })
  })
  if (errors.length > 0) throw new RuleValidationError(errors)
  return list
}
