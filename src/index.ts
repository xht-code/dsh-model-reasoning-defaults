/**
 * dsh-model-reasoning-defaults
 *
 * 为每个模型配置默认推理等级。请求已显式指定 reasoningEffort 时保持原值；
 * 其余按 provider/model 路由查找默认值并转换为 DSH 的品牌类型。
 *
 * agent-loop 请求在 agent/request waterfall 中注入（此后到达 llm/stream 时
 * 已深冻结）；手写调用在 llm.stream 入口复制后再进入 waterfall，调用配置
 * 方法走同一共享包装层。
 *
 * @module dsh-model-reasoning-defaults
 */
import type { Context, EventOptions } from '@deepseek-ai/cordis'
import { isAgentLoopRequest, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  LlmCallConfig,
  LlmRuntime,
} from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

/** 插件名（同时作为 Cordis 插件 id）。 */
export const name = 'dsh-model-reasoning-defaults'

/** 声明依赖的服务：LLM 服务就绪后装配；注册/读取设置命名空间需要设置服务。 */
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
 * 插件配置：支持按 Provider 与模型嵌入式层级配置，也可使用扁平路由字典 defaults。
 * 两种形式是同等的一等配置入口（本仓库无历史版本，不存在"新旧兼容"语义），
 * 归一化到同一张路由表后统一参与六级匹配。
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
  /** 扁平路由字典：键为上表六级路由键；与结构化配置产生同键时覆盖结构化项。 */
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
// xhigh/max）与 llm-deepseek（off/low/high/max，为其子集）的并集。仅用于激活期与
// 提取期的告警提示而不阻断注入——最终合法性由适配器逐字匹配裁决，本地白名单
// 收窄反而会在上游新增等级时挡住合法配置。
const KNOWN_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

// llm-deepseek 注册的唯一 provider 路由名（宿主 packages/llm/llm-deepseek 的
// PROVIDER 常量）；llm-pi-ai 家族无法注册同名路由，宿主会拒绝重名 adapter family。
const DEEPSEEK_OFFICIAL_PROVIDER_ID = 'deepseek-official'

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

