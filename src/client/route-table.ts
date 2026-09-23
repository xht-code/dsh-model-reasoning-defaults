/**
 * 路由表的编辑模型（纯函数，不依赖 React 与 UI 组件）。
 *
 * 面板把存储中的 `defaults` 字典渲染成可编辑行，保存时再把行集合与基线做差异，
 * 折叠成宿主 settings Remote 的路径寻址操作。这里的每个函数都只做数据变换，
 * 便于直接覆盖"增删改 / 冲突合并 / 异常键"这些容易静默出错的边界。
 *
 * @module dsh-model-reasoning-defaults/client/route-table
 */

/** 一条可编辑的路由行。 */
export interface RouteRow {
  /** 路由键（provider:model 等六级写法之一）。 */
  key: string
  /** 该路由的推理等级。 */
  effort: string
}

/** 一条路径寻址的写入操作，与宿主 `settings.mutate` 的入参一致。 */
export type SettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: string }
  | { op: 'unset'; path: readonly string[] }

/** 路由表在配置项中的字段名：操作路径的前缀。 */
const DEFAULTS_FIELD = 'defaults'

/**
 * 把路由字典展开成按键排序的可编辑行。
 *
 * @param defaults - 路由字典。
 * @returns 稳定排序的行列表。
 */
export function rowsOf(defaults: Record<string, string>): RouteRow[] {
  return Object.entries(defaults)
    .map(([key, effort]) => ({ key, effort }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/**
 * 把存储中"外部新增"的路由键并入当前编辑行，用于冲突后的重试保存。
 *
 * 只补 `latest` 相对 `previous` 新增的键：差异语义是"行里没有即删除"，补进来的
 * 外部新增键可避免重试时顺手删掉它们；而用户自己删掉或改名的键本来就在
 * `previous` 里，绝不能再补回来——补回来等于把删除意图覆盖成"键仍在行中"，
 * 用户会发现该路由怎么都删不掉，重命名也会退化成"新增"。
 *
 * @param rows - 当前编辑的行。
 * @param previous - 发起本次保存所用的基线，即用户编辑所依据的键集。
 * @param latest - 宿主当前生效的路由表。
 * @returns 合并后的行列表，按键排序（空键行是待填写的残渣，排在末尾）。
 */
export function mergeStoredRows(
  rows: RouteRow[],
  previous: Readonly<Record<string, string>>,
  latest: Readonly<Record<string, string>>,
): RouteRow[] {
  const known = new Set(rows.map(row => row.key.trim()).filter(key => key.length > 0))
  const appended = Object.entries(latest)
    .filter(([key]) => !Object.hasOwn(previous, key) && !known.has(key))
    .map(([key, effort]) => ({ key, effort }))
  return [...rows, ...appended].sort((a, b) => {
    const left = a.key.trim()
    const right = b.key.trim()
    if (left.length === 0) return right.length === 0 ? 0 : 1
    if (right.length === 0) return -1
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/**
 * 把编辑后的行集合与存储基线做差异，折叠成路径寻址的写入操作。
 *
 * 只写差异而不是整段覆盖：宿主按路径写入，删除路由才能落盘（省略键不表达删除），
 * 同时不动同一配置项里的结构化字段。
 *
 * @param baseline - 存储中当前生效的路由表。
 * @param rows - 当前编辑的行。
 * @returns 写入操作列表；路由键重复时返回错误消息。
 */
export function buildRouteOps(
  baseline: Readonly<Record<string, string>>,
  rows: RouteRow[],
): SettingsPathOp[] | { error: string } {
  // 路由键是自由输入的字符串，可能撞上 Object.prototype 的成员名（toString、
  // constructor…）：空原型对象 + Object.hasOwn 才不会把这类键误判成重复，
  // 也不会在删除它们时因为原型链命中而漏发 unset。
  const next: Record<string, string> = Object.create(null)
  for (const row of rows) {
    const key = row.key.trim()
    // 空键行是编辑过程中的残渣：直接丢弃而不是拦住保存。
    if (key.length === 0) continue
    if (Object.hasOwn(next, key)) return { error: '存在重复路由键：' + key }
    next[key] = row.effort
  }

  const ops: SettingsPathOp[] = []
  for (const [key, effort] of Object.entries(next)) {
    if (baseline[key] !== effort) ops.push({ op: 'set', path: [DEFAULTS_FIELD, key], value: effort })
  }
  for (const key of Object.keys(baseline)) {
    if (!Object.hasOwn(next, key)) ops.push({ op: 'unset', path: [DEFAULTS_FIELD, key] })
  }
  return ops
}
