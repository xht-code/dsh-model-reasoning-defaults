import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmCallConfig } from '@deepseek-ai/dsh-llm'
import {
  apply,
  applyDefaultReasoningEffort,
  Config as PluginConfig,
  normalizeConfig,
} from '../src/index.ts'
import type { Config, ResolvedConfig } from '../src/index.ts'

type RegisteredListener = (...args: unknown[]) => unknown

// 显式用 Mock 参数化签名：ReturnType<typeof vi.fn> 会展开成宽类型
// Mock<Procedure | Constructable>，无法直接调用（需要 new）。tests 由
// tsconfig.test.json / typecheck:test 覆盖，类型错误会在 typecheck 阶段暴露。
type FakeLlm = {
  stream: Mock<(options: GenerateOptions) => GenerateOptions>
  prepareCall: Mock<(config: LlmCallConfig, signal?: AbortSignal) => Promise<{ config: LlmCallConfig; signal?: AbortSignal }>>
  resolveCallConfig: Mock<(config: LlmCallConfig, signal?: AbortSignal) => Promise<{ config: LlmCallConfig; signal?: AbortSignal }>>
}

function callConfig(provider: string, model: string): LlmCallConfig {
  return { provider, model }
}

/**
 * 走真实 schema 解析插件配置：apply 收到的是 cordis 解析后的形状，
 * defaults 在这里已变成 volatile 引用，测试必须复现这一点。
 */
function pluginConfig(plain: Config): ResolvedConfig {
  return PluginConfig(plain)
}

/** 复现宿主接到设置页写入后的原地引用更新（见 cordis-plugin-loader 的 volatile 提交路径）。 */
function commitLiveDefaults(config: ResolvedConfig, defaults: Record<string, string>): void {
  updateVolatile(config.defaults, PluginConfig({ defaults }).defaults)
}

function createHarness() {
  // 多值存储：global waterfall 允许同一事件注册多个 listener，Map 单值覆盖会丢失旧监听器。
  const listeners = new Map<string, RegisteredListener[]>()
  // 记录 on 的 options（尤其 global:true），用于断言全局监听正常注册。
  const onOptions: Array<{ event: string; options: unknown }> = []
  // 按注册顺序收集 effect disposer；同时以 fiber 为单位分组，便于按 fiber 卸载而非按下标清理。
  const fiberEffects: Array<{ fiber: number; disposers: Array<() => void> }> = []
  let currentFiber = 0
  const cleanups: Array<() => void> = []
  // 幂等地从事件表移除单个监听器；重复调用返回 false 而非抛错。
  const removeListener = (event: string, listener: unknown): boolean => {
    const cur = listeners.get(event)
    if (!cur) return false
    const idx = cur.indexOf(listener as RegisteredListener)
    if (idx === -1) return false
    cur.splice(idx, 1)
    if (cur.length === 0) listeners.delete(event)
    return true
  }
  const originalStream = vi.fn((options: GenerateOptions) => options)
  const originalPrepareCall = vi.fn(async (config: LlmCallConfig, signal?: AbortSignal) => ({ config, signal }))
  const originalResolveCallConfig = vi.fn(async (config: LlmCallConfig, signal?: AbortSignal) => ({ config, signal }))
  const llm: FakeLlm = {
    stream: originalStream,
    prepareCall: originalPrepareCall,
    resolveCallConfig: originalResolveCallConfig,
  }
  const settingsConfigure = vi.fn(() => () => {})
  const ctx = {
    llm,
    fiber: { uid: 1 },
    settings: { configure: settingsConfigure },
    on: vi.fn((event: string, listener: unknown, options?: unknown) => {
      onOptions.push({ event, options })
      // 镜像真实 cordis：ctx.on 内部把监听器注册为当前 fiber 上的 effect
      // （events.register 调用 fiber.effect），随 fiber 卸载自动清理；这里复用
      // ctx.effect 桩，使热重载用例可以按 fiber 卸载监听器，而非依赖外层包一层
      // ctx.effect。
      ctx.effect(() => {
        const arr = listeners.get(event) ?? []
        arr.push(listener as RegisteredListener)
        listeners.set(event, arr)
        return () => removeListener(event, listener)
      })
      return () => removeListener(event, listener)
    }),
    effect: vi.fn((factory: () => (() => void) | void) => {
      const cleanup = factory()
      if (cleanup !== undefined) {
        cleanups.push(cleanup)
        let fiber = fiberEffects.find((f) => f.fiber === currentFiber)
        if (!fiber) {
          fiber = { fiber: currentFiber, disposers: [] }
          fiberEffects.push(fiber)
        }
        fiber.disposers.push(cleanup)
      }
      return async () => {}
    }),
    // warn 桩用于断言激活期诊断与运行期等级告警。
    logger: { info: vi.fn(), warn: vi.fn() },
  }
  const disposeFiber = (fiberIndex: number): void => {
    const fiber = fiberEffects.find((f) => f.fiber === fiberIndex)
    if (!fiber) return
    // Cordis fiber 卸载时按注册逆序清理，此处按逆序执行以贴近真实语义。
    for (let i = fiber.disposers.length - 1; i >= 0; i--) fiber.disposers[i]!()
    fiber.disposers.length = 0
  }
  const advanceFiber = (): number => {
    currentFiber += 1
    return currentFiber
  }
  return {
    ctx: ctx as unknown as Context,
    llm,
    logger: ctx.logger,
    settingsConfigure,
    listeners: listeners as unknown as Map<string, RegisteredListener>,
    listenerArrays: listeners,
    onOptions,
    cleanups,
    disposeFiber,
    advanceFiber,
    originalStream,
    originalPrepareCall,
    originalResolveCallConfig,
  }
}

