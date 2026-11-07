# 规则库与判定引擎

> 一句话：**规则是数据，不是代码。** 法规和平台政策每月都在变，如果改规则要发版，这工具活不过三个月。

## 1. 为什么是数据

| 如果规则写进代码 | 后果 |
|---|---|
| 平台改了标题字数上限 | 发版、重新签名、让所有人更新 App |
| 某个类目新增资质要求 | 同上，而且往往等不到发版就已经被下架 |
| 想给不同站点用不同严度 | 只能靠 if-else 堆分支 |
| 想知道「这条结论依据哪条规则」 | 只能翻代码，翻不到条款 |

规则落成 JSON 之后，上面四件事分别变成：改一个文件、加一条、加一个 scope、读 `source` 字段。

## 2. 规则包（pack）

规则包挂在**平台 pack** 下面（`~/.pgh/packs/<packId>/`）。一个包一个文件，带版本与生效期：

```
~/.pgh/packs/marketplace-a/
├── meta.json                      平台字段映射、站点、抓取选择器（不进 git）
├── rules/
│   ├── baseline@2026.11.1.json    平台通用规则（商品信息、图片、价格）
│   ├── category-certs@2026.10.15.json  类目资质与禁限售
│   └── eu-market@2026.09.01.json  欧盟市场（CE / REACH / 标签）
└── dict/
    ├── extreme-words.zh.json      极限词词典
    ├── forbidden-materials.json   禁用材质
    └── category-certs.json        类目 → 必备资质
```

包之间可以引用词典，**不能互相引用规则**（避免依赖图与加载顺序问题）。
同一个 `packId` 下可以有多个规则包，也可以并列多个平台 pack，各自独立生效。

```json
{
  "packId": "baseline",
  "platform": "marketplace-a",
  "version": "2026.11.1",
  "effectiveFrom": "2026-11-01",
  "effectiveTo": null,
  "source": {
    "doc": "《商品信息发布规范》",
    "clause": "第 3 章 商品标题",
    "url": "（本机 pack 内配置，不写死域名）",
    "retrievedAt": "2026-11-06"
  },
  "rules": []
}
```

> `platform` 是 pack 的标识，不是规则的一部分。规则 id 里**不带平台前缀** ——
> 同一套「标题极限词」规则换个平台还能用，带前缀就复不了了。

## 3. 单条规则

