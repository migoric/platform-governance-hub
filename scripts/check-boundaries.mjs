#!/usr/bin/env node
// 边界门禁 —— AGENTS.md §2 的前三条。
//
//   1. 外部协议字段名只允许出现在 sidecar/agent/providers/
//   2. 全仓搜不到「按 provider 名字分支」的写法（只许按 capabilities）
//   3. sidecar 不得引第三方包（architecture.md §2：零依赖，node: 内置和相对路径之外一律不许）
//
// 退出码：0 通过 / 1 有命中 / 2 配置错误

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))

const SCAN_DIRS = ["sidecar", "GovernanceHub/crates", "browser"]
const SKIP_DIRS = new Set([".git", "node_modules", "target", ".build", "dist", "renders", "fixtures", ".pnpm-store"])

// 外部协议字段名：出现即说明有人在 provider 之外解析上游报文
const PROTOCOL_NAMES = ["content_block", "message_start", "message_delta", "response.completed", "text/event-stream", "stream-json"]
const PROVIDER_DIR = "sidecar/agent/providers/"

// 「按 provider 名字分支」：provider === "xxx" / providerID == "xxx"
const PROVIDER_BRANCH = /\bprovider[A-Za-z]*\s*(?:===?|!==?)\s*["'`]/

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile() && /\.(mjs|cjs|rs)$/.test(entry.name)) out.push(full)
  }
  return out
}

const existing = []
for (const dir of SCAN_DIRS) {
  try {
    if (statSync(join(ROOT, dir)).isDirectory()) existing.push(join(ROOT, dir))
  } catch {
    console.log(`⚠ 跳过不存在的目录：${dir}`)
  }
}

if (existing.length === 0) {
  console.error("没有可扫描的目录（sidecar / GovernanceHub/crates / browser 都不存在）")
  process.exit(2)
}

const files = existing.flatMap((dir) => walk(dir))
const violations = []

for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join("/")
  const lines = readFileSync(file, "utf8").split("\n")

  lines.forEach((line, index) => {
    const at = `${rel}:${index + 1}`

    // 门禁 1
    if (!rel.startsWith(PROVIDER_DIR)) {
      for (const name of PROTOCOL_NAMES) {
        if (line.includes(name)) violations.push({ at, rule: "外部协议字段名", detail: name })
      }
    }

    // 门禁 2
    if (PROVIDER_BRANCH.test(line)) violations.push({ at, rule: "按 provider 名字分支", detail: line.trim().slice(0, 80) })

    // 门禁 3：只查 sidecar
    if (rel.startsWith("sidecar/")) {
      const imported = /^\s*(?:import\s[^'"]*from\s*|import\s*)["']([^"']+)["']/.exec(line)
      const required = /\brequire\(\s*["']([^"']+)["']\s*\)/.exec(line)
      const spec = imported?.[1] ?? required?.[1]
      if (spec && !spec.startsWith(".") && !spec.startsWith("node:")) {
        violations.push({ at, rule: "sidecar 引第三方包", detail: spec })
      }
    }
  })
}

console.log(`边界门禁（${files.length} 个文件）`)
if (violations.length === 0) {
  console.log("✔ 通过")
  process.exit(0)
}
console.log("\n命中：")
for (const v of violations) console.log(`  ✘ ${v.at}  ${v.rule}：${v.detail}`)
console.log("\n说明：外部字段名收进 sidecar/agent/providers/；分支按 capabilities；sidecar 只用 node: 与相对路径。")
process.exit(1)
