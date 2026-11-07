// 快照组装（architecture.md §5：snapshot 只组装与校验，不取数、不落盘）。
//
// M0 只产出 mock：一份能让 UI 出图、能让门禁跑通的合法快照。真实采集在 M3。
// 纯函数：时间由调用方注入，同一份输入重复调用输出字节级一致（roadmap M1 验收 2 的同一套要求）。

import { toLocalIso } from "../util/dates.mjs"
import { SNAPSHOT_SCHEMA_VERSION, SEVERITIES, getPath, SnapshotValidationError, validateSnapshot } from "./schema.mjs"

const RULE_PACK = { id: "baseline", version: "2026.11.1", ruleCount: 32, effectiveFrom: "2026-11-01" }

// 全部为虚构数据：不含真实平台名、域名、SKU（architecture.md §8）
const MOCK_ITEMS = [
  {
    id: "it_8f21a",
    sku: "sh2309-dress-001",
    spuCode: "SPU-88213",
    title: "Best Women Summer Floral Midi Dress",
    category: ["女装", "连衣裙"],
    site: "US",
    status: "on_sale",
    updatedAt: "2026-11-05T09:00:00+08:00",
    attrs: { material: "95% Polyester, 5% Elastane", origin: "CN", ageGroup: "adult" },
    assets: [{ kind: "main_image", ref: "ev_9c1", width: 1000, height: 1000, hasText: false, background: "white" }],
    listing: { bullets: 5, description: "Lightweight midi dress for daily wear.", price: { current: 12.99, compareAt: 24.99, currency: "USD" } },
  },
  {
    id: "it_3c702",
    sku: "sh2310-tee-014",
    spuCode: "SPU-88214",
    title: "100% Pure Cotton Slim Fit Tee",
    category: ["女装", "T恤"],
    site: "US",
    status: "on_sale",
    updatedAt: "2026-11-05T09:10:00+08:00",
    attrs: { material: "100% Cotton", origin: "CN", ageGroup: "adult" },
    assets: [{ kind: "main_image", ref: "ev_9c2", width: 1000, height: 1000, hasText: false, background: "white" }],
    listing: { bullets: 4, description: "Soft cotton tee with a slim cut.", price: { current: 9.5, compareAt: 9.5, currency: "USD" } },
  },
  {
    id: "it_5d18b",
    sku: "be2401-cream-002",
    spuCode: "SPU-88215",
    title: "Skin Repair Cream for Sensitive Skin",
    category: ["美妆", "面霜"],
    site: "US",
    status: "on_sale",
    updatedAt: "2026-11-05T09:20:00+08:00",
    attrs: { material: "Aqua, Glycerin", origin: "CN", ageGroup: "adult" },
    assets: [{ kind: "main_image", ref: "ev_9c3", width: 1200, height: 1200, hasText: false, background: "white" }],
    listing: { bullets: 6, description: "Daily moisturizer, fragrance free.", price: { current: 18.0, compareAt: 22.0, currency: "USD" } },
  },
  {
    id: "it_b204e",
    sku: "hm2402-towel-008",
    spuCode: "SPU-88216",
    title: "Organic Bamboo Kitchen Towel Set",
    category: ["家居", "厨房"],
    site: "DE",
    status: "on_sale",
    updatedAt: "2026-11-04T18:20:00+08:00",
    attrs: { material: "70% Bamboo, 30% Cotton", origin: "CN", ageGroup: "adult" },
    assets: [{ kind: "main_image", ref: "ev_9c4", width: 1000, height: 1000, hasText: false, background: "white" }],
    listing: { bullets: 3, description: "Pack of three absorbent kitchen towels.", price: { current: 7.99, compareAt: 11.99, currency: "EUR" } },
  },
  {
    id: "it_7a9f1",
    sku: "ot2410-jacket-021",
    spuCode: "SPU-88217",
    title: "Winter Puffer Jacket -50% Off",
    category: ["女装", "外套"],
    site: "US",
    status: "on_sale",
    updatedAt: "2026-11-03T11:00:00+08:00",
    attrs: { material: "100% Nylon", origin: "CN", ageGroup: "adult" },
    assets: [{ kind: "main_image", ref: "ev_9c5", width: 1000, height: 1000, hasText: true, background: "gray" }],
    listing: { bullets: 5, description: "Warm puffer for winter commutes.", price: { current: 39.99, compareAt: 79.98, currency: "USD" } },
  },
  {
    id: "it_c61aa",
    sku: "kd2409-shoes-033",
    spuCode: "SPU-88218",
    title: "Kids LED Sneakers with Battery",
    category: ["童装", "鞋"],
    site: "US",
    status: "blocked",
    updatedAt: "2026-11-02T16:40:00+08:00",
    attrs: { material: "Synthetic Leather", origin: "CN", ageGroup: "kids" },
    assets: [
      { kind: "main_image", ref: "ev_9c6", width: 1000, height: 1000, hasText: false, background: "white" },
      { kind: "certificate", ref: "ev_4d7", docType: "BATTERY_MSDS" },
    ],
    listing: { bullets: 4, description: "Light-up sneakers with replaceable cell.", price: { current: 24.99, compareAt: 29.99, currency: "USD" } },
  },
  {
    id: "it_e13b7",
    sku: "hm2408-bottle-017",
    spuCode: "SPU-88219",
    title: "Stainless Steel Water Bottle 1L",
    category: ["家居", "水具"],
    site: "DE",
    status: "on_sale",
    updatedAt: "2026-11-01T10:10:00+08:00",
    attrs: { material: "304 Stainless Steel", origin: "CN", ageGroup: "adult" },
    assets: [{ kind: "main_image", ref: "ev_9c7", width: 1000, height: 1000, hasText: false, background: "white" }],
    listing: { bullets: 3, description: "Insulated bottle keeps drinks cold.", price: { current: 15.5, compareAt: 15.5, currency: "EUR" } },
  },
  {
    id: "it_9f4c2",
    sku: "be2405-dryer-006",
    spuCode: "SPU-88220",
    title: "Professional Salon Hair Dryer 2200W",
    category: ["美妆", "工具"],
    site: "US",
    status: "on_sale",
    updatedAt: "2026-10-31T09:30:00+08:00",
    attrs: { material: "ABS", origin: "CN", ageGroup: "adult" },
    assets: [
      { kind: "main_image", ref: "ev_9c8", width: 1000, height: 1000, hasText: false, background: "white" },
      { kind: "certificate", ref: "ev_4d8", docType: "CE_DOC" },
    ],
    listing: { bullets: 5, description: "Fast drying with three heat settings.", price: { current: 45.0, compareAt: 59.0, currency: "USD" } },
  },
]

