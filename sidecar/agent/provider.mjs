// Provider 接口 —— 只有类型注释，没有实现（agent-acl §3）。
//
// 这个文件故意不含一行逻辑：它是「适配器该长什么样」的唯一书面定义。
// 一旦这里有实现，实现就会变成事实标准，接口文档随之作废。
//
// StartRequest 里**不含**模型名 / temperature / max_tokens：那些属于 provider
// 内部实现，公司网关的模型命名不一定和它一致。想调这些参数的适配器，
// 应该把它们写进自己的配置，而不是塞进跨服务的请求对象。

/**
 * 一次会话的启动请求。
 * @typedef {Object} StartRequest
 * @property {string} prompt            用户输入（已脱敏）
 * @property {RequestContext} [context] 当前选中的 finding / item，供模型聚焦
 * @property {string[]} [toolAllowlist] 允许调用的工具名；缺省 = 全部只读工具
 * @property {number} [maxSteps]        步数上限；缺省用 provider 能力里的值
 * @property {string} [locale]          输出语言，如 "zh-CN"
 */

/**
 * @typedef {Object} RequestContext
 * @property {string} [itemId]
 * @property {string} [findingId]
 * @property {string} [ruleId]
 */

/**
 * 适配器必须实现的四件事。
 *
 * `start` 返回 AsyncIterable 而不是 Promise<Event[]>：非流式服务也要能接，
 * 把整段包成一条 text 事件即可 —— 这是「只有 delta 没有整段」的代价，
 * 也是流式与非流式共用一套事件的办法。
 *
 * @typedef {Object} Provider
 * @property {() => string} id
 * @property {() => Promise<import("./contract.mjs").CAPABILITIES_FLOOR>} capabilities
 * @property {(req: StartRequest) => AsyncIterable<object>} start
 * @property {() => Promise<void>} cancel
 */

/**
 * 握手结果（agent-acl §5）。`serverVersion` 只展示，不参与分支判断。
 * @typedef {Object} Handshake
 * @property {boolean} ok
 * @property {number} contractVersion 适配器声明自己实现的契约版本
 * @property {string} provider
 * @property {string} [serverVersion]
 * @property {object} capabilities
 * @property {string} [reason]        握手失败时的原因（给人看的）
 */

export {}
