// `~/.pgh/config.json` 的读写 —— agent 服务配置的唯一入口。
//
// 为什么单独一个文件：配置里要放凭据（agent-acl §11），读写权限与「保留其它字段」
// 这两件事必须只有一处实现。写偏好的时候顺手把凭据清掉，是最难查的那种事故。
//
// 坏配置**不宽容**：读到非法 JSON 就抛错，不静默当空配置。
// 当空配置的后果是「偏好设置突然失效」，而用户会以为是自己选错了服务。

import { readFileSync } from "node:fs"

import { configPath, writeAtomic } from "./fs.mjs"

/** 配置读不了 / 不是对象。消息里带路径，排查时不用猜。 */
export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = "ConfigError"
  }
}

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * 读配置。文件不存在返回 `{}`（第一次用是正常状态，不是错误）。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, unknown>}
 */
export function readConfig(env = process.env) {
  const path = configPath(env)
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return {}
    throw new ConfigError(`${path} 读不了：${error.message}`)
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ConfigError(`${path} 不是合法 JSON：${error.message}`)
  }
  if (!isObj(parsed)) throw new ConfigError(`${path} 顶层必须是对象`)
  return parsed
}

/**
 * 写 `agent.preferred`。`null` 表示「按阶梯自动选」，键会被删掉而不是写成 null。
 *
 * 只动这一个键：`agent.remote.endpoint` 之类的配置与凭据原样保留。
 * 配置坏了直接抛（readConfig），不做「先清空再写」—— 那等于用一次点击换掉凭据。
 *
 * @param {string | null} id
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} 写入路径
 */
export function writePreferred(id, env = process.env) {
  const config = readConfig(env)
  const agent = isObj(config.agent) ? { ...config.agent } : {}

  if (id === null) delete agent.preferred
  else agent.preferred = id

  const next = { ...config }
  if (Object.keys(agent).length > 0) next.agent = agent
  else delete next.agent

  return writeAtomic(configPath(env), JSON.stringify(next))
}

/**
 * 读当前偏好。没配 / 类型不对都返回 `null`（不是「自动选 remote」）。
 * 类型不对要说出来，所以坏值也算配置错误。
 *
 * @param {Record<string, unknown>} config
 * @returns {string | null}
 */
export function preferredOf(config) {
  const value = isObj(config?.agent) ? config.agent.preferred : undefined
  if (value === undefined) return null
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`config.agent.preferred 必须是 provider id，实际是 ${JSON.stringify(value)}`)
  }
  return value
}