// quote 是判定要引用的原文片段，offset 由程序算出来（见 toFinding）——
// 手写 offset 必错，而 offset 错一条就等于证据链断一条。
const MOCK_FINDINGS = [
  {
    itemId: "it_8f21a",
    field: "title",
    quote: "Best",
    ruleId: "listing.title.absolute_terms",
    severity: "blocker",
    message: "标题含绝对化用词「Best」",
    hint: "删除 Best / No.1 这类绝对化表述",
  },
  {
    itemId: "it_b204e",
    field: "title",
    quote: "Organic",
    ruleId: "listing.claim.organic_cert",
    severity: "blocker",
    message: "宣称 Organic 但未附有机认证",
    hint: "补充认证文件，或删除 Organic 字样",
  },
  {
    itemId: "it_c61aa",
    field: "title",
    quote: "Battery",
    ruleId: "category.battery.doc_required",
    severity: "blocker",
    message: "含电池类目未提供 MSDS",
    hint: "上传电池 MSDS 与运输声明",
  },
  {
    itemId: "it_3c702",
    field: "title",
    quote: "100%",
    ruleId: "listing.claim.composition",
    severity: "required",
    message: "成分宣称 100% 需与材质字段一致并附检测报告",
    hint: "核对材质字段，补齐检测报告",
  },
  {
    itemId: "it_5d18b",
    field: "title",
    quote: "Repair",
    ruleId: "listing.claim.medical",
    severity: "required",
    message: "「Repair」属医疗功效表述，化妆品类目不允许",
    hint: "改为保湿 / 舒缓等非医疗表述",
  },
  {
    itemId: "it_7a9f1",
    field: "title",
    quote: "-50%",
    ruleId: "listing.promo.expression",
    severity: "suggest",
    message: "折扣表述建议改为「原价 × 现价」并列",
    hint: "按站点要求展示原价与折扣依据",
  },
  {
    itemId: "it_9f4c2",
    field: "title",
    quote: "Professional",
    ruleId: "listing.claim.professional",
    severity: "suggest",
    message: "「Professional」属专业级宣称，建议注明适用场景",
    hint: "补一句适用人群或场景说明",
  },
  {
    itemId: "it_e13b7",
    field: "title",
    quote: "1L",
    ruleId: "listing.unit.dual_display",
    severity: "observe",
    message: "容量使用单一单位，部分站点要求双单位",
    hint: "补标 33.8 oz",
  },
]

