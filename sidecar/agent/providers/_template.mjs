// _template —— 接新 agent 服务时复制这个文件（agent-acl §10）。
//
// 复制成 providers/<name>.mjs，改三处：id、capabilities、start 的翻译逻辑。
// 然后在 providers/registry.mjs 里追加一行。上层零改动。
//
// 四件事必须做对，否则 conformance 过不去：
//   1. 产出只用 contract.mjs 的 7 种事件，别自己发明 kind
//   2. tool_call 与 tool_result 用你生成的 callId 配对（外部 id 不许直接透出）
//   3. 拿不到成本就不发 usage.costUsd，或发 null —— 不要写 0
//   4. 任何退出路径（正常 / 超时 / 取消 / 抛错）都必须有 done

import { Event } from "../contract.mjs"

/**
 * @param {object} [options] 适配器自己的配置（从 ~/.pgh/config.json 读，别硬编码）
 * @returns {import("../provider.mjs").Provider}
 */
export function createTemplateProvider(options = {}) {
  let cancelled = false

  return {
    // 起个名字。注册表用它做 key，fixture 用它命名，UI 只是**展示**它（不做分支判断）
    id: () => "template",

    async capabilities() {
      // 按实际能力声明。不支持的写 false —— UI 会灰掉对应入口并注明原因，
      // 这比「支持但返回空结果」诚实得多。
      return {
        streaming: true,
        tools: false,
        vision: false,
        cost: false,
        maxSteps: 4,
      }
    },

    async *start(req) {
      cancelled = false
      void options
      void req

      // 起会话必须先发 started，否则整条时间线都是违规的
      yield {
        kind: Event.STARTED,
        sessionId: `sess-template-${Date.now()}`,
        provider: "template",
        capabilities: await this.capabilities(),
      }

      try {
        // ── 在这里把外部服务的输出逐条翻译成 7 种事件 ──
        // 流式服务：来一段发一条 text；非流式：整段包成一条 text 也行。
        yield { kind: Event.TEXT, delta: "…" }

        yield { kind: Event.DONE, reason: cancelled ? "cancelled" : "ok" }
      } catch (error) {
        // 异常路径也要收尾（铁律 5）
        yield {
          kind: Event.ERROR,
          code: "E_TEMPLATE_FAILED",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        }
        yield { kind: Event.DONE, reason: "error" }
      }
    },

    async cancel() {
      cancelled = true
    },
  }
}
