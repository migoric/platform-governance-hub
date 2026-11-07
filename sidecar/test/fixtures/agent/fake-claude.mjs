#!/usr/bin/env node
// 假的 claude CLI —— 让 claude-cli provider 的进程层也能被测到。
//
// 存在的理由：开发机没装 claude，但 start() 里的 spawn / 读行 / 收尾
// 是真代码，不能因为「本机没有」就一直不测。这个脚本按样例格式吐行，
// 契约与 test/fixtures/agent/claude-cli.stream.jsonl 一致。
//
// 它**不能**证明真实的 claude 输出长这样 —— 那要靠真实录制。
// 它证明了：给定这样的输出，provider 的进程层能正确翻译并收尾。

const lines = [
  { type: "system", subtype: "init", session_id: "sess-fake" },
  { type: "assistant", message: { content: [{ type: "text", text: "先看看数据。" }] } },
  {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "toolu_fake_01", name: "snapshot_query", input: { section: "items" } }],
    },
  },
  {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_fake_01", content: '{"n":1}' }] },
  },
  { type: "assistant", message: { content: [{ type: "text", text: "结论如上。" }] } },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    usage: { input_tokens: 10, output_tokens: 5 },
    total_cost_usd: 0.0002,
  },
]

// 混一行非 JSON，验证 provider 会跳过而不是崩
console.log("启动中…")
for (const line of lines) console.log(JSON.stringify(line))
