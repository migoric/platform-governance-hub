// 命令行参数解析 —— 零依赖，只支持 `--flag` / `--flag=value` / `--flag value`。
//
// 不用 node:util 的 parseArgs：它要求每个选项都声明 type，命令一多就变成一堆重复声明；
// 这里的命令只有十来个开关，手写反而更短，且能给出中文错误。

export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = "UsageError"
  }
}

/**
 * @param {string[]} argv
 * @param {{ booleans?: string[], strings?: string[] }} spec
 * @returns {{ flags: Record<string, true | string>, positional: string[] }}
 */
export function parseFlags(argv, { booleans = [], strings = [] } = {}) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf("=")
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)

    if (booleans.includes(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} 不接受取值`)
      flags[name] = true
      continue
    }
    if (strings.includes(name)) {
      const value = inline !== undefined ? inline : argv[++i]
      if (value === undefined || value === "") throw new UsageError(`--${name} 需要一个值`)
      flags[name] = value
      continue
    }
    throw new UsageError(`不认识的参数：${arg}`)
  }
  return { flags, positional }
}
