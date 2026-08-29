/**
 * dsh-model-reasoning-defaults 的客户端半体。
 *
 * - 设置页 section：编辑本插件设置命名空间中的扁平路由表，经宿主统一的
 *   settings API 写入。Host 每次请求实时读取该层，保存即生效。
 *
 * 控件一律使用官方 @deepseek-ai/dsh-client-ui-primitives（平台基线模块，
 * 宿主模块表直接应答），与设置壳视觉一致。
 */
import { createElement, useEffect, useState } from 'react'
import type { ChangeEvent, CSSProperties, ReactNode } from 'react'
import {
  Button,
  IconChevronDownOutline14,
  IconPlusOutline16,
  IconTrashOutline16,
  Input,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only：拉入 SlotMap 声明面，使下方 declare module 增强可解析。
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** 设置页 section 槽位类型由 ui-settings 壳声明；本插件不依赖该包，本地补齐面。 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.section': { kind: 'list'; scope: 'root'; owner: { close: () => void } }
  }
}

/** 宿主 SlotRegistry 的窄面：本插件只用 inject/register 两个入口。 */
interface SlotRegistry {
  inject(name: string, callback: () => () => void): () => void
  register(options: unknown, component: unknown): () => void
}

/** 本插件的设置命名空间，与 Host 侧 UI_DEFAULTS_NAMESPACE 一致。 */
const SETTINGS_NS = 'model-reasoning-defaults'

/** 已知推理等级集合（与 Host 侧 KNOWN_REASONING_EFFORTS 保持一致）。 */
const KNOWN_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

type ClientContext = {
  slots: SlotRegistry
  remote: {
    settings: RemoteSettings
  }
}

/** 声明客户端所需的槽位与 settings Remote 命名空间。 */
export const inject = ['slots', 'remote', 'remote.settings'] as const

/** settings Remote 的读写方法面（宿主 API Gateway 经 Typert Remote 生成）。 */
interface RemoteSettings {
  describe(): Promise<RemoteResult<SettingsDescribeValue>>
  update(
    ns: string,
    patch: Record<string, unknown>,
    expectedRevision: number | undefined,
  ): Promise<RemoteResult<SettingsNamespaceView>>
}

/** Typert Remote 统一应答形状。 */
type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details: object } }

/** describe 应答：每个已注册命名空间与写入能力标记。 */
interface SettingsDescribeValue {
  /** 设置文档是否可写。 */
  writable: boolean
  /** 是否有宿主侧的设置文档。 */
  hasDocument: boolean
  /** 已注册命名空间视图列表。 */
  namespaces: SettingsNamespaceView[]
}

/** 单个命名空间的描述视图。 */
interface SettingsNamespaceView {
  /** 命名空间键。 */
  ns: string
  /** 脱敏后的解析值。 */
  value: unknown
  /** 该视图读取时的修订号，写回时作为 expectedRevision。 */
  revision: number
}

/** apply 时捕获的设置 Remote；组件经模块级引用读取（单注册插件，热重载时随 apply 刷新）。 */
let currentApi: RemoteSettings | undefined

/** 一条可编辑的路由行。 */
interface RouteRow {
  key: string
  effort: string
}

/** describe 应答中单个命名空间的视图子集。 */
interface NamespaceView {
  ns: string
  value: unknown
  revision: number
}

/**
 * 从 describe 应答中提取本插件命名空间的路由表与修订号。
 *
 * @param namespaces - describe 应答携带的命名空间视图列表。
 * @returns 路由字典副本与修订号；命名空间尚未注册时为 undefined。
 */
function findOwnNamespace(namespaces: NamespaceView[]): { defaults: Record<string, string>; revision: number } | undefined {
  const own = namespaces.find(entry => entry.ns === SETTINGS_NS)
  if (own === undefined) return undefined
  const section = own.value as { defaults?: Record<string, string> } | null
  return {
    defaults: section !== null && typeof section === 'object'
      && section.defaults !== undefined && typeof section.defaults === 'object'
      ? { ...section.defaults }
      : {},
    revision: own.revision,
  }
}

/**
 * 从 describe 应答中收集已知 provider 与 provider:model 路由键，作为输入建议。
 *
 * @param namespaces - describe 应答携带的命名空间视图列表。
 * @returns 排序后的建议键列表。
 */
