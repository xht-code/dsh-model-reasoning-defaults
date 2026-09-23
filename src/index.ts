/**
 * dsh-model-reasoning-defaults
 *
 * 为每个模型配置默认推理等级。请求已显式指定 reasoningEffort 时保持原值；
 * 其余按 provider/model 路由查找默认值并转换为 DSH 的品牌类型。
 *
 * 路由表存放在插件自身的配置项中（profile patch 里 id 为
 * model-reasoning-defaults 的 `defaults` 字段），DSH 设置页经 settings Remote
 * 写入。该字段声明为 volatile：宿主原地更新配置引用而不重载插件，因此每次
 * 请求都读取当下快照，设置页保存后立即对新请求生效。
 *
 * agent-loop 请求在 agent/request waterfall 中注入（此后到达 llm/stream 时
 * 已深冻结）；手写调用在 llm.stream 入口复制后再进入 waterfall，调用配置
 * 方法走同一共享包装层。
 *
 * @module dsh-model-reasoning-defaults
 */
import type { Context, EventOptions } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cosmokit'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmCallConfig,
  LlmRuntime,
} from '@deepseek-ai/dsh-llm'
// Type-only：拉入 ctx.settings 的声明增强。设置在运行时由宿主装载，本插件不做
// 运行时导入（package.json 里的 peer 声明的是所需的最低宿主版本）。
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** 插件名（同时作为 Cordis 插件 id）。 */
export const name = 'dsh-model-reasoning-defaults'

/** 声明依赖的服务：LLM 服务就绪后装配；声明设置页策略需要设置服务。 */
export const inject = ['llm', 'settings'] as const

/** 单个模型的推理等级配置。 */
export interface ModelConfig {
  /** 模型 ID（数组形式必填；字典形式以键名为准，可省略）。 */
  id?: string
  /** 默认推理等级（如 off | minimal | low | medium | high | xhigh | max）。 */
  reasoningEffort?: string
}

/** 单个模型配置输入：既可以是等级字符串简写，也可以是配置对象。 */
export type ModelConfigInput = string | ModelConfig

/** 单个 Provider 的推理等级配置。 */
export interface ProviderConfig {
  /** 该 Provider 下所有模型的默认推理等级。 */
  reasoningEffort?: string
  /** 该 Provider 下各模型的推理等级配置（字典或对象列表）。 */
  models?: Record<string, ModelConfigInput> | ModelConfigInput[]
}

/** Provider 配置输入：既可以是等级字符串简写（作用于该 Provider 所有模型），也可以是配置对象。 */
export type ProviderConfigInput = string | ProviderConfig

/**
 * 用户书写的插件配置：支持按 Provider 与模型嵌入式层级配置，也可使用扁平路由
 * 字典 defaults。两种形式是同等的一等配置入口，归一化到同一张路由表后统一参与
 * 六级匹配。
 *
 * 合并后的匹配优先级从高到低为：
 * - "provider:model"：精确匹配（来自 providers[p].models[m] 或 defaults["provider:model"]）
 * - "provider:*"：该 provider 下所有模型（来自 providers[p].reasoningEffort 或 defaults["provider:*"]）
 * - "provider/*"：斜杠写法（来自 defaults["provider/*"]）
 * - "provider"：裸 provider 写法（来自 defaults["provider"]）
 * - "*:model"：跨 provider 的同名模型（来自 top-level models[m] 或 defaults["*:model"]）
 * - "*"：全局匹配（来自 top-level reasoningEffort 或 defaults["*"]）
 */
export interface Config {
  /**
   * 扁平路由字典：键为上表六级路由键，值为推理等级。该字段是设置页的编辑对象，
   * 与结构化配置产生同键时覆盖结构化项。
   */
  defaults?: Record<string, string>
  /** 按 Provider 组织的嵌入式配置。 */
  providers?: Record<string, ProviderConfigInput>
  /** 跨 Provider 适用的模型默认配置（等价于 "*:model"）。 */
  models?: Record<string, ModelConfigInput> | ModelConfigInput[]
  /** 全局默认推理等级（等价于 "*"）。 */
  reasoningEffort?: string
}

