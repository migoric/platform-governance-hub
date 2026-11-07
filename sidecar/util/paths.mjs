// 点号路径读取 —— 规则、校验器、引擎共用一份实现。
//
// 为什么单独一个文件：规则按路径读字段（`attrs.material`），快照校验也按路径读（证据命中校验）。
// 两处各写一份，迟到一天就会出现「校验通过但规则读不到」这种对不上的错。

const isContainer = (v) => typeof v === "object" && v !== null

/**
 * 按点号路径读字段：`listing.description`、`attrs.material`、`category`。
 * 读不到返回 undefined（调用方自己决定算「未填」还是「错」）。
 * @param {unknown} root
 * @param {string} path
 * @returns {unknown}
 */
export function getPath(root, path) {
  if (typeof path !== "string" || path === "") return undefined
  let cur = root
  for (const key of path.split(".")) {
    if (!isContainer(cur)) return undefined
    cur = cur[key]
    if (cur === undefined) return undefined
  }
  return cur
}
