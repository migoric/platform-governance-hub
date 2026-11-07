// remote provider —— 公司网关。对端尚未存在（agent-acl §12）。
//
// 这个文件是**空实现 + 骨架**，故意不发请求：一个没有对端的 HTTP 客户端
// 只会把「服务没上线」伪装成「网络抖了一下」，让排查的人白跑。
//
// 所以这里的 start 一律抛 E_REMOTE_NOT_CONFIGURED / E_REMOTE_NOT_IMPLEMENTED，
// 让降级阶梯老实退到 claude-cli 或 replay，并在 UI 上说清为什么。
//
// 对端就绪后按 docs/agent-acl.md §12.2 的六件事逐条确认，再回来实现
// `start`：把 SSE 逐行翻译成 7 种事件，翻译逻辑只写在这个文件里。

import { Event } from "../contract.mjs"

/** 配置读取只认 ~/.pgh/config.json 的 agent.remote（凭据不进代码、不进日志）。 */
export function createRemoteProvider({ config } = {}) {
  const endpoint = config?.endpoint ?? null
  const configured = typeof endpoint === "string" && endpoint.trim() !== ""

  return {
    id: () => "remote",

    /** 远程 hub 一旦接上就是真实分析；接不上时压根不会走到这里（probe 先失败）。 */
    attribution() {
      return { real: true, label: "远程 hub 分析" }
    },

    /** 自我探测：没配 endpoint 就是不可用。握手只调这个方法，不判断名字。 */
    async probe() {
      return configured
        ? { ok: false, reason: "已配置 endpoint，但协议尚未接入（对端未就绪）" }
        : { ok: false, reason: "远程 hub 未配置（~/.pgh/config.json 缺 agent.remote.endpoint）" }
    },

    async capabilities() {
      // 没配置就当「什么都不支持」，UI 据此灰掉入口，而不是显示一个假的绿灯
      return {
        streaming: false,
        tools: false,
        vision: false,
        cost: false,
        maxSteps: 0,
      }
    },

    async *start() {
      // 先发 started：不发的话整条时间线都违反铁律 1（第一个事件必须是 started），
      // 哪怕后面全是失败也不合规 —— 失败也要失败得合规。
      yield {
        kind: Event.STARTED,
        sessionId: "sess-remote-unavailable",
        provider: "remote",
        capabilities: await this.capabilities(),
      }

      if (!configured) {
        yield {
          kind: Event.ERROR,
          code: "E_REMOTE_NOT_CONFIGURED",
          message: "远程 hub 未配置（~/.pgh/config.json 缺 agent.remote.endpoint）",
          retryable: false,
        }
        yield { kind: Event.DONE, reason: "error" }
        return
      }
      // 配了但还没实现对端协议 —— 这里必须失败得清清楚楚
      yield {
        kind: Event.ERROR,
        code: "E_REMOTE_NOT_IMPLEMENTED",
        message: "远程 hub 协议尚未接入（对端未就绪，见 docs/agent-acl.md §12）",
        retryable: false,
      }
      yield { kind: Event.DONE, reason: "error" }
    },

    async cancel() {
      // 没有在途请求，无需收尾；保留方法是为了满足 Provider 接口
    },
  }
}