const nonBlankPattern = /^\S+$/

// 已知推理等级集合：llm-pi-ai 的 ModelThinkingLevel（off/minimal/low/medium/high/
// xhigh/max）与 llm-deepseek（off/low/high/max，为其子集）的并集。仅用于告警提示
// 而不阻断注入——最终合法性由适配器逐字匹配裁决，本地白名单收窄反而会在上游新增
// 等级时挡住合法配置。
const KNOWN_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

const modelConfigSchema = z.object({
  id: z.string().pattern(nonBlankPattern),
  reasoningEffort: z.string().pattern(nonBlankPattern),
})

const modelEntrySchema = z.union([
  z.string().pattern(nonBlankPattern),
  modelConfigSchema,
])

const modelsFieldSchema = z.union([
  z.dict(modelEntrySchema, z.string().pattern(nonBlankPattern)),
  z.array(modelEntrySchema),
])

const providerConfigSchema = z.object({
  reasoningEffort: z.string().pattern(nonBlankPattern),
  models: modelsFieldSchema,
})

const providerEntrySchema = z.union([
  z.string().pattern(nonBlankPattern),
  providerConfigSchema,
])

/**
 * Cordis 解析后的配置形状：`defaults` 已由 schemastery 换成 volatile 引用，
 * 其余字段与书写形状一致。
 *
 * 该接口显式写出而非由 `Schemastery.TypeT` 推导，是为了让 `Config` 的注解保持
 * 可命名（推导会展开成内联结构类型，声明产物随之膨胀且绑死 schemastery 内部
 * 泛型）；注解本身由编译器与真实 schema 交叉校验，两者不一致会直接报错。
 */
export interface ResolvedConfig {
  /** 设置页编辑的扁平路由表引用。 */
  defaults: Volatile<Record<string, string>>
  /** 按 Provider 组织的嵌入式配置。 */
  providers?: Record<string, ProviderConfigInput>
  /** 跨 Provider 适用的模型默认配置。 */
  models?: Record<string, ModelConfigInput> | ModelConfigInput[]
  /** 全局默认推理等级。 */
  reasoningEffort?: string
}

/**
 * Cordis 配置模式。
 *
 * `defaults` 声明为 volatile：设置页经宿主 configEditor 改写 profile patch 后，
 * 宿主原地更新该引用（见 cordis-plugin-loader 的 volatile 提交路径），插件无需
 * 重载即可读到新值。其余结构化字段保持普通字段——它们是 patch 层的书写形式，
 * 变更后正常走插件重载。
 */
export const Config: z<Config, ResolvedConfig> = z.object({
  // 路由键与等级值都要求非空白：空白键永远不会被 candidateKeys 命中，空白值
  // 会被适配器逐字匹配拒绝，都在配置阶段直接报错暴露最省排查成本。
  // .default({}) 与 schemastery 对 dict 的内建空对象默认重复，保留它是为了让
  // 编程直调路径（绕过 cordis resolveConfig）也能拿到确定的形状。
  defaults: z.dict(
    z.string().pattern(nonBlankPattern),
    z.string().pattern(nonBlankPattern),
  ).default({}).volatile(),
  providers: z.dict(
    providerEntrySchema,
    z.string().pattern(nonBlankPattern),
  ).default({}),
  models: modelsFieldSchema,
  reasoningEffort: z.string().pattern(nonBlankPattern),
})

/**
 * 从字符串简写或配置对象中提取非空推理等级。
 *
 * 只认单一规范字段 reasoningEffort，不做多字段兜底链：同义多源读取会在字段
 * 冲突时按书写顺序静默裁决（例如 reasoningEffort 与 effort 同时配置时无声地
 * 二选一），掩盖配置错误；确需别名应由用户层显式映射后再传入。
 *
 * @param val - 等级字符串，或 ModelConfig/ProviderConfig 形状的对象。
 * @returns trim 后非空的等级字符串；无法提取时返回 undefined。
 */
