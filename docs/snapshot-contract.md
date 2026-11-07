# 快照契约（snapshot.json）

> 这是 App 与 sidecar 之间**唯一**的数据契约。改字段 = 同时改 Swift 解码 + 兼容旧快照。
> 契约版本：`schemaVersion: 1`。破坏性改动加 1，App 遇到不认识的 major 直接拒读并提示升级。

## 1. 原则

1. **快照是派生物，不是真相源。** 删掉它能从原始数据重建；原始证据在 `~/.pgh/evidence/`。
2. **只增不删。** 加字段随便加，删字段要么改 major，要么保留并恒为默认值。
3. **App 宽容解码。** 缺字段走默认、多字段忽略、单个元素坏掉只丢那一条（不是整份快照报废）。
4. **写盘前校验。** `snapshot/schema.mjs` 不过就不写；App 看到的是上一次的合法数据，不是半截数据。
5. **紧凑单行。** 给人看的格式化在 `pgh snapshot --pretty`，落盘永远是 `JSON.stringify(x)`。

## 2. 顶层

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-07T01:12:00+08:00",
  "durationMs": 4821,
  "source": { "kind": "export", "label": "商家后台导出 2026-11-06" },
  "scope": { "platform": "marketplace-a", "sites": ["US", "DE"], "categories": ["女装/连衣裙"] },
  "summary": {
    "items": 1284,
    "findings": 96,
    "bySeverity": { "blocker": 3, "required": 27, "suggest": 58, "observe": 8 },
    "unjudged": 12,
    "rulesEvaluated": 41,
    "rulePacks": 3
  },
  "rulePacks": [
    { "id": "baseline", "version": "2026.11.1", "ruleCount": 32, "effectiveFrom": "2026-11-01" }
  ],
  "items": [],
  "findings": [],
  "agent": {
    "provider": "remote",
    "capabilities": { "streaming": true, "tools": true, "vision": false, "cost": true },
    "degraded": false,
    "reason": null
  }
}
```

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `schemaVersion` | int | — | 必填，缺失视为 0 → App 拒读 |
| `generatedAt` | ISO8601 | — | 带时区，东八区 |
| `source.kind` | `export` / `browser` / `mock` / `local` | `mock` | UI 顶部角标显示来源，**不同来源的数字不可比较** |
| `scope` | object | `{}` | 本次采集的筛选条件，UI 原样显示，不反推 |
| `summary.unjudged` | int | 0 | 规则判不了的条数（不是「通过」，是「没说」） |
| `unjudged` | array | 省略 | 待判明细（`ruleId` / `itemId` / `reason` / `detail`）。只增字段，旧 App 忽略即可 |
| `agent` | object | 空对象 | 仅描述当前 agent 能力，**不含模型名**（换供应商不改契约） |

`summary` 是冗余字段，但它是「面板数字只有一个计算处」的落点：sidecar 算一次，App 直接显示。App 端 `DashboardSelector` 只做分组与排序，不重算计数。

## 3. item（商品 / SKU 的一个快照）

```json
{
  "id": "it_8f21a",
  "sku": "sh2309-dress-001",
  "title": "Women Summer Floral Midi Dress",
  "spuCode": "SPU-88213",
  "category": ["女装", "连衣裙"],
  "site": "US",
  "status": "on_sale",
  "updatedAt": "2026-11-05T09:00:00+08:00",
  "attrs": {
    "material": "95% Polyester, 5% Elastane",
    "origin": "CN",
    "ageGroup": "adult",
    "battery": "none"
  },
  "assets": [
    { "kind": "main_image", "ref": "ev_9c1", "width": 1000, "height": 1000, "hasText": false, "background": "white" },
    { "kind": "certificate", "ref": "ev_4d7", "docType": "CE_DOC" }
  ],
  "listing": {
    "titleLen": 46,
    "bullets": 5,
    "description": "…",
    "price": { "current": 12.99, "compareAt": 24.99, "currency": "USD" }
  }
}
```

`attrs` / `listing` / `assets` 都是**开放字典**：新增字段不需要改契约，规则按路径读（`attrs.material`），读不到就是「未填」（规则可以据此判 required，也可以不判）。

`assets[].ref` 指向证据：`ev_*` 是 `~/.pgh/evidence/` 下条目的 id。快照里不内联二进制，也不内联检测结论。

## 4. finding（一条判定）

```json
{
  "id": "fd_3a91",
  "itemId": "it_8f21a",
  "ruleId": "listing.title.limit_words",
  "ruleVersion": "2026.11.1",
  "severity": "blocker",
  "kind": "deterministic",
  "message": "标题含极限词「最」",
  "evidence": {
    "kind": "quote",
    "field": "title",
    "quote": "Best",
    "offset": 0,
    "length": 4,
    "assetRef": null,
    "sourceRef": "rule:listing.title.limit_words"
  },
  "remediation": { "hint": "删除「Best / 最」这类绝对化用词", "autoFixable": false },
  "judgedAt": "2026-11-07T01:12:00+08:00",
  "status": "open"
}
```

| 字段 | 约束 |
|---|---|
| `severity` | `blocker` / `required` / `suggest` / `observe`，四档，**没有第二套叫法** |
| `kind` | `deterministic`（规则引擎）/ `semantic`（agent）/ `manual`（人）—— 决定 UI 角标与是否可复算 |
| `evidence.kind` | `quote` / `absence` / `element`，缺省 `quote`（旧快照不写这个字段也照常读） |
| `evidence.field` | 指向 item 内路径；`quote` 必须能在该值里按 `offset/length` 命中，否则校验失败 |
| `evidence.sourceRef` | `rule:<id>` 或 `doc:<evidenceId>`，二选一，不能为空 |
| `status` | `open` / `fixed` / `waived` / `stale`（规则或商品变了，旧结论失效） |

**证据三态**（M1 起）：

| kind | 用在什么结论上 | 约束 |
|---|---|---|
| `quote` | 字段里有原文可引（极限词、正则命中、长度越界） | `quote` 必须是 `field` 值里 `[offset, offset+length)` 那一段 |
| `absence` | 字段没填（必填缺失、白名单里一个词都没有） | `quote` 为空串，`offset` 与 `length` 为 0，且 `field` 必须**真的**没填 |
| `element` | 数组里的某个元素（禁售类目、禁用标签） | `elementIndex` 必须有效，`quote` 必须等于该元素，`offset` 为 0 |

`absence` 的存在是为了不撒谎：缺字段时没有原文可引，硬编一个 quote 等于伪造证据。校验器会拒绝
「字段有值却用 absence」的 finding —— 这是把证据链守住的那条线。

「证据对不上」是硬失败：组装快照时若 `quote` 在 `field` 值里找不到，这条 finding 丢弃并计入 `summary.unjudged`，**不降级为模糊描述**。这是防止「结论漂移」的唯一闸门。

## 5. 兼容策略

| 变更 | 做法 |
|---|---|
| 加字段 | 直接加，App 侧 `decodeIfPresent` 给默认值 |
| 加枚举值（如新 severity） | **不加**。四档是封闭集；新语义映射到最近的一档并在 `message` 里说清楚 |
| 改字段名 | 加新字段 + 旧字段保留一个版本（双写），下个 major 删 |
| 删除字段 | 需 major + App 侧同时发版 |
| 规则库 schema 变 | 与快照无关：快照只存 `ruleId` / `ruleVersion` / `rulePacks` |

## 6. 校验（schema.mjs）

```js
// 伪代码，M1 落地
validate(snapshot) -> { ok, errors: [] }
```

必查项：

1. `schemaVersion === 1`
2. 每个 finding 的 `itemId` 存在于 `items`（或 item 被裁剪时已在 `summary` 计数）
3. 每个 finding 的 `ruleId` 出现在 `rulePacks` 的规则集里
4. `evidence.quote` 在 `item[evidence.field]` 里按 offset 命中
5. `summary.bySeverity` 之和 === `findings.length`
6. 顶层无 `undefined`、无非有限数（`NaN` / `Infinity` 一律拒绝）
7. `evidence.kind` 在封闭集内，且三态各自的约束成立
8. 若给了 `unjudged` 明细数组，其长度必须等于 `summary.unjudged`（计数与明细不许打架）

不过就抛错，`pgh` 命令非零退出，**不写盘**。

## 7. 体积

单份快照目标 < 4MB（1200 个 SKU、5 条 finding/个的量级）。超了先裁 `items` 的 `listing.description`（只留前 200 字符，完整值留在证据里），不裁 findings —— 结论比原文重要。
