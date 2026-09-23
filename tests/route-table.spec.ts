/**
 * 路由表编辑模型测试。
 *
 * 这些纯函数决定设置页"保存"究竟发出哪些路径操作，出错都是静默的（删除不落盘、
 * 重命名退化成新增、键被原型链误判），因此按边界逐条覆盖。
 */
import { describe, expect, it } from 'vitest'
import { buildRouteOps, mergeStoredRows, rowsOf } from '../src/client/route-table.ts'
import type { RouteRow } from '../src/client/route-table.ts'

describe('rowsOf', () => {
  it('expands the route table into key-sorted rows', () => {
    expect(rowsOf({ 'gw:m': 'high', '*': 'low', 'gw:*': 'medium' })).toEqual([
      { key: '*', effort: 'low' },
      { key: 'gw:*', effort: 'medium' },
      { key: 'gw:m', effort: 'high' },
    ])
  })

  it('returns no rows for an empty table', () => {
    expect(rowsOf({})).toEqual([])
  })
})

describe('buildRouteOps', () => {
  it('emits nothing when the edited rows match the baseline', () => {
    expect(buildRouteOps({ 'gw:m': 'high', '*': 'low' }, [
      { key: 'gw:m', effort: 'high' },
      { key: '*', effort: 'low' },
    ])).toEqual([])
  })

  it('emits a set for added and changed routes and an unset for removed ones', () => {
    expect(buildRouteOps({ 'gw:m': 'low', 'gone': 'high' }, [
      { key: 'gw:m', effort: 'max' },
      { key: 'gw:new', effort: 'medium' },
    ])).toEqual([
      { op: 'set', path: ['defaults', 'gw:m'], value: 'max' },
      { op: 'set', path: ['defaults', 'gw:new'], value: 'medium' },
      { op: 'unset', path: ['defaults', 'gone'] },
    ])
  })

  it('turns a renamed route into a set plus an unset of the old key', () => {
    expect(buildRouteOps({ 'gw:old': 'high' }, [{ key: 'gw:new', effort: 'high' }])).toEqual([
      { op: 'set', path: ['defaults', 'gw:new'], value: 'high' },
      { op: 'unset', path: ['defaults', 'gw:old'] },
    ])
  })

  it('clears the whole table when every row is removed', () => {
    expect(buildRouteOps({ a: 'low', b: 'high' }, [])).toEqual([
      { op: 'unset', path: ['defaults', 'a'] },
      { op: 'unset', path: ['defaults', 'b'] },
    ])
  })

  it('trims route keys and drops blank editing residue instead of blocking the save', () => {
    expect(buildRouteOps({}, [
      { key: '  ', effort: 'high' },
      { key: ' gw:m ', effort: 'low' },
    ])).toEqual([{ op: 'set', path: ['defaults', 'gw:m'], value: 'low' }])
  })

  it('reports duplicate route keys instead of silently collapsing them', () => {
    const ops = buildRouteOps({}, [
      { key: 'gw:m', effort: 'low' },
      { key: ' gw:m ', effort: 'high' },
    ])
    expect(ops).toEqual({ error: '存在重复路由键：gw:m' })
  })

  it('treats names colliding with Object.prototype members as ordinary route keys', () => {
    // 路由键撞上 toString/constructor 时，`in` 会沿原型链命中：重复检查会误报，
    // 删除检查会漏发 unset（该路由永远删不掉）。
    expect(buildRouteOps({}, [{ key: 'toString', effort: 'high' }])).toEqual([
      { op: 'set', path: ['defaults', 'toString'], value: 'high' },
    ])
    expect(buildRouteOps({ toString: 'high', constructor: 'low' }, [
      { key: 'toString', effort: 'high' },
    ])).toEqual([{ op: 'unset', path: ['defaults', 'constructor'] }])
    // 两条原型同名键共存时才算重复
    expect(buildRouteOps({}, [
      { key: 'toString', effort: 'high' },
      { key: 'constructor', effort: 'low' },
    ])).toEqual([
      { op: 'set', path: ['defaults', 'toString'], value: 'high' },
      { op: 'set', path: ['defaults', 'constructor'], value: 'low' },
    ])
  })

  it('handles a __proto__ route key that arrives as an own property over the wire', () => {
    // JSON.parse（而非对象字面量）才会生成自有的 __proto__ 属性，与远端来的一致。
    const baseline = JSON.parse('{"__proto__":"low"}') as Record<string, string>
    expect(Object.hasOwn(baseline, '__proto__')).toBe(true)
    expect(buildRouteOps(baseline, [])).toEqual([{ op: 'unset', path: ['defaults', '__proto__'] }])
    expect(buildRouteOps({}, [{ key: '__proto__', effort: 'high' }])).toEqual([
      { op: 'set', path: ['defaults', '__proto__'], value: 'high' },
    ])
  })
})

describe('mergeStoredRows', () => {
  it('appends externally added routes so a retry does not delete them', () => {
    const previous = { 'gw:m': 'low' }
    const latest = { 'gw:m': 'low', 'other:m': 'high' }

    expect(mergeStoredRows([{ key: 'gw:m', effort: 'low' }], previous, latest)).toEqual([
      { key: 'gw:m', effort: 'low' },
      { key: 'other:m', effort: 'high' },
    ])
  })

  it('does not resurrect a route the user deleted', () => {
    // 回归保护：把 latest 全量并回行视图会让"删除"变成"键仍在行中"，
    // 重试保存时差异为空，该路由再也删不掉。
    const previous = { 'gw:m': 'low', gone: 'high' }
    const latest = { 'gw:m': 'low', gone: 'high' }

    const merged = mergeStoredRows([{ key: 'gw:m', effort: 'low' }], previous, latest)
    expect(merged).toEqual([{ key: 'gw:m', effort: 'low' }])
    expect(buildRouteOps(latest, merged)).toEqual([{ op: 'unset', path: ['defaults', 'gone'] }])
  })

  it('does not resurrect the old key of a rename', () => {
    const previous = { 'gw:old': 'high' }
    const latest = { 'gw:old': 'high' }

    const merged = mergeStoredRows([{ key: 'gw:new', effort: 'high' }], previous, latest)
    expect(merged).toEqual([{ key: 'gw:new', effort: 'high' }])
    expect(buildRouteOps(latest, merged)).toEqual([
      { op: 'set', path: ['defaults', 'gw:new'], value: 'high' },
      { op: 'unset', path: ['defaults', 'gw:old'] },
    ])
  })

  it('keeps the user edits and sorts keys with blank residue last', () => {
    const previous = { a: 'low' }
    const latest = { a: 'low', b: 'high' }

    const rows: RouteRow[] = [
      { key: 'z', effort: 'max' },
      { key: '', effort: 'medium' },
    ]
    expect(mergeStoredRows(rows, previous, latest)).toEqual([
      { key: 'b', effort: 'high' },
      { key: 'z', effort: 'max' },
      { key: '', effort: 'medium' },
    ])
  })

  it('does not duplicate a key already present in the edited rows', () => {
    const previous = { a: 'low' }
    const latest = { a: 'low', b: 'high' }

    expect(mergeStoredRows([{ key: 'b', effort: 'max' }], previous, latest)).toEqual([
      { key: 'b', effort: 'max' },
    ])
  })
})
