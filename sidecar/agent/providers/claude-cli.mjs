// claude-cli provider —— 调用本机已安装的 claude 命令（agent-acl §6 阶梯中段）。
//
// ⚠️ 本机（开发机）没有装 claude，所以下面的映射**没有对真实输出验证过**。
// 格式依据的是 claude CLI `--output-format stream-json` 的公开形态，不是录制结果。
// 验证它只有一条路：在有 claude 的机器上跑一次 `node sidecar/pgh.mjs agent record --provider claude-cli`，
// 用真实录制替换掉 test/fixtures/agent/claude-cli.stream.jsonl，再跑 conformance。
// 在那之前，这个 provider 的准确说法是「翻译层写好了，端到端未验证」。
//
// 外部协议字段名（stream-json / content_block 之类）**只许出现在这个文件里** ——
// 这是 agent-acl §8 那条 grep 门禁存在的全部意义：逼你把翻译写在正确的位置。

import { spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"

import { Event, normalizeCapabilities } from "../contract.mjs"

/** claude CLI 能给出成本，但只在 result 事件里；在此之前 UI 显示「—」。 */
const CAPABILITIES = {
  streaming: true,
  tools: true,
  vision: true,
  cost: true,
  maxSteps: 8,
}

/** 单次超时与「无首 token」超时（agent-acl §6 第 4 条）。 */
export const TIMEOUT_MS = 30_000
export const FIRST_TOKEN_MS = 45_000

/**
 * 探测命令是否可用。查 PATH 而不是执行 `--version`：
 * 后者会加载配置、可能弹权限，探测不该有副作用。
 *
 * 注意不能用 `spawn` + try/catch —— 命令不存在时 spawn 是**异步**报 error，
 * 同步 catch 捕不到，结果永远是「装了」。这个坑踩过一次。
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isInstalled(command = "claude") {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""]
  const candidates = command.includes("/") || command.includes("\\")
    ? [command]
    : (process.env.PATH ?? "").split(delimiter).flatMap((dir) => (dir ? exts.map((e) => join(dir, command + e)) : []))

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return true
    } catch {
      // 继续找下一个
    }
  }
  return false
}

/**
 * 把 claude 的一行 stream-json 翻译成内部事件。
 *
 * 返回数组而不是单条：assistant 消息里可能同时有文本与工具调用。
 * 认不出的类型返回空数组 —— **忽略并计数由调用方做**，翻译层不抛错。
 *
 * @param {object} raw
 * @param {{ callIds: Map<string, string>, nextId: () => string }} state
 * @returns {object[]}
 */
export function translateLine(raw, state) {
  const out = []

  // ① 系统初始化：不产生事件，但它是「服务真的活了」的唯一信号
  if (raw.type === "system") return out

  // ② assistant：文本增量 + 工具调用
  if (raw.type === "assistant") {
    const blocks = raw.message?.content
    if (!Array.isArray(blocks)) return out
    for (const block of blocks) {
      if (block?.type === "text" && typeof block.text === "string") {
        out.push({ kind: Event.TEXT, delta: block.text })
      } else if (block?.type === "tool_use") {
        // 外部 id 格式各异，一律换成本地 callId（铁律 3），但要记住映射以便配对
        const callId = state.nextId()
        if (typeof block.id === "string") state.callIds.set(block.id, callId)
        out.push({ kind: Event.TOOL_CALL, callId, name: block.name, args: block.input ?? {} })
      }
    }
    return out
  }

  // ③ user：工具结果回流
  if (raw.type === "user") {
    const blocks = raw.message?.content
    if (!Array.isArray(blocks)) return out
    for (const block of blocks) {
      if (block?.type !== "tool_result") continue
      const callId = state.callIds.get(block.tool_use_id)
      // 对不上本地 callId 就别硬塞一条无主的 tool_result，那会让铁律 3 误报
      if (!callId) continue
      const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "")
      out.push({
        kind: Event.TOOL_RESULT,
        callId,
        ok: block.is_error !== true,
        summary: text.slice(0, 200),
        bytes: Buffer.byteLength(text, "utf8"),
      })
    }
    return out
  }

  // ④ result：收尾。成本拿不到就给 null，不要给 0（铁律 4）
  if (raw.type === "result") {
    const usage = raw.usage
    if (usage && (Number.isInteger(usage.input_tokens) || Number.isInteger(usage.output_tokens))) {
      out.push({
        kind: Event.USAGE,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        costUsd: typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : null,
      })
    }
    out.push({
      kind: Event.DONE,
      reason: raw.is_error === true || raw.subtype === "error" ? "error" : "ok",
    })
  }

  return out
}

