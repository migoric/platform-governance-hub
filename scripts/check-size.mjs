#!/usr/bin/env node
// 产品代码单文件行数门禁 —— AGENTS.md §4.1。零依赖，Node ≥ 20。
//
// 规则：
//   1. 产品代码文件 > 500 行 → 失败
//   2. 测试 / fixture / 构建产物 / vendor 不受限
//   3. ROOTS 里写死的目录不存在 → 警告跳过（--strict 下算配置错误）：
//      M0 期间 GovernanceHub 还没落地，不能让这条门禁在别的项上瞎报

import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const USAGE = "用法：node scripts/check-size.mjs [--limit N] [--strict]"

function usageError(message) {
  console.error(`${message}\n${USAGE}`)
  process.exit(2)
}

function parseArgs(argv) {
  let limit = 500
  let strict = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE)
      process.exit(0)
    }
    if (arg === "--strict") {
      strict = true
      continue
    }
    if (arg !== "--limit") usageError(`不认识的参数：${arg}`)
    const value = argv[++i]
    if (value === undefined || !/^[1-9]\d*$/.test(value)) usageError(`--limit 需要一个正整数`)
    limit = Number(value)
  }
  return { limit, strict }
}

const { limit: LIMIT, strict: STRICT } = parseArgs(process.argv.slice(2))

const ROOTS = ["GovernanceHub/crates", "sidecar", "browser", "scripts"]
const EXT = new Set([".rs", ".mjs", ".cjs", ".js", ".jsx", ".ts", ".tsx", ".mts", ".cts"])

const EXEMPT_DIRS = new Set([
  "test", "tests", "Tests", "__tests__", "__mocks__",
  "fixtures", "fixture", "__fixtures__",
  "vendor", "node_modules", "target", "dist", ".build",
  "generated", "__generated__",
])
const EXEMPT_FILE = [/\.(test|spec)\.[^.]+$/, /\.(generated|gen)\.[^.]+$/, /\.d\.[cm]?ts$/, /\.(min|iife)\.js$/]

const extOf = (name) => {
  const dot = name.lastIndexOf(".")
  return dot === -1 ? "" : name.slice(dot)
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (EXEMPT_DIRS.has(entry.name)) continue
      walk(full, out)
    } else if (entry.isFile() && EXT.has(extOf(entry.name))) {
      out.push(full)
    }
  }
  return out
}

const missing = []
function collect(root) {
  const abs = join(ROOT, root)
  let stat
  try {
    stat = statSync(abs)
  } catch {
    missing.push(root)
    return []
  }
  return stat.isDirectory() ? walk(abs) : [abs]
}

const isExempt = (rel) => {
  const parts = rel.split("/")
  if (parts.slice(0, -1).some((p) => EXEMPT_DIRS.has(p))) return true
  return EXEMPT_FILE.some((re) => re.test(basename(rel)))
}

const countLines = (file) => readFileSync(file, "utf8").split("\n").length - 1

const files = [...new Set(ROOTS.flatMap(collect))]
  .map((file) => ({ file, rel: relative(ROOT, file).split(sep).join("/") }))
  .filter(({ rel }) => !isExempt(rel))

if (missing.length > 0) {
  if (STRICT) {
    console.error(`ROOTS 里的路径不存在：${missing.join(", ")}（改名 / 移走了？同步 check-size.mjs 的 ROOTS）`)
    process.exit(2)
  }
  console.log(`⚠ 跳过不存在的目录：${missing.join(", ")}（还没落地，不算通过）`)
}

const violations = files.map(({ rel }) => ({ rel, lines: countLines(join(ROOT, rel)) })).filter(({ lines }) => lines > LIMIT)

console.log(`产品代码单文件行数门禁（阈值 ${LIMIT} 行，检查 ${files.length} 个文件）`)
if (violations.length === 0) {
  console.log("✔ 通过")
  process.exit(0)
}
console.log(`\n超过 ${LIMIT} 行：`)
for (const v of violations) console.log(`  ✘ ${v.rel}  ${v.lines} 行`)
console.log("\n拆分要求见 AGENTS.md §4：不改行为、不改对外接口、单独提交。")
process.exit(1)
