// 东八区日期 —— 全仓唯一实现（architecture.md §5：util 只有 dates / redact 两个文件）。
//
// 纯函数：不读时钟、不读环境变量（refactor-constraints §2.3）。「现在几点」由 cli 层注入，
// 这样同一份输入连跑 10 次输出字节级一致（roadmap M1 验收 2 的同一套要求，M0 就按它写）。

export const OFFSET_MINUTES = 8 * 60

const pad = (n, width = 2) => String(Math.trunc(Math.abs(n))).padStart(width, "0")

/**
 * Date → 带时区偏移的 ISO 字符串（东八区默认）。
 * @param {Date} date
 * @param {number} [offsetMinutes] 与 UTC 的分钟差，东八区为 480
 * @returns {string} 形如 2026-11-07T01:12:00+08:00
 */
export function toLocalIso(date, offsetMinutes = OFFSET_MINUTES) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError("toLocalIso: 需要一个有效 Date")
  }
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 14 * 60) {
    throw new RangeError(`toLocalIso: offsetMinutes 越界: ${offsetMinutes}`)
  }
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000)
  const sign = offsetMinutes < 0 ? "-" : "+"
  const abs = Math.abs(offsetMinutes)
  const day = `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
  const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  return `${day}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2}):(\d{2})$/

/**
 * 带时区的 ISO 字符串 → Date。格式不对或日期不存在（如 02-30）一律抛错。
 * @param {string} text
 * @returns {Date}
 */
export function parseLocalIso(text) {
  const m = typeof text === "string" ? ISO_RE.exec(text) : null
  if (!m) throw new TypeError(`parseLocalIso: 不是带时区的 ISO 时间: ${text}`)
  const [, y, mo, d, h, mi, s, sign, oh, om] = m
  const offset = (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om))
  const utcMs =
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - offset * 60_000
  const date = new Date(utcMs)
  // 反向校验：Date 会把 2026-02-30 悄悄进位成 03-02，往返不一致就是非法日期
  if (toLocalIso(date, offset) !== text) throw new RangeError(`parseLocalIso: 日期不存在: ${text}`)
  return date
}

/**
 * 两个时间点之间的毫秒数（后减前）。
 * @param {string} fromIso
 * @param {string} toIso
 * @returns {number}
 */
export function diffMs(fromIso, toIso) {
  return parseLocalIso(toIso).getTime() - parseLocalIso(fromIso).getTime()
}

/**
 * 毫秒 → 人话时长。任务卡和思考折叠条用同一套格式，避免两处各写一份。
 * @param {number} ms
 * @returns {string} 45 秒 / 2 分 14 秒 / 1 时 2 分
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`formatDuration: 需要非负毫秒: ${ms}`)
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes === 0 ? `${hours} 时` : `${hours} 时 ${restMinutes} 分`
}
