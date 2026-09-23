/**
 * dsh-model-reasoning-defaults 的客户端半体。
 *
 * - 设置页 section：编辑本插件配置项（profile patch 中 id 为
 *   model-reasoning-defaults 的 `defaults` 字段）里的扁平路由表，经宿主统一的
 *   settings Remote 写入。Host 每次请求实时读取该 volatile 字段，保存即生效。
 *
 * 控件一律使用官方 @deepseek-ai/dsh-client-ui-primitives（平台基线模块，
 * 宿主模块表直接应答），与设置壳视觉一致。
 */
import { createElement, useEffect, useState } from 'react'
import type { ChangeEvent, CSSProperties, ReactNode } from 'react'
import {
  Button,
  IconChevronDownOutlineRegular,
  IconPlusOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only：拉入 SlotMap 声明面，使下方 declare module 增强可解析。
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { buildRouteOps, mergeStoredRows, rowsOf } from './route-table.js'
import type { RouteRow, SettingsPathOp } from './route-table.js'

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

/**
 * 本插件的设置命名空间。宿主侧的命名空间就是配置项 id——插件自带 bundle patch
 * 插入的那条 loader entry 的 id（见仓库根目录 cordis.patch.yml），不是插件名。
 */
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
  mutate(
    ns: string,
    ops: readonly SettingsPathOp[],
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

/** 本插件命名空间的编辑状态：路由表与写回用的修订号。 */
interface NamespaceState {
  /** 存储中当前生效的路由表，作为差异写入的基线。 */
  defaults: Record<string, string>
  /** 基线读取时的修订号，写回时作为 expectedRevision。 */
  revision: number
}

/**
 * 从 describe 应答中提取本插件命名空间的路由表与修订号。
 *
 * @param namespaces - describe 应答携带的命名空间视图列表。
 * @returns 路由字典副本与修订号；命名空间尚未注册时为 undefined。
 */
function findOwnNamespace(namespaces: SettingsNamespaceView[]): NamespaceState | undefined {
  const own = namespaces.find(entry => entry.ns === SETTINGS_NS)
  if (own === undefined) return undefined
  return { defaults: defaultsOf(own.value), revision: own.revision }
}

/**
 * 从命名空间解析值中取出路由字典。
 *
 * @param value - 命名空间视图的解析值。
 * @returns 路由字典副本；形状不符时为空对象。
 */
function defaultsOf(value: unknown): Record<string, string> {
  const section = value as { defaults?: Record<string, string> } | null
  if (section === null || typeof section !== 'object') return {}
  const defaults = section.defaults
  return defaults !== undefined && typeof defaults === 'object' ? { ...defaults } : {}
}

/**
 * 从 describe 应答中收集已知 provider 与 provider:model 路由键，作为输入建议。
 *
 * @param namespaces - describe 应答携带的命名空间视图列表。
 * @returns 排序后的建议键列表。
 */
function collectSuggestions(namespaces: SettingsNamespaceView[]): string[] {
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
 * 设置页「推理等级默认」编辑面板。
 *
 * 数据流：挂载时 describe 读一次（拿路由表、修订号、只读标记与建议键）；
 * 保存时把编辑差异作为路径操作连同 expectedRevision 发出，陈旧编辑会被宿主
 * 拒绝而不是静默覆盖——撞上冲突时保留本地编辑并刷新修订号，用户再保存一次
 * 即可覆盖。外部改动（另一标签页、手工编辑 profile patch）在本组件重新挂载时
 * 可见——设置壳每次打开都重新挂载 section，无需订阅失效事件。
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
  const store = useState<NamespaceState>(() => ({ defaults: {}, revision: 0 }))[0]

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
          setFeedback({ kind: 'error', text: 'Host 未提供 ' + SETTINGS_NS + ' 配置项，请确认插件已启用并刷新页面' })
          return
        }
        store.defaults = own.defaults
        store.revision = own.revision
        setRows(rowsOf(own.defaults))
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
  }, [store])

  const save = async (): Promise<void> => {
    const api = currentApi
    if (api === undefined || saving) return
    const ops = buildRouteOps(store.defaults, rows)
    if ('error' in ops) {
      setFeedback({ kind: 'error', text: ops.error })
      return
    }
    if (ops.length === 0) {
      setFeedback({ kind: 'ok', text: '没有需要保存的改动' })
      return
    }
    setSaving(true)
    setFeedback(undefined)
    try {
      const response = await api.mutate(SETTINGS_NS, ops, store.revision)
      if (!response.ok) {
        // 冲突是"读到的版本已过期"，不是请求非法：重新读取最新路由表作为新基线，
        // 本地编辑保留，用户再保存一次即可覆盖。
        if (response.error.code === 'settings/conflict') {
          const latest = await api.describe()
          const own = latest.ok ? findOwnNamespace(latest.value.namespaces) : undefined
          if (own === undefined) {
            // 刷新失败时不能宣称"已刷新"：修订号还是旧值，再点保存只会再次冲突，
            // 用户会陷入同一句提示的循环，必须把真实原因说出来。
            setFeedback({
              kind: 'error',
              text: '配置已被其它页面或文件修改，且重新读取失败'
                + (latest.ok ? '（Host 未提供 ' + SETTINGS_NS + ' 配置项）' : '：' + latest.error.message)
                + '；请关闭并重新打开设置页后再试。',
            })
            return
          }
          const previous = store.defaults
          store.defaults = own.defaults
          store.revision = own.revision
          setRows(current => mergeStoredRows(current, previous, own.defaults))
          // 行集会被重排/追加，仍指向旧下标的弹层必须收起，否则会挂到别的行上。
          setOpenMenuIndex(null)
          setSuggestIndex(null)
          setFeedback({ kind: 'error', text: '配置已被其它页面或文件修改，已刷新最新版本；请再次保存以覆盖。' })
          return
        }
        setFeedback({ kind: 'error', text: response.error.message })
        return
      }
      // 写回应答携带写入后的路由表与修订号，直接作为新基线，无需再读一次。
      const stored = defaultsOf(response.value.value)
      store.defaults = stored
      store.revision = response.value.revision
      setRows(rowsOf(stored))
      setOpenMenuIndex(null)
      setSuggestIndex(null)
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
    children.push(createElement('p', { key: 'readonly', style: mutedStyle }, '当前 profile 不接受写入，修改需在 Host 侧完成。'))
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
        }, row.effort, createElement(IconChevronDownOutlineRegular, { size: 14 })),
      }),
      createElement(Button, {
        key: 'remove',
        variant: 'ghost',
        size: 'sm',
        icon: createElement(IconTrashOutlineRegular),
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
      icon: createElement(IconPlusOutlineRegular),
      onClick: () => setRows([...rows, { key: '', effort: 'medium' }]),
    }, '添加路由'),
    createElement(Button, {
      variant: 'primary',
      size: 'sm',
      disabled: saving || !writable,
      onClick: () => { void save() },
    }, saving ? '保存中…' : '保存'),
  ))

  children.push(createElement(
    'p',
    { key: 'hint', style: hintStyle },
    '已知等级：' + KNOWN_EFFORTS.join(' / ')
    + '。路由表写入本插件的 profile 配置项，仅覆盖未显式指定 reasoningEffort 的请求。'
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