```json
{
  "id": "listing.title.limit_words",
  "title": "标题不得使用极限词 / 绝对化用语",
  "severity": "blocker",
  "kind": "deterministic",
  "scope": { "sites": ["*"], "categories": ["*"], "status": ["draft", "on_sale"] },
  "checks": [
    {
      "type": "text.dictionary",
      "path": "title",
      "dict": "extreme-words.zh",
      "mode": "any"
    }
  ],
  "evidence": { "quote": true, "locate": "offset" },
  "remediation": { "hint": "删除「最 / 第一 / 国家级」等绝对化用词", "autoFixable": false },
  "source": { "clause": "3.2.1", "note": "平台按违规严重度扣分" }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | `<域>.<字段>.<判据>`，**至少三段**（校验器强制），全局唯一且**不带平台前缀**，**永不改名**（改名 = 新规则，旧 finding 会失联） |
| `severity` | 是 | 四档见 §4 |
| `kind` | 是 | `deterministic` 必须能由 checks 复算；`semantic` / `manual` 的 checks 为空 |
| `scope` | 否 | 缺省 = 全匹配。`"*"` 是通配，不是字符串字面量 |
| `checks` | 是 | 数组，**全部 pass 才算通过**；空数组只对 `semantic` / `manual` 合法 |
| `evidence` | 是 | 决定 finding 里证据怎么长 |
| `source` | 是 | 条款出处；没有出处的规则不许入库（校验器会拒绝） |

## 4. 严重度四档

| 档 | 含义 | UI | 例子 |
|---|---|---|---|
| `blocker` | 会被下架 / 罚款 / 拒绝入仓 | 红，置顶，不可批量忽略 | 禁售品、缺 CE、极限词 |
| `required` | 上架前必须补齐，否则审核不过 | 橙 | 属性缺失、主图带水印、尺码表缺失 |
| `suggest` | 大概率被驳回，值得改 | 灰蓝 | 标题堆砌关键词、描述过于简略 |
| `observe` | 只是记一笔，不催 | 浅灰 | 价格环比异常（不是违规，是信号） |

四档是**封闭集**。新增语义请映射到最近的一档并在 `message` 里写清楚，不要加第五档 —— 分级一旦有第九种，颜色就失去意义。

## 5. check 类型（M1 只实现前 6 个）

| type | 参数 | 语义 |
|---|---|---|
| `text.dictionary` | `path`, `dict`, `mode: any/all/exclude` | 命中词典 |
| `text.match` | `path`, `pattern`（ECMA 正则） | 正则命中 |
| `text.length` | `path`, `min`, `max` | 字符数（按 `Array.from` 计，emoji 算 1） |
| `field.required` | `path` | 空串 / null / 空数组都算未填 |
| `field.enum` | `path`, `values` | 值必须在集合内 |
| `list.contains` | `path`, `values`, `mode` | 数组字段包含关系（类目、标签） |
| `asset.meta` | `kind`, `assert` | 图片尺寸 / 白底 / 含水印（依赖 sources 给的元数据） |
| `relation.exists` | `left`, `right`, `dict` | 类目与资质证书的对应关系 |
| `external.query` | `queryId` | 交给 agent 或外部服务，**产出的是 `semantic` finding** |

约定：

- **路径语法**：`a.b.c`，数组下标不写（一律「任一元素满足」语义），要精确匹配就在值里比较。
- **不读整份文档**。规则只读 item 字段，不做跨商品推断（跨商品的事归 domain 里的独立分析器，不归规则）。
- **只支持 AND，不支持条件**。`checks` 全部通过才算通过，所以「标题宣称 Organic 但缺证书」这类
  **跨字段条件**在 M1 表达不出来。处理方式只有两种：拆成两条独立规则，或标成 `semantic` 只产待判占位。
  M1 选了后者 —— 一条规则说清一件事，比一条规则假装能判两件事更可靠。
- **`list.contains` 只有 `any`（黑名单）**。白名单需要「缺哪一项」的证据，而 M1 的证据只能指向
  字符串位置、未填字段、数组元素三种，「缺的第 N 项」不在其中。白名单场景用 `field.enum` 或 semantic。
- **正则不许回溯爆炸**：同步 JS 没有抢占点，「20ms 就中断」是做不到的 —— 只能在跑完之后才发现超时，
  那时卡顿已经发生。实际是两道闸：
  1. **入库静态拒绝**（`rules/schema.mjs`）：嵌套量词 `(a+)+`、连续三个以上 `.*`、超过 200 字符的
     pattern 一律不入库。这是唯一能在执行前拦住回溯爆炸的办法。
  2. **运行时熔断**：万一带病上线，第一次超预算后这条 pattern 在本次判定里被标记，
     后续 item 直接记 `unjudged` 不再执行 —— 慢一次，不会慢 N 次。
  实测 `(a+)+$` 在静态检查阶段就被拒绝，对 2000 字符攻击串的整次判定耗时 < 1ms（有单测守）。

## 6. 判定引擎

```js
// domain/rules-engine.mjs —— 纯函数，无 IO
evaluate({ items, rules, dicts, judgedAt }) -> { findings, unjudged }
// rules: [{ packId, packVersion, rule }]（loader 拍平后的形态）
// judgedAt: 由调用方注入的带时区 ISO 时间 —— 引擎不读时钟
```

规则：

1. **输入不可变**：不修改传进来的 item / rule。
2. **顺序无关**：finding 最终按 `(severity, itemId, ruleId)` 排序，不依赖遍历顺序。
3. **单条规则失败不影响其他**：try/catch 包住每条 check，异常记 `unjudged` 并带 `ruleId`。
   `unjudged` 的 `reason` 是封闭集：`requires_semantic` / `requires_manual` / `dict_missing` /
   `pattern_rejected` / `check_type_unsupported` / `check_threw` / `field_missing` / `field_not_string` /
   `field_not_array` / `value_not_string`。
4. **可复算**：同一份输入跑一百次，输出字节级一致（时间戳由调用方注入）。
5. **纯同步**。异步的只有 `external.query`，它在引擎外面先跑完，结果作为参数传进来。

引擎不碰：文件、网络、时钟、随机数、`process.env`。这几样全部由 `cli/commands/check.mjs` 注入。

## 7. 与 AI 的分工

```js
if (rule.kind === "deterministic") { ... }   // 引擎自己算，可解释、可复算、零成本
else {                                        // semantic / manual
  // 引擎只产出「待判」占位，不猜
}
```

| 判据 | 谁判 | 为什么 |
|---|---|---|
| 字数、缺失、枚举、禁售清单 | 规则引擎 | 确定，且必须能指着字段说 |
| 「这句话是不是功效宣称」 | agent（语义） | 词典永远漏，但漏了也只是「待人工」 |
| 「这张图有没有抄袭别家」 | agent（视觉）或外部服务 | 需要能力声明，provider 不支持就标 unjudged |
| 「这个材质能不能进欧盟」 | 规则 + 词典 | 材质→法规的映射是可枚举的 |

**语义判定的产出必须带原文引用**，否则引擎拒收（§ snapshot-contract §4 的证据命中校验）。模型说「像功效宣称」但指不出是哪句，这条就不许进快照。

## 8. 规则的热更新

`pgh serve` 提供 `GET /api/rules` 与 `GET /api/rules/check`（返回「本地包 vs 远端包」的 diff）：

- 远端源是本机配置的规则仓地址（`~/.pgh/config.json`，M3 才接），现在返回 `not_configured`
- 仓库里不写死任何内网地址：地址只存在于本机配置，`.gitignore` 挡住
- App 的「规则库」面板能看到每个包的版本、生效期、条数，以及「有新版」提示
- **更新永远是显式动作**：点「更新」才写盘；自动更新会让「昨天还好好的今天全红」变成灵异事件
- 更新前把旧包挪到 `rules/.history/<version>.json`（pack 内），面板里能一键回滚

## 9. 规则质量的自我约束

新加一条规则，必须同时提供：

1. **正例与反例各一个 fixture**（在 `sidecar/test/fixtures/rules/<rule-id>.json`），
   `rule-fixtures.test.mjs` 会遍历规则库逐个跑：缺 fixture 直接失败，反例被误判也失败
2. **误报成本说明**写在 `source.note` 里：「这条判严了会怎样」
3. **impact 预估**：`pgh rules impact <id>` 用当前快照回放，告诉你这条规则会新增多少条 finding

第 3 条是防止「加了一条规则，全站 800 条报警」这个最常见的失败模式。规则库的可用性不取决于规则数量，取决于**每条规则都有人愿意处理**。
