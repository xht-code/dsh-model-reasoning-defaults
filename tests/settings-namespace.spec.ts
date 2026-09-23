/**
 * 设置命名空间契约测试。
 *
 * 这些用例直接跑宿主真实的 SettingsForms（dsh-settings 0.1.7+），只把
 * configEditor / profileContext / Context 换成本地桩：设置页能否工作取决于
 * 插件 Config 中是否存在 volatile 字段，以及保存时的路径写入是否被接受，
 * 这两点都由宿主实现裁决，用桩复制逻辑无法覆盖，因此这里跑真实实现。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SettingsForms } from '@deepseek-ai/dsh-settings'
import { Config as PluginConfig } from '../src/index.ts'
import type { Config, ResolvedConfig } from '../src/index.ts'

const NAMESPACE = 'model-reasoning-defaults'

type Stored = Record<string, unknown>

/** 宿主 loader entry 的最小面：SettingsForms 读取 schema、解析值与原始配置。 */
interface StubEntry {
  id: string
  options: { id: string; config: Config }
  fiber: { uid: number; state: number; runtime: { Config: typeof PluginConfig }; config: ResolvedConfig; ctx: unknown }
}

/**
 * 搭一个只覆盖 SettingsForms 用到的面的宿主桩。
 *
 * @param raw - 用户层原始配置（profile patch 里该 entry 的 config）。
 * @returns 真实 SettingsForms 实例、entry 桩与已记录事件。
 */
function createSettingsHost(raw: Config) {
  const emitted: Array<[string, ...unknown[]]> = []
  const written: Stored[] = []
  // entry 与 context 互相引用：configEditor 的桩经闭包延迟读取 entry，避免循环初始化。
  let entry!: StubEntry
  const context = {
    reflect: { provide() {} },
    effect: (factory: () => () => void) => { factory(); return () => {} },
    on: () => () => {},
    emit: (name: string, ...args: unknown[]) => { emitted.push([name, ...args]); return [] },
    root: { loader: { await: async () => {} } },
    // invalidate() 会读 ownerContext.fiber.state，取其"已激活"值。
    fiber: { state: 2 },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    profileContext: {
      home: '/nonexistent-dsh-home',
      dir: '/nonexistent',
      installAnchor: '',
      name: 'probe',
      patchPath: '/nonexistent/cordis.patch.yml',
    },
    configEditor: {
      entries: () => [entry],
      configuration: () => [{ entry, inherited: {}, override: raw }],
      edit: async (_entry: unknown, change: (raw: Stored, inherited: Stored) => Stored) => {
        written.push(change({ ...raw }, {}))
      },
    },
  }
  entry = {
    id: NAMESPACE,
    options: { id: NAMESPACE, config: raw },
    fiber: { uid: 1, state: 2, runtime: { Config: PluginConfig }, config: PluginConfig(raw), ctx: context },
  }
  const forms = new SettingsForms(context as unknown as Context)
  return { forms, entry, written, emitted }
}

describe('settings namespace contract', () => {
  it('exposes the namespace to the settings panel', () => {
    // 本插件的设置页入口 id 与插件自带 bundle patch 插入的 entry id 一致；
    // 没有 volatile 字段时宿主不会把该 entry 列进 describe，设置页就只能报
    // "未提供配置项"（这正是 0.1.7 宿主上设置面板打不开的原因）。
    const { forms } = createSettingsHost({ defaults: { 'gw:m': 'high' } })
    const own = forms.describe().find((descriptor) => String(descriptor.ns) === NAMESPACE)

    expect(own).toBeDefined()
    expect(own?.value).toEqual({ defaults: { 'gw:m': 'high' } })
    expect(own?.applies).toBe('live')
  })

  it('honours the plugin declaring its own settings page', () => {
    // apply() 调用 settings.configure({ auto: false }, ctx.fiber)：本插件自带
    // section，宿主不应再为该 entry 生成通用表单。
    const { forms, entry } = createSettingsHost({})
    forms.configure({ auto: false }, entry.fiber as never)

    expect(forms.describe().find((descriptor) => String(descriptor.ns) === NAMESPACE)?.autoGenerate).toBe(false)
  })

  it('applies path-addressed route edits and preserves structured config', async () => {
    const { forms, written, emitted } = createSettingsHost({
      defaults: { 'gw:old': 'low', '*': 'medium' },
      providers: { gw: { reasoningEffort: 'low' } },
    })

    await forms.mutate(NAMESPACE, [
      { op: 'set', path: ['defaults', 'gw:old'], value: 'max' },
      { op: 'set', path: ['defaults', 'gw:new'], value: 'high' },
      { op: 'unset', path: ['defaults', '*'] },
    ], 0)

    // 省略键不表达删除：只有路径寻址的 unset 才能把删除落盘；同时写 defaults
    // 不能碰到同一 entry 里的结构化字段（它们是 patch 层的普通字段）。
    expect(written).toEqual([{
      providers: { gw: { reasoningEffort: 'low' } },
      defaults: { 'gw:old': 'max', 'gw:new': 'high' },
    }])
    // 客户端镜像靠该事件重新读取，保存后界面才能显示最新值。
    expect(emitted.some(([name, ns]) => name === 'settings/document-updated' && ns === NAMESPACE)).toBe(true)
  })

  it('refuses a stale revision instead of overwriting', async () => {
    const { forms, written } = createSettingsHost({ defaults: { 'gw:m': 'high' } })

    await expect(forms.mutate(NAMESPACE, [{ op: 'set', path: ['defaults', 'gw:m'], value: 'low' }], 99))
      .rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' })
    expect(written).toEqual([])
  })

  it('keeps non-volatile fields out of the settings panel', async () => {
    // 设置页只能编辑 defaults；结构化字段属于 profile patch，写它们必须被拒绝。
    const { forms, written } = createSettingsHost({})

    await expect(forms.mutate(NAMESPACE, [{ op: 'set', path: ['reasoningEffort'], value: 'low' }], 0))
      .rejects.toThrow('is not volatile')
    expect(written).toEqual([])
  })
})