/** Cordis 配置模式（显式注解接口类型，满足声明产物的可命名要求）。 */
export const Config: z<Config> = z.object({
  // 路由键与等级值都要求非空白：空白键永远不会被 candidateKeys 命中，空白值
  // 会被适配器逐字匹配拒绝，都在配置阶段直接报错暴露最省排查成本。
  // .default({}) 与 schemastery 对 dict 的内建空对象默认重复，保留它是为了让
  // 编程直调路径（绕过 cordis resolveConfig）也能拿到确定的形状。
  defaults: z.dict(
    z.string().pattern(nonBlankPattern),
    z.string().pattern(nonBlankPattern),
  ).default({}),
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
 * 将结构化 Config 归一化为统一的扁平路由字典。
 *
 * @param config - 插件配置对象。
 * @returns 归一化后的键值映射；键与值均已去除首尾空白。
 */
export function normalizeConfig(config: Config): Record<string, string> {
  const result: Record<string, string> = {}

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
  // 配置同键冲突时胜出（显式路由键的表达意图更具体）。键值均 trim 后判断，
  // 与结构化路径（id 空则跳过）保持一致：空白键与空白值一样永不命中任何
  // 请求路由（cordis 路径由 schema 拒绝，此处覆盖绕开 schema 的直调路径）。
  if (config.defaults && typeof config.defaults === 'object') {
    for (const [rawKey, value] of Object.entries(config.defaults)) {
      const key = rawKey.trim()
      const trimmedValue = value.trim()
      if (key.length === 0 || trimmedValue.length === 0) continue
      result[key] = trimmedValue
    }
  }

  return result
}

type ReasoningConfig = Pick<LlmCallConfig, 'provider' | 'model' | 'reasoningEffort'>

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
  const knownLevels = [...KNOWN_REASONING_EFFORTS].join('/')

  const checkLevel = (route: string, level: string | undefined): void => {
    if (level !== undefined && !KNOWN_REASONING_EFFORTS.has(level)) {
      issues.push('路由 ' + route + ' 的推理等级 "' + level + '" 不在已知集合 (' + knownLevels + ') 内，请确认目标模型支持')
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

  // 扁平 defaults 字典：schema 在 cordis 路径直接拒绝空白键值，但编程直调
  // 会绕过校验；这里的空键检查与 normalizeConfig 的跳过逻辑保持一致，把
  // 静默降级变成可见告警。
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

type ReasoningDefaults = Readonly<Record<string, string>>

/**
 * 设置页 UI 专用命名空间。该命名空间由本插件注册为可写设置项，浏览器设置
 * 面板通过宿主统一的 settings API 编辑它；生效优先级位于自动提取之上、
 * cordis 插件配置之下（见 resolveEffectiveDefaults）。
 */
export const UI_DEFAULTS_NAMESPACE = 'model-reasoning-defaults'

/** 设置命名空间的用户层数据形状：与 Config.defaults 同构的扁平路由字典。 */
export interface UiDefaultsSection {
  /** 扁平路由字典：键为六级路由键，值为推理等级。 */
  defaults?: Record<string, string>
}

// 命名空间 schema 与 Config.defaults 复用同一约束（非空白键值），保证两条
// 配置入口的合法性标准完全一致。
const uiDefaultsSectionSchema = z.object({
  defaults: z.dict(
    z.string().pattern(nonBlankPattern),
    z.string().pattern(nonBlankPattern),
  ).default({}),
})

type SettingsService = {
  get: (ns: string) => unknown
  /**
   * 注册可写命名空间（真实签名见 @deepseek-ai/dsh-settings 的 SettingsProvider.register；
   * 此处只声明本插件用到的参数面）。可选：设置服务存在才可注册。
   */
  register?: (
    ns: string,
    schema: z<UiDefaultsSection>,
    options?: { applies?: 'live' | 'restart' },
  ) => unknown
}

/**
 * 取当前上下文上的设置服务；不存在或 get 不可调用时返回 undefined。
 *
 * apply() 的注入门槛判定与本提取路径共用这一个函数，避免两处标准不一致
 * 造成"装了包装层却永远提取不到数据"的错位。
 */
function settingsService(ctx: Context): SettingsService | undefined {
  const settings = (ctx as { settings?: SettingsService }).settings
  if (!settings || typeof settings.get !== 'function') return undefined
  return settings
}

// 提取期告警去重：settings 提取位于每次请求的热路径上，同一问题只告警一次，
// 避免日志刷屏；进程生命周期内出现一次提示即足以定位配置错误。
const warnedMessages = new Set<string>()

/** 经当前上下文的 logger 发出一次性告警。 */
function warnOnce(ctx: Context, message: string): void {
  if (warnedMessages.has(message)) return
  warnedMessages.add(message)
  ctx.logger?.warn?.('[' + name + '] ' + message)
}

/**
 * 创建一条提取结果的记录器：等级 trim 后写入映射；不在已知集合时一次性告警
 * 但仍注入，让适配器的逐字匹配给出最终裁决（避免本地白名单过期后挡住上游
 * 新增的等级）。设置提取位于每次请求的热路径上，告警按消息去重防止刷屏。
 *
 * @param ctx - Cordis 上下文。
 * @param extracted - 提取结果的目标映射。
 * @returns 记录函数。
 */
function createEffortRecorder(
  ctx: Context,
  extracted: Record<string, string>,
): (routeKey: string, level: unknown) => void {
  return (routeKey, level) => {
    if (typeof level !== 'string') return
    const trimmedLevel = level.trim()
    if (trimmedLevel.length === 0) return
    if (!KNOWN_REASONING_EFFORTS.has(trimmedLevel)) {
      warnOnce(ctx, '设置中路由 ' + routeKey + ' 的推理等级 "' + trimmedLevel + '" 不在已知集合内，请确认目标模型支持')
    }
    extracted[routeKey] = trimmedLevel
  }
}

/**
 * 从当前 Cordis 上下文的设置服务中读取各 Provider 与模型的默认推理等级。
 *
 * 字段约定（每个来源只读单一规范字段，不做别名兜底）：
 * - llm-pi-ai：provider 级 `reasoning` 是宿主原生声明字段；模型级
 *   `models[].reasoning` 与 `modelOverrides.<model>.reasoning` 是本插件约定
 *   读取的扩展字段，依赖其设置解析对未声明键的透传行为。宿主在模型层另有
 *   原生字段 `reasoningEfforts`，但那是"可选等级集合 + 线格式映射"的能力
 *   声明而非默认值选择，语义不同，本插件不读取；若上游收紧对未声明键的
 *   解析策略，`reasoning` 这部分提取会静默失效。
 * - llm-deepseek：顶层 `reasoningEffort` 为宿主原生字段，映射到其注册的
 *   provider 路由 deepseek-official（见 DEEPSEEK_OFFICIAL_PROVIDER_ID）。
 *
 * 整个函数不包 try/catch：宿主的 settings.get 对未注册命名空间返回 undefined
 * 且不会抛错，函数体已对全部外部数据做了形状防御，剩余可能抛错的只有代码
 * 缺陷，应当让它暴露，而不是吞掉后以空映射继续主流程。
 *
 * @param ctx - Cordis 上下文。
 * @returns 提取出的路由默认映射字典。
 */
export function extractSettingsDefaults(ctx: Context): Record<string, string> {
  const extracted: Record<string, string> = {}
  const settings = settingsService(ctx)
  if (!settings) return extracted
  const record = createEffortRecorder(ctx, extracted)

  // 1. 读取 llm-pi-ai 命名空间设置（涵盖所有 OpenAI-compatible、Anthropic、自定义网关等提供商）
  const piAi = settings.get('llm-pi-ai') as {
    providers?: Record<string, {
      reasoning?: unknown
      models?: Array<{ id?: unknown; reasoning?: unknown }>
      modelOverrides?: Record<string, { reasoning?: unknown }>
    }>
  } | undefined

  if (piAi?.providers && typeof piAi.providers === 'object') {
    for (const [providerId, providerProfile] of Object.entries(piAi.providers)) {
      if (!providerId || !providerProfile || typeof providerProfile !== 'object') continue

      // pi-ai 家族无法占用 deepseek-official 路由（宿主拒绝重名 adapter family），
      // 这里提取的值永远不会命中；跳过并提示一次，避免稍后被 llm-deepseek
      // 来源的同名键无声覆盖、留下难以解释的死配置。
      if (providerId === DEEPSEEK_OFFICIAL_PROVIDER_ID) {
        warnOnce(ctx, 'llm-pi-ai 中名为 ' + DEEPSEEK_OFFICIAL_PROVIDER_ID + ' 的 provider 无法注册该路由，已跳过其推理等级提取')
        continue
      }

      // Provider 级别默认思考等级（原生字段 reasoning）
      record(providerId + ':*', providerProfile.reasoning)

      // 模型列表中的思考等级（扩展字段，见函数头注释）
      if (Array.isArray(providerProfile.models)) {
        for (const m of providerProfile.models) {
          const id = m && typeof m === 'object' && typeof m.id === 'string' ? m.id.trim() : ''
          if (id.length === 0) continue
          record(providerId + ':' + id, m.reasoning)
        }
      }

      // modelOverrides 中的思考等级（扩展字段，见函数头注释）
      if (providerProfile.modelOverrides && typeof providerProfile.modelOverrides === 'object') {
        for (const [modelId, override] of Object.entries(providerProfile.modelOverrides)) {
          const id = modelId.trim()
          if (id.length === 0 || !override || typeof override !== 'object') continue
          record(providerId + ':' + id, override.reasoning)
        }
      }
    }
  }

  // 2. 读取 llm-deepseek 命名空间设置（原生字段 reasoningEffort → deepseek-official 路由）
  const deepseek = settings.get('llm-deepseek') as { reasoningEffort?: unknown } | undefined
  if (deepseek && typeof deepseek === 'object') {
    record(DEEPSEEK_OFFICIAL_PROVIDER_ID + ':*', deepseek.reasoningEffort)
  }

  return extracted
}

/**
 * 从本插件专用的设置命名空间读取设置页 UI 写入的路由表。
 *
 * 该命名空间由 apply() 注册、浏览器设置面板写入，是"设置里改默认推理强度"
 * 的存储层；每次请求实时读取，改动即时生效。形状非法（非对象/缺字段）时
 * 返回空映射——schema 校验已保证写入合法，这里的防御只覆盖外部手工编辑
 * settings 文档的场景。
 *
 * @param ctx - Cordis 上下文。
 * @returns 路由映射字典。
 */
export function extractUiNamespaceDefaults(ctx: Context): Record<string, string> {
  const extracted: Record<string, string> = {}
  const settings = settingsService(ctx)
  if (!settings) return extracted

  const section = settings.get(UI_DEFAULTS_NAMESPACE) as UiDefaultsSection | undefined
  if (!section || typeof section !== 'object') return extracted

  const record = createEffortRecorder(ctx, extracted)
  const defaults = section.defaults
  if (defaults && typeof defaults === 'object') {
    for (const [rawKey, level] of Object.entries(defaults)) {
      const key = rawKey.trim()
      if (key.length === 0) continue
      record(key, level)
    }
  }
  return extracted
}

// 注册重试参数：热重载期间旧代 fiber 仍持有命名空间（注册清理挂在调用方
// fiber 上，见 SettingsProvider.register 文档），新代直接 register 会撞
// "already registered"；旧代卸载后键位释放，轮询即可补上。
const UI_NS_RETRY_INTERVAL_MS = 250
const UI_NS_RETRY_MAX_ATTEMPTS = 240

/**
 * 在设置服务上注册本插件的可编辑命名空间（跨热重载安全）。
 *
 * 每次激活都先直接尝试注册——不缓存"已注册"标记，因为旧代的卸载会把命名空间
 * 一并注销，缓存的真值会在"停用后再启用"的场景下变成谎言。撞上
 * "already registered" 说明旧代尚未释放，进入短周期轮询直到键位空出；
 * 其它错误告警后放弃，不阻断主流程（patch 层配置仍然生效）。
 *
 * @param ctx - 当前插件上下文。
 * @param settings - 当前上下文的设置服务。
 */
function registerUiDefaultsNamespace(ctx: Context, settings: SettingsService): void {
  if (settings.register === undefined) {
    warnOnce(ctx, '当前设置服务不支持命名空间注册，设置页将无法编辑推理等级默认值')
    return
  }

  const attempt = (): 'ok' | 'busy' => {
    try {
      settings.register!(UI_DEFAULTS_NAMESPACE, uiDefaultsSectionSchema, { applies: 'live' })
      return 'ok'
    } catch (error) {
      if (!String(error).includes('already registered')) {
        ctx.logger?.warn?.('[' + name + '] 注册设置命名空间失败，设置页将无法编辑推理等级默认值：' + String(error))
        return 'ok'
      }
      return 'busy'
    }
  }

  if (attempt() !== 'busy') return

  let attempts = 0
  const timer = setInterval(() => {
    attempts += 1
    if (attempts > UI_NS_RETRY_MAX_ATTEMPTS) {
      clearInterval(timer)
      warnOnce(ctx, '等待旧代释放设置命名空间超时，本次运行设置页不可用；请重启宿主或再次重载本插件')
      return
    }
    if (attempt() === 'ok') clearInterval(timer)
  }, UI_NS_RETRY_INTERVAL_MS)
  ctx.effect(() => () => {
    clearInterval(timer)
  }, name + ': stop UI namespace registration retry')
}

type RuntimePatchState = {
  /** 创建共享包装层的 fiber 上下文；热重载复用包装层时随最新 fiber 刷新。 */
  ctx: Context
  defaults: Map<symbol, ReasoningDefaults>
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
 * 取最后激活的配置层。热重载期间新 fiber 覆盖旧 fiber，旧 fiber 卸载后
 * 新配置仍保持生效；最后一个 fiber 卸载时才还原原始服务方法。
 *
 * @param state - 同一 LLM 服务上的包装状态。
 * @returns 当前生效的 defaults；没有活跃层时返回 undefined。
 */
function currentDefaults(state: RuntimePatchState): ReasoningDefaults | undefined {
  let current: ReasoningDefaults | undefined
  for (const defaults of state.defaults.values()) current = defaults
  return current
}

/**
 * 解析当前生效的完整 defaults 映射。三个配置层按优先级从低到高合并：
 * 设置服务自动提取项（llm-pi-ai / llm-deepseek 原生字段）→ 本插件设置
 * 命名空间（设置页 UI 写入）→ 插件自身 cordis 配置（patch 层）。
 * 同一路由键上高优先级层覆盖低优先级层。
 *
 * @param ctx - 当前共享包装层绑定的上下文（热重载后为新 fiber 的 ctx）。
 * @param state - 同一 LLM 服务上的包装状态。
 * @returns 合并后的路由映射；三层均为空时为空对象。
 */
function resolveEffectiveDefaults(
  ctx: Context,
  state: RuntimePatchState,
): ReasoningDefaults {
  const pluginDefaults = currentDefaults(state) ?? {}
  const uiStoreDefaults = extractUiNamespaceDefaults(ctx)
  const settingsDefaults = extractSettingsDefaults(ctx)
  return {
    ...settingsDefaults,
    ...uiStoreDefaults,
    ...pluginDefaults,
  }
}

/**
 * 将当前活跃层应用到配置。保留原对象是卸载后仍被外部持有的旧包装的必要语义，
 * 也避免把一个空对象伪装成真实配置来源。
 *
 * @param state - 同一 LLM 服务上的包装状态（ctx 从 state 读取，保证热重载后
 *   提取路径跟随最新 fiber）。
 * @param config - 待处理的调用配置。
 * @returns 原配置或带默认推理等级的浅复制对象。
 */
function applyCurrentDefault<T extends ReasoningConfig>(
  state: RuntimePatchState,
  config: T,
): T {
  const defaults = resolveEffectiveDefaults(state.ctx, state)
  return Object.keys(defaults).length === 0 ? config : applyDefaultReasoningEffort(config, defaults)
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
 * 经 isAgentLoopRequest 判定后按原引用透传——浅复制会丢失该进程标识。
 *
 * @param ctx - 当前插件上下文。
 * @param llm - LLM 服务实例。
 * @returns 可复用的包装状态。
 */
function createRuntimePatchState(ctx: Context, llm: LlmRuntime): RuntimePatchState {
  const originalStream = llm.stream
  const originalPrepareCall = llm.prepareCall
  const originalResolveCallConfig = llm.resolveCallConfig
  let state!: RuntimePatchState

  const stream: LlmRuntime['stream'] = (options) => {
    const patched = isAgentLoopRequest(options) ? options : applyCurrentDefault(state, options)
    return originalStream.call(llm, patched)
  }
  const prepareCall: LlmRuntime['prepareCall'] = async (config, signal) => {
    return originalPrepareCall.call(llm, applyCurrentDefault(state, config), signal)
  }
  const resolveCallConfig: LlmRuntime['resolveCallConfig'] = async (config, signal) => {
    return originalResolveCallConfig.call(llm, applyCurrentDefault(state, config), signal)
  }

  state = {
    ctx,
    defaults: new Map(),
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
 * 每个插件 fiber 只持有自己的配置层。这样新 fiber 先装配、旧 fiber 后卸载时，
 * 不会把服务方法恢复为已经失效的旧包装。
 *
 * @param ctx - 当前插件上下文。
 * @param llm - LLM 服务实例。
 * @param defaults - 默认推理等级映射。
 */
function installRuntimePatches(
  ctx: Context,
  llm: LlmRuntime,
  defaults: ReasoningDefaults,
): RuntimePatchState {
  const state = existingRuntimePatchState(llm) ?? createRuntimePatchState(ctx, llm)
  // 复用跨热重载共享的包装层时刷新 ctx：设置服务本身是全局单例，但
  // ctx.logger 等 fiber 级能力应跟随最新装配层，保证告警走当前 fiber 的日志。
  state.ctx = ctx
  if (llm.stream !== state.stream) llm.stream = state.stream
  if (llm.prepareCall !== state.prepareCall) llm.prepareCall = state.prepareCall
  if (llm.resolveCallConfig !== state.resolveCallConfig) llm.resolveCallConfig = state.resolveCallConfig

  const token = Symbol(name)
  state.defaults.set(token, defaults)
  ctx.effect(() => () => {
    state.defaults.delete(token)
    if (state.defaults.size !== 0) return
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
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config = {}): void {
  // 默认参数仅为编程直调便利；cordis 配置路径总先经 Config 校验并把可选集合补全。
  const defaults = normalizeConfig(config)

  // 结构化条目若因缺 id / 缺等级被归一化忽略，在此一次性上报，
  // 避免"配了却不生效"的静默降级无从排查。
  for (const issue of collectConfigIssues(config)) {
    ctx.logger?.warn?.('[' + name + '] ' + issue)
  }

  const settings = settingsService(ctx)

  // 注册设置页可编辑命名空间；失败不阻断主流程（patch 层配置仍然生效）。
  if (settings) registerUiDefaultsNamespace(ctx, settings)

  if (Object.keys(defaults).length === 0 && !settings) {
    ctx.logger?.info?.('[' + name + '] 未配置推理等级默认值且无设置服务，跳过注入')
    return
  }

  const llm = ctx.llm

  // 先建立共享配置层；agent/request 和三个公开 LLM 入口都从这层读取最新 defaults。
  const state = installRuntimePatches(ctx, llm, defaults)

  // agent-loop 在这里仍允许替换配置；此阶段操作的是调用配置种子，loop 随后
  // 才据此构建并深冻结真正的请求对象，loop 识别由 stream 入口的
  // isAgentLoopRequest 完成（见 createRuntimePatchState）。
  registerAgentRequestListener(ctx, async function (_payload, next) {
    return applyCurrentDefault(state, await next())
  })

  // 激活日志保留生效路由清单，排障时可直接对照请求的 provider/model。
  ctx.logger?.info?.('[' + name + '] 已激活：routes=' + Object.keys(defaults).join(', '))
}