function cloneItem(item) {
  const copy = { ...item, category: [...item.category], attrs: { ...item.attrs }, assets: item.assets.map((a) => ({ ...a })), listing: { ...item.listing, price: { ...item.listing.price } } }
  copy.listing.titleLen = item.title.length
  return copy
}

function toFinding(spec, byId, judgedAt) {
  const item = byId.get(spec.itemId)
  if (!item) throw new Error(`mock 数据不一致：找不到 item ${spec.itemId}`)
  const value = getPath(item, spec.field)
  const offset = typeof value === "string" ? value.indexOf(spec.quote) : -1
  if (offset < 0) {
    throw new Error(`mock 数据不一致：${spec.itemId} 的 ${spec.field} 里找不到「${spec.quote}」`)
  }
  return {
    id: `fd_${spec.ruleId.split(".").pop()}_${spec.itemId.slice(3)}`,
    itemId: spec.itemId,
    ruleId: spec.ruleId,
    ruleVersion: RULE_PACK.version,
    severity: spec.severity,
    kind: "deterministic",
    message: spec.message,
    evidence: {
      field: spec.field,
      quote: spec.quote,
      offset,
      length: spec.quote.length,
      assetRef: null,
      sourceRef: `rule:${spec.ruleId}`,
    },
    remediation: { hint: spec.hint, autoFixable: false },
    judgedAt,
    status: "open",
  }
}

function countBySeverity(findings) {
  const out = {}
  for (const severity of SEVERITIES) out[severity] = 0
  for (const f of findings) out[f.severity] += 1
  return out
}

/**
 * 造一份合法的 mock 快照。
 * @param {{ now?: Date, label?: string }} [options]
 * @returns {object}
 */
export function buildMockSnapshot({ now = new Date(), label = "mock 数据（虚构）" } = {}) {
  if (!(now instanceof Date)) throw new TypeError("buildMockSnapshot: now 必须是 Date")
  const generatedAt = toLocalIso(now)
  const items = MOCK_ITEMS.map(cloneItem)
  const byId = new Map(items.map((it) => [it.id, it]))
  const findings = MOCK_FINDINGS.map((spec) => toFinding(spec, byId, generatedAt))

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt,
    durationMs: 0,
    source: { kind: "mock", label },
    scope: { platform: "marketplace-a", sites: ["US", "DE"], categories: ["女装", "家居", "美妆"] },
    summary: {
      items: items.length,
      findings: findings.length,
      bySeverity: countBySeverity(findings),
      // 判不了的不算通过：M0 没有规则库，这个数字只是给 UI 一个非零值的样例
      unjudged: 2,
      rulesEvaluated: RULE_PACK.ruleCount,
      rulePacks: 1,
    },
    rulePacks: [RULE_PACK],
    items,
    findings,
    agent: {
      provider: "replay",
      capabilities: { streaming: true, tools: true, vision: false, cost: true },
      degraded: false,
      reason: null,
    },
  }
}

/**
 * 校验并返回同一份快照；不合法直接抛（调用方据此「不写盘」）。
 * @param {unknown} snapshot
 * @returns {object}
 */
export function assertValidSnapshot(snapshot) {
  const { ok, errors } = validateSnapshot(snapshot)
  if (!ok) throw new SnapshotValidationError(errors)
  return snapshot
}
