// `pgh agent` —— 握手、跑一次会话、调工具（agent-acl §5、§9）。
//
// 这个命令存在的意义是**可验证**：不用开窗口就能确认「降级到哪一层、为什么」、
// 「事件流合不合规」、「工具返回什么」。UI 之后读的是同一份结论，不是另算一遍。

import { readFileSync } from "node:fs"

import { Event, CONTRACT_VERSION, sumCost, joinText, validateTimeline, toolTrace } from "../../agent/contract.mjs"
import { resolveAgent, handshake } from "../../agent/ladder.mjs"
import { listProviderIds, createProvider } from "../../agent/providers/registry.mjs"
import { SessionProjectionError, SessionValidationError, assertValidSession, projectSession } from "../../agent/session.mjs"
import { listTools, invokeTool } from "../../agent/tools.mjs"
import { loadRuleSet } from "../../rules/load.mjs"
import { parseFlags, UsageError } from "../args.mjs"
import { agentSessionPath, snapshotPath, stringify, writeAtomic } from "../fs.mjs"

export const AGENT_USAGE = `用法：pgh agent <子命令> [参数]

  list                            列出注册的 provider 与各自握手结果
  handshake [--provider <id>]     只握手，看降级到哪一层（默认跑整条阶梯）
  run --prompt <文本>             跑一次会话，事件流打到 stdout
  session --prompt <文本>         跑一次会话并落盘**投影**（界面读这份，不读事件流）
  tool <名字> [--args <JSON>]     直接调一个只读工具（调试用）

公共参数：
  --provider <id>   指定 provider（${listProviderIds().join(" / ")}）；不给就走降级阶梯
  --json            机器可读输出（一行一个 JSON）
  --snapshot <文件> 覆盖快照路径（默认 ~/.pgh/snapshot.json）

session 专有：
  --out <文件>      写到指定路径（默认 ~/.pgh/agent/session.json）
  --pretty          JSON 缩进输出（落盘仍是紧凑单行，除非重定向）`

