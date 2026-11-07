// 快照组装（architecture.md §5：snapshot 只组装与校验，不取数、不落盘）。
//
// M0 只产出 mock：一份能让 UI 出图、能让门禁跑通的合法快照。真实采集在 M3。
// 纯函数：时间由调用方注入，同一份输入重复调用输出字节级一致（roadmap M1 验收 2 的同一套要求）。

import { evaluate } from "../domain/rules-engine.mjs"
import { defaultRuleSet } from "../rules/default.mjs"
import { toLocalIso } from "../util/dates.mjs"
import { SNAPSHOT_SCHEMA_VERSION, SEVERITIES, SnapshotValidationError, validateSnapshot } from "./schema.mjs"

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

// 深拷贝一份，且把 titleLen 这个冗余字段算准：一个数字只能有一个计算处（ui-ia §5）
function cloneItem(item) {
  const copy = {
    ...item,
    category: [...item.category],
    attrs: { ...item.attrs },
    assets: item.assets.map((a) => ({ ...a })),
    listing: { ...item.listing, price: { ...item.listing.price } },
  }
  copy.listing.titleLen = item.title.length
  return copy
}

function countBySeverity(findings) {
  const out = {}
  for (const severity of SEVERITIES) out[severity] = 0
  for (const f of findings) out[f.severity] += 1
  return out
}

/**
 * 造一份合法的 mock 快照。
 *
 * M1 起 finding **不由这里手写**，而是 `evaluate()` 现算：手写 finding 就等于手写 offset，
 * 而 offset 错一条就是证据链断一条。同一个引擎同时供给 `pgh check`、`pgh rules impact` 和 App，
 * 三处的数字才可能一致。
 *
 * @param {{ now?: Date, label?: string, ruleSet?: object }} [options]
 * @returns {object}
 */
export function buildMockSnapshot({ now = new Date(), label = "mock 数据（虚构）", ruleSet = defaultRuleSet() } = {}) {
  if (!(now instanceof Date)) throw new TypeError("buildMockSnapshot: now 必须是 Date")
  const generatedAt = toLocalIso(now)
  const items = MOCK_ITEMS.map(cloneItem)
  const { findings, unjudged } = evaluate({ items, rules: ruleSet.rules, dicts: ruleSet.dicts, judgedAt: generatedAt })

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt,
    durationMs: 0,
    source: { kind: "mock", label },
    scope: { platform: "marketplace-a", sites: ["US", "DE"], categories: ["女装", "家居", "美妆", "童装"] },
    summary: {
      items: items.length,
      findings: findings.length,
      bySeverity: countBySeverity(findings),
      // 判不了的不算通过（snapshot-contract §2）：这个数字是「没说」，不是「没问题」
      unjudged: unjudged.length,
      rulesEvaluated: ruleSet.rules.length,
      rulePacks: ruleSet.packMeta.length,
    },
    rulePacks: ruleSet.packMeta,
    items,
    findings,
    // 明细随快照走：UI 的「判不了」面板要能点开看到是哪条规则、为什么判不了
    unjudged,
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
