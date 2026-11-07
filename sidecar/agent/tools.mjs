// 工具面 —— agent 能碰到的全部数据入口（agent-acl §7）。
//
// 三条硬规矩：
//   1. **只读**。处置、豁免、导出报告都只能由人点，不进这张表。
//   2. 返回值一律脱敏 + 截断（单次 ≤ 32KB）。截断必须说出来，
//      不能给模型一段悄悄被砍掉的数据，让它当成完整事实去推理。
//   3. 与 provider 无关。换哪个服务，这张表都一样。

import { redactDeep } from "../util/redact.mjs"

/** 单次工具返回的字节上限。超过就截断并标记，不静默。 */
export const MAX_PAYLOAD_BYTES = 32 * 1024

/** 可选的分区名，封闭集。写错分区名要报错，不能返回空数组糊过去。 */
export const SNAPSHOT_SECTIONS = Object.freeze(["items", "findings", "rulePacks", "unjudged", "summary"])

const byteLength = (value) => Buffer.byteLength(JSON.stringify(value ?? null), "utf8")

/**
 * 把结果裁到上限内。宁可少给，也不要给一份被砍断的 JSON 让模型去猜。
 * @param {unknown} data
 * @returns {{ data: unknown, bytes: number, truncated: boolean }}
 */
function clamp(data) {
  const bytes = byteLength(data)
  if (bytes <= MAX_PAYLOAD_BYTES) return { data, bytes, truncated: false }

  // 数组按元素累加裁剪，保留完整元素；对象整体不裁（宁可报太大，也不给半截对象）
  if (Array.isArray(data)) {
    const kept = []
    let used = 0
    for (const item of data) {
      const size = byteLength(item)
      if (used + size > MAX_PAYLOAD_BYTES) break
      kept.push(item)
      used += size
    }
    return {
      data: kept,
      bytes,
      truncated: true,
      note: `原始 ${data.length} 条 / ${bytes} 字节，超上限只返回前 ${kept.length} 条`,
    }
  }
  return {
    data: null,
    bytes,
    truncated: true,
    note: `结果 ${bytes} 字节超过 ${MAX_PAYLOAD_BYTES} 上限，且无法按条裁剪；请缩小查询范围`,
  }
}

function needString(args, key) {
  const value = args?.[key]
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`缺参数 ${key}`)
  }
  return value
}

/**
 * 工具定义表。`run` 只读 ctx，不改它 —— 事实层的数据不许被 agent 侧改到。
 * @type {Array<{ name: string, readOnly: true, description: string, run: (ctx: object, args: object) => object }>}
 */
export const TOOLS = [
  {
    name: "snapshot_query",
    readOnly: true,
    description: "读快照的某个分区（items / findings / rulePacks / unjudged / summary），可用 itemId 过滤",
    run(ctx, args) {
      const section = needString(args, "section")
      if (!SNAPSHOT_SECTIONS.includes(section)) {
        throw new Error(`分区名不在封闭集：${section}（可选：${SNAPSHOT_SECTIONS.join(" / ")}）`)
      }
      const raw = ctx.snapshot?.[section]
      if (section !== "summary" && !Array.isArray(raw)) {
        throw new Error(`快照里没有 ${section} 分区`)
      }
      let picked = raw
      if (typeof args.itemId === "string" && Array.isArray(raw)) {
        picked = raw.filter((row) => row?.itemId === args.itemId || row?.id === args.itemId)
      }
      return { summary: `${section}：${Array.isArray(picked) ? `${picked.length} 条` : "对象"}`, data: picked }
    },
  },
  {
    name: "rule_lookup",
    readOnly: true,
    description: "按 ruleId 取规则详情、判据与条款出处（出处是否核实也会如实返回）",
    run(ctx, args) {
      const ruleId = needString(args, "ruleId")
      const hit = ctx.ruleSet?.byId?.get(ruleId)
      if (!hit) throw new Error(`没有这条规则：${ruleId}`)
      const source = hit.rule.source ?? {}
      return {
        summary: `${ruleId}（${hit.rule.severity}）· 出处 ${source.status === "verified" ? "已核实" : "未核实"}`,
        data: {
          packId: hit.packId,
          packVersion: hit.packVersion,
          rule: hit.rule,
          // 把「能不能对外引用」直接算好给模型：省得它自己从 status 猜语义
          sourceVerified: source.status === "verified",
        },
      }
    },
  },
  {
    name: "evidence_get",
    readOnly: true,
    description: "按 findingId 取证据元信息（引文、位置、元素下标），不返回二进制",
    run(ctx, args) {
      const findingId = needString(args, "findingId")
      const finding = (ctx.snapshot?.findings ?? []).find((f) => f?.id === findingId)
      if (!finding) throw new Error(`没有这条 finding：${findingId}`)
      const evidence = finding.evidence ?? null
      return {
        summary: `证据类型 ${evidence?.kind ?? "未知"} · 关联 ${finding.ruleId}`,
        data: {
          id: finding.id,
          itemId: finding.itemId,
          ruleId: finding.ruleId,
          severity: finding.severity,
          evidence,
        },
      }
    },
  },
  {
    name: "impact_estimate",
    readOnly: true,
    description: "估算某条规则在现有快照上会造成多少条 finding（只回放，不落盘）",
    run(ctx, args) {
      const ruleId = needString(args, "ruleId")
      const hit = ctx.ruleSet?.byId?.get(ruleId)
      if (!hit) throw new Error(`没有这条规则：${ruleId}`)
      // 现状命中数：直接从快照数，不重跑引擎 —— 重跑属于 rules impact 命令的活
      const current = (ctx.snapshot?.findings ?? []).filter((f) => f?.ruleId === ruleId).length
      const unjudged = (ctx.snapshot?.unjudged ?? []).filter((u) => u?.ruleId === ruleId).length
      return {
        summary: `${ruleId} 当前命中 ${current} 条、待判 ${unjudged} 条`,
        data: { ruleId, currentFindings: current, unjudged, evaluatedItems: ctx.snapshot?.summary?.items ?? 0 },
      }
    },
  },
]

/**
 * 供模型看的工具清单（JSON Schema 形态，OpenAI / Anthropic 都能直接用）。
 * 只列只读工具；将来若放开写操作，必须在这里显式标 `readOnly: false`。
 */
export function listTools() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    readOnly: tool.readOnly,
    parameters: { type: "object", additionalProperties: true },
  }))
}

/**
 * 调一个工具。返回值固定为 `{ ok, summary, bytes, truncated, data }` ——
 * 形状固定才好在 provider 侧翻译成 tool_result。
 *
 * @param {string} name
 * @param {object} args
 * @param {{ snapshot?: object, ruleSet?: object }} ctx
 */
export function invokeTool(name, args, ctx) {
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) {
    return { ok: false, summary: `没有这个工具：${name}`, bytes: 0, truncated: false, data: null }
  }
  try {
    const result = tool.run(ctx ?? {}, args ?? {})
    // 脱敏在最后一步统一做：任何工具的返回值都不许绕过它
    const safe = redactDeep(result.data)
    const clamped = clamp(safe)
    return {
      ok: true,
      summary: clamped.truncated ? `${result.summary}（已截断）` : result.summary,
      bytes: clamped.bytes,
      truncated: clamped.truncated,
      note: clamped.note,
      data: clamped.data,
    }
  } catch (error) {
    return {
      ok: false,
      summary: error instanceof Error ? error.message : String(error),
      bytes: 0,
      truncated: false,
      data: null,
    }
  }
}
