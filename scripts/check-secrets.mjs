#!/usr/bin/env node
// 敏感信息门禁 —— AGENTS.md §2 的第 4 条、README「如果要把仓库公开」。
//
// 两类检查：
//   1. 凭据形态（内建，不需要配置）：真 token 才报，文档里提到「凭据前缀」这种说法不报。
//   2. 内网域名 / 真实平台名：**词表不进仓库**，放在 scripts/gates.local.json（已 gitignore）。
//      理由和「平台是外挂」一样——内网域名本身就是敏感信息，写进仓库等于自曝。
//
// 退出码：0 通过 / 1 有命中 / 2 配置错误

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const LOCAL_CONFIG = join(ROOT, "scripts", "gates.local.json")
const SELF = fileURLToPath(import.meta.url)

const seg = (...parts) => parts.join("")

// 真 token 的形态：前缀 + 足够长的随机段。只写「AKIA 这类前缀」不会命中，避免误报文档。
const CREDENTIALS = [
  { id: "github-token", re: new RegExp(`\\b${seg("gh", "p_")}[A-Za-z0-9]{30,}\\b`) },
  { id: "github-oauth", re: new RegExp(`\\b${seg("gh", "o_")}[A-Za-z0-9]{30,}\\b`) },
  { id: "aws-key", re: new RegExp(`\\b${seg("AK", "IA")}[0-9A-Z]{16}\\b`) },
  { id: "openai-key", re: new RegExp(`\\b${seg("s", "k-")}[A-Za-z0-9]{32,}\\b`) },
  { id: "slack-token", re: new RegExp(`\\b${seg("xo", "xb-")}[0-9A-Za-z-]{20,}\\b`) },
  { id: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
]

const TEXT_EXT = new Set([
  ".md", ".mjs", ".cjs", ".js", ".jsx", ".ts", ".tsx", ".json", ".rs", ".toml", ".sh", ".yml", ".yaml",
  ".html", ".css", ".txt", ".swift", ".gitignore", ".env", "",
])
const SKIP_DIRS = new Set([".git", "node_modules", "target", ".build", "dist", "renders", ".pnpm-store", "vendor"])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, out)
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".")
      const ext = dot === -1 ? "" : entry.name.slice(dot)
      if (!TEXT_EXT.has(ext)) continue
      if (statSync(full).size > 2 * 1024 * 1024) continue
      out.push(full)
    }
  }
  return out
}

let local = { forbiddenPatterns: [] }
try {
  local = JSON.parse(readFileSync(LOCAL_CONFIG, "utf8"))
} catch (error) {
  if (error.code !== "ENOENT") {
    console.error(`scripts/gates.local.json 解析失败：${error.message}`)
    process.exit(2)
  }
}

const extra = (local.forbiddenPatterns ?? []).map((pattern) => ({
  id: "forbidden-word",
  re: new RegExp(pattern, "i"),
  label: pattern,
}))

if (extra.length === 0) {
  console.log("⚠ 未配置 scripts/gates.local.json 的 forbiddenPatterns：内网域名 / 平台名未检查（不算通过）")
}

const rules = [...CREDENTIALS, ...extra]
const hits = []
const files = walk(ROOT).filter((file) => file !== SELF)

for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join("/")
  if (rel === "scripts/gates.local.json") continue // 词表本身当然包含这些词
  const lines = readFileSync(file, "utf8").split("\n")
  lines.forEach((line, i) => {
    for (const rule of rules) {
      if (rule.re.test(line)) hits.push({ rel, line: i + 1, id: rule.id })
    }
  })
}

console.log(`敏感信息门禁（${files.length} 个文本文件，${rules.length} 条规则）`)
if (hits.length === 0) {
  console.log("✔ 通过")
  process.exit(0)
}
console.log("\n命中：")
for (const hit of hits) console.log(`  ✘ ${hit.rel}:${hit.line}  ${hit.id}`)
console.log("\n凭据请走 keychain / 环境变量；内网域名请写进 scripts/gates.local.json 的词表。")
process.exit(1)
