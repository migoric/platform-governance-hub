// `~/.pgh/config.json` 的读写。这里最要紧的一条：写偏好不许碰别的键。
//
// 凭据就在同一个文件里（agent-acl §11）。一次「顺手清空重写」的事故，
// 表现是「设置页点了一下，服务就连不上了」，而且没有任何日志。

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { ConfigError, preferredOf, readConfig, writePreferred } from "../cli/config.mjs"
import { configPath, dataDir } from "../cli/fs.mjs"

function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), "pgh-config-"))
  const env = { ...process.env, PGH_HOME: home }
  // 手动写配置的用例需要目录已存在；正常路径由 writeAtomic 负责建
  mkdirSync(dataDir(env), { recursive: true })
  try {
    return run(env)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test("没有配置文件是正常状态，不是错误", () => {
  withHome((env) => {
    assert.deepEqual(readConfig(env), {})
  })
})

test("坏 JSON 要报错并带路径，不静默当空配置", () => {
  withHome((env) => {
    writeFileSync(configPath(env), "{ oops", "utf8")
    assert.throws(
      () => readConfig(env),
      (error) => error instanceof ConfigError && error.message.includes("config.json") && /JSON/.test(error.message),
    )
  })
})

test("顶层不是对象也要拦", () => {
  withHome((env) => {
    writeFileSync(configPath(env), "[1,2]", "utf8")
    assert.throws(() => readConfig(env), ConfigError)
  })
})

test("写偏好保留其它配置与凭据", () => {
  withHome((env) => {
    writeFileSync(
      configPath(env),
      JSON.stringify({ agent: { remote: { endpoint: "https://hub.example", token: "secret" }, ttl: 3 } }),
      "utf8",
    )
    writePreferred("replay", env)
    const config = readConfig(env)
    assert.equal(config.agent.preferred, "replay")
    assert.deepEqual(config.agent.remote, { endpoint: "https://hub.example", token: "secret" })
    assert.equal(config.agent.ttl, 3, "不认识的键也不能丢")
  })
})

test("auto 是删键，不是写一个 null", () => {
  withHome((env) => {
    writePreferred("replay", env)
    writePreferred(null, env)
    const raw = readFileSync(configPath(env), "utf8")
    assert.ok(!raw.includes("preferred"), raw)
    assert.ok(!raw.includes("agent"), "agent 空了就整个删掉，不留空对象")
  })
})

test("落盘 0600，目录 0700", () => {
  withHome((env) => {
    writePreferred("replay", env)
    const file = statSync(configPath(env))
    assert.equal(file.mode & 0o777, 0o600)
    const dir = statSync(join(configPath(env), ".."))
    assert.equal(dir.mode & 0o777, 0o700)
  })
})

test("preferredOf 只在类型不对时报错", () => {
  assert.equal(preferredOf({}), null)
  assert.equal(preferredOf({ agent: {} }), null)
  assert.equal(preferredOf({ agent: { preferred: "replay" } }), "replay")
  assert.throws(() => preferredOf({ agent: { preferred: 42 } }), ConfigError)
  assert.throws(() => preferredOf({ agent: { preferred: "  " } }), ConfigError)
})