describe('applyDefaultReasoningEffort', () => {
  it('uses the exact route before all wildcard forms', () => {
    const result = applyDefaultReasoningEffort(callConfig('gateway', 'reasoner'), {
      'gateway:reasoner': 'exact',
      'gateway:*': 'provider',
      'gateway/reasoner': 'slash',
      gateway: 'bare',
      '*:reasoner': 'model',
      '*': 'global',
    })

    expect(result.reasoningEffort).toBe('exact')
  })

  it('uses provider, slash, model, then global entries in order', () => {
    expect(applyDefaultReasoningEffort(callConfig('gateway', 'other'), {
      'gateway:*': 'provider',
      '*:other': 'model',
      '*': 'global',
    }).reasoningEffort).toBe('provider')

    expect(applyDefaultReasoningEffort(callConfig('gateway', 'other'), {
      'gateway/*': 'slash',
      '*:other': 'model',
      '*': 'global',
    }).reasoningEffort).toBe('slash')

    expect(applyDefaultReasoningEffort(callConfig('gateway', 'other'), {
      '*:other': 'model',
      '*': 'global',
    }).reasoningEffort).toBe('model')

    expect(applyDefaultReasoningEffort(callConfig('gateway', 'other'), {
      '*': 'global',
    }).reasoningEffort).toBe('global')
  })

  it('keeps the bare provider alias and explicit values', () => {
    const aliased = applyDefaultReasoningEffort(callConfig('gateway', 'other'), { gateway: 'bare' })
    expect(aliased.reasoningEffort).toBe('bare')

    const explicit = {
      ...callConfig('gateway', 'other'),
      reasoningEffort: ReasoningEffortId('explicit'),
    }
    expect(applyDefaultReasoningEffort(explicit, { '*': 'global' })).toBe(explicit)
  })

  it('does not mutate a frozen config', () => {
    const config = Object.freeze(callConfig('gateway', 'reasoner'))
    const result = applyDefaultReasoningEffort(config, { '*': 'high' })

    expect(result).not.toBe(config)
    expect(result.reasoningEffort).toBe('high')
    expect(config.reasoningEffort).toBeUndefined()
  })

  it('rejects blank defaults and blank route keys during configuration validation', () => {
    expect(() => PluginConfig({ defaults: { '*': '   ' } })).toThrow()
    // 空白/空路由键永远不会被 candidateKeys 命中，拒绝以便在配置阶段直接暴露。
    expect(() => PluginConfig({ defaults: { '': 'high' } })).toThrow()
    expect(() => PluginConfig({ defaults: { '  ': 'high' } })).toThrow()
    expect(PluginConfig({ defaults: { '*': 'high' } }).defaults.get()['*']).toBe('high')
  })

  it('exposes the flat route table as a volatile reference with a stable empty default', () => {
    // 设置页写入依赖这一点：宿主原地更新该引用，插件无需重载即可读到新路由表。
    const resolved = PluginConfig({ defaults: { '*': 'high' } })
    expect(resolved.defaults.get()).toEqual({ '*': 'high' })
    expect(PluginConfig({}).defaults.get()).toEqual({})
  })

  it('accepts structured providers and models in PluginConfig validation', () => {
    const validated = PluginConfig({
      providers: {
        'my-gw': {
          reasoningEffort: 'medium',
          models: {
            'deepseek-reasoner': 'high',
            'o3-mini': { reasoningEffort: 'high' },
          },
        },
        'anthropic': {
          models: [
            { id: 'claude-3-7-sonnet', reasoningEffort: 'high' },
          ],
        },
        'shorthand-gw': 'low',
      },
      models: {
        'global-model': 'high',
      },
      reasoningEffort: 'low',
    })

    expect(validated.providers?.['my-gw']).toBeDefined()
    expect(validated.reasoningEffort).toBe('low')
  })

  it('applies a structured Config after normalization', () => {
    // applyDefaultReasoningEffort 只接受扁平路由表（形状嗅探会被含特殊键的
    // 路由表误触发，已移除）；结构化 Config 必须先经 normalizeConfig。
    const config = callConfig('my-gw', 'deepseek-reasoner')
    const normalized = normalizeConfig({
      providers: {
        'my-gw': {
          reasoningEffort: 'medium',
          models: {
            'deepseek-reasoner': 'high',
          },
        },
      },
      reasoningEffort: 'low',
    })

    expect(applyDefaultReasoningEffort(config, normalized).reasoningEffort).toBe('high')
  })
})