/**
 * 消费一个逐行 JSON 的流，翻译成内部事件。
 *
 * 抽出来是为了可测：真正跑进程的部分没法在没装 claude 的机器上验，
 * 但「给定这些行，产出哪些事件、收尾对不对」是纯逻辑，必须能测。
 *
 * @param {AsyncIterable<string>} input 逐行输入
 * @param {{ callIds: Map<string, string>, nextId: () => string }} state
 * @param {{ isCancelled: () => boolean, failure: () => string | null }} control
 * @returns {AsyncGenerator<object>}
 */
export async function* consumeLines(input, state, control) {
  let sawDone = false
  for await (const line of input) {
    if (control.isCancelled()) break
    if (line.trim() === "") continue
    let raw
    try {
      raw = JSON.parse(line)
    } catch {
      continue // 非 JSON 行（进度条、警告）直接跳过，不进事件流
    }
    for (const event of translateLine(raw, state)) {
      if (event.kind === Event.DONE) sawDone = true
      yield event
    }
  }

  if (sawDone) return

  // 三条退出路径都要有 done（铁律 5），少一条 UI 的转圈就永远不停
  const failure = control.failure()
  if (control.isCancelled()) {
    yield { kind: Event.DONE, reason: "cancelled" }
  } else if (failure !== null) {
    yield {
      kind: Event.ERROR,
      code: failure === "timeout" ? "E_TIMEOUT" : "E_NO_FIRST_TOKEN",
      message: failure === "timeout" ? "超过 30s 未完成" : "45s 内没有首个输出",
      retryable: true,
    }
    yield { kind: Event.DONE, reason: "error" }
  } else {
    yield {
      kind: Event.ERROR,
      code: "E_NO_DONE",
      message: "进程结束但没有 result 事件",
      retryable: false,
    }
    yield { kind: Event.DONE, reason: "error" }
  }
}

/**
 * @param {{ command?: string, timeoutMs?: number, firstTokenMs?: number }} [options]
 * @returns {import("../provider.mjs").Provider & { isInstalled: () => boolean }}
 */
export function createClaudeCliProvider({ command = "claude", timeoutMs = TIMEOUT_MS, firstTokenMs = FIRST_TOKEN_MS } = {}) {
  let child = null
  let cancelled = false

  return {
    id: () => "claude-cli",
    isInstalled: () => isInstalled(command),

    /** 本机命令行分析，是真跑了一遍模型，不是回放。 */
    attribution() {
      return { real: true, label: "本机 claude 分析" }
    },

    /**
     * 自我探测。握手只调这个方法，**不判断 provider 名字** ——
     * 一旦上层写成「如果 id 是 claude-cli 就检查安装」，加第四个 provider 时又得改一遍。
     */
    async probe() {
      return isInstalled(command)
        ? { ok: true }
        : { ok: false, reason: `本机没有 ${command} 命令（未安装或不在 PATH 里）` }
    },

    async capabilities() {
      return normalizeCapabilities(CAPABILITIES)
    },

    /**
     * 起一个进程，按行翻译。
     *
     * 超时与取消的收尾交给 consumeLines —— 三条退出路径都必须有 `done`（铁律 5）。
     */
    async *start(req) {
      cancelled = false
      const callIds = new Map()
      let seq = 0
      const state = { callIds, nextId: () => `call-${++seq}` }

      // started 必须第一个（铁律 1）。适配器自己知道 id 与能力，就不该等上层补。
      // 这里直接读常量而不是 this.capabilities()：start 被解构调用时 this 就没了。
      yield {
        kind: Event.STARTED,
        sessionId: `sess-claude-${Date.now()}`,
        provider: "claude-cli",
        capabilities: normalizeCapabilities(CAPABILITIES),
      }

      child = spawn(command, ["-p", req.prompt ?? "", "--output-format", "stream-json", "--verbose"], {
        stdio: ["ignore", "pipe", "pipe"],
      })

      let killedFor = null
      let sawFirstToken = false

      const firstTokenTimer = setTimeout(() => {
        if (!sawFirstToken) killedFor = "first_token_timeout"
        child?.kill()
      }, firstTokenMs)
      const hardTimer = setTimeout(() => {
        killedFor = "timeout"
        child?.kill()
      }, timeoutMs)

      const lines = createInterface({ input: child.stdout })
      try {
        for await (const event of consumeLines(lines, state, {
          isCancelled: () => cancelled,
          failure: () => killedFor,
        })) {
          if (!sawFirstToken && event.kind === Event.TEXT) {
            sawFirstToken = true
            clearTimeout(firstTokenTimer)
          }
          yield event
        }
      } finally {
        clearTimeout(firstTokenTimer)
        clearTimeout(hardTimer)
      }
    },

    async cancel() {
      cancelled = true
      child?.kill()
    },
  }
}