function collectSuggestions(namespaces: NamespaceView[]): string[] {
  const suggestions = new Set<string>()
  const addProvider = (id: string, models: readonly string[]): void => {
    const providerId = id.trim()
    if (providerId.length === 0) return
    suggestions.add(providerId)
    for (const model of models) {
      const modelId = model.trim()
      if (modelId.length > 0) suggestions.add(providerId + ':' + modelId)
    }
  }

  const piAi = namespaces.find(entry => entry.ns === 'llm-pi-ai')?.value as {
    providers?: Record<string, { models?: Array<{ id?: unknown }> }>
  } | null
  if (piAi?.providers && typeof piAi.providers === 'object') {
    for (const [providerId, profile] of Object.entries(piAi.providers)) {
      const models = Array.isArray(profile?.models)
        ? profile.models.map(m => (typeof m?.id === 'string' ? m.id : '')).filter(id => id.length > 0)
        : []
      addProvider(providerId, models)
    }
  }

  if (namespaces.some(entry => entry.ns === 'llm-deepseek')) addProvider('deepseek-official', [])

  return [...suggestions].sort()
}

/** 建议弹层最多展示的条数；更多条目没有滚动价值，缩小查询即可。 */
const SUGGESTION_LIMIT = 12

/**
 * 按当前输入过滤建议键：子串匹配（路由键常以 provider 前缀开头，前缀过滤
 * 会漏掉 model 段命中），排除与输入完全相同的项，空输入展示前若干条。
 *
 * @param value - 输入框当前值。
 * @param all - 全量建议键。
 * @returns 供弹层展示的建议键列表。
 */
function suggestionMatches(value: string, all: string[]): string[] {
  const exact = value.trim()
  const query = exact.toLowerCase()
  const pool = query.length === 0
    ? all
    : all.filter(candidate => candidate !== exact && candidate.toLowerCase().includes(query))
  return pool.slice(0, SUGGESTION_LIMIT)
}

// 颜色一律使用 --dsw-alias-* 语义 token（随明暗主题翻转）；布局遵循设置壳
// 约定：.options 已提供 24px 内边距，section 只负责纵向节奏与最大宽度。
const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  maxWidth: 720,
  color: 'var(--dsw-alias-label-primary)',
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
  lineHeight: 1.4,
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

const keyFieldStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
}

const mutedStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-tertiary)',
}

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-tertiary)',
}

const errorStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-state-error-primary)',
}

const okStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-state-success-primary)',
}

/**
 * 把官方 Input 的默认几何（h32 / r8 / 字号 14）对齐到行内 sm 胶囊控件
 * （Button.sm：h28 / r14 / 字号 12），使路由键输入框与右侧下拉、删除按钮同高同形。
 * 建议弹层的包裹 span 由 Menu 注入为 inline 布局，这里展开成块级并撑满列宽，
 * 让弹层与输入框左缘对齐。通过 data-plugin-css 标记幂等注入，遵循宿主插件样式约定。
 */
const COMPACT_INPUT_CSS = [
  '.dsh-mrd-input-sm {',
  // 宿主无全局 border-box reset：content-box 下 width:100% 只是内容宽，
  // 叠加 padding/border 后总宽超出父容器 22px，溢出盖住右侧按钮。
  '  box-sizing: border-box;',
  '  width: 100%;',
  '  height: 28px;',
  '  border-radius: 14px;',
  '  padding: 0 10px;',
  '}',
  '.dsh-mrd-input-sm > input {',
  '  font-size: 12px;',
  '  line-height: 18px;',
  '}',
  '.dsh-mrd-suggest {',
  '  display: block;',
  '  width: 100%;',
  '}',
].join('\n')

const COMPACT_INPUT_STYLE_TAG = 'dsh-model-reasoning-defaults/input-sm'

// 样式注入必须脱离 React 渲染树（模块级副作用）：若以组件节点渲染，每次
// 渲染的 DOM 幂等检查会让 React 把该节点当作"不再渲染"而卸载/重挂，
// 菜单展开等重渲染期间样式短暂丢失，`.dsh-mrd-suggest` 回退为 Menu 默认的
// inline-flex，输入框宽度塌缩（跟随宿主 tsdown.client.ts 的注入约定）。
if (
  typeof document !== 'undefined'
  && document.querySelector('style[data-plugin-css="' + COMPACT_INPUT_STYLE_TAG + '"]') === null
) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-model-reasoning-defaults'
  tag.dataset.pluginCss = COMPACT_INPUT_STYLE_TAG
  tag.textContent = COMPACT_INPUT_CSS
  document.head.appendChild(tag)
}

/**
 * 把路由字典展开成按键排序的可编辑行。
 *
 * @param defaults - 路由字典。
 * @returns 稳定排序的行列表。
 */