describe('normalizeConfig', () => {
  it('normalizes provider-level reasoning effort and model-level effort', () => {
    const normalized = normalizeConfig({
      providers: {
        'my-gw': {
          reasoningEffort: 'medium',
          models: {
            'deepseek-reasoner': 'high',
            'deepseek-chat': { reasoningEffort: 'low' },
          },
        },
      },
    })

    expect(normalized).toEqual({
      'my-gw:*': 'medium',
      'my-gw:deepseek-reasoner': 'high',
      'my-gw:deepseek-chat': 'low',
    })
  })

  it('supports shorthand string providers and array of models', () => {
    const normalized = normalizeConfig({
      providers: {
        'shorthand-gw': 'low',
        'anthropic': {
          reasoningEffort: 'medium',
          models: [
            { id: 'claude-3-7-sonnet', reasoningEffort: 'high' },
            { id: 'claude-3-5-sonnet', reasoningEffort: 'low' },
          ],
        },
      },
      models: [
        { id: 'o3-mini', reasoningEffort: 'high' },
      ],
      reasoningEffort: 'low',
    })

    expect(normalized).toEqual({
      '*': 'low',
      '*:o3-mini': 'high',
      'shorthand-gw:*': 'low',
      'anthropic:*': 'medium',
      'anthropic:claude-3-7-sonnet': 'high',
      'anthropic:claude-3-5-sonnet': 'low',
    })
  })

  it('trims structured and flat values alike and skips blank ids', () => {
    const normalized = normalizeConfig({
      defaults: {
        '*': '  high  ',
        'gw:*': '   ',
      },
      providers: {
        'gw': {
          models: [
            { id: '  ', reasoningEffort: 'high' },
            { id: ' ok ', reasoningEffort: ' low ' },
          ],
        },
      },
    })

    // 值统一 trim；空白 id 与 trim 后为空的值被跳过
    expect(normalized).toEqual({
      '*': 'high',
      'gw:ok': 'low',
    })
  })

  it('trims flat route keys and skips the ones that collapse to blank', () => {
    // schema 在 cordis 路径拒绝空白键；编程直调绕过 schema，normalize 与
    // 结构化路径（id 空则跳过）保持一致地兜底跳过，而不是生成空键死路由。
    expect(normalizeConfig({
      defaults: { '  ': 'high', '*': '  high  ', 'gw:m': ' medium ' },
    })).toEqual({ '*': 'high', 'gw:m': 'medium' })
  })

  it('merges defaults map with structured providers and models, with defaults taking priority', () => {
    const normalized = normalizeConfig({
      providers: {
        'my-gw': {
          reasoningEffort: 'medium',
          models: {
            'deepseek-reasoner': 'high',
          },
        },
      },
      models: {
        'o3-mini': 'high',
      },
      reasoningEffort: 'low',
      defaults: {
        'my-gw:deepseek-reasoner': 'exact-override',
        'custom:route': 'custom-effort',
      },
    })

    expect(normalized).toEqual({
      '*': 'low',
      '*:o3-mini': 'high',
      'my-gw:*': 'medium',
      'my-gw:deepseek-reasoner': 'exact-override',
      'custom:route': 'custom-effort',
    })
  })
})

