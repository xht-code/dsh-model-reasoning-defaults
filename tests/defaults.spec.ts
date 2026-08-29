import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { markAgentLoopRequest, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { apply, applyDefaultReasoningEffort, Config as PluginConfig, extractSettingsDefaults, extractUiNamespaceDefaults, normalizeConfig } from '../src/index.ts'

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
  const ctx = {
    llm,
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
    // warn 桩用于断言激活期诊断与设置提取告警。
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
    expect(PluginConfig({ defaults: { '*': 'high' } }).defaults?.['*']).toBe('high')
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
    apply(harness.ctx, { defaults: { '*': 'high' } })

    // harness 以数组存储多 listener，此处取首个（热重载前仅一个）
    const listener = harness.listenerArrays.get('agent/request')?.[0]
    expect(listener).toBeDefined()
    const signal = new AbortController().signal
    const result = await listener?.({ turn: 1, step: 0, signal }, async () => callConfig('gateway', 'reasoner'))

    expect(result).toMatchObject({ provider: 'gateway', model: 'reasoner', reasoningEffort: 'high' })
  })

  it('copies mutable hand-built requests before their waterfall begins', () => {
    const harness = createHarness()
    apply(harness.ctx, { defaults: { '*': 'high' } })
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
    apply(harness.ctx, {
      defaults: {
        'gw:reasoner': 'exact',
        'gw:*': 'provider',
        '*:reasoner': 'model',
        '*': 'global',
      },
    })

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
    apply(harness.ctx, { defaults: { 'gw/*': 'slash', gw: 'bare' } })
    harness.llm.stream({ provider: 'gw', model: 'm', messages: [] })
    expect(harness.originalStream.mock.calls[0]![0]).toMatchObject({ reasoningEffort: 'slash' })

    // 裸 provider 键在无更高级键时的兜底命中
    const harnessBare = createHarness()
    apply(harnessBare.ctx, { defaults: { gw: 'bare' } })
    harnessBare.llm.stream({ provider: 'gw', model: 'm', messages: [] })
    expect(harnessBare.originalStream.mock.calls[0]![0]).toMatchObject({ reasoningEffort: 'bare' })
  })

  it('copies frozen auxiliary requests once without dropping their purpose', () => {
    const harness = createHarness()
    apply(harness.ctx, { defaults: { '*': 'high' } })
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
    apply(harness.ctx, { defaults: { '*': 'high' } })
    // 复现真实流程：agent/request 只处理调用配置种子；loop 随后据此构建完整
    // 请求、打宿主 markAgentLoopRequest 标识并深冻结，再进入 stream。
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

    const options = Object.freeze(markAgentLoopRequest({ ...seed, messages: [] }))
    harness.llm.stream(options)
    const [forwarded] = harness.originalStream.mock.calls[0]!

    expect(harness.originalStream).toHaveBeenCalledOnce()
    expect(forwarded).toBe(options)
    expect(forwarded.reasoningEffort).toBe('high')
  })

  it('never copies a loop request even when its effort is unset', () => {
    // 回归保护：agent/request 阶段缺席或未命中时，stream 入口路由即使命中也
    // 不得浅复制 loop 请求——复制会丢失宿主进程标识，令观察者误判请求来源。
    const harness = createHarness()
    apply(harness.ctx, { defaults: { '*': 'high' } })
    const options = Object.freeze(
      markAgentLoopRequest({ provider: 'gateway', model: 'reasoner', messages: [] }),
    )

    harness.llm.stream(options)
    const [forwarded] = harness.originalStream.mock.calls[0]!

    expect(forwarded).toBe(options)
  })

  it('passes injected config and abort signal through prepareCall', async () => {
    const harness = createHarness()
    apply(harness.ctx, { defaults: { '*': 'high' } })
    const signal = new AbortController().signal

    await harness.llm.prepareCall(callConfig('gateway', 'reasoner'), signal)

    expect(harness.originalPrepareCall).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'high' }),
      signal,
    )
  })

  it('passes injected config and abort signal through resolveCallConfig', async () => {
    const harness = createHarness()
    apply(harness.ctx, { defaults: { '*': 'high' } })
    const signal = new AbortController().signal

    await harness.llm.resolveCallConfig(callConfig('gateway', 'reasoner'), signal)

    expect(harness.originalResolveCallConfig).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'high' }),
      signal,
    )
  })

  it('does not install listeners or wrappers for empty defaults', () => {
    const harness = createHarness()
    apply(harness.ctx, { defaults: {} })

    expect(harness.listeners.size).toBe(0)
    expect(harness.cleanups).toHaveLength(0)
    expect(harness.llm.stream).toBe(harness.originalStream)
    expect(harness.llm.prepareCall).toBe(harness.originalPrepareCall)
    expect(harness.llm.resolveCallConfig).toBe(harness.originalResolveCallConfig)
  })

  it('keeps the newest defaults active while an older fiber unloads', () => {
    const harness = createHarness()
    apply(harness.ctx, { defaults: { '*': 'low' } })
    const sharedStream = harness.llm.stream
    apply(harness.ctx, { defaults: { '*': 'high' } })

    expect(harness.llm.stream).toBe(sharedStream)
    harness.llm.stream({ provider: 'gateway', model: 'reasoner', messages: [] })
    expect(harness.originalStream.mock.calls[0]![0]).toMatchObject({ reasoningEffort: 'high' })

    // 每个 fiber 产生 2 个 effect：wrapper restore + listener dispose。
    // 卸载旧 fiber 需同时清理其两个 effect，但 wrapper 只有在最后一个 defaults 移除后才还原。
    // 因此先执行旧 fiber 的 wrapper 清理（cleanups[0]），此时 listener 仍存但 defaults 已更新为 high。
    harness.cleanups[0]!()
    harness.llm.stream({ provider: 'gateway', model: 'reasoner', messages: [] })
    expect(harness.originalStream.mock.calls[1]![0]).toMatchObject({ reasoningEffort: 'high' })
    // 再清理旧 fiber 的 listener disposer
    harness.cleanups[1]!()
    // 旧 fiber 完全卸载后，stream 仍由新 fiber 持有，不应还原。
    expect(harness.llm.stream).toBe(sharedStream)

    // 卸载新 fiber 的两个 effect 后才完全还原
    harness.cleanups[2]!()
    harness.cleanups[3]!()
    expect(harness.llm.stream).toBe(harness.originalStream)
    expect(harness.llm.prepareCall).toBe(harness.originalPrepareCall)
    expect(harness.llm.resolveCallConfig).toBe(harness.originalResolveCallConfig)
  })

  it('uses the newest defaults from an older agent listener during hot reload', async () => {
    const harness = createHarness()
    apply(harness.ctx, { defaults: { '*': 'low' } })
    const olderListener = harness.listenerArrays.get('agent/request')![0]!
    apply(harness.ctx, { defaults: { '*': 'high' } })

    const result = await olderListener(
      { turn: 1, step: 0, signal: new AbortController().signal },
      async () => callConfig('gateway', 'reasoner'),
    )

    expect(result).toMatchObject({ reasoningEffort: 'high' })
  })

  it('restores only methods still owned by the active wrapper', () => {
    const harness = createHarness()
    apply(harness.ctx, { defaults: { '*': 'high' } })
    const newerPrepareCall = vi.fn()
    harness.llm.prepareCall = newerPrepareCall

    harness.cleanups[0]!()

    expect(harness.llm.prepareCall).toBe(newerPrepareCall)
    expect(harness.llm.stream).toBe(harness.originalStream)
    expect(harness.llm.resolveCallConfig).toBe(harness.originalResolveCallConfig)
  })
  it('does not duplicate or leak global listeners across hot reload', async () => {
    const harness = createHarness()
    apply(harness.ctx, { defaults: { '*': 'low' } })
    expect(harness.onOptions[0]).toMatchObject({ event: 'agent/request', options: { global: true } })
    // 进入下一个 fiber：显式推进，后续 effect 将归属新 fiber
    harness.advanceFiber()
    apply(harness.ctx, { defaults: { '*': 'high' } })
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

  it('does not interfere with external LLM wrappers installed after plugin', async () => {
    const harness = createHarness()
    apply(harness.ctx, { defaults: { '*': 'high' } })
    expect(harness.onOptions[0]).toMatchObject({ event: 'agent/request', options: { global: true } })
    const externalStream = vi.fn((opts: GenerateOptions) => opts)
    const externalPrepareCall = vi.fn(async (c: LlmCallConfig) => ({ config: c }))
    harness.llm.stream = externalStream as unknown as typeof harness.llm.stream
    harness.llm.prepareCall = externalPrepareCall as unknown as typeof harness.llm.prepareCall

    // 外部方法应被真实调用且透传参数
    const signal = new AbortController().signal
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

  it('injects requests correctly when configured with structured providers and models', async () => {
    const harness = createHarness()
    apply(harness.ctx, {
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
    })

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

  it('automatically extracts and applies reasoning defaults from ctx.settings', async () => {
    const harness = createHarness()
    // 模拟注册在 ctx.settings 上的 llm-pi-ai 与 llm-deepseek 设置文档
    const settingsStore = new Map<string, unknown>([
      [
        'llm-pi-ai',
        {
          providers: {
            'custom-gateway': {
              reasoning: 'medium',
              models: [
                { id: 'deepseek-reasoner', reasoning: 'high' },
                { id: 'standard-chat', reasoning: 'low' },
              ],
              modelOverrides: {
                'overridden-model': { reasoning: 'high' },
              },
            },
          },
        },
      ],
      [
        'llm-deepseek',
        {
          reasoningEffort: 'high',
        },
      ],
    ])

    const ctxWithSettings = {
      ...harness.ctx,
      settings: {
        get: (ns: string) => settingsStore.get(ns),
      },
    } as unknown as Context

    apply(ctxWithSettings, {})

    const streamEffort = (provider: string, model: string): string | undefined => {
      harness.llm.stream({ provider, model, messages: [] })
      const forwarded = harness.originalStream.mock.calls.at(-1)?.[0] as GenerateOptions | undefined
      return forwarded?.reasoningEffort
    }

    expect(streamEffort('custom-gateway', 'deepseek-reasoner')).toBe('high')
    expect(streamEffort('custom-gateway', 'standard-chat')).toBe('low')
    expect(streamEffort('custom-gateway', 'overridden-model')).toBe('high')
    expect(streamEffort('custom-gateway', 'unlisted-model')).toBe('medium')
    expect(streamEffort('deepseek-official', 'any-model')).toBe('high')
  })
})

describe('extractSettingsDefaults', () => {
  it('returns empty object when settings service is not present', () => {
    const harness = createHarness()
    expect(extractSettingsDefaults(harness.ctx)).toEqual({})
  })

  it('extracts provider and model reasoning levels correctly from settings', () => {
    const fakeCtx = {
      settings: {
        get: (ns: string) => {
          if (ns === 'llm-pi-ai') {
            return {
              providers: {
                'my-gw': {
                  reasoning: 'medium',
                  models: [{ id: 'r1', reasoning: 'high' }],
                  modelOverrides: { 'o3': { reasoning: 'high' } },
                },
              },
            }
          }
          if (ns === 'llm-deepseek') {
            return { reasoningEffort: 'high' }
          }
          return undefined
        },
      },
    } as unknown as Context

    const defaults = extractSettingsDefaults(fakeCtx)
    expect(defaults).toEqual({
      'my-gw:*': 'medium',
      'my-gw:r1': 'high',
      'my-gw:o3': 'high',
      'deepseek-official:*': 'high',
    })
  })

  it('propagates errors from settings.get instead of swallowing them', () => {
    // 提取路径不再包整体 try/catch：宿主 settings.get 本不抛错，
    // 剩余异常只可能是代码缺陷，应 fail-fast 而非以空映射静默继续。
    const fakeCtx = {
      settings: {
        get: () => {
          throw new Error('boom')
        },
      },
    } as unknown as Context

    expect(() => extractSettingsDefaults(fakeCtx)).toThrow('boom')
  })

  it('skips llm-pi-ai profiles named deepseek-official in favor of the real route', () => {
    // pi-ai 家族无法注册 deepseek-official 路由，其提取值永不命中；
    // llm-deepseek 的原生设置才是该路由的有效来源。
    const fakeCtx = {
      settings: {
        get: (ns: string) => {
          if (ns === 'llm-pi-ai') {
            return { providers: { 'deepseek-official': { reasoning: 'low' } } }
          }
          if (ns === 'llm-deepseek') {
            return { reasoningEffort: 'high' }
          }
          return undefined
        },
      },
    } as unknown as Context

    expect(extractSettingsDefaults(fakeCtx)).toEqual({ 'deepseek-official:*': 'high' })
  })

  it('keeps unknown reasoning levels but warns once per unique message', () => {
    let calls = 0
    const fakeCtx = {
      logger: { warn: vi.fn() },
      settings: {
        get: (ns: string) => {
          // 每次提取会对两个命名空间各调一次 get，只统计 deepseek 侧以计提取次数
          if (ns === 'llm-deepseek') {
            calls++
            return { reasoningEffort: 'ultra' }
          }
          return undefined
        },
      },
    } as unknown as Context

    const first = extractSettingsDefaults(fakeCtx)
    expect(first).toEqual({ 'deepseek-official:*': 'ultra' })
    // 同一问题只告警一次，避免请求热路径刷日志
    extractSettingsDefaults(fakeCtx)
    expect(calls).toBe(2)
    expect(fakeCtx.logger.warn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fakeCtx.logger.warn).mock.calls[0]?.[0]).toContain('不在已知集合')
  })
})

describe('extractUiNamespaceDefaults', () => {
  it('returns empty object when settings service is not present', () => {
    const harness = createHarness()
    expect(extractUiNamespaceDefaults(harness.ctx)).toEqual({})
  })

  it('extracts the flat route table with trim and blank-key skip', () => {
    const fakeCtx = {
      settings: {
        get: (ns: string) => ns === 'model-reasoning-defaults'
          ? { defaults: { 'gw:r1': ' high ', '  ': 'low', '*': 'medium' } }
          : undefined,
      },
    } as unknown as Context

    expect(extractUiNamespaceDefaults(fakeCtx)).toEqual({ 'gw:r1': 'high', '*': 'medium' })
  })

  it('ignores malformed section shapes instead of throwing', () => {
    // schema 校验保证合法写入；这里的防御只覆盖外部手工编辑 settings 文档
    const fakeCtx = {
      settings: { get: () => 'not-an-object' },
    } as unknown as Context
    expect(extractUiNamespaceDefaults(fakeCtx)).toEqual({})

    const missingDefaults = {
      settings: { get: () => ({ defaults: undefined }) },
    } as unknown as Context
    expect(extractUiNamespaceDefaults(missingDefaults)).toEqual({})
  })

  it('warns once about unknown levels but still records them', () => {
    const warn = vi.fn()
    const fakeCtx = {
      logger: { warn },
      settings: {
        get: () => ({ defaults: { '*': 'ultra' } }),
      },
    } as unknown as Context

    expect(extractUiNamespaceDefaults(fakeCtx)).toEqual({ '*': 'ultra' })
    // 同一问题只告警一次，避免请求热路径刷日志
    extractUiNamespaceDefaults(fakeCtx)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('不在已知集合')
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
    apply(harness.ctx, {
      defaults: { '*': 'low', 'models': 'high', 'my-gw:r1': 'exact' },
    })
    const effort = makeStreamProbe(harness)

    expect(effort('my-gw', 'r1')).toBe('exact')
    expect(effort('other', 'x')).toBe('low')
  })

  it('activates global default configured via top-level reasoningEffort only', () => {
    // 回归保护：仅含顶层 reasoningEffort 的最小结构化配置曾因形状嗅探漏判而失效。
    const harness = createHarness()
    apply(harness.ctx, { reasoningEffort: 'low' })
    expect(makeStreamProbe(harness)('any', 'model')).toBe('low')
  })

  it('warns at activation about structured entries that normalize away', () => {
    const harness = createHarness()
    apply(harness.ctx, {
      providers: {
        'gw': {
          models: [
            { reasoningEffort: 'high' },
            { id: 'ok', reasoningEffort: 'medium' },
          ],
        },
        'empty-gw': {},
      },
    })

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
    apply(harness.ctx, { providers: { gw: { models: ['high'] } } })

    const warnTexts = harness.logger.warn.mock.calls.map((call) => String(call[0]))
    expect(warnTexts.some((text) => text.includes('缺少有效 id'))).toBe(true)
  })

  it('warns about unknown reasoning levels at activation and still injects them', () => {
    const harness = createHarness()
    apply(harness.ctx, { defaults: { '*': 'extreme' } })

    expect(String(harness.logger.warn.mock.calls[0]?.[0])).toContain('不在已知集合')
    expect(makeStreamProbe(harness)('any', 'model')).toBe('extreme')
  })

  it('warns about blank flat route keys and treats them as empty config', () => {
    // 编程直调路径无 schema 拦截，collectConfigIssues 与 normalizeConfig 同步
    // 兜底：告警 + 跳过，不产生空键死路由、不安装任何包装。
    const harness = createHarness()
    apply(harness.ctx, { defaults: { ' ': 'high' } })

    const warnTexts = harness.logger.warn.mock.calls.map((call) => String(call[0]))
    expect(warnTexts.some((text) => text.includes('路由键为空白'))).toBe(true)
    expect(harness.listeners.size).toBe(0)
    expect(harness.llm.stream).toBe(harness.originalStream)
  })

  it('logs the effective route list on activation', () => {
    const harness = createHarness()
    apply(harness.ctx, { defaults: { '*': 'low', 'gw:m': 'high' } })

    const infoTexts = harness.logger.info.mock.calls.map((call) => String(call[0]))
    expect(infoTexts.some((text) => text.includes('routes=') && text.includes('gw:m'))).toBe(true)
  })

  it('uses the newest fiber context for settings extraction across hot reload', () => {
    const harness = createHarness()
    const settingsA = {
      get: (ns: string) => ns === 'llm-pi-ai' ? { providers: { gwA: { reasoning: 'low' } } } : undefined,
    }
    apply({ ...harness.ctx, settings: settingsA } as unknown as Context, {})

    // 模拟热重载：新 fiber 以携带不同 settings 的 ctx 再次装配
    harness.advanceFiber()
    const settingsB = {
      get: (ns: string) => ns === 'llm-pi-ai' ? { providers: { gwB: { reasoning: 'high' } } } : undefined,
    }
    apply({ ...harness.ctx, settings: settingsB } as unknown as Context, {})

    const effort = makeStreamProbe(harness)
    expect(effort('gwB', 'm')).toBe('high')
    // 共享包装层的 ctx 已刷新为新 fiber，旧 fiber 的提取来源不再生效
    expect(effort('gwA', 'm')).toBeUndefined()
  })
})