/** 读快照；读不到不算错，工具会自己报「没有这个分区」。 */
function readSnapshot(env, file) {
  const path = file ?? snapshotPath(env)
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

function printHandshake(stdout, handshakeResult) {
  const mark = handshakeResult.ok ? "✔" : "✘"
  stdout(`${mark} ${handshakeResult.provider}  契约 v${handshakeResult.contractVersion}`)
  if (handshakeResult.reason) stdout(`  ${handshakeResult.reason}`)
  const caps = handshakeResult.capabilities ?? {}
  stdout(
    `  能力：流式 ${caps.streaming ? "有" : "无"} · 工具 ${caps.tools ? "有" : "无"} · 视觉 ${caps.vision ? "有" : "无"} · 成本 ${caps.cost ? "有" : "无"}`,
  )
}

async function runList({ stdout, config }) {
  for (const id of listProviderIds()) {
    const result = await handshake(createProvider(id, { config: config?.agent?.[id] ?? config?.[id] }))
    printHandshake(stdout, result)
  }
  return 0
}

async function runHandshake({ flags, stdout, stderr, config }) {
  const { provider, degraded, reason, attempts } = await resolveAgent({ config, preferred: flags.provider })

  if (flags.json === true) {
    stdout(JSON.stringify({ ok: provider !== null, provider: provider?.id() ?? "none", degraded, reason: attempts }))
    return provider ? 0 : 1
  }

  for (const attempt of attempts) {
    stdout(`${attempt.ok ? "✔" : "✘"} ${attempt.provider}${attempt.reason ? `  ${attempt.reason}` : ""}`)
  }
  if (!provider) {
    stderr("没有任何可用 provider。")
    return 1
  }
  stdout(`→ 使用 ${provider.id()}${degraded ? `（已降级）` : ""}`)
  if (reason) stdout(`  ${reason}`)
  return 0
}

async function runSession({ flags, stdout, stderr, env, config }) {
  if (typeof flags.prompt !== "string" || flags.prompt.trim() === "") {
    stderr("run 需要 --prompt")
    stderr(AGENT_USAGE)
    return 2
  }

  const { provider, degraded, reason } = await resolveAgent({ config, preferred: flags.provider })
  if (!provider) {
    stderr(reason ?? "没有可用的 agent 服务")
    return 1
  }
  // 降级必须明说 —— 这是 agent-acl §6 第 1 条，CLI 与 UI 同一条规矩
  if (degraded) stderr(`⚠ ${reason ?? "已降级"}（provider：${provider.id()}）`)

  const events = []
  for await (const event of provider.start({ prompt: flags.prompt })) {
    events.push(event)
    if (flags.json === true) stdout(JSON.stringify(event))
  }

  const violations = validateTimeline(events)
  if (flags.json !== true) {
    const text = joinText(events)
    if (text !== "") stdout(text)
    const cost = sumCost(events)
    stdout(`— ${events.length} 个事件 · 工具 ${toolTrace(events).length} 次 · 成本 ${cost === null ? "—" : `$${cost.toFixed(4)}`}`)
  }

  if (violations.length > 0) {
    stderr(`事件流违反契约（${violations.length} 处）：`)
    for (const v of violations) stderr(`  · [${v.at}] ${v.rule}  ${v.detail}`)
    return 1
  }

  const done = events.find((e) => e?.kind === Event.DONE)
  void env
  return done?.reason === "ok" ? 0 : 1
}

/**
 * `pgh agent session` —— 跑一次会话，落盘**投影**而不是事件流。
 *
 * 界面读这份文件。它与 `run` 的区别不是「跑法不同」，而是「存什么」：
 * 事件流是过程，投影是结论。存过程会让界面自己聚合一遍（第二个计算处），
 * 存结论又怕手写 —— 所以投影里同时带着 events，校验器从 events 重算比对
 * （`validateSession` 的 E_SESSION_TIMELINE_DRIFT）。
 */
async function runRecordSession({ flags, stdout, stderr, env, config }) {
  if (typeof flags.prompt !== "string" || flags.prompt.trim() === "") {
    stderr("session 需要 --prompt")
    stderr(AGENT_USAGE)
    return 2
  }

  const { provider, degraded, reason } = await resolveAgent({ config, preferred: flags.provider })
  if (!provider) {
    stderr(reason ?? "没有可用的 agent 服务")
    return 1
  }
  // 归属声明由 provider 给，写盘前后各说一次 —— 落到磁盘上的东西，看到终端的人都该知道它是什么。
  // 降级原因和归属标签常常是同一句话（replay 的 reason 就是它的 label），只说一次。
  const attribution = provider.attribution()
  if (degraded && reason && reason !== attribution.label) stderr(`⚠ ${reason}（provider：${provider.id()}）`)

  const events = []
  for await (const event of provider.start({ prompt: flags.prompt })) events.push(event)

  let session
  try {
    session = assertValidSession(projectSession(events, { prompt: flags.prompt, attribution }))
  } catch (error) {
    if (error instanceof SessionProjectionError) {
      stderr(`拒绝落盘：${error.message}`)
      for (const d of error.details) stderr(`  · ${d.rule}@${d.at}  ${d.detail ?? ""}`)
      return 1
    }
    if (error instanceof SessionValidationError) {
      stderr(error.message)
      for (const e of error.errors) stderr(`  · ${e.path || "<root>"}  ${e.code}  ${e.message}`)
      return 1
    }
    throw error
  }

  // 归属声明必须在写盘前说出来：落到磁盘上的东西，看过终端的人都该知道它是什么
  if (session.attribution.real === false) stderr(`⚠ ${session.attribution.label}`)

  const summary = `${session.eventCount} 个事件 · ${session.toolCount} 次工具 · 耗时未知 · 成本 ${session.usage?.costUsd === null || session.usage === null ? "—" : `$${session.usage.costUsd.toFixed(4)}`}`

  if (flags.json === true) {
    stdout(JSON.stringify(session))
    return 0
  }
  if (typeof flags.out === "string") {
    writeAtomic(flags.out, stringify(session, false))
    stderr(`已写入 ${flags.out}（${summary}）`)
    return 0
  }
  if (flags.pretty === true) {
    stdout(stringify(session, true))
    return 0
  }
  const target = agentSessionPath(env)
  writeAtomic(target, stringify(session, false))
  stderr(`已写入 ${target}（${summary}）`)
  return 0
}

function runTool({ flags, stdout, stderr, env }) {
  const name = flags._?.[0]
  if (typeof name !== "string") {
    stderr("tool 需要一个工具名")
    stderr(AGENT_USAGE)
    return 2
  }
  let args = {}
  if (typeof flags.args === "string") {
    try {
      args = JSON.parse(flags.args)
    } catch (error) {
      stderr(`--args 不是合法 JSON：${error.message}`)
      return 2
    }
  }

  const result = invokeTool(name, args, {
    snapshot: readSnapshot(env, flags.snapshot),
    ruleSet: loadRuleSet(),
  })

  if (flags.json === true) {
    stdout(JSON.stringify(result))
  } else {
    stdout(`${result.ok ? "✔" : "✘"} ${result.summary}`)
    if (result.note) stdout(`  ${result.note}`)
  }
  return result.ok ? 0 : 1
}

/**
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, stdout?: (s: string) => void, stderr?: (s: string) => void }} [io]
 * @returns {Promise<number>}
 */
export async function runAgent(argv, io = {}) {
  const stdout = io.stdout ?? console.log
  const stderr = io.stderr ?? console.error
  const env = io.env ?? process.env

  let parsed
  try {
    parsed = parseFlags(argv, {
      booleans: ["json", "help", "pretty"],
      strings: ["provider", "prompt", "args", "snapshot", "out"],
    })
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(error.message)
      stderr(AGENT_USAGE)
      return 2
    }
    throw error
  }

  const { flags, positional } = parsed
  if (flags.help === true || positional.length === 0) {
    stdout(AGENT_USAGE)
    return flags.help === true ? 0 : 2
  }

  const config = {}
  const [sub, ...rest] = positional
  const ctx = { flags: { ...flags, _: rest }, stdout, stderr, env, config }

  switch (sub) {
    case "list":
      return runList(ctx)
    case "handshake":
      return runHandshake(ctx)
    case "run":
      return runSession(ctx)
    case "session":
      return runRecordSession(ctx)
    case "tool":
      return runTool(ctx)
    default:
      stderr(`不认识的子命令：${sub}`)
      stderr(AGENT_USAGE)
      return 2
  }
}

export { CONTRACT_VERSION, listTools }