describe('apply', () => {
  it('injects agent requests before the loop freezes them', async () => {
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({ defaults: { '*': 'high' } }))

    // harness 以数组存储多 listener，此处取首个（热重载前仅一个）
    const listener = harness.listenerArrays.get('agent/request')?.[0]
    expect(listener).toBeDefined()
    const signal = new AbortController().signal
    const result = await listener?.({ turn: 1, step: 0, signal }, async () => callConfig('gateway', 'reasoner'))

    expect(result).toMatchObject({ provider: 'gateway', model: 'reasoner', reasoningEffort: 'high' })
  })

  it('copies mutable hand-built requests before their waterfall begins', () => {
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({ defaults: { '*': 'high' } }))
    const options: GenerateOptions = { provider: 'gateway', model: 'reasoner', messages: [] }

    const result = harness.llm.stream(options)
    const [forwarded] = harness.originalStream.mock.calls[0]!

    expect(harness.listeners.has('llm/stream')).toBe(false)
    expect(harness.originalStream).toHaveBeenCalledOnce()
    expect(forwarded).not.toBe(options)
    expect(forwarded).toMatchObject({ reasoningEffort: 'high' })
    expect(options.reasoningEffort).toBeUndefined()
    expect(result).toBe(forwarded)
  })

  it('routes through the same priority table at the stream entry', () => {
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({
      defaults: {
        'gw:reasoner': 'exact',
        'gw:*': 'provider',
        '*:reasoner': 'model',
        '*': 'global',
      },
    }))

    const streamEffort = (provider: string, model: string): string | undefined => {
      harness.llm.stream({ provider, model, messages: [] })
      const forwarded = harness.originalStream.mock.calls.at(-1)?.[0] as GenerateOptions | undefined
      return forwarded?.reasoningEffort
    }

    expect(streamEffort('gw', 'reasoner')).toBe('exact')    // provider:model 优先于其它全部
    expect(streamEffort('gw', 'other')).toBe('provider')    // provider:* 优先于 *:model 与 *
    expect(streamEffort('x', 'reasoner')).toBe('model')     // *:model 优先于 *
    expect(streamEffort('x', 'other')).toBe('global')       // 仅全局命中
  })

  it('accepts the slash and bare provider aliases at the stream entry', () => {
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({ defaults: { 'gw/*': 'slash', gw: 'bare' } }))
    harness.llm.stream({ provider: 'gw', model: 'm', messages: [] })
    expect(harness.originalStream.mock.calls[0]![0]).toMatchObject({ reasoningEffort: 'slash' })

    // 裸 provider 键在无更高级键时的兜底命中
    const harnessBare = createHarness()
    apply(harnessBare.ctx, pluginConfig({ defaults: { gw: 'bare' } }))
    harnessBare.llm.stream({ provider: 'gw', model: 'm', messages: [] })
    expect(harnessBare.originalStream.mock.calls[0]![0]).toMatchObject({ reasoningEffort: 'bare' })
  })

  it('copies frozen auxiliary requests once without dropping their purpose', () => {
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({ defaults: { '*': 'high' } }))
    // 显式标注 GenerateOptions 以便断言原对象的 reasoningEffort 未被写入。
    const options: GenerateOptions = Object.freeze({
      provider: 'gateway',
      model: 'reasoner',
      messages: [],
      purpose: 'compaction' as const,
    })

    harness.llm.stream(options)
    const [forwarded] = harness.originalStream.mock.calls[0]!

    expect(harness.originalStream).toHaveBeenCalledOnce()
    expect(forwarded).not.toBe(options)
    expect(forwarded).toMatchObject({ purpose: 'compaction', reasoningEffort: 'high' })
    expect(options.reasoningEffort).toBeUndefined()
  })

  it('keeps loop-built requests by reference at the stream boundary', async () => {
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({ defaults: { '*': 'high' } }))
    // 复现真实流程：agent/request 只处理调用配置种子；loop 随后据此构建完整
    // 请求、写入 sessionId 并深冻结，再进入 stream。测试故意不调用
    // markAgentLoopRequest，模拟宿主与插件加载不同 dsh-llm 副本时的场景。
    const listener = harness.listenerArrays.get('agent/request')![0]!
    const assemble = listener as unknown as (
      payload: { turn: number; step: number; signal: AbortSignal },
      next: () => Promise<LlmCallConfig>,
    ) => Promise<LlmCallConfig>
    const seed = await assemble(
      { turn: 1, step: 0, signal: new AbortController().signal },
      async () => callConfig('gateway', 'reasoner'),
    )
    expect(seed).toMatchObject({ reasoningEffort: 'high' })

    const options = Object.freeze({
      ...seed,
      messages: [],
      sessionId: 'session-1' as GenerateOptions['sessionId'],
    })
    harness.llm.stream(options)
    const [forwarded] = harness.originalStream.mock.calls[0]!

    expect(harness.originalStream).toHaveBeenCalledOnce()
    expect(forwarded).toBe(options)
    expect(forwarded.reasoningEffort).toBe('high')
  })

  it('never copies a loop request even when its effort is unset', () => {
    // 回归保护：即使 agent/request 阶段缺席或未命中，带有 Loop 公开边界契约
    // 的请求也不得浅复制；复制会丢失宿主的请求身份与不可变边界。
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({ defaults: { '*': 'high' } }))
    const options = Object.freeze({
      provider: 'gateway',
      model: 'reasoner',
      messages: [],
      sessionId: 'session-2' as GenerateOptions['sessionId'],
    })

    harness.llm.stream(options)
    const [forwarded] = harness.originalStream.mock.calls[0]!

    expect(forwarded).toBe(options)
  })

  it('passes injected config and abort signal through prepareCall', async () => {
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({ defaults: { '*': 'high' } }))
    const signal = new AbortController().signal

    await harness.llm.prepareCall(callConfig('gateway', 'reasoner'), signal)

    expect(harness.originalPrepareCall).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'high' }),
      signal,
    )
  })

  it('passes injected config and abort signal through resolveCallConfig', async () => {
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({ defaults: { '*': 'high' } }))
    const signal = new AbortController().signal

    await harness.llm.resolveCallConfig(callConfig('gateway', 'reasoner'), signal)

    expect(harness.originalResolveCallConfig).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'high' }),
      signal,
    )
  })

  it('declares its own settings page instead of letting the host generate one', () => {
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({ defaults: { '*': 'high' } }))

    expect(harness.settingsConfigure).toHaveBeenCalledWith({ auto: false }, harness.ctx.fiber)
  })

  it('installs wrappers for empty defaults so later settings edits take effect', () => {
    // 设置页可以在运行期写入路由：激活时空表不能跳过安装，否则改动要等重启才生效。
    const harness = createHarness()
    const config = pluginConfig({ defaults: {} })
    apply(harness.ctx, config)

    expect(harness.llm.stream).not.toBe(harness.originalStream)
    expect(harness.listenerArrays.get('agent/request')).toHaveLength(1)
    harness.llm.stream({ provider: 'gateway', model: 'reasoner', messages: [] })
    expect(harness.originalStream.mock.calls[0]![0].reasoningEffort).toBeUndefined()

    commitLiveDefaults(config, { '*': 'high' })
    harness.llm.stream({ provider: 'gateway', model: 'reasoner', messages: [] })
    expect(harness.originalStream.mock.calls[1]![0]).toMatchObject({ reasoningEffort: 'high' })
  })

  it('applies live route table updates without reactivating the plugin', () => {
    // 设置页保存走宿主 configEditor；defaults 是 volatile 字段，宿主原地更新
    // 引用而不重载插件，因此下一次请求就要读到新路由表。
    const harness = createHarness()
    const config = pluginConfig({ defaults: { '*': 'low', 'gw:m': 'low' } })
    apply(harness.ctx, config)

    const streamEffort = (provider: string, model: string): string | undefined => {
      harness.llm.stream({ provider, model, messages: [] })
      return harness.originalStream.mock.calls.at(-1)?.[0].reasoningEffort
    }

    expect(streamEffort('gw', 'm')).toBe('low')
    expect(streamEffort('gw', 'other')).toBe('low')

    commitLiveDefaults(config, { 'gw:m': 'high' })

    expect(streamEffort('gw', 'm')).toBe('high')     // 精确键已改写
    expect(streamEffort('gw', 'other')).toBeUndefined() // 删除的全局键不再命中
  })

  it('keeps the newest route table active while an older fiber unloads', () => {
    const harness = createHarness()
    const older = pluginConfig({ defaults: { '*': 'low' } })
    apply(harness.ctx, older)
    const sharedStream = harness.llm.stream
    // 进入下一个 fiber：模拟热重载时新代先装配、旧代后卸载的重叠窗口。
    harness.advanceFiber()
    const newer = pluginConfig({ defaults: { '*': 'high' } })
    apply(harness.ctx, newer)

    expect(harness.llm.stream).toBe(sharedStream)
    harness.llm.stream({ provider: 'gateway', model: 'reasoner', messages: [] })
    expect(harness.originalStream.mock.calls[0]![0]).toMatchObject({ reasoningEffort: 'high' })

    // 旧 fiber 的 volatile 引用即使仍可读，也不再是生效层。
    commitLiveDefaults(older, { '*': 'max' })
    harness.llm.stream({ provider: 'gateway', model: 'reasoner', messages: [] })
    expect(harness.originalStream.mock.calls[1]![0]).toMatchObject({ reasoningEffort: 'high' })

    // 卸载旧 fiber 的 effect（设置页策略 + wrapper restore + listener），
    // wrapper 只有在最后一个路由表来源移除后才还原。
    harness.disposeFiber(0)
    harness.llm.stream({ provider: 'gateway', model: 'reasoner', messages: [] })
    expect(harness.originalStream.mock.calls[2]![0]).toMatchObject({ reasoningEffort: 'high' })
    // 旧 fiber 完全卸载后，stream 仍由新 fiber 持有，不应还原。
    expect(harness.llm.stream).toBe(sharedStream)

    // 卸载新 fiber 后完全还原，之后的新写入不再生效。
    harness.disposeFiber(1)
    expect(harness.llm.stream).toBe(harness.originalStream)
    expect(harness.llm.prepareCall).toBe(harness.originalPrepareCall)
    expect(harness.llm.resolveCallConfig).toBe(harness.originalResolveCallConfig)
    commitLiveDefaults(newer, { '*': 'max' })
    harness.llm.stream({ provider: 'gateway', model: 'reasoner', messages: [] })
    expect(harness.originalStream.mock.calls[3]![0].reasoningEffort).toBeUndefined()
  })

  it('uses the newest route table from an older agent listener during hot reload', async () => {
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({ defaults: { '*': 'low' } }))
    const olderListener = harness.listenerArrays.get('agent/request')![0]!
    apply(harness.ctx, pluginConfig({ defaults: { '*': 'high' } }))

    const result = await olderListener(
      { turn: 1, step: 0, signal: new AbortController().signal },
      async () => callConfig('gateway', 'reasoner'),
    )

    expect(result).toMatchObject({ reasoningEffort: 'high' })
  })

  it('restores only methods still owned by the active wrapper', () => {
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({ defaults: { '*': 'high' } }))
    const newerPrepareCall = vi.fn()
    harness.llm.prepareCall = newerPrepareCall

    harness.disposeFiber(0)

    expect(harness.llm.prepareCall).toBe(newerPrepareCall)
    expect(harness.llm.stream).toBe(harness.originalStream)
    expect(harness.llm.resolveCallConfig).toBe(harness.originalResolveCallConfig)
  })
  it('does not duplicate or leak global listeners across hot reload', async () => {
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({ defaults: { '*': 'low' } }))
    expect(harness.onOptions[0]).toMatchObject({ event: 'agent/request', options: { global: true } })
    // 进入下一个 fiber：显式推进，后续 effect 将归属新 fiber
    harness.advanceFiber()
    apply(harness.ctx, pluginConfig({ defaults: { '*': 'high' } }))
    expect(harness.onOptions[1]).toMatchObject({ event: 'agent/request', options: { global: true } })
    const arr = harness.listenerArrays.get('agent/request')!
    expect(arr).toHaveLength(2)
    const results = await Promise.all(
      arr.map((fn) =>
        (fn as unknown as (p: unknown, next: () => Promise<LlmCallConfig>) => Promise<LlmCallConfig>)(
          { turn: 1, step: 0, signal: new AbortController().signal },
          async () => callConfig('gateway', 'reasoner'),
        ),
      ),
    )
    for (const r of results) expect(r).toMatchObject({ reasoningEffort: 'high' })

    // 按 fiber 卸载旧 fiber，验证不依赖 cleanups 下标也能正确清理。
    harness.disposeFiber(0)
    expect(harness.listenerArrays.get('agent/request')).toHaveLength(1)
    const remaining = harness.listenerArrays.get('agent/request')![0]!
    const r2 = await (remaining as unknown as (p: unknown, next: () => Promise<LlmCallConfig>) => Promise<LlmCallConfig>)(
      { turn: 1, step: 0, signal: new AbortController().signal },
      async () => callConfig('gateway', 'reasoner'),
    )
    expect(r2).toMatchObject({ reasoningEffort: 'high' })

    harness.disposeFiber(1)
    expect(harness.listenerArrays.has('agent/request')).toBe(false)
    // 两个 fiber 均卸载后 wrapper 应还原
    expect(harness.llm.stream).toBe(harness.originalStream)
  })

  it('does not interfere with external LLM wrappers installed after plugin', () => {
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({ defaults: { '*': 'high' } }))
    expect(harness.onOptions[0]).toMatchObject({ event: 'agent/request', options: { global: true } })
    const externalStream = vi.fn((opts: GenerateOptions) => opts)
    const externalPrepareCall = vi.fn(async (c: LlmCallConfig) => ({ config: c }))
    harness.llm.stream = externalStream as unknown as typeof harness.llm.stream
    harness.llm.prepareCall = externalPrepareCall as unknown as typeof harness.llm.prepareCall

    // 外部方法应被真实调用且透传参数
    // 通过新 fiber 隔离验证：先让外部 wrapper 生效，再卸载本插件 fiber
    harness.disposeFiber(0)
    expect(harness.llm.stream).toBe(externalStream)
    expect(harness.llm.prepareCall).toBe(externalPrepareCall)
    expect(harness.llm.resolveCallConfig).toBe(harness.originalResolveCallConfig)
    expect(harness.listenerArrays.has('agent/request')).toBe(false)
    // 外部 wrapper 仍可被调用
    const opts: GenerateOptions = { provider: 'gateway', model: 'reasoner', messages: [] }
    harness.llm.stream(opts)
    expect(externalStream).toHaveBeenCalledWith(opts)
  })

  it('injects requests correctly when configured with structured providers and models', () => {
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({
      providers: {
        'gw': {
          reasoningEffort: 'medium',
          models: {
            'reasoner': 'high',
            'chat': { reasoningEffort: 'low' },
          },
        },
        'anthropic': {
          models: [
            { id: 'claude-3-7-sonnet', reasoningEffort: 'high' },
          ],
        },
      },
      models: {
        'o3-mini': 'high',
      },
      reasoningEffort: 'low',
    }))

    const streamEffort = (provider: string, model: string): string | undefined => {
      harness.llm.stream({ provider, model, messages: [] })
      const forwarded = harness.originalStream.mock.calls.at(-1)?.[0] as GenerateOptions | undefined
      return forwarded?.reasoningEffort
    }

    expect(streamEffort('gw', 'reasoner')).toBe('high')
    expect(streamEffort('gw', 'chat')).toBe('low')
    expect(streamEffort('gw', 'other')).toBe('medium')
    expect(streamEffort('anthropic', 'claude-3-7-sonnet')).toBe('high')
    expect(streamEffort('other-provider', 'o3-mini')).toBe('high')
    expect(streamEffort('other-provider', 'other-model')).toBe('low')
  })

  it('lets the flat defaults map win over structured config and live updates win over both', () => {
    const harness = createHarness()
    const config = pluginConfig({
      providers: { 'gw': { reasoningEffort: 'medium' } },
      defaults: { 'gw:*': 'high' },
    })
    apply(harness.ctx, config)

    const streamEffort = (): string | undefined => {
      harness.llm.stream({ provider: 'gw', model: 'm', messages: [] })
      return harness.originalStream.mock.calls.at(-1)?.[0].reasoningEffort
    }

    expect(streamEffort()).toBe('high')

    // 结构化字段是激活期快照；运行期只有 volatile defaults 会变。
    commitLiveDefaults(config, { 'gw:m': 'max' })
    expect(streamEffort()).toBe('max')
  })
})

