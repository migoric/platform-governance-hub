// `pgh agent` 的 CLI 行为 —— 不用开窗口就能验证降级与事件流是否合规。
//
// 这些测试用 replay 作为确定性数据源：它不依赖本机装没装 claude，
// 所以结论在 CI 与开发机上一致。

import assert from "node:assert/strict"
import test from "node:test"

import { main } from "../pgh.mjs"

/** 收集一次 CLI 调用的输出。agent 子命令是异步的，这里统一 await。 */
async function run(argv) {
  const out = []
  const err = []
  const code = await main(argv, { stdout: (s) => out.push(s), stderr: (s) => err.push(s) })
  return { code, out: out.join("\n"), err: err.join("\n") }
}

test("agent list 列出所有 provider，不可用的要给出原因", async () => {
  const { code, out } = await run(["agent", "list"])
  assert.equal(code, 0)
  assert.match(out, /remote/)
  assert.match(out, /claude-cli/)
  assert.match(out, /replay/)
  // 每个不可用的都得有理由，不能只画一个叉
  const badLines = out.split("\n").filter((line) => line.startsWith("✘"))
  for (const line of badLines) assert.ok(line.length > 10, `失败没给原因：${line}`)
})

test("handshake 说清降级到哪一层、为什么", async () => {
  const { code, out } = await run(["agent", "handshake", "--provider", "replay"])
  assert.equal(code, 0)
  assert.match(out, /使用 replay/)
  assert.match(out, /回放数据，不是真实分析/)
})

test("run 走回放时，降级提示进 stderr（不混进正文）", async () => {
  const { code, out, err } = await run(["agent", "run", "--provider", "replay", "--prompt", "看看 it_8f21a"])
  assert.equal(code, 0)
  assert.match(err, /回放数据，不是真实分析/)
  // 正文里不该出现那条警告，否则用户复制正文会把警告一起带走
  assert.ok(!out.includes("回放数据，不是真实分析"))
  assert.match(out, /Best/)
  assert.match(out, /成本 —/, "拿不到成本要显示破折号，不是 0")
})

test("run --json 输出一行一个事件，且事件流合契约", async () => {
  const { code, out } = await run(["agent", "run", "--provider", "replay", "--json", "--prompt", "x"])
  assert.equal(code, 0)
  const events = out
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
  assert.equal(events[0].kind, "started")
  assert.equal(events.at(-1).kind, "done")
})

test("run 缺 --prompt 是用法错误（退出码 2），不是运行失败", async () => {
  const { code, err } = await run(["agent", "run"])
  assert.equal(code, 2)
  assert.match(err, /--prompt/)
})

test("tool 直接调只读工具；名字写错返回 1 而不是崩", async () => {
  const ok = await run(["agent", "tool", "rule_lookup", "--args", '{"ruleId":"listing.title.absolute_terms"}'])
  assert.equal(ok.code, 0)
  assert.match(ok.out, /listing\.title\.absolute_terms/)

  const bad = await run(["agent", "tool", "not_a_tool"])
  assert.equal(bad.code, 1)
  assert.match(bad.out, /没有这个工具/)
})

test("tool 的 --args 不是合法 JSON 时报用法错误", async () => {
  const { code, err } = await run(["agent", "tool", "snapshot_query", "--args", "{oops"])
  assert.equal(code, 2)
  assert.match(err, /JSON/)
})

test("不认识的子命令给出用法，不静默成功", async () => {
  const { code, err } = await run(["agent", "deploy"])
  assert.equal(code, 2)
  assert.match(err, /不认识的子命令/)
  assert.match(err, /用法/)
})

test("pgh 帮助里能看到 agent 入口", async () => {
  const { out } = await run(["--help"])
  assert.match(out, /agent/)
})

test("直接执行入口时，异步命令的退出码能传出去", async () => {
  const { spawnSync } = await import("node:child_process")
  const { join, dirname } = await import("node:path")
  const { fileURLToPath } = await import("node:url")
  const root = join(dirname(fileURLToPath(import.meta.url)), "..")

  const ok = spawnSync(process.execPath, [join(root, "pgh.mjs"), "agent", "handshake", "--provider", "replay"], {
    encoding: "utf8",
  })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /replay/)

  // 不可用的 provider 要以非零退出，不能被 Promise 吞掉
  const bad = spawnSync(process.execPath, [join(root, "pgh.mjs"), "agent", "handshake", "--provider", "remote"], {
    encoding: "utf8",
  })
  assert.equal(bad.status, 1, bad.stdout + bad.stderr)
})

test("异步命令抛错时退出码为 1，不能被 Promise 吞成 0", async () => {
  const { settle } = await import("../pgh.mjs")
  const before = process.exitCode
  const logs = []

  settle(Promise.reject(new Error("provider 炸了")), { error: (e) => logs.push(e.message) })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(process.exitCode, 1)
  assert.deepEqual(logs, ["provider 炸了"])
  process.exitCode = before
})

test("同步命令的退出码原样落下去", async () => {
  const { settle } = await import("../pgh.mjs")
  const before = process.exitCode
  settle(2)
  assert.equal(process.exitCode, 2)
  process.exitCode = before
})