function rowsOf(defaults: Record<string, string>): RouteRow[] {
  return Object.entries(defaults)
    .map(([key, effort]) => ({ key, effort }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/**
 * 校验待保存的行集合并折叠回路由字典。
 *
 * @param rows - 当前编辑的行。
 * @returns 校验通过时返回字典；失败时返回错误消息。
 */
function collapseRows(rows: RouteRow[]): Record<string, string> | { error: string } {
  const result: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    // 空键行是编辑过程中的残渣：直接丢弃而不是拦住保存。
    if (key.length === 0) continue
    if (key in result) return { error: '存在重复路由键：' + key }
    result[key] = row.effort
  }
  return result
}

/**
 * 设置页「推理等级默认」编辑面板。
 *
 * 数据流：挂载时 describe 读一次（拿路由表、修订号、只读标记与建议键）；
 * 保存时带 expectedRevision 做 update，陈旧编辑会被宿主拒绝而不是静默覆盖。
 * 外部改动（另一标签页、手工编辑 yaml）在本组件重新挂载时可见——设置壳每次
 * 打开都重新挂载 section，无需订阅失效事件。
 *
 * @param props - 无属主属性（close 由壳持有，本面板不离开设置页）。
 * @returns 面板节点树。
 */
function ReasoningDefaultsSection(_props: { close: () => void }): ReactNode {
  const [rows, setRows] = useState<RouteRow[]>([])
  const [phase, setPhase] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [writable, setWritable] = useState(true)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>(undefined)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [openMenuIndex, setOpenMenuIndex] = useState<number | null>(null)
  const [suggestIndex, setSuggestIndex] = useState<number | null>(null)
  const revisionRef = useState<{ revision: number }>(() => ({ revision: 0 }))[0]

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const api = currentApi
      if (api === undefined) {
        if (!cancelled) setPhase('unavailable')
        return
      }
      try {
        const response = await api.describe()
        if (cancelled) return
        if (!response.ok) {
          setPhase('unavailable')
          setFeedback({ kind: 'error', text: response.error.message })
          return
        }
        const own = findOwnNamespace(response.value.namespaces)
        if (own === undefined) {
          setPhase('unavailable')
          setFeedback({ kind: 'error', text: 'Host 未注册 ' + SETTINGS_NS + ' 命名空间，请确认插件已启用并刷新页面' })
          return
        }
        setRows(rowsOf(own.defaults))
        revisionRef.revision = own.revision
        setWritable(response.value.writable)
        setSuggestions(collectSuggestions(response.value.namespaces))
        setPhase('ready')
      } catch (error) {
        if (!cancelled) {
          setPhase('unavailable')
          setFeedback({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    void load()
    return () => { cancelled = true }
  }, [revisionRef])

  const save = async (): Promise<void> => {
    const api = currentApi
    if (api === undefined || saving) return
    const collapsed = collapseRows(rows)
    if ('error' in collapsed) {
      setFeedback({ kind: 'error', text: collapsed.error })
      return
    }
    setSaving(true)
    setFeedback(undefined)
    try {
      const response = await api.update(SETTINGS_NS, { defaults: collapsed }, revisionRef.revision)
      if (!response.ok) {
        setFeedback({ kind: 'error', text: response.error.message })
        return
      }
      // 写回应答里带新修订号；再 describe 一次让行视图与存储严格一致（含 trim）。
      const reread = await api.describe()
      if (reread.ok) {
        const own = findOwnNamespace(reread.value.namespaces)
        if (own !== undefined) {
          setRows(rowsOf(own.defaults))
          revisionRef.revision = own.revision
        }
      }
      setFeedback({ kind: 'ok', text: '已保存，对新请求即时生效' })
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setSaving(false)
    }
  }

  if (phase === 'loading') {
    return createElement('div', { style: sectionStyle }, createElement('p', { style: mutedStyle }, '加载推理等级配置…'))
  }

  if (phase === 'unavailable') {
    return createElement(
      'div',
      { style: sectionStyle },
      createElement('p', { style: errorStyle }, '无法读取推理等级配置。'),
      feedback === undefined
        ? null
        : createElement('p', { style: feedback.kind === 'error' ? errorStyle : okStyle }, feedback.text),
    )
  }

  const children: ReactNode[] = [
    createElement('div', { key: 'title', style: titleStyle }, '推理等级默认'),
    createElement(
      'p',
      { key: 'intro', style: mutedStyle },
      '请求未显式指定 reasoningEffort 时按此路由表补齐。匹配顺序：provider:model → provider:* → provider/* → provider → *:model → *。',
    ),
  ]

  if (!writable) {
    children.push(createElement('p', { key: 'readonly', style: mutedStyle }, '当前设置文档为只读，修改需在 Host 侧完成。'))
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const menuOpen = openMenuIndex === index
    const keySuggestions = suggestionMatches(row.key, suggestions)
    children.push(createElement(
      'div',
      { key: 'row-' + index, style: rowStyle },
      createElement('div', { key: 'key', style: keyFieldStyle },
          // 建议弹层与等级下拉一样走 portal：设置壳的 .panel 裁剪 overflow，
          // 原地弹层会被裁掉或顶出面板（原生 datalist 更是完全不受控）。
        createElement(Menu, {
          key: 'key-suggest',
          className: 'dsh-mrd-suggest',
          open: suggestIndex === index && keySuggestions.length > 0,
          portal: true,
          dense: true,
          items: keySuggestions.map(candidate => ({ id: candidate, label: candidate })),
          onSelect: (candidate: string) => {
            const next = [...rows]
            next[index] = { ...row, key: candidate }
            setRows(next)
            setSuggestIndex(null)
          },
          onClose: () => { setSuggestIndex(null) },
          anchor: createElement(Input, {
            className: 'dsh-mrd-input-sm',
            value: row.key,
            placeholder: 'provider:model / provider:* / *',
            'aria-label': '路由键',
            style: { width: '100%' },
            onFocus: () => { setSuggestIndex(index) },
            onChange: (event: ChangeEvent<HTMLInputElement>) => {
              const next = [...rows]
              next[index] = { ...row, key: event.target.value }
              setRows(next)
              setSuggestIndex(index)
            },
          }),
        }),
      ),
      createElement(Menu, {
        key: 'effort',
        open: menuOpen,
        onClose: () => { setOpenMenuIndex(null) },
        portal: true,
        dense: true,
        items: KNOWN_EFFORTS.map(level => ({ id: level, label: level })),
        selectedId: row.effort,
        onSelect: (id: string) => {
          const next = [...rows]
          next[index] = { ...row, effort: id }
          setRows(next)
          setOpenMenuIndex(null)
        },
        anchor: createElement(Button, {
          variant: 'outline',
          size: 'sm',
          'aria-haspopup': 'menu',
          'aria-expanded': menuOpen,
          onClick: () => { setOpenMenuIndex(menuOpen ? null : index) },
        }, row.effort, createElement(IconChevronDownOutline14)),
      }),
      createElement(Button, {
        key: 'remove',
        variant: 'ghost',
        size: 'sm',
        icon: createElement(IconTrashOutline16),
        'aria-label': '删除路由 ' + row.key,
        title: '删除该路由',
        onClick: () => {
          setRows(rows.filter((_, i) => i !== index))
          setOpenMenuIndex(null)
          setSuggestIndex(null)
        },
      }, '删除'),
    ))
  }

  children.push(createElement(
    'div',
    { key: 'actions', style: rowStyle },
    createElement(Button, {
      variant: 'outline',
      size: 'sm',
      icon: createElement(IconPlusOutline16),
      onClick: () => setRows([...rows, { key: '', effort: 'medium' }]),
    }, '添加路由'),
    createElement(Button, {
      variant: 'primary',
      size: 'sm',
      disabled: saving || !writable || rows.length === 0,
      onClick: () => { void save() },
    }, saving ? '保存中…' : '保存'),
  ))

  children.push(createElement(
    'p',
    { key: 'hint', style: hintStyle },
    '已知等级：' + KNOWN_EFFORTS.join(' / ')
    + '。生效优先级：patch 层插件配置 > 此处 > Host 各 Provider 已声明的思考等级。'
    + '路由键支持 * 通配，聚焦输入框可查看已配置 Provider/Model 的建议。',
  ))

  if (feedback !== undefined) {
    children.push(createElement(
      'p',
      { key: 'feedback', style: { ...(feedback.kind === 'error' ? errorStyle : okStyle) } },
      feedback.text,
    ))
  }

  return createElement('div', { style: sectionStyle }, children)
}

/**
 * 注册设置页编辑 section。
 *
 * slots.inject 已绑定当前 fiber 的生命周期，不需要再套一层 effect，
 * 注册和注销由同一个 slot owner 管理，不会留下嵌套 disposer。
 *
 * @param ctx - 提供槽位与连接服务的客户端上下文。
 */
export function apply(ctx: ClientContext): void {
  // 宿主 API Gateway 装配了 settings Remote 命名空间后，ctx.remote.settings 才可用；
  // inject 声明保证了装配顺序，此处直接引用。
  currentApi = ctx.remote.settings

  ctx.slots.inject(
    'settings.section',
    () => ctx.slots.register({
      name: 'settings.section',
      id: SETTINGS_NS,
      order: 15,
      label: () => '推理等级默认',
    }, ReasoningDefaultsSection),
  )
}
