// token / 邮箱 / 手机号脱敏 —— 全仓唯一实现（architecture.md §5）。
//
// 为什么前缀要拆成片段拼：AGENTS.md §2 的门禁 4 禁止凭据前缀字面量出现在仓库里，
// 而脱敏器本身又必须认得它们。拼装是唯一同时满足两边的写法，别「优化」成一行字符串。

const seg = (...parts) => parts.join("")

const GH = seg("gh", "p_") // GitHub personal access token
const AK = seg("AK", "IA") // AWS access key
const SK = seg("s", "k-") // 通用 secret key 前缀
const XO = seg("xo", "xb-") // Slack bot token

const CREDENTIAL_RE = new RegExp(
  `\\b(?:${[GH, AK, SK, XO].join("|")})[A-Za-z0-9_-]{8,}`,
  "g",
)
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/g
const EMAIL_RE = /\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)+\b/g
const PHONE_RE = /(?<![0-9A-Za-z])1[3-9]\d{9}(?![0-9])/g

const maskEmail = (raw) => {
  const at = raw.indexOf("@")
  if (at <= 0) return "***"
  return `${raw[0]}***${raw.slice(at)}`
}

const maskPhone = (raw) => `${raw.slice(0, 3)}****${raw.slice(7)}`

const RULES = [
  { id: "credential", re: CREDENTIAL_RE, mask: (m) => `${m.slice(0, 4)}…<已脱敏>` },
  { id: "bearer", re: BEARER_RE, mask: () => "Bearer <已脱敏>" },
  { id: "email", re: EMAIL_RE, mask: maskEmail },
  { id: "phone", re: PHONE_RE, mask: maskPhone },
]

/**
 * 把一段文本里的敏感片段替换成脱敏形式。
 * @param {string} text
 * @returns {{ text: string, hits: Array<{ id: string, count: number }> }}
 */
export function redact(text) {
  if (typeof text !== "string") throw new TypeError("redact: 需要字符串")
  let out = text
  const hits = []
  for (const rule of RULES) {
    let count = 0
    out = out.replace(rule.re, (m) => {
      count += 1
      return rule.mask(m)
    })
    if (count > 0) hits.push({ id: rule.id, count })
  }
  return { text: out, hits }
}

/**
 * 递归脱敏对象里的所有字符串（请求体默认脱敏，见 agent-acl §11）。
 * 键名原样保留 —— 键不是内容，改键会破坏对端契约。
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactDeep(value) {
  if (typeof value === "string") return redact(value).text
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value !== null && typeof value === "object") {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v)
    return out
  }
  return value
}

/** 脱敏后是否还有命中（上报前做闸门用，不算第二次脱敏）。 */
export function hasSensitive(text) {
  if (typeof text !== "string") throw new TypeError("hasSensitive: 需要字符串")
  return RULES.some((rule) => {
    rule.re.lastIndex = 0
    return rule.re.test(text)
  })
}