describe('apply diagnostics and robustness', () => {
  /** 组装一个从最近一次 stream 转发读取注入结果的探针。 */
  function makeStreamProbe(harness: ReturnType<typeof createHarness>) {
    return (provider: string, model: string): string | undefined => {
      harness.llm.stream({ provider, model, messages: [] })
      const forwarded = harness.originalStream.mock.calls.at(-1)?.[0] as GenerateOptions | undefined
      return forwarded?.reasoningEffort
    }
  }

  it('treats every flat defaults key as a route key, even reserved-looking ones', () => {
    // 回归保护：旧实现按对象形状嗅探区分扁平表与结构化 Config，
    // 含 "models" 等键的扁平字典会被误归一化为空表导致全部路由失效。
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({
      defaults: { '*': 'low', 'models': 'high', 'my-gw:r1': 'exact' },
    }))
    const effort = makeStreamProbe(harness)

    expect(effort('my-gw', 'r1')).toBe('exact')
    expect(effort('other', 'x')).toBe('low')
  })

  it('activates global default configured via top-level reasoningEffort only', () => {
    // 回归保护：仅含顶层 reasoningEffort 的最小结构化配置曾因形状嗅探漏判而失效。
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({ reasoningEffort: 'low' }))
    expect(makeStreamProbe(harness)('any', 'model')).toBe('low')
  })

  it('warns at activation about structured entries that normalize away', () => {
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({
      providers: {
        'gw': {
          models: [
            { reasoningEffort: 'high' },
            { id: 'ok', reasoningEffort: 'medium' },
          ],
        },
        'empty-gw': {},
      },
    }))

    // 缺 id 与无任何等级的条目分别告警
    const warnTexts = harness.logger.warn.mock.calls.map((call) => String(call[0]))
    expect(warnTexts.some((text) => text.includes('缺少有效 id'))).toBe(true)
    expect(warnTexts.some((text) => text.includes('未包含 reasoningEffort 或 models'))).toBe(true)

    // 告警不影响同配置中合法条目的正常注入
    expect(makeStreamProbe(harness)('gw', 'ok')).toBe('medium')
  })

  it('warns about string shorthand entries in array position', () => {
    // 数组位置没有键名可用作 id，字符串简写永远生成不了路由键；必须告警而非静默忽略。
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({ providers: { gw: { models: ['high'] } } }))

    const warnTexts = harness.logger.warn.mock.calls.map((call) => String(call[0]))
    expect(warnTexts.some((text) => text.includes('缺少有效 id'))).toBe(true)
  })

  it('warns about unknown reasoning levels at activation and still injects them', () => {
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({ defaults: { '*': 'extreme' } }))

    // 激活期体检与激活日志都会看到同一处配置：文案一致 + warnOnce 去重，
    // 因此只应出现一条告警，且带上已知等级清单便于直接比对。
    expect(harness.logger.warn).toHaveBeenCalledTimes(1)
    expect(String(harness.logger.warn.mock.calls[0]?.[0])).toContain('不在已知集合')
    expect(String(harness.logger.warn.mock.calls[0]?.[0])).toContain('medium/high/xhigh/max')
    expect(makeStreamProbe(harness)('any', 'model')).toBe('extreme')
    expect(harness.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('warns once about an unknown level introduced by a live settings write', () => {
    // volatile 写入不会重载插件、也不再走激活期体检；读取热路径上一次告警即可
    // 让手工编辑暴露，同时避免每次请求刷日志。
    const harness = createHarness()
    const config = pluginConfig({ defaults: {} })
    apply(harness.ctx, config)
    harness.logger.warn.mockClear()
    commitLiveDefaults(config, { '*': 'ultra' })

    const effort = makeStreamProbe(harness)
    expect(effort('any', 'model')).toBe('ultra')
    expect(effort('any', 'model')).toBe('ultra')

    expect(harness.logger.warn).toHaveBeenCalledTimes(1)
    expect(String(harness.logger.warn.mock.calls[0]?.[0])).toContain('不在已知集合')
  })

  it('warns about blank flat route keys and treats them as empty config', () => {
    // 空白键在 schema 路径直接被拒绝；这里覆盖绕过 schema 的编程直调形态，
    // collectConfigIssues 与 normalizeFlatDefaults 必须同步地告警 + 跳过，
    // 而不是产出永不命中的空键死路由。
    const harness = createHarness()
    apply(harness.ctx, {
      defaults: createVolatile({ ' ': 'high' }),
    } as unknown as ResolvedConfig)

    const warnTexts = harness.logger.warn.mock.calls.map((call) => String(call[0]))
    expect(warnTexts.some((text) => text.includes('路由键为空白'))).toBe(true)
    harness.llm.stream({ provider: 'any', model: 'model', messages: [] })
    expect(harness.originalStream.mock.calls[0]![0].reasoningEffort).toBeUndefined()
  })

  it('logs the effective route list on activation', () => {
    const harness = createHarness()
    apply(harness.ctx, pluginConfig({ defaults: { '*': 'low', 'gw:m': 'high' } }))

    const infoTexts = harness.logger.info.mock.calls.map((call) => String(call[0]))
    expect(infoTexts.some((text) => text.includes('routes=') && text.includes('gw:m'))).toBe(true)
  })

  it('keeps the route table stable when the same defaults object is re-committed', () => {
    // 宿主在写入后可能重复提交等价快照；重复提交不应影响已生效的路由表。
    const harness = createHarness()
    const config = pluginConfig({ defaults: { 'gw:m': 'high' } })
    apply(harness.ctx, config)

    commitLiveDefaults(config, { 'gw:m': 'high' })
    commitLiveDefaults(config, { 'gw:m': 'high' })

    expect(makeStreamProbe(harness)('gw', 'm')).toBe('high')
    expect(harness.logger.warn).not.toHaveBeenCalled()
  })
})