function extractEffort(val: unknown): string | undefined {
  const candidate = typeof val === 'string'
    ? val
    : (typeof val === 'object' && val !== null)
      ? (val as { reasoningEffort?: unknown }).reasoningEffort
      : undefined
  if (typeof candidate !== 'string') return undefined
  const trimmed = candidate.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * 归一化扁平路由字典。
 *
 * 键值均 trim 后判断：空白键与空白值一样永不命中任何请求路由（cordis 路径由
 * schema 拒绝，此处覆盖绕开 schema 的直调路径）。
 *
 * @param defaults - 扁平路由字典；未配置时为 undefined。
 * @returns 归一化后的键值映射。
 */
function normalizeFlatDefaults(defaults: Record<string, string> | undefined): Record<string, string> {
  // 空原型累加器：路由键是任意非空白字符串，普通对象上给 __proto__ 赋值不会生成
  // 自有属性。schema 解析本身就会丢弃 __proto__ 键，这里保证的是本函数对任意
  // 普通对象输入（含绕过 schema 的直调）都成立。
  const result: Record<string, string> = Object.create(null)
  if (!defaults || typeof defaults !== 'object') return result
  for (const [rawKey, value] of Object.entries(defaults)) {
    const key = rawKey.trim()
    const trimmedValue = typeof value === 'string' ? value.trim() : ''
    if (key.length === 0 || trimmedValue.length === 0) continue
    result[key] = trimmedValue
  }
  return result
}

/**
 * 将结构化 Config 归一化为统一的扁平路由字典。
 *
 * @param config - 插件配置对象（defaults 为普通字典形式）。
 * @returns 归一化后的键值映射；键与值均已去除首尾空白。
 */
export function normalizeConfig(config: Config): Record<string, string> {
  // 与 normalizeFlatDefaults 一致用空原型：合并 defaults 时若键为 __proto__，
  // 普通对象上的赋值不会生成自有属性，路由会被静默丢掉。
  const result: Record<string, string> = Object.create(null)

  // 1. 全局默认 (对应 "*")
  const globalEffort = extractEffort(config.reasoningEffort)
  if (globalEffort) {
    result['*'] = globalEffort
  }

  // 2. 顶层跨 Provider 模型默认 (对应 "*:model")
  if (config.models) {
    if (Array.isArray(config.models)) {
      for (const item of config.models) {
        // 数组形式必须携带非空白 id 才能生成路由键；缺失项由 apply() 的
        // 激活期诊断告警上报，这里只负责安静地跳过无效形状。
        const id = typeof item === 'object' && item !== null && typeof item.id === 'string' ? item.id.trim() : ''
        if (id.length === 0) continue
        const effort = extractEffort(item)
        if (effort) result['*:' + id] = effort
      }
    } else if (typeof config.models === 'object') {
      for (const [rawModelId, modelVal] of Object.entries(config.models)) {
        const modelId = rawModelId.trim()
        if (modelId.length === 0) continue
        const effort = extractEffort(modelVal)
        if (effort) result['*:' + modelId] = effort
      }
    }
  }

  // 3. Provider 层级配置
  if (config.providers && typeof config.providers === 'object') {
    for (const [rawProviderId, providerVal] of Object.entries(config.providers)) {
      const providerId = rawProviderId.trim()
      if (providerId.length === 0) continue

      // 3.1 Provider 级默认 (对应 "provider:*")
      const providerEffort = extractEffort(providerVal)
      if (providerEffort) {
        result[providerId + ':*'] = providerEffort
      }

      // 3.2 Provider 内的具体模型 (对应 "provider:model")
      if (typeof providerVal === 'object' && providerVal !== null && providerVal.models) {
        const models = providerVal.models
        if (Array.isArray(models)) {
          for (const item of models) {
            const id = typeof item === 'object' && item !== null && typeof item.id === 'string' ? item.id.trim() : ''
            if (id.length === 0) continue
            const effort = extractEffort(item)
            if (effort) result[providerId + ':' + id] = effort
          }
        } else if (typeof models === 'object') {
          for (const [rawModelId, modelVal] of Object.entries(models)) {
            const modelId = rawModelId.trim()
            if (modelId.length === 0) continue
            const effort = extractEffort(modelVal)
            if (effort) result[providerId + ':' + modelId] = effort
          }
        }
      }
    }
  }

  // 4. 扁平 defaults 字典：与结构化配置同等的一等入口，写在最后使其在与结构化
  // 配置同键冲突时胜出（显式路由键的表达意图更具体）。
  Object.assign(result, normalizeFlatDefaults(config.defaults))

  return result
}

type ReasoningConfig = Pick<LlmCallConfig, 'provider' | 'model' | 'reasoningEffort'>

/**
 * 未知推理等级的告警文案。
 *
 * 激活期体检与运行期读取共用同一文案：同一处配置在两条路径上都会被看到
 * （激活时既做体检、又会读一次路由表用于日志），文案一致才能靠 warnOnce
 * 收敛成一条日志，而不是打出两条内容几乎相同、仅差等级清单的告警。
 *
 * @param route - 命中的路由键。
 * @param level - 配置的推理等级。
 * @returns 供 logger 输出的告警文案。
 */
function unknownLevelIssue(route: string, level: string): string {
  return '路由 ' + route + ' 的推理等级 "' + level + '" 不在已知集合 ('
    + [...KNOWN_REASONING_EFFORTS].join('/') + ') 内，请确认目标模型支持'
}

/**
 * 静态体检插件配置，返回人类可读的问题清单（纯函数，不修改任何数据）。
 *
 * schemastery 的对象属性全部可选且对未知键透传，"拼错字段""模型项缺 id"
 * 这类错误能通过校验却在 normalizeConfig 中被静默忽略；此清单在插件激活时
 * 一次性告警，把这类静默降级变成可见信息。等级值不在已知集合也在此提示，
 * 但仍会注入——最终是否可用交给适配器逐字匹配裁决。
 *
 * @param config - 用户原始配置（未经归一化）。
 * @returns 问题描述列表；无问题时为空数组。
 */
function collectConfigIssues(config: Config): string[] {
  const issues: string[] = []

  const checkLevel = (route: string, level: string | undefined): void => {
    if (level !== undefined && !KNOWN_REASONING_EFFORTS.has(level)) {
      issues.push(unknownLevelIssue(route, level))
    }
  }

  /**
   * 检查单个模型条目：字符串简写直接校验等级；
   * 对象形式要求携带有效等级，数组元素还要求有效 id。
   */
  const checkModelEntry = (route: string, entry: ModelConfigInput, requireId: boolean): void => {
    if (typeof entry === 'string') {
      // 数组位置没有键名可用作 id，字符串简写永远生成不了路由键；字典位置的
      // 字符串值以键名为 id（requireId=false），不受此限制。
      if (requireId) {
        issues.push('数组形式模型条目缺少有效 id（字符串简写无键名可用），已被忽略：' + JSON.stringify(entry))
        return
      }
      checkLevel(route, extractEffort(entry))
      return
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (requireId && id.length === 0) {
      issues.push('模型条目缺少有效 id，已被忽略：' + JSON.stringify(entry))
      return
    }
    const effort = extractEffort(entry)
    if (effort === undefined) {
      issues.push('模型条目未包含 reasoningEffort，已被忽略：' + JSON.stringify(entry))
      return
    }
    checkLevel(route, effort)
  }

  // 全局等级
  checkLevel('*', extractEffort(config.reasoningEffort))

  // 顶层跨 Provider 模型
  if (config.models) {
    if (Array.isArray(config.models)) {
      config.models.forEach((entry, index) => {
        checkModelEntry('*:<models[' + index + ']>', entry, true)
      })
    } else if (typeof config.models === 'object') {
      for (const [modelId, entry] of Object.entries(config.models)) {
        checkModelEntry('*:' + modelId, entry, false)
      }
    }
  }

  // Provider 层级
  if (config.providers && typeof config.providers === 'object') {
    for (const [providerId, providerVal] of Object.entries(config.providers)) {
      if (typeof providerVal === 'string') {
        checkLevel(providerId + ':*', extractEffort(providerVal))
        continue
      }
      const hasModels = providerVal.models !== undefined
      const providerEffort = extractEffort(providerVal)
      if (!hasModels && providerEffort === undefined) {
        issues.push('provider ' + providerId + ' 未包含 reasoningEffort 或 models，整条配置已被忽略')
        continue
      }
      checkLevel(providerId + ':*', providerEffort)
      if (hasModels) {
        const models = providerVal.models!
        if (Array.isArray(models)) {
          models.forEach((entry, index) => {
            checkModelEntry(providerId + ':<models[' + index + ']>', entry, true)
          })
        } else if (typeof models === 'object') {
          for (const [modelId, entry] of Object.entries(models)) {
            checkModelEntry(providerId + ':' + modelId, entry, false)
          }
        }
      }
    }
  }

  // 扁平 defaults 字典：schema 在解析阶段就拒绝空白键值，所以这里只对绕过 schema
  // 的直调形态生效（手工构造 ResolvedConfig 直接调用 apply，例如测试或其它插件）。
  // 空键检查与 normalizeFlatDefaults 的跳过逻辑一致，把静默降级变成可见告警。
  if (config.defaults && typeof config.defaults === 'object') {
    for (const [rawKey, value] of Object.entries(config.defaults)) {
      const key = rawKey.trim()
      if (key.length === 0) {
        issues.push('扁平路由键为空白，已被忽略：' + JSON.stringify(rawKey))
        continue
      }
      checkLevel(key, extractEffort(value))
    }
  }

  return issues
}

// agent/request 的 loop 侧 emit 实参是 { turn, step, signal }；core/agent 的派发器
// 会把路由主体 agent（Scoped<Agent>）融合进 payload 并同时作为监听器 this，因此
// 实收 payload 含 agent 字段。本监听器不读取任何 payload 字段，此处仅按本插件
// 用到的形状窄化 ctx.on 的签名。
type AgentRequestPayload = {
  turn: number
  step: number
  signal: AbortSignal
}

type AgentRequestListener = (
  this: object,
  payload: AgentRequestPayload,
  next: () => Promise<LlmCallConfig>,
) => Promise<LlmCallConfig>

type AgentRequestRegistrar = (
  name: 'agent/request',
  listener: AgentRequestListener,
  options?: boolean | EventOptions,
) => () => boolean

/**
 * 注册全局 agent/request waterfall。
 *
 * cordis 的 ctx.on 内部会把监听器注册为当前 fiber 上的 effect（见 events
 * 服务的 register()），无论 global 标志如何都会在 fiber 卸载时自动清理；
 * global 只影响事件派发时的上下文过滤。因此无需再包一层 ctx.effect。
 *
 * 该事件的运行时接收者是 Scoped<Agent>，Cordis 根 Context 的事件泛型表不会
 * 暴露它，因此在最小边界内窄化签名（仅约束本插件用到的事件名与参数）。
 *
 * @param ctx - 当前插件上下文。
 * @param listener - agent/request waterfall 监听器。
 */
function registerAgentRequestListener(ctx: Context, listener: AgentRequestListener): void {
  // 窄化仅覆盖本插件实际使用的事件名与参数；内部转调仍通过 ctx.on 的真实实现。
  const register = ctx.on.bind(ctx) as AgentRequestRegistrar
  register('agent/request', listener, { global: true })
}

/**
 * 生成一个路由的候选配置键。
 *
 * 兼容键保留在明确的优先级表中，避免不同调用入口各自实现一套匹配规则。
 *
 * @param provider - 请求使用的 provider。
 * @param model - 请求使用的 model。
 * @returns 按匹配优先级排列的候选键。
 */
function candidateKeys(provider: string, model: string): readonly string[] {
  return [
    provider + ':' + model,
    provider + ':*',
    provider + '/*',
    provider,
    '*:' + model,
    '*',
  ]
}

/**
 * 查找一个路由对应的默认推理等级。
 *
 * @param defaults - 归一化后的扁平路由映射。
 * @param provider - 请求使用的 provider。
 * @param model - 请求使用的 model。
 * @returns 找到的非空推理等级，未找到时返回 undefined。
 */
function lookupEffort(
  defaults: Readonly<Record<string, string>>,
  provider: string,
  model: string,
): string | undefined {
  for (const key of candidateKeys(provider, model)) {
    const effort = defaults[key]
    if (typeof effort === 'string' && effort.length > 0) return effort
  }
  return undefined
}

/**
 * 在不修改原对象的前提下应用默认推理等级。
 *
 * 该函数同时用于 GenerateOptions 和 LlmCallConfig，因此调用方可以保留
 * 原请求对象中的 messages、signal 等其它字段，并安全处理深冻结输入。
 *
 * 第二参数只接受归一化后的扁平路由表；结构化 Config 必须先经 normalizeConfig。
 * 曾尝试用对象形状嗅探让本函数同时接纳两种入参，但路由表允许任意非空白键，
 * 含 "models"/"providers" 等键的路由表会被误判成结构化配置（整表归一化为空、
 * 注入全部失效），反之仅含顶层 reasoningEffort 的最小结构化配置又会漏判——
 * 两类误判都是静默失效，因此彻底拆掉形状嗅探。
 *
 * @param config - 待补齐的 LLM 请求或调用配置。
 * @param defaults - normalizeConfig 产出的扁平路由表。
 * @returns 原配置或带有 reasoningEffort 的浅复制对象。
 */
export function applyDefaultReasoningEffort<T extends ReasoningConfig>(
  config: T,
  defaults: Readonly<Record<string, string>>,
): T {
  if (config.reasoningEffort !== undefined || !config.provider || !config.model) return config
  const effort = lookupEffort(defaults, config.provider, config.model)
  if (effort === undefined) return config
  return { ...config, reasoningEffort: ReasoningEffortId(effort) }
}

/**
 * 一层插件 fiber 的路由表来源。
 *
 * 结构化字段在激活期归一化一次后不再变化（改动它们会触发插件重载）；扁平
 * `defaults` 是设置页的编辑对象，其 volatile 引用被宿主原地更新，因此每次
 * 请求读取当下快照。
 */
type RouteTableSource = {
  /** 读取与告警所用的当前 fiber 上下文。 */
  ctx: Context
  /** providers/models/reasoningEffort 归一化结果（激活期一次）。 */
  structured: Record<string, string>
  /** 设置页可编辑的扁平路由表引用。 */
  defaults: Volatile<Record<string, string>>
}

// 告警去重：路由表读取位于每次请求的热路径上，同一问题只告警一次，避免日志
// 刷屏；进程生命周期内出现一次提示即足以定位配置错误。激活期体检与运行期读取
// 共用这里，同一处配置不会既被体检报一次、又被读取报一次。
const warnedMessages = new Set<string>()

/** 发出一次性（进程内按文案去重）的插件告警，自动带上插件名前缀。 */
function warnOnce(ctx: Context, message: string): void {
  if (warnedMessages.has(message)) return
  warnedMessages.add(message)
  ctx.logger?.warn?.('[' + name + '] ' + message)
}

/**
 * 读取一层 fiber 当前生效的路由表。
 *
 * 结构化配置为底、volatile defaults 快照覆盖。手工编辑 profile patch 时
 * defaults 走的也是 volatile 原地更新（不会重载插件、不再有激活期体检），
 * 因此未知等级在这里一次性告警，避免静默降级。
 *
 * @param source - 一层 fiber 的路由表来源。
 * @returns 合并后的扁平路由映射；两层均为空时为空对象。
 */
function readRouteTable(source: RouteTableSource): Record<string, string> {
  const live = normalizeFlatDefaults(source.defaults.get())
  for (const [route, level] of Object.entries(live)) {
    if (!KNOWN_REASONING_EFFORTS.has(level)) {
      warnOnce(source.ctx, unknownLevelIssue(route, level))
    }
  }
  return { ...source.structured, ...live }
}

type RuntimePatchState = {
  /** 各活跃 fiber 的路由表来源；热重载期间新 fiber 覆盖旧 fiber。 */
  sources: Map<symbol, RouteTableSource>
  originalStream: LlmRuntime['stream']
  originalPrepareCall: LlmRuntime['prepareCall']
  originalResolveCallConfig: LlmRuntime['resolveCallConfig']
  stream: LlmRuntime['stream']
  prepareCall: LlmRuntime['prepareCall']
  resolveCallConfig: LlmRuntime['resolveCallConfig']
}

// Symbol.for 让热重载后的模块副本复用同一层状态，而不是再包一层旧包装。
const runtimePatchStateKey = Symbol.for('dsh-model-reasoning-defaults.runtime-patch-state')

/**
 * 取最后激活的路由表来源。热重载期间新 fiber 覆盖旧 fiber，旧 fiber 卸载后
 * 新配置仍保持生效；最后一个 fiber 卸载时才还原原始服务方法。
 *
 * @param state - 同一 LLM 服务上的包装状态。
 * @returns 当前生效的来源；没有活跃层时返回 undefined。
 */
function currentSource(state: RuntimePatchState): RouteTableSource | undefined {
  let current: RouteTableSource | undefined
  for (const source of state.sources.values()) current = source
  return current
}

/**
 * 将当前活跃层的路由表应用到配置。保留原对象是卸载后仍被外部持有的旧包装的
 * 必要语义，也避免把一个空对象伪装成真实配置来源。
 *
 * @param state - 同一 LLM 服务上的包装状态。
 * @param config - 待处理的调用配置。
 * @returns 原配置或带默认推理等级的浅复制对象。
 */
function applyCurrentDefault<T extends ReasoningConfig>(
  state: RuntimePatchState,
  config: T,
): T {
  const source = currentSource(state)
  if (source === undefined) return config
  const routeTable = readRouteTable(source)
  return Object.keys(routeTable).length === 0 ? config : applyDefaultReasoningEffort(config, routeTable)
}

/**
 * 判断请求是否已经进入 Agent Loop 的不可变边界。
 *
 * `isAgentLoopRequest()` 背后是 `@deepseek-ai/dsh-llm` 模块副本私有的
 * `WeakSet`。宿主和插件若解析到不同副本，宿主写入的标识不会被插件读取，
 * 入口包装就会错误地复制 Loop 请求。这里改用 DSH 公开的请求契约：Loop
 * 在交给 LLM 前会把完整请求顶层冻结，并写入用于路由的 `sessionId`；冻结的
 * 手写辅助请求（例如 compaction）没有 `sessionId`，仍应允许插件复制并补齐默认值。
 *
 * @param options - 进入 `llm.stream` 的完整请求。
 * @returns 是否应按原引用透传该请求。
 */
function isAgentLoopRequestBoundary(options: GenerateOptions): boolean {
  return options.sessionId !== undefined && Object.isFrozen(options)
}

/**
 * 从当前 stream 包装上恢复跨热重载共享的状态。
 *
 * @param llm - LLM 服务实例。
 * @returns 现有包装状态；服务尚未被本插件包装时返回 undefined。
 */
function existingRuntimePatchState(llm: LlmRuntime): RuntimePatchState | undefined {
  return (llm.stream as unknown as Record<PropertyKey, unknown>)[runtimePatchStateKey] as RuntimePatchState | undefined
}

/**
 * 创建覆盖三个公开入口的 LLM 服务包装。
 *
 * 手写请求在 stream 入口浅复制补齐后再进 waterfall，保证每个监听器只处理
 * 一次；loop 构建的请求由宿主打 markAgentLoopRequest 进程标识并深冻结，
 * 经公开的冻结与 sessionId 契约判定后按原引用透传——浅复制会丢失请求身份。
 *
 * @param llm - LLM 服务实例。
 * @returns 可复用的包装状态。
 */
function createRuntimePatchState(llm: LlmRuntime): RuntimePatchState {
  const originalStream = llm.stream
  const originalPrepareCall = llm.prepareCall
  const originalResolveCallConfig = llm.resolveCallConfig
  let state!: RuntimePatchState

  const stream: LlmRuntime['stream'] = (options) => {
    const patched = isAgentLoopRequestBoundary(options) ? options : applyCurrentDefault(state, options)
    return originalStream.call(llm, patched)
  }
  const prepareCall: LlmRuntime['prepareCall'] = async (config, signal) => {
    return originalPrepareCall.call(llm, applyCurrentDefault(state, config), signal)
  }
  const resolveCallConfig: LlmRuntime['resolveCallConfig'] = async (config, signal) => {
    return originalResolveCallConfig.call(llm, applyCurrentDefault(state, config), signal)
  }

  state = {
    sources: new Map(),
    originalStream,
    originalPrepareCall,
    originalResolveCallConfig,
    stream,
    prepareCall,
    resolveCallConfig,
  }
  Object.defineProperty(stream, runtimePatchStateKey, { value: state })
  return state
}

/**
 * 安装一层可卸载的 LLM 服务包装。
 *
 * 每个插件 fiber 只持有自己的路由表来源。这样新 fiber 先装配、旧 fiber 后卸载
 * 时，不会把服务方法恢复为已经失效的旧包装。
 *
 * 路由表为空时同样安装：设置页可以在插件运行期间写入新路由，跳过安装会让这些
 * 改动直到宿主重启才生效。
 *
 * @param ctx - 当前插件上下文。
 * @param llm - LLM 服务实例。
 * @param source - 本 fiber 的路由表来源。
 * @returns 共享的包装状态。
 */
function installRuntimePatches(
  ctx: Context,
  llm: LlmRuntime,
  source: RouteTableSource,
): RuntimePatchState {
  const state = existingRuntimePatchState(llm) ?? createRuntimePatchState(llm)
  if (llm.stream !== state.stream) llm.stream = state.stream
  if (llm.prepareCall !== state.prepareCall) llm.prepareCall = state.prepareCall
  if (llm.resolveCallConfig !== state.resolveCallConfig) llm.resolveCallConfig = state.resolveCallConfig

  const token = Symbol(name)
  state.sources.set(token, source)
  ctx.effect(() => () => {
    state.sources.delete(token)
    if (state.sources.size !== 0) return
    if (llm.stream === state.stream) llm.stream = state.originalStream
    if (llm.prepareCall === state.prepareCall) llm.prepareCall = state.originalPrepareCall
    if (llm.resolveCallConfig === state.resolveCallConfig) llm.resolveCallConfig = state.originalResolveCallConfig
  }, name + ': restore LLM method wrappers')
  return state
}

/**
 * 安装默认推理等级注入逻辑。
 *
 * @param ctx - 当前插件上下文。
 * @param config - Cordis 解析后的插件配置。
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  // 结构化字段只在激活期归一化一次；defaults 是 volatile 引用，留给每次请求读取。
  // 两者必须分开：把激活期的 defaults 快照并进 structured，会让设置页删掉的路由
  // 继续从旧快照命中——运行期的删除只反映在 volatile 快照上。
  const structured = normalizeConfig({
    providers: config.providers,
    models: config.models,
    reasoningEffort: config.reasoningEffort,
  })

  // 结构化条目若因缺 id / 缺等级被归一化忽略，在此一次性上报，
  // 避免"配了却不生效"的静默降级无从排查。与运行期读取共用 warnOnce：
  // 激活期同时会读一次路由表（见下方日志），同一问题只应出现一条告警。
  for (const issue of collectConfigIssues({
    defaults: config.defaults.get(),
    providers: config.providers,
    models: config.models,
    reasoningEffort: config.reasoningEffort,
  })) {
    warnOnce(ctx, issue)
  }

  // 本插件自带设置页 section，声明宿主无需再为该配置项生成通用表单。
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber))

  const source: RouteTableSource = { ctx, structured, defaults: config.defaults }

  // 先建立共享配置层；agent/request 和三个公开 LLM 入口都从这层读取最新路由表。
  const state = installRuntimePatches(ctx, ctx.llm, source)

  // agent-loop 在这里仍允许替换配置；此阶段操作的是调用配置种子，loop 随后
  // 才据此构建并深冻结真正的请求对象，stream 入口按公开冻结边界透传它。
  registerAgentRequestListener(ctx, async function (_payload, next) {
    return applyCurrentDefault(state, await next())
  })

  // 激活日志保留生效路由清单，排障时可直接对照请求的 provider/model。
  ctx.logger?.info?.('[' + name + '] 已激活：routes=' + Object.keys(readRouteTable(source)).join(', '))
}
