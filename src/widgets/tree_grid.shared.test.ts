// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { FocusManager } from '../core/focus_manager'
import { InputComposer } from '../core/input_composer'
import { PopupManager } from '../core/popup_manager'
import { TextMeasurer } from '../core/text_measurer'
import { PaintContext } from '../rendering/paint_context'
import { DrawList } from '../rendering/draw_list'
import { deriveGridCellStyle, resolveBgColor } from '../theme/component_styles'
import { ImGuiDarkTheme } from '../theme/default_theme'
import type { GridColumnDef } from './grid_view'
import { RenderTreeGrid, type TreeGridNode } from './tree_grid'
import { RenderTextBox } from './text_field'
import { RenderStackPanel } from '../layout/render_flex'
import { EventDispatcher } from '../gestures/recognizers'

interface DemoRow {
  name: string
  code: string
  category: string
  count: number
  active: boolean
}

interface NodeLikeRow {
  key: string
  row: { label: string }
  name: string
}

const columns: GridColumnDef<DemoRow>[] = [
  { type: 'text', key: 'name', title: '名称', width: 220, sortable: true, fixed: true },
  { type: 'text', key: 'code', title: '编码', width: 100, sortable: true },
  { type: 'text', key: 'category', title: '类别', width: 120, sortable: true },
  { type: 'number', key: 'count', title: '数量', width: 80, sortable: true, align: 'right' },
  { type: 'checkbox', key: 'active', title: '启用', width: 60, sortable: true, align: 'center' },
]

const nodeLikeColumns: GridColumnDef<NodeLikeRow>[] = [
  { type: 'text', key: 'name', title: '名称', width: 160, editable: true },
  { type: 'text', key: 'key', title: '业务键', width: 120, editable: true },
]

function createRoots(): TreeGridNode<DemoRow>[] {
  return [
    {
      key: 'root-a',
      row: { name: '检验', code: 'LAB', category: '目录', count: 6, active: true },
      children: [
        {
          key: 'a-chem',
          row: { name: '生化', code: 'LAB-BIO', category: '分类', count: 4, active: true },
          checkable: false,
          selectable: false,
          children: [
            { key: 'a-alt', row: { name: 'ALT', code: 'LAB001', category: '项目', count: 2, active: true } },
            { key: 'a-ast', row: { name: 'AST', code: 'LAB002', category: '项目', count: 1, active: false } },
          ],
        },
        {
          key: 'a-blood',
          row: { name: 'Standard item', code: 'LAB-CBC', category: '分类', count: 2, active: true },
          selectable: false,
          children: [
            { key: 'a-wbc', row: { name: '白细胞', code: 'LAB101', category: '项目', count: 1, active: true } },
          ],
        },
      ],
    },
    {
      key: 'root-b',
      row: { name: '影像', code: 'SKU', category: '目录', count: 5, active: true },
      children: [
        {
          key: 'b-ct',
          row: { name: 'CT', code: 'SKU-CT', category: '分类', count: 3, active: true },
          children: [
            { key: 'b-head', row: { name: 'Alpha product', code: 'SKU301', category: '项目', count: 3, active: true } },
            { key: 'b-chest', row: { name: 'Beta product', code: 'SKU302', category: '项目', count: 2, active: true } },
          ],
        },
      ],
    },
  ]
}

function createFlatRoots(count: number): TreeGridNode<DemoRow>[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `flat-${index}`,
    row: {
      name: `项目 ${index}`,
      code: `CODE-${index}`,
      category: '项目',
      count: index,
      active: true,
    },
  }))
}

function layout<T extends Record<string, any>>(grid: RenderTreeGrid<T>, width = 360, height = 180): void {
  grid.layout({ minWidth: 0, maxWidth: width, minHeight: 0, maxHeight: height }, false, { theme: ImGuiDarkTheme })
}

function paintTreeGrid<T extends Record<string, any>>(grid: RenderTreeGrid<T>): string[] {
  const textCalls: string[] = []
  let fillStyle: unknown = ''
  let strokeStyle: unknown = ''
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn((value) => {
      textCalls.push(String(value))
    }),
    measureText: vi.fn(text => ({ width: Array.from(String(text)).length * 8 }) as TextMetrics),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    set fillStyle(value: unknown) { fillStyle = value },
    get fillStyle() { return fillStyle as string },
    set strokeStyle(value: unknown) { strokeStyle = value },
    get strokeStyle() { return strokeStyle as string },
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D
  grid.paint(new PaintContext(ctx, ImGuiDarkTheme), { x: 0, y: 0 })
  return textCalls
}

function inputElement(): HTMLTextAreaElement {
  const ta = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement | null
  if (!ta) throw new Error('InputComposer textarea was not created')
  return ta
}

function headerClick(grid: RenderTreeGrid<DemoRow>, colIndex: number): void {
  const viewport = (grid as any)._viewport
  const x = viewport.cellX(grid.columns, grid.globalOffset.x, colIndex) + 20
  ;(grid as any)._toggleSortAt(x)
}

function visibleNodeAt(grid: RenderTreeGrid<DemoRow>, index: number): TreeGridNode<DemoRow> {
  const node = grid.getVisibleNodes()[index]
  if (!node) throw new Error(`Missing visible tree node ${index}`)
  return node
}

afterEach(() => {
  PopupManager.instance.dispose()
  InputComposer.instance.dispose()
  FocusManager.disposeInstance()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('RenderTreeGrid', () => {
  it('paints built-in icon names as glyphs and preserves text icon fallback', () => {
    class MockPath2D {
      constructor(readonly data: string) {}
    }
    vi.stubGlobal('Path2D', MockPath2D)
    const grid = new RenderTreeGrid({
      columns,
      roots: [
        { key: 'built-in', row: { name: 'Built in', code: 'A', category: 'Type', count: 1, active: true }, icon: 'folder' },
        { key: 'text', row: { name: 'Text', code: 'B', category: 'Type', count: 1, active: true }, icon: '📁' },
      ],
      treeColumnKey: 'name',
      rowHeight: 24,
      headerHeight: 24,
    })
    layout(grid, 360, 100)

    const textValues = paintTreeGrid(grid)

    expect(textValues).not.toContain('folder')
    expect(textValues).toContain('📁')
    expect(textValues).toEqual(expect.arrayContaining(['Built in', 'Text']))
    grid.dispose()
  })

  it('refreshes its instance lookup index after a same-length option update', () => {
    const lookupRows = [{ code: 'A', name: 'Alpha' }]
    const lookupColumns: GridColumnDef<Record<string, any>>[] = [{
      type: 'text',
      key: 'itemCode',
      title: 'Item',
      width: 180,
      editor: {
        kind: 'lookup',
        columns: [{ key: 'name', title: 'Name' }],
        rows: lookupRows,
        valueKey: 'code',
        labelKey: 'name',
      },
    }]
    const roots: TreeGridNode<Record<string, any>>[] = [{ key: 'row', row: { itemCode: 'A' } }]
    const grid = new RenderTreeGrid({ columns: lookupColumns, roots, treeColumnKey: 'itemCode' })
    layout(grid, 240, 80)
    expect(paintTreeGrid(grid)).toContain('Alpha')

    lookupRows[0] = { code: 'B', name: 'Beta' }
    roots[0]!.row.itemCode = 'B'
    expect(grid.refreshLookup('itemCode')).toBe(true)
    expect(grid.refreshLookup('missing')).toBe(false)
    expect(paintTreeGrid(grid)).toContain('Beta')
    grid.dispose()
  })

  it('does not let measure layout clamp the real scroll state', () => {
    const grid = new RenderTreeGrid({
      columns,
      roots: createFlatRoots(40),
      treeColumnKey: 'name',
      rowHeight: 20,
      headerHeight: 20,
    })

    layout(grid, 360, 90)
    grid.onWheel({ pointerId: 0, position: { x: 20, y: 60 }, type: 'wheel', deltaX: 0, deltaY: 1 })
    const before = grid.debugState().scrollY

    grid.measure({ minWidth: 0, maxWidth: 360, minHeight: 0, maxHeight: 900 }, { theme: ImGuiDarkTheme })

    expect(before).toBeGreaterThan(0)
    expect(grid.debugState().scrollY).toBe(before)
  })

  it('exposes selected tree grid cell text for generic copy handling', () => {
    const grid = new RenderTreeGrid({
      columns: [
        { type: 'text', key: 'name', title: 'Name', width: 120 },
        { type: 'number', key: 'count', title: 'Count', width: 80 },
      ],
      roots: [{ key: 'root', row: { name: 'Root', count: 7 } }],
      treeColumnKey: 'name',
      rowHeight: 20,
      headerHeight: 20,
    })
    layout(grid, 240, 80)
    FocusManager.instance.setFocus(grid)

    expect(grid.getCopyText()).toBe('Root')

    grid.dispose()
  })

  it('ellipsizes overflowing body cell text and exposes the full text as tooltip', () => {
    vi.spyOn(TextMeasurer, 'measureWidth').mockImplementation(text => Array.from(String(text)).length * 8)
    const grid = new RenderTreeGrid({
      columns: [{ type: 'text', key: 'name', title: 'Name', width: 56 }],
      roots: [{ key: 'root', row: { name: 'Alphabet' } }],
      treeColumnKey: 'name',
      rowHeight: 20,
      headerHeight: 20,
    })

    layout(grid, 100, 60)
    const textCalls = paintTreeGrid(grid)

    expect(textCalls.some(text => text.endsWith('...'))).toBe(true)
    expect(textCalls).not.toContain('Alphabet')

    grid.onPointerMove({ pointerId: 0, position: { x: 10, y: 30 }, type: 'move' })
    expect(grid.tooltip).toBe('Alphabet')

    grid.onPointerLeave({ pointerId: 0, position: { x: 120, y: 30 }, type: 'move' })
    expect(grid.tooltip).toBeUndefined()
  })

  it('ellipsizes overflowing header text', () => {
    vi.spyOn(TextMeasurer, 'measureWidth').mockImplementation(text => Array.from(String(text)).length * 8)
    const grid = new RenderTreeGrid({
      columns: [{ type: 'text', key: 'name', title: 'Alphabet', width: 56 }],
      roots: [],
      treeColumnKey: 'name',
      rowHeight: 20,
      headerHeight: 20,
    })

    layout(grid, 100, 40)
    const textCalls = paintTreeGrid(grid)

    expect(textCalls).toContain('A...')
    expect(textCalls).not.toContain('Alphabet')
  })

  it('keeps clipped body text when tree grid overflow is configured as clip', () => {
    vi.spyOn(TextMeasurer, 'measureWidth').mockImplementation(text => Array.from(String(text)).length * 8)
    const grid = new RenderTreeGrid({
      columns: [{ type: 'text', key: 'name', title: 'Name', width: 56 }],
      roots: [{ key: 'root', row: { name: 'Alphabet' } }],
      treeColumnKey: 'name',
      rowHeight: 20,
      headerHeight: 20,
      cellTextOverflow: 'clip',
    })

    layout(grid, 100, 60)
    const textCalls = paintTreeGrid(grid)

    expect(textCalls).toContain('Alphabet')
    expect(textCalls.some(text => text.endsWith('...'))).toBe(false)
  })

  it('applies height constraints on the tree grid itself', () => {
    const grid = new RenderTreeGrid({
      columns,
      roots: createRoots(),
      treeColumnKey: 'name',
      height: 220,
      minHeight: 160,
      maxHeight: 300,
    })

    grid.layout({ minWidth: 0, maxWidth: 360, minHeight: 0, maxHeight: Infinity }, false, { theme: ImGuiDarkTheme })

    expect(grid.height).toBe(220)
    expect(grid.size.height).toBe(220)
    expect((grid as any)._viewport.size.height).toBe(220)

    grid.height = undefined
    grid.maxHeight = undefined
    grid.minHeight = 520
    grid.layout({ minWidth: 0, maxWidth: 360, minHeight: 0, maxHeight: Infinity }, false, { theme: ImGuiDarkTheme })
    expect(grid.size.height).toBe(520)

    grid.minHeight = undefined
    grid.maxHeight = 180
    grid.layout({ minWidth: 0, maxWidth: 360, minHeight: 0, maxHeight: Infinity }, false, { theme: ImGuiDarkTheme })
    expect(grid.size.height).toBe(180)

    grid.layout({ minWidth: 0, maxWidth: 360, minHeight: 0, maxHeight: 140 }, false, { theme: ImGuiDarkTheme })
    expect(grid.size.height).toBe(140)
    expect((grid as any)._viewport.size.height).toBe(140)
  })

  it('builds visible items from the hierarchical roots and toggles expansion', () => {
    const grid = new RenderTreeGrid({
      columns,
      roots: createRoots(),
      treeColumnKey: 'name',
      defaultExpandedKeys: ['root-a'],
    })
    layout(grid)

    expect(grid.debugState().visibleKeys).toEqual([
      'root-a',
      'a-chem',
      'a-blood',
      'root-b',
    ])

    grid.expandAll()

    expect(grid.debugState().visibleKeys).toEqual([
      'root-a',
      'a-chem',
      'a-alt',
      'a-ast',
      'a-blood',
      'a-wbc',
      'root-b',
      'b-ct',
      'b-head',
      'b-chest',
    ])
  })

  it('does not toggle a non-selectable parent from a normal row click', () => {
    const grid = new RenderTreeGrid({
      columns,
      roots: createRoots(),
      treeColumnKey: 'name',
      defaultExpandedKeys: ['root-a'],
      rowHeight: 20,
      headerHeight: 20,
    })
    layout(grid, 360, 120)

    grid.onPointerDown({
      pointerId: 1,
      type: 'down',
      position: { x: 250, y: 50 },
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
    })

    expect(grid.debugState().visibleKeys).toEqual([
      'root-a',
      'a-chem',
      'a-blood',
      'root-b',
    ])

    grid.onDoubleClick({ x: 250, y: 50 })

    expect(grid.debugState().visibleKeys).toEqual([
      'root-a',
      'a-chem',
      'a-alt',
      'a-ast',
      'a-blood',
      'root-b',
    ])
  })

  it('does not apply row double-click activation after double-clicking the expand arrow', () => {
    const grid = new RenderTreeGrid({
      columns,
      roots: createRoots(),
      treeColumnKey: 'name',
      defaultExpandedKeys: ['root-a'],
      rowHeight: 20,
      headerHeight: 20,
    })
    layout(grid, 360, 120)

    grid.onPointerDown({
      pointerId: 1,
      type: 'down',
      position: { x: 40, y: 50 },
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
    })
    grid.onPointerDown({
      pointerId: 1,
      type: 'down',
      position: { x: 40, y: 50 },
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
    })

    const visibleKeysAfterTwoArrowClicks = grid.debugState().visibleKeys
    grid.onDoubleClick({ x: 40, y: 50 })

    expect(grid.debugState().visibleKeys).toEqual(visibleKeysAfterTwoArrowClicks)
  })

  it('marks layout dirty when visible rows change', () => {
    const grid = new RenderTreeGrid({
      columns,
      roots: createRoots(),
      treeColumnKey: 'name',
      defaultExpandedKeys: ['root-a'],
    })
    layout(grid)
    expect(grid.needsLayout).toBe(false)

    grid.expandAll()

    expect(grid.needsLayout).toBe(true)
  })

  it('filters rows while preserving matching ancestors and auto-expanding the path', () => {
    const grid = new RenderTreeGrid({
      columns,
      roots: createRoots(),
      treeColumnKey: 'name',
    })
    layout(grid)

    grid.setFilterValue('name', 'Alpha')

    expect(grid.debugState().visibleKeys).toEqual(['root-b', 'b-ct', 'b-head'])
  })

  it('sorts siblings by the selected column without flattening the hierarchy', () => {
    const grid = new RenderTreeGrid({
      columns,
      roots: createRoots(),
      treeColumnKey: 'name',
      defaultExpandedKeys: ['root-a', 'root-b', 'b-ct'],
    })
    layout(grid, 720, 180)

    headerClick(grid, 3)

    expect(grid.sortState).toEqual({ key: 'count', order: 'asc' })
    expect(grid.debugState().visibleKeys).toEqual([
      'root-b',
      'b-ct',
      'b-chest',
      'b-head',
      'root-a',
      'a-blood',
      'a-chem',
    ])
  })

  it('uses canonical minute precision for time display sorting and edits', () => {
    interface TimeRow {
      name: string
      at: string
    }
    const timeRoots: TreeGridNode<TimeRow>[] = [
      { key: 'late-seconds', row: { name: 'A', at: '08:30:45' } },
      { key: 'minute', row: { name: 'B', at: '08:30' } },
      { key: 'next-minute', row: { name: 'C', at: '08:31:00' } },
    ]
    const grid = new RenderTreeGrid<TimeRow>({
      columns: [
        { key: 'name', title: 'Name', type: 'text', width: 100 },
        {
          key: 'at',
          title: 'At',
          type: 'time',
          precision: 'minute',
          width: 100,
          sortable: true,
        },
      ],
      roots: timeRoots,
      treeColumnKey: 'name',
      editable: true,
    })
    layout(grid)

    expect(grid.beginEdit(0, 'at')).toBe(true)
    expect(grid.editingCell?.text).toBe('08:30')
    grid.cancelEdit()

    grid.setFilterValue('at', '45')
    expect(grid.debugState().visibleKeys).toEqual([])
    grid.setFilterValue('at', '08:30')
    expect(grid.debugState().visibleKeys).toEqual([
      'late-seconds',
      'minute',
    ])
    grid.clearAllFilters()

    grid.sortState = { key: 'at', order: 'asc' }
    expect(grid.debugState().visibleKeys).toEqual([
      'late-seconds',
      'minute',
      'next-minute',
    ])
    const paintedText = paintTreeGrid(grid)
    expect(paintedText).toContain('08:30')
    expect(paintedText).not.toContain('08:30:45')

    expect(grid.structureEditing.commitVisibleCell(0, 1, '09:15:59')).toBe(true)
    expect(timeRoots[0]!.row.at).toBe('09:15')

    grid.dispose()
  })

  it('cascades check state and exposes only checked leaves', () => {
    const onCheck = vi.fn()
    const grid = new RenderTreeGrid({
      columns,
      roots: createRoots(),
      treeColumnKey: 'name',
      selectionMode: 'check',
      defaultExpandedKeys: ['root-a', 'a-chem'],
      onCheck,
    })
    layout(grid)

    const viewport = (grid as any)._viewport
    const item = (grid as any)._visibleItems[1]
    const cellRect = viewport.cellGlobalRect(grid.columns, grid.globalOffset, 1, 0)
    const treeLayout = (grid as any)._treeCellLayout(item, cellRect.x, cellRect.y, ImGuiDarkTheme, deriveGridCellStyle(ImGuiDarkTheme))
    const checkboxRect = treeLayout.checkboxRect
    expect(checkboxRect).toBeNull()

    const leafItem = (grid as any)._visibleItems[2]
    const leafRect = viewport.cellGlobalRect(grid.columns, grid.globalOffset, 2, 0)
    const leafLayout = (grid as any)._treeCellLayout(leafItem, leafRect.x, leafRect.y, ImGuiDarkTheme, deriveGridCellStyle(ImGuiDarkTheme))
    const leafCheckboxRect = leafLayout.checkboxRect
    expect(leafCheckboxRect).toBeTruthy()

    grid.onPointerDown({
      pointerId: 0,
      type: 'down',
      position: { x: leafCheckboxRect.x + 2, y: leafCheckboxRect.y + 2 },
    })

    expect(grid.checkedKeys).toEqual(['a-alt'])
    expect(grid.halfCheckedKeys).toContain('root-a')
    expect(onCheck).toHaveBeenCalledWith(expect.objectContaining({
      checkedKeys: ['a-alt'],
      toggledNode: expect.objectContaining({ key: 'a-alt' }),
    }))
  })

  it('reveals deep nodes by expanding ancestors and scrolling them into view', () => {
    const grid = new RenderTreeGrid({
      columns,
      roots: createRoots(),
      treeColumnKey: 'name',
    })
    layout(grid, 340, 90)

    grid.revealNode('b-head')

    expect(grid.debugState().visibleKeys).toContain('b-head')
    expect(grid.debugState().scrollY).toBeGreaterThan(0)
  })

  it('captures scrollbar drags and stops parent scroll gestures', () => {
    const grid = new RenderTreeGrid({
      columns,
      roots: createRoots(),
      treeColumnKey: 'name',
      defaultExpandedKeys: ['root-a', 'a-chem', 'a-blood', 'root-b', 'b-ct'],
    })
    layout(grid, 340, 90)
    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    const stopPropagation = vi.fn()
    const viewport = (grid as any)._viewport
    const scrollbarX = grid.size.width - 7
    const scrollbarY = viewport.headerHeight + 10

    grid.onPointerDown({
      pointerId: 1,
      type: 'down',
      position: { x: scrollbarX, y: scrollbarY },
      setPointerCapture,
      releasePointerCapture,
      stopPropagation,
    })
    grid.onPointerMove({
      pointerId: 1,
      type: 'move',
      position: { x: scrollbarX, y: scrollbarY + 30 },
      stopPropagation,
    })
    grid.onPointerUp({
      pointerId: 1,
      type: 'up',
      position: { x: scrollbarX, y: scrollbarY + 30 },
      releasePointerCapture,
      stopPropagation,
    })

    expect(setPointerCapture).toHaveBeenCalledTimes(1)
    expect(releasePointerCapture).toHaveBeenCalledTimes(1)
    expect(stopPropagation).toHaveBeenCalled()
    expect(grid.debugState().scrollY).toBeGreaterThan(0)
  })

  it('keeps a resize owned by touch zero when mouse zero moves or terminates', () => {
    const sourceColumns: GridColumnDef<DemoRow>[] = [
      { type: 'text', key: 'name', title: '名称', width: 220, sortable: true, fixed: true },
      { type: 'text', key: 'code', title: '编码', width: 100, sortable: true, minWidth: 60 },
      { type: 'text', key: 'category', title: '类别', width: 120, sortable: true },
    ]
    const grid = new RenderTreeGrid<DemoRow>({
      columns: sourceColumns,
      roots: createFlatRoots(3),
      treeColumnKey: 'name',
      rowHeight: 20,
      headerHeight: 20,
    })
    layout(grid, 520, 160)
    const ownerSetPointerCapture = vi.fn()
    const ownerReleasePointerCapture = vi.fn()
    const foreignSetPointerCapture = vi.fn()
    const foreignReleasePointerCapture = vi.fn()
    const foreignPreventActivation = vi.fn()
    const ownerTerminalReleasePointerCapture = vi.fn()

    grid.onPointerDown({
      pointerId: 0,
      pointerType: 'touch',
      type: 'down',
      button: 0,
      position: { x: 320, y: 10 },
      setPointerCapture: ownerSetPointerCapture,
      releasePointerCapture: ownerReleasePointerCapture,
    })
    grid.onPointerDown({
      pointerId: 0,
      pointerType: 'mouse',
      type: 'down',
      button: 0,
      position: { x: 440, y: 10 },
      setPointerCapture: foreignSetPointerCapture,
      releasePointerCapture: foreignReleasePointerCapture,
      preventActivation: foreignPreventActivation,
    })
    grid.onPointerMove({
      pointerId: 0,
      pointerType: 'mouse',
      type: 'move',
      position: { x: 400, y: 10 },
    })
    grid.onPointerUp({
      pointerId: 0,
      pointerType: 'mouse',
      type: 'up',
      button: 0,
      position: { x: 400, y: 10 },
      releasePointerCapture: foreignReleasePointerCapture,
    })
    grid.onPointerCancel({
      pointerId: 0,
      pointerType: 'mouse',
      type: 'cancel',
      position: { x: 400, y: 10 },
      releasePointerCapture: foreignReleasePointerCapture,
    })

    expect((grid as any)._viewport.resizingCol).toBe(1)
    expect((grid as any)._viewport.resizeStartX).toBe(320)
    expect((grid as any)._viewport.resizeCurrentX).toBe(320)
    expect(grid.columns[1]).toMatchObject({ width: 100 })
    expect(foreignSetPointerCapture).not.toHaveBeenCalled()
    expect(foreignReleasePointerCapture).not.toHaveBeenCalled()
    expect(foreignPreventActivation).toHaveBeenCalledTimes(1)

    grid.onPointerMove({
      pointerId: 0,
      pointerType: 'touch',
      type: 'move',
      position: { x: 350, y: 10 },
    })
    grid.onPointerUp({
      pointerId: 0,
      pointerType: 'touch',
      type: 'up',
      button: 0,
      position: { x: 350, y: 10 },
      releasePointerCapture: ownerTerminalReleasePointerCapture,
    })

    expect(ownerSetPointerCapture).toHaveBeenCalledTimes(1)
    expect(ownerReleasePointerCapture).toHaveBeenCalledTimes(1)
    expect(ownerTerminalReleasePointerCapture).not.toHaveBeenCalled()
    expect(grid.columns[1]).toMatchObject({ width: 130, widthMode: 'interactive' })
    expect((grid as any)._viewport.resizingCol).toBe(-1)
    expect((grid as any)._dragPointerKey).toBeUndefined()

    grid.dispose()
  })

  it('clears resize ownership before rethrowing a layout notification error and accepts the next sequence', () => {
    const sourceColumns: GridColumnDef<DemoRow>[] = [
      { type: 'text', key: 'name', title: '名称', width: 220, sortable: true, fixed: true },
      { type: 'text', key: 'code', title: '编码', width: 100, sortable: true, minWidth: 60 },
      { type: 'text', key: 'category', title: '类别', width: 120, sortable: true },
    ]
    const grid = new RenderTreeGrid<DemoRow>({
      columns: sourceColumns,
      roots: createFlatRoots(3),
      treeColumnKey: 'name',
      rowHeight: 20,
      headerHeight: 20,
    })
    layout(grid, 520, 160)
    const firstReleasePointerCapture = vi.fn()
    const error = new Error('layout failed')
    const markNeedsLayout = grid.markNeedsLayout.bind(grid)
    const markNeedsLayoutSpy = vi.spyOn(grid, 'markNeedsLayout')
      .mockImplementationOnce(() => {
        throw error
      })
      .mockImplementation(markNeedsLayout)

    grid.onPointerDown({
      pointerId: 1,
      pointerType: 'touch',
      type: 'down',
      button: 0,
      position: { x: 320, y: 10 },
      setPointerCapture: vi.fn(),
      releasePointerCapture: firstReleasePointerCapture,
    })

    expect(() => grid.onPointerUp({
      pointerId: 1,
      pointerType: 'touch',
      type: 'up',
      button: 0,
      position: { x: 350, y: 10 },
    })).toThrow(error)

    expect(firstReleasePointerCapture).toHaveBeenCalledOnce()
    expect((grid as any)._dragPointerKey).toBeUndefined()
    expect((grid as any)._viewport.resizingCol).toBe(-1)
    expect((grid as any)._viewport.vScrollbar.dragging).toBe(false)
    expect((grid as any)._viewport.hScrollbar.dragging).toBe(false)
    expect(grid.columns[1]).toMatchObject({ width: 130, widthMode: 'interactive' })

    layout(grid, 520, 160)
    const nextSetPointerCapture = vi.fn()
    grid.onPointerDown({
      pointerId: 2,
      pointerType: 'mouse',
      type: 'down',
      button: 0,
      position: { x: 350, y: 10 },
      setPointerCapture: nextSetPointerCapture,
      releasePointerCapture: vi.fn(),
    })
    grid.onPointerUp({
      pointerId: 2,
      pointerType: 'mouse',
      type: 'up',
      button: 0,
      position: { x: 360, y: 10 },
    })

    expect(nextSetPointerCapture).toHaveBeenCalledOnce()
    expect(grid.columns[1]).toMatchObject({ width: 140, widthMode: 'interactive' })
    expect((grid as any)._dragPointerKey).toBeUndefined()

    markNeedsLayoutSpy.mockRestore()
    grid.dispose()
  })

  it('contains wheel events at scroll boundaries when the tree grid overflows', () => {
    const grid = new RenderTreeGrid({
      columns,
      roots: createRoots(),
      treeColumnKey: 'name',
      defaultExpandedKeys: ['root-a', 'a-chem', 'a-blood', 'root-b', 'b-ct'],
    })
    layout(grid, 340, 90)

    const topConsumed = grid.onWheel({
      pointerId: 0,
      position: { x: 20, y: 60 },
      type: 'wheel',
      deltaX: 0,
      deltaY: -1,
    })
    expect(topConsumed).toBe(true)
    expect(grid.debugState().scrollY).toBe(0)

    for (let i = 0; i < 20; i++) {
      grid.onWheel({ pointerId: 0, position: { x: 20, y: 60 }, type: 'wheel', deltaX: 0, deltaY: 1 })
    }
    const bottom = grid.debugState().scrollY
    const bottomConsumed = grid.onWheel({
      pointerId: 0,
      position: { x: 20, y: 60 },
      type: 'wheel',
      deltaX: 0,
      deltaY: 1,
    })

    expect(bottomConsumed).toBe(true)
    expect(grid.debugState().scrollY).toBe(bottom)
  })

  it('does not jump scroll when first clicking a visible row after wheel scrolling', () => {
    const grid = new RenderTreeGrid({
      columns,
      roots: createFlatRoots(40),
      treeColumnKey: 'name',
      rowHeight: 20,
      headerHeight: 20,
      sortable: false,
      resizableColumns: false,
    })
    layout(grid, 340, 100)

    for (let i = 0; i < 3; i++) {
      grid.onWheel({ pointerId: 0, position: { x: 20, y: 60 }, type: 'wheel', deltaX: 0, deltaY: 1 })
    }
    const scrollBeforeClick = grid.debugState().scrollY
    expect(scrollBeforeClick).toBeGreaterThan(0)

    grid.onPointerDown({
      pointerId: 1,
      type: 'down',
      position: { x: 20, y: 60 },
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
    })

    expect(grid.debugState().scrollY).toBe(scrollBeforeClick)
    expect(grid.debugState().selectedKey).toBe('flat-11')
  })

  it('does not jump scroll when first clicking a visible checked tree grid row', () => {
    const grid = new RenderTreeGrid({
      columns,
      roots: createFlatRoots(40),
      treeColumnKey: 'name',
      selectionMode: 'check',
      defaultCheckedKeys: ['flat-0'],
      rowHeight: 20,
      headerHeight: 20,
      sortable: false,
      resizableColumns: false,
    })
    layout(grid, 340, 100)

    for (let i = 0; i < 3; i++) {
      grid.onWheel({ pointerId: 0, position: { x: 20, y: 60 }, type: 'wheel', deltaX: 0, deltaY: 1 })
    }
    const scrollBeforeClick = grid.debugState().scrollY
    expect(scrollBeforeClick).toBeGreaterThan(0)

    grid.onPointerDown({
      pointerId: 1,
      type: 'down',
      position: { x: 120, y: 60 },
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
    })

    expect(grid.debugState().scrollY).toBe(scrollBeforeClick)
    expect(grid.debugState().focusedItemIndex).toBe(11)
    expect(grid.debugState().checkedKeys).toEqual(['flat-0'])
  })

  it('persists drag-resized column width across layout and cell clicks without mutating source columns', () => {
    const sourceColumns: GridColumnDef<DemoRow>[] = [
      { type: 'text', key: 'name', title: '名称', width: 220, sortable: true, fixed: true },
      { type: 'text', key: 'code', title: '编码', width: 100, sortable: true, minWidth: 60 },
      { type: 'text', key: 'category', title: '类别', width: 120, sortable: true },
    ]
    const originalCodeColumn = { ...sourceColumns[1]! }
    const grid = new RenderTreeGrid<DemoRow>({
      columns: sourceColumns,
      roots: createFlatRoots(3),
      treeColumnKey: 'name',
      rowHeight: 20,
      headerHeight: 20,
    })
    layout(grid, 520, 160)

    grid.onPointerDown({ pointerId: 0, position: { x: 320, y: 10 }, type: 'down' })
    grid.onPointerMove({ pointerId: 0, position: { x: 350, y: 10 }, type: 'move' })

    expect((grid as any)._viewport.colWidths[1]).toBe(100)
    expect(sourceColumns[1]).toEqual(originalCodeColumn)

    grid.onPointerUp({ pointerId: 0, position: { x: 350, y: 10 }, type: 'up' })

    expect(grid.needsLayout).toBe(true)

    layout(grid, 520, 160)

    expect(sourceColumns[1]).toEqual(originalCodeColumn)
    expect(grid.columns[1]).toMatchObject({ width: 130, widthMode: 'interactive' })
    expect((grid as any)._viewport.colWidths[1]).toBe(130)

    grid.onPointerDown({ pointerId: 0, position: { x: 260, y: 30 }, type: 'down' })
    layout(grid, 520, 160)

    expect((grid as any)._viewport.colWidths[1]).toBe(130)

    grid.dispose()
  })

  it('resizes the last tree grid column from its right header edge', () => {
    const sourceColumns: GridColumnDef<DemoRow>[] = [
      { type: 'text', key: 'name', title: '名称', width: 220, sortable: true, fixed: true },
      { type: 'text', key: 'code', title: '编码', width: 100, sortable: true },
      { type: 'text', key: 'category', title: '类别', width: 120, sortable: true, minWidth: 80 },
    ]
    const originalCategoryColumn = { ...sourceColumns[2]! }
    const grid = new RenderTreeGrid<DemoRow>({
      columns: sourceColumns,
      roots: createFlatRoots(3),
      treeColumnKey: 'name',
      rowHeight: 20,
      headerHeight: 20,
    })
    layout(grid, 520, 160)

    grid.onPointerDown({ pointerId: 0, position: { x: 440, y: 10 }, type: 'down' })
    grid.onPointerMove({ pointerId: 0, position: { x: 470, y: 10 }, type: 'move' })
    grid.onPointerUp({ pointerId: 0, position: { x: 470, y: 10 }, type: 'up' })
    layout(grid, 520, 160)

    expect(sourceColumns[2]).toEqual(originalCategoryColumn)
    expect(grid.columns[2]).toMatchObject({ width: 150, widthMode: 'interactive' })
    expect((grid as any)._viewport.colWidths[2]).toBe(150)

    grid.dispose()
  })

  it('prioritizes checked nodes over selectedKey when entering focus in check mode', () => {
    const grid = new RenderTreeGrid({
      columns,
      roots: createRoots(),
      treeColumnKey: 'name',
      selectionMode: 'check',
      defaultExpandedKeys: ['root-a', 'a-chem', 'root-b'],
      defaultCheckedKeys: ['a-ast'],
    })
    grid.selectedKey = 'root-b'
    layout(grid)

    grid.focusIn()

    expect(grid.debugState().focusedItemIndex).toBe(grid.debugState().visibleKeys.indexOf('a-ast'))
  })

  it('clears sortState when columns change and the sorted column is no longer available', () => {
    const grid = new RenderTreeGrid({
      columns,
      roots: createRoots(),
      treeColumnKey: 'name',
      defaultExpandedKeys: ['root-a', 'root-b', 'b-ct'],
    })
    layout(grid, 720, 180)
    grid.sortState = { key: 'count', order: 'asc' }

    grid.columns = columns.filter(column => column.key !== 'count')

    expect(grid.sortState).toEqual({ key: '', order: null })
    expect(grid.debugState().visibleKeys).toEqual([
      'root-a',
      'a-chem',
      'a-blood',
      'root-b',
      'b-ct',
      'b-head',
      'b-chest',
    ])
  })

  it('keeps treeColumnKey valid when an unknown key is assigned', () => {
    const grid = new RenderTreeGrid({
      columns,
      roots: createRoots(),
      treeColumnKey: 'name',
    })

    grid.treeColumnKey = 'missing' as keyof DemoRow & string

    expect(grid.treeColumnKey).toBe('name')
  })

  it('exposes object-first selection and focus state', () => {
    const roots = createRoots()
    const grid = new RenderTreeGrid({
      columns,
      roots,
      treeColumnKey: 'name',
      defaultExpandedKeys: ['root-a'],
    })
    layout(grid)

    expect(grid.getVisibleNodes()[1]).toBe(roots[0]!.children![0])
    expect(grid.focusCell(roots[0]!, 'code', { select: true, scroll: false })).toBe(true)

    expect(grid.getSelectionState()).toMatchObject({
      selectedKey: 'root-a',
      selectedNode: roots[0],
      selectedRow: roots[0]!.row,
      focusedNode: roots[0],
      focusedRow: roots[0]!.row,
      focusedKey: 'code',
    })
    expect(grid.getSelectedNode()).toBe(roots[0])
    expect(grid.getSelectedRow()).toBe(roots[0]!.row)
    expect(grid.getFocusedCell()).toMatchObject({
      node: roots[0],
      row: roots[0]!.row,
      key: 'code',
    })
    expect(grid.getFocusedColumn()?.key).toBe('code')
    expect(grid.focusCell(roots[0]!, 'missing' as keyof DemoRow & string, { scroll: false })).toBe(false)
    expect(grid.getFocusedKey()).toBe('code')
  })

  it('focusRow selects and scrolls by default while preserving explicit focus-only mode', () => {
    const roots = createRoots()
    const grid = new RenderTreeGrid({
      columns,
      roots,
      treeColumnKey: 'name',
      defaultExpandedKeys: ['root-a', 'a-chem', 'a-blood', 'root-b', 'b-ct'],
    })
    layout(grid, 360, 80)

    expect(grid.focusRow('b-chest')).toBe(true)
    expect(grid.getSelectionState()).toMatchObject({
      selectedKey: 'b-chest',
      selectedNode: roots[1]!.children![0]!.children![1],
      focusedNode: roots[1]!.children![0]!.children![1],
    })
    expect(grid.debugState().scrollY).toBeGreaterThan(0)

    const previousScrollY = grid.debugState().scrollY
    expect(grid.focusRow('a-alt', { select: false, scroll: false })).toBe(true)
    expect(grid.getSelectionState()).toMatchObject({
      selectedKey: 'b-chest',
      focusedNode: roots[0]!.children![0]!.children![0],
    })
    expect(grid.debugState().scrollY).toBe(previousScrollY)
  })

  it('focusCell does not select by default', () => {
    const roots = createRoots()
    const grid = new RenderTreeGrid({
      columns,
      roots,
      treeColumnKey: 'name',
      defaultExpandedKeys: ['root-a'],
    })
    layout(grid)

    expect(grid.focusCell(roots[0]!, 'code', { scroll: false })).toBe(true)

    expect(grid.getSelectionState()).toMatchObject({
      selectedKey: '',
      selectedNode: null,
      focusedNode: roots[0],
      focusedKey: 'code',
    })
  })

  it('updates filtered-out node objects through setCellValue', () => {
    const roots = createRoots()
    const onCellChange = vi.fn()
    const targetNode = roots[0]!.children![0]!.children![0]!
    const grid = new RenderTreeGrid({
      columns,
      roots,
      treeColumnKey: 'name',
      onCellChange,
    })
    layout(grid)

    grid.setFilterValue('name', 'Renamed')
    expect(grid.getVisibleNodes()).toHaveLength(0)

    expect(grid.setCellValue(targetNode, 'name', 'Renamed')).toBe(true)

    expect(targetNode.row.name).toBe('Renamed')
    expect(grid.debugState().visibleKeys).toEqual(['root-a', 'a-chem', 'a-alt'])
    expect(onCellChange).toHaveBeenCalledWith(targetNode, 'name', 'Renamed')
  })

  it('does not bypass readonly columns when updating filtered-out nodes', () => {
    const roots = createRoots()
    const onCellChange = vi.fn()
    const targetNode = roots[0]!.children![0]!.children![0]!
    const readonlyColumns = columns.map(column =>
      column.key === 'code'
        ? { ...column, editable: false }
        : column,
    )
    const grid = new RenderTreeGrid({
      columns: readonlyColumns,
      roots,
      treeColumnKey: 'name',
      onCellChange,
    })
    layout(grid)

    grid.setFilterValue('name', 'not-matched')
    expect(grid.getVisibleNodes()).toHaveLength(0)

    expect(grid.setCellValue(targetNode, 'code', 'LOCKED')).toBe(false)

    expect(targetNode.row.code).toBe('LAB001')
    expect(onCellChange).not.toHaveBeenCalled()
  })

  it('refreshes externally mutated node rows without visible row indices', () => {
    const roots = createRoots()
    const targetNode = roots[0]!.children![0]!.children![0]!
    const grid = new RenderTreeGrid({
      columns,
      roots,
      treeColumnKey: 'name',
    })
    layout(grid)

    grid.setFilterValue('name', 'Renamed')
    expect(grid.getVisibleNodes()).toHaveLength(0)

    targetNode.row.name = 'Renamed'
    expect(grid.refreshNode(targetNode.row)).toBe(true)

    expect(grid.debugState().visibleKeys).toEqual(['root-a', 'a-chem', 'a-alt'])
  })

  it('refreshes in-place tree structure changes through refreshData', () => {
    const roots = createRoots()
    const grid = new RenderTreeGrid({
      columns,
      roots,
      treeColumnKey: 'name',
      defaultExpandedKeys: ['root-b'],
    })
    layout(grid)

    roots[1]!.children!.push({
      key: 'b-us',
      row: { name: '超声', code: 'SKU-US', category: '分类', count: 2, active: true },
    })
    expect(grid.debugState().visibleKeys).not.toContain('b-us')

    grid.refreshData()

    expect(grid.debugState().visibleKeys).toContain('b-us')
  })

  it('resolves row objects before node-like key fields', () => {
    const roots: TreeGridNode<NodeLikeRow>[] = [
      {
        key: 'tree-root',
        row: {
          key: 'domain-key',
          row: { label: 'payload' },
          name: 'Original',
        },
      },
    ]
    const grid = new RenderTreeGrid({
      columns: nodeLikeColumns,
      roots,
      treeColumnKey: 'name',
      editable: true,
    })
    layout(grid)

    expect(grid.focusCell(roots[0]!.row, 'name', { select: true, scroll: false })).toBe(true)
    expect(grid.getFocusedNode()).toBe(roots[0])
    expect(grid.setCellValue(roots[0]!.row, 'name', 'Updated')).toBe(true)
    expect(roots[0]!.row.name).toBe('Updated')
  })

  it('commits inline text edits through the shared editing controller', () => {
    vi.useFakeTimers()
    vi.spyOn(TextMeasurer, 'measureWidth').mockImplementation(text => text.length * 8)
    const roots = createRoots()
    const onCellChange = vi.fn()
    const grid = new RenderTreeGrid({
      columns,
      roots,
      treeColumnKey: 'name',
      editable: true,
      defaultExpandedKeys: ['root-a'],
      onCellChange,
    })
    layout(grid)

    expect(grid.beginEdit(0, 1)).toBe(true)

    const ta = inputElement()
    ta.value = 'LAB-EDIT'
    ta.dispatchEvent(new Event('input'))
    grid.commitEdit()

    expect(roots[0]!.row.code).toBe('LAB-EDIT')
    expect(onCellChange).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'root-a' }),
      'code',
      'LAB-EDIT',
    )
  })

  it.each(['reorder', 'replace', 'remove'] as const)('cancels the old draft when columns %s', change => {
    const roots = createRoots()
    const before = { ...roots[0]!.row }
    const onCellChange = vi.fn()
    const grid = new RenderTreeGrid({ columns, roots, treeColumnKey: 'name', editable: true, onCellChange })
    layout(grid)
    expect(grid.beginEdit(0, 'code')).toBe(true)
    inputElement().value = 'pending-code'
    inputElement().dispatchEvent(new Event('input'))
    grid.columns = change === 'reorder'
      ? [columns[1]!, columns[0]!, ...columns.slice(2)]
      : change === 'replace'
        ? columns.map(column => ({ ...column }))
        : columns.filter(column => column.key !== 'code')
    expect(grid.editingCell).toBe(null)
    expect(InputComposer.instance.hasSession).toBe(false)
    grid.commitEdit()
    expect(roots[0]!.row).toEqual(before)
    expect(onCellChange).not.toHaveBeenCalled()
    expect(grid.beginEdit(0, 'name')).toBe(true)
    inputElement().value = 'new-name'
    inputElement().dispatchEvent(new Event('input'))
    grid.commitEdit()
    expect(roots[0]!.row.name).toBe('new-name')
    expect(roots[0]!.row.code).toBe(before.code)
    expect(onCellChange).toHaveBeenCalledOnce()
    grid.dispose()
  })

  it('closes a popup editor before replacing its columns', () => {
    const roots = createRoots()
    const popupColumns: GridColumnDef<DemoRow>[] = [columns[0]!, {
      type: 'text', key: 'category', title: '类别', width: 120,
      editor: { kind: 'select', options: [{ value: '目录', label: '目录' }, { value: '项目', label: '项目' }] },
    }]
    const grid = new RenderTreeGrid({ columns: popupColumns, roots, treeColumnKey: 'name', editable: true })
    layout(grid)
    expect(grid.beginEdit(0, 'category')).toBe(true)
    const popup = PopupManager.instance.current!
    expect(PopupManager.instance.stack).toContain(popup)
    grid.columns = [popupColumns[1]!, popupColumns[0]!]
    expect(PopupManager.instance.stack).not.toContain(popup)
    expect(grid.editingCell).toBe(null)
    expect(roots[0]!.row.category).toBe('目录')
    grid.dispose()
  })

  it('commits popup editor selections through the shared popup host', () => {
    const roots = createRoots()
    const onCellChange = vi.fn()
    const popupColumns: GridColumnDef<DemoRow>[] = [
      columns[0]!,
      columns[1]!,
      {
        type: 'text',
        key: 'category',
        title: '类别',
        width: 120,
        editor: {
          kind: 'select',
          options: [
            { value: '目录', label: '目录' },
            { value: '分类', label: '分类' },
            { value: '项目', label: '项目' },
          ],
        },
      },
      columns[3]!,
      columns[4]!,
    ]
    const grid = new RenderTreeGrid({
      columns: popupColumns,
      roots,
      treeColumnKey: 'name',
      editable: true,
      defaultExpandedKeys: ['root-a'],
      onCellChange,
    })
    layout(grid)

    expect(grid.beginEdit(0, 2)).toBe(true)
    const dropdownPopup = PopupManager.instance.current as any

    expect(dropdownPopup).toBeTruthy()
    expect((grid as any)._cellPopupEditors.dropdownPopup.visible).toBe(true)

    dropdownPopup._select({ value: '项目', label: '项目' })

    expect(roots[0]!.row.category).toBe('项目')
    expect(onCellChange).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'root-a' }),
      'category',
      '项目',
    )
    expect((grid as any)._cellPopupEditors.dropdownPopup.visible).toBe(false)
  })

  it('commits text edits from the focused cell and keeps cell focus after Enter', () => {
    vi.useFakeTimers()
    vi.spyOn(TextMeasurer, 'measureWidth').mockImplementation(text => text.length * 8)
    const roots = createRoots()
    const onCellChange = vi.fn()
    const grid = new RenderTreeGrid({
      columns,
      roots,
      treeColumnKey: 'name',
      editable: true,
      defaultExpandedKeys: ['root-a'],
      onCellChange,
    })
    layout(grid)

    FocusManager.instance.setFocus(grid)
    grid.focusCell(visibleNodeAt(grid, 0), 'code', { select: true, scroll: false })

    expect(grid.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true)
    expect(grid.editingCell).toMatchObject({ node: roots[0], row: roots[0]!.row, key: 'code', text: 'LAB' })

    const ta = inputElement()
    ta.value = 'LAB-EDIT'
    ta.dispatchEvent(new Event('input'))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(roots[0]!.row.code).toBe('LAB-EDIT')
    expect(onCellChange).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'root-a' }),
      'code',
      'LAB-EDIT',
    )
    expect(grid.debugState()).toMatchObject({
      focusedItemIndex: 0,
      focusedCol: 1,
      edit: null,
      selectedKey: 'root-a',
    })
    expect(FocusManager.instance.current).toBe(grid)
  })

  it('starts popup editing from the focused cell and keeps focus after selection', () => {
    const roots = createRoots()
    const popupColumns: GridColumnDef<DemoRow>[] = [
      columns[0]!,
      columns[1]!,
      {
        type: 'text',
        key: 'category',
        title: '类别',
        width: 120,
        editor: {
          kind: 'select',
          options: [
            { value: '目录', label: '目录' },
            { value: '分类', label: '分类' },
            { value: '项目', label: '项目' },
          ],
        },
      },
      columns[3]!,
      columns[4]!,
    ]
    const grid = new RenderTreeGrid({
      columns: popupColumns,
      roots,
      treeColumnKey: 'name',
      editable: true,
      defaultExpandedKeys: ['root-a'],
    })
    layout(grid)

    FocusManager.instance.setFocus(grid)
    grid.focusCell(visibleNodeAt(grid, 0), 'category', { select: true, scroll: false })

    expect(grid.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true)
    const dropdownPopup = PopupManager.instance.current as any
    expect(dropdownPopup).toBeTruthy()
    expect(grid.editingCell).toMatchObject({ node: roots[0], row: roots[0]!.row, key: 'category' })

    dropdownPopup._select({ value: '项目', label: '项目' })

    expect(roots[0]!.row.category).toBe('项目')
    expect(grid.debugState()).toMatchObject({
      focusedItemIndex: 0,
      focusedCol: 2,
      edit: null,
      selectedKey: 'root-a',
    })
    expect(FocusManager.instance.current).toBe(grid)

    expect(grid.onKeyDown(new KeyboardEvent('keydown', { key: 'Tab' }))).toBe(true)
    expect(grid.debugState()).toMatchObject({
      focusedItemIndex: 0,
      focusedCol: 3,
      edit: null,
    })
  })

  it('moves focused cells with Tab and Shift+Tab when not editing', () => {
    const grid = new RenderTreeGrid({
      columns,
      roots: createRoots(),
      treeColumnKey: 'name',
      editable: true,
      defaultExpandedKeys: ['root-a'],
    })
    layout(grid)

    FocusManager.instance.setFocus(grid)
    grid.focusCell(0, 1, { select: true, scroll: false })

    expect(grid.onKeyDown(new KeyboardEvent('keydown', { key: 'Tab' }))).toBe(true)
    expect(grid.debugState()).toMatchObject({ focusedItemIndex: 0, focusedCol: 2, edit: null })

    expect(grid.onKeyDown(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }))).toBe(true)
    expect(grid.debugState()).toMatchObject({ focusedItemIndex: 0, focusedCol: 1, edit: null })
  })

  it('passes the active theme and resolved selection background to style callbacks', () => {
    const resolveRowStyle = vi.fn((_args: any) => null)
    const resolveCellStyle = vi.fn((_args: any) => null)
    const grid = new RenderTreeGrid({
      columns,
      roots: createRoots(),
      treeColumnKey: 'name',
      defaultExpandedKeys: ['root-a'],
      resolveRowStyle,
      resolveCellStyle,
    })
    layout(grid)
    grid.selectedKey = 'root-a'

    paintTreeGrid(grid)

    const tokens = deriveGridCellStyle(ImGuiDarkTheme)
    const selectedBackground = resolveBgColor(tokens.rowBgState, 'selected')
    const rowArgs = resolveRowStyle.mock.calls.find(call => call[0].node.key === 'root-a')?.[0]
    const cellArgs = resolveCellStyle.mock.calls.find(call => call[0].node.key === 'root-a')?.[0]
    expect(rowArgs).toEqual(expect.objectContaining({
      theme: ImGuiDarkTheme,
      backgroundColor: selectedBackground,
      selected: true,
    }))
    expect(cellArgs).toEqual(expect.objectContaining({
      theme: ImGuiDarkTheme,
      backgroundColor: selectedBackground,
      selected: true,
    }))
    grid.dispose()
  })

  it('keeps non-editable columns out of the default Tab path', () => {
    const grid = new RenderTreeGrid({
      columns: columns.map(column => column.key === 'name'
        ? { ...column, editable: false }
        : { ...column }),
      roots: createRoots(),
      treeColumnKey: 'name',
      editable: true,
      defaultExpandedKeys: ['root-a'],
    })
    layout(grid)
    grid.focusCell(0, 1, { select: true, scroll: false })

    expect(grid.onKeyDown(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }))).toBe(false)
    expect(grid.debugState()).toMatchObject({ focusedItemIndex: 0, focusedCol: 1, edit: null })
  })

  it('keeps the current numeric value when a visible node receives invalid programmatic input', () => {
    const roots = createRoots()
    const grid = new RenderTreeGrid({
      columns,
      roots,
      treeColumnKey: 'name',
      defaultExpandedKeys: ['root-a'],
    })
    layout(grid)

    expect(grid.setCellValue(roots[0]!, 'count', '12abc')).toBe(false)
    expect(roots[0]!.row.count).toBe(6)
  })

  it('toggles a focused checkbox cell with Enter and Space while keeping cell focus', () => {
    const roots = createRoots()
    const grid = new RenderTreeGrid({
      columns,
      roots,
      treeColumnKey: 'name',
      editable: true,
      defaultExpandedKeys: ['root-a'],
    })
    layout(grid)

    FocusManager.instance.setFocus(grid)
    grid.focusCell(0, 4, { select: true, scroll: false })

    expect(grid.debugState()).toMatchObject({ focusedItemIndex: 0, focusedCol: 4, edit: null })

    expect(grid.onKeyDown(new KeyboardEvent('keydown', { key: ' ' }))).toBe(true)
    expect(roots[0]!.row.active).toBe(false)
    expect(grid.debugState()).toMatchObject({ focusedItemIndex: 0, focusedCol: 4, edit: null })

    expect(grid.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true)
    expect(roots[0]!.row.active).toBe(true)
    expect(grid.debugState()).toMatchObject({ focusedItemIndex: 0, focusedCol: 4, edit: null })
  })
})


describe('TreeGrid border ownership', () => {
  it('does not paint a custom outline for a column clipped to less than its insets', () => {
    const color = { r: 240, g: 0, b: 0, a: 1 }
    const grid = new RenderTreeGrid({
      columns: [
        { key: 'name', title: 'Name', type: 'text', width: 70, pinned: 'left' },
        { key: 'code', title: 'Code', type: 'text', width: 100 },
        { key: 'more', title: 'More', type: 'text', width: 200 },
        { key: 'tail', title: 'Tail', type: 'text', width: 60, pinned: 'right' },
      ],
      roots: [{ key: 'a', row: { name: 'A', code: 'B', more: 'C', tail: 'D' } }],
      treeColumnKey: 'name', resolveCellStyle: ({ column }) => column.key === 'code' ? { borderColor: color } : {},
    })
    grid.layout({ minWidth: 0, maxWidth: 260, minHeight: 0, maxHeight: 160 })
    const viewport = (grid as any)._viewport
    viewport.setScrollX(grid.columns, 98.5)
    expect(viewport.visibleCellRect(grid.columns, 0, 1).w).toBe(1.5)
    const borders = vi.spyOn(DrawList.prototype, 'strokeRect')
    paintTreeGrid(grid)
    expect(borders.mock.calls.filter(call => call[4] === color)).toHaveLength(0)
    grid.dispose()
  })
  it('keeps custom cell fills below shared edges and state borders', () => {
    const color = { r: 200, g: 20, b: 20, a: 1 }
    const grid = new RenderTreeGrid({
      columns: [{ key: 'name', title: 'Name', type: 'text', width: 100 }, { key: 'code', title: 'Code', type: 'text', width: 220 }],
      roots: [0, 1, 2].map(i => ({ key: String(i), row: { name: 'Name', code: String(i) } })),
      treeColumnKey: 'name', rowHeight: 24, headerHeight: 24, editable: true,
      resolveCellStyle: () => ({ backgroundColor: ImGuiDarkTheme.surfaceControl, borderColor: color }),
    })
    grid.layout({ minWidth: 0, maxWidth: 260, minHeight: 0, maxHeight: 160 })
    expect(grid.beginEdit(1, 'code')).toBe(true)
    const fills = vi.spyOn(DrawList.prototype, 'fillRect')
    const borders = vi.spyOn(DrawList.prototype, 'strokeRect')
    const gridLines = vi.spyOn(DrawList.prototype, 'strokeSegments')
    paintTreeGrid(grid)
    expect(borders.mock.calls.filter(call => call[5] === 0.5)).toHaveLength(0)
    const stateOrders = borders.mock.calls.flatMap((call, i) => call[4] === color ? [borders.mock.invocationCallOrder[i]!] : [])
    expect(stateOrders.length).toBeGreaterThan(0)
    expect(Math.min(...stateOrders)).toBeGreaterThan(Math.max(...gridLines.mock.invocationCallOrder))
    expect(borders.mock.invocationCallOrder.at(-1)).toBeGreaterThan(Math.max(...fills.mock.invocationCallOrder))
    grid.dispose()
  })

  it('draws each frozen boundary once while both sides stay pinned', () => {
    const grid = new RenderTreeGrid({
      columns: [{ key: 'name', title: 'Name', type: 'text', width: 70, pinned: 'left' },
        { key: 'code', title: 'Code', type: 'text', width: 240 },
        { key: 'tail', title: 'Tail', type: 'text', width: 60, pinned: 'right' }],
      roots: [{ key: 'a', row: { name: 'A', code: 'B', tail: 'C' } }], treeColumnKey: 'name',
    })
    grid.layout({ minWidth: 0, maxWidth: 260, minHeight: 0, maxHeight: 160 })
    const lines = vi.spyOn(DrawList.prototype, 'line')
    const segments = vi.spyOn(DrawList.prototype, 'strokeSegments')
    paintTreeGrid(grid)
    const dividers = lines.mock.calls.filter(([x1, y1, x2, y2, , width]) => x1 === x2 && y1 === 0 && y2 > 100 && width === 1)
    expect(dividers).toHaveLength(2)
    for (const divider of dividers) expect(segments.mock.calls.flatMap(([s]) => s).some(edge => edge.x1 === divider[0] && edge.x2 === divider[0])).toBe(false)
    grid.dispose()
  })
})

describe('RenderTreeGrid owner navigation', () => {
  it.each(['self', 'ancestor', 'dispose'] as const)('cancels an old column resize on %s before a stale pointer up can commit', action => {
    const parent = new RenderStackPanel()
    const grid = new RenderTreeGrid({ columns: columns.map(column => ({ ...column, fixed: false })), roots: createFlatRoots(30), treeColumnKey: 'name', focusMode: 'owner' })
    parent.addChild(grid); layout(grid, 340, 90)
    const release = vi.fn(), position = { x: 220, y: 10 }
    grid.onPointerDown({ pointerId: 1, type: 'down', position, setPointerCapture: vi.fn(), releasePointerCapture: release })
    expect((grid as any)._viewport.resizingCol).toBe(0)
    if (action === 'self') { grid.visible = false; grid.visible = true }
    if (action === 'ancestor') { parent.visible = false; parent.visible = true }
    if (action === 'dispose') grid.dispose()
    expect((grid as any)._viewport.resizingCol).toBe(-1)
    expect((grid as any)._viewport.resizeCurrentX).toBe(0)
    expect(release).toHaveBeenCalledOnce()
    if (action !== 'dispose') layout(grid, 340, 90)
    grid.onPointerMove({ pointerId: 1, type: 'move', position: { x: 260, y: 10 } })
    grid.onPointerUp({ pointerId: 1, type: 'up', position: { x: 260, y: 10 } })
    expect(grid.columns[0]!.width).toBe(220)
    parent.dispose()
    expect(release).toHaveBeenCalledOnce()
  })

  it.each(['vertical', 'horizontal'] as const)('cancels an old %s scrollbar drag and accepts a fresh one after redisplay', axis => {
    const parent = new RenderStackPanel()
    const grid = new RenderTreeGrid({ columns: columns.map(column => ({ ...column, fixed: false })), roots: createFlatRoots(30), treeColumnKey: 'name', focusMode: 'owner' })
    parent.addChild(grid); layout(grid, 340, 90)
    const viewport = (grid as any)._viewport
    const thumbPosition = () => {
      const geometry = axis === 'vertical'
        ? viewport.vScrollbarGeometry(grid.globalOffset, grid.getVisibleNodes().length)
        : viewport.hScrollbarGeometry(grid.globalOffset, grid.columns)
      const rect = geometry.thumbHitRect
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }
    const scrollOffset = () => axis === 'vertical' ? grid.debugState().scrollY : grid.debugState().scrollX
    const position = thumbPosition(), release = vi.fn()
    const dragPosition = { x: position.x + (axis === 'horizontal' ? 30 : 0), y: position.y + (axis === 'vertical' ? 30 : 0) }
    grid.onPointerDown({ pointerId: 1, type: 'down', position, setPointerCapture: vi.fn(), releasePointerCapture: release })
    expect(axis === 'vertical' ? viewport.vScrollbar.dragging : viewport.hScrollbar.dragging).toBe(true)
    parent.visible = false; parent.visible = true
    expect(viewport.vScrollbar.dragging).toBe(false)
    expect(viewport.hScrollbar.dragging).toBe(false)
    expect(viewport.vScrollbarController.activePointerKey).toBeUndefined()
    expect(viewport.hScrollbarController.activePointerKey).toBeUndefined()
    expect(release).toHaveBeenCalledOnce()
    layout(grid, 340, 90)
    const before = scrollOffset()
    grid.onPointerMove({ pointerId: 1, type: 'move', position: dragPosition })
    grid.onPointerUp({ pointerId: 1, type: 'up', position: dragPosition })
    expect(scrollOffset()).toBe(before)
    const fresh = thumbPosition(), freshRelease = vi.fn()
    const destination = { x: fresh.x + (axis === 'horizontal' ? 30 : 0), y: fresh.y + (axis === 'vertical' ? 30 : 0) }
    grid.onPointerDown({ pointerId: 2, type: 'down', position: fresh, setPointerCapture: vi.fn(), releasePointerCapture: freshRelease })
    grid.onPointerMove({ pointerId: 2, type: 'move', position: destination })
    grid.onPointerUp({ pointerId: 2, type: 'up', position: destination })
    expect(scrollOffset()).toBeGreaterThan(before)
    expect(freshRelease).toHaveBeenCalledOnce()
    parent.dispose()
  })

  it.each([false, true])('preserves a new resize started from old capture cleanup, throws=%s', throws => {
    const parent = new RenderStackPanel()
    const grid = new RenderTreeGrid({ columns: columns.map(column => ({ ...column, fixed: false })), roots: createFlatRoots(30), treeColumnKey: 'name', focusMode: 'owner' })
    parent.addChild(grid); layout(grid, 340, 90)
    const freshRelease = vi.fn()
    const release = vi.fn(() => {
      parent.visible = true
      expect((grid as any)._viewport.resizingCol).toBe(-1)
      grid.onPointerDown({ pointerId: 2, type: 'down', position: { x: 220, y: 10 }, setPointerCapture: vi.fn(), releasePointerCapture: freshRelease })
      if (throws) throw new Error('old release')
    })
    grid.onPointerDown({ pointerId: 1, type: 'down', position: { x: 220, y: 10 }, setPointerCapture: vi.fn(), releasePointerCapture: release })
    if (throws) expect(() => { parent.visible = false }).toThrow('old release')
    else parent.visible = false
    expect(release).toHaveBeenCalledOnce()
    expect((grid as any)._viewport.resizingCol).toBe(0)
    expect(freshRelease).not.toHaveBeenCalled()
    grid.onPointerUp({ pointerId: 2, type: 'up', position: { x: 260, y: 10 } })
    expect(grid.columns[0]!.width).toBe(260)
    expect(freshRelease).toHaveBeenCalledOnce()
    parent.dispose()
  })

  it('cancels a hidden resize through the real event dispatcher and permits the next mouse sequence', () => {
    const parent = new RenderStackPanel()
    const grid = new RenderTreeGrid({ columns: columns.map(column => ({ ...column, fixed: false })), roots: createFlatRoots(30), treeColumnKey: 'name', focusMode: 'owner' })
    parent.addChild(grid)
    const canvas = document.createElement('canvas'); document.body.appendChild(canvas)
    const dispatcher = new EventDispatcher(canvas); dispatcher.addRoot(parent)
    const constraints = { minWidth: 340, maxWidth: 340, minHeight: 90, maxHeight: 90 }
    const mouse = (type: string, x: number) => canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: 10, button: 0, bubbles: true, cancelable: true }))
    try {
      parent.layout(constraints, false, { theme: ImGuiDarkTheme })
      mouse('mousedown', 220)
      expect((grid as any)._viewport.resizingCol).toBe(0)
      parent.visible = false; parent.visible = true
      parent.layout(constraints, false, { theme: ImGuiDarkTheme })
      mouse('mouseup', 260)
      expect(grid.columns[0]!.width).toBe(220)
      mouse('mousedown', 220); mouse('mousemove', 260); mouse('mouseup', 260)
      expect(grid.columns[0]!.width).toBe(260)
    } finally { dispatcher.dispose(); parent.dispose(); canvas.remove() }
  })

  it('preserves the newest navigation across a nested hide and releases the old capture once', () => {
    const parent = new RenderStackPanel(), input = new RenderTextBox({ value: 'query' })
    const activate = vi.fn(), release = vi.fn()
    const grid = new RenderTreeGrid({ columns, roots: createFlatRoots(30), treeColumnKey: 'name', focusMode: 'owner', onActivate: activate })
    parent.addChild(input); parent.addChild(grid)
    layout(grid, 340, 90)
    input.requestFocus(); grid.setNavigationKey('flat-0')
    grid.onPointerDown({ pointerId: 1, type: 'down', position: { x: grid.size.width - 7, y: (grid as any)._viewport.headerHeight + 10 }, setPointerCapture: vi.fn(), releasePointerCapture: release })
    input.subscribeBlur(() => {
      parent.visible = true
      grid.setNavigationKey('flat-1')
      parent.visible = false
      expect(grid.navigationKey).toBe(null)
      parent.visible = true
      grid.setNavigationKey('flat-2')
    })
    parent.visible = false
    expect(release).toHaveBeenCalledOnce()
    expect(grid.navigationKey).toBe('flat-2')
    grid.handleOwnedKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ key: 'flat-2' }))
    parent.dispose()
    expect(release).toHaveBeenCalledOnce()
  })

  it.each([false, true])('invalidates old targets before blur and preserves explicit fresh navigation=%s', fresh => {
    const parent = new RenderStackPanel(), input = new RenderTextBox({ value: 'query' })
    const activate = vi.fn()
    const grid = new RenderTreeGrid({ columns, roots: createFlatRoots(30), treeColumnKey: 'name', focusMode: 'owner', onActivate: activate })
    parent.addChild(input); parent.addChild(grid)
    layout(grid, 340, 90)
    input.requestFocus(); grid.setNavigationKey('flat-0')
    const blur = vi.fn(() => {
      parent.visible = true
      expect(grid.navigationKey).toBe(null)
      expect(grid.handleOwnedKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false)
      if (fresh) expect(grid.setNavigationKey('flat-1')).toBe(true)
    })
    input.subscribeBlur(blur)
    parent.visible = false
    expect(blur).toHaveBeenCalledOnce()
    expect(grid.navigationKey).toBe(fresh ? 'flat-1' : null)
    expect(grid.handleOwnedKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(fresh)
    if (fresh) expect(activate).toHaveBeenCalledWith(expect.objectContaining({ key: 'flat-1' }))
    else expect(activate).not.toHaveBeenCalled()
    parent.dispose()
  })

  it.each([false, true])('keeps a fresh scrollbar capture established from blur, replacing old capture=%s', oldCapture => {
    const parent = new RenderStackPanel(), input = new RenderTextBox({ value: 'query' })
    const grid = new RenderTreeGrid({ columns, roots: createFlatRoots(30), treeColumnKey: 'name', focusMode: 'owner' })
    parent.addChild(input); parent.addChild(grid)
    layout(grid, 340, 90)
    input.requestFocus(); grid.setNavigationKey('flat-0')
    const oldRelease = vi.fn(), newRelease = vi.fn(), capture = vi.fn()
    const down = { pointerId: 7, type: 'down' as const, position: { x: grid.size.width - 7, y: (grid as any)._viewport.headerHeight + 10 }, setPointerCapture: capture }
    if (oldCapture) grid.onPointerDown({ ...down, releasePointerCapture: oldRelease })
    input.subscribeBlur(() => {
      parent.visible = true
      if (oldCapture) grid.onPointerCancel({ ...down, type: 'cancel' })
      grid.setNavigationKey('flat-1')
      grid.onPointerDown({ ...down, releasePointerCapture: newRelease })
    })
    parent.visible = false
    expect(capture).toHaveBeenCalledTimes(oldCapture ? 2 : 1)
    expect(oldRelease).toHaveBeenCalledTimes(oldCapture ? 1 : 0)
    expect(newRelease).not.toHaveBeenCalled()
    expect(grid.navigationKey).toBe('flat-1')
    expect((grid as any)._dragPointerKey).toBeDefined()
    grid.onPointerUp({ ...down, type: 'up' })
    expect(newRelease).toHaveBeenCalledOnce()
    parent.dispose()
    expect(newRelease).toHaveBeenCalledOnce()
  })

  it.each([false, true])('keeps fresh sibling navigation created by a deferred capture release, throws=%s', throws => {
    const parent = new RenderStackPanel()
    const first = new RenderTreeGrid({ columns, roots: createFlatRoots(30), treeColumnKey: 'name', focusMode: 'owner' })
    const activate = vi.fn()
    const second = new RenderTreeGrid({ columns, roots: createFlatRoots(30), treeColumnKey: 'name', focusMode: 'owner', onActivate: activate })
    parent.addChild(first); parent.addChild(second)
    layout(first, 340, 90); layout(second, 340, 90)
    first.setNavigationKey('flat-0'); second.setNavigationKey('flat-0')
    const release = vi.fn(() => {
      parent.visible = true
      expect(second.navigationKey).toBe(null)
      second.setNavigationKey('flat-2')
      if (throws) throw new Error('capture release')
    })
    first.onPointerDown({ pointerId: 1, type: 'down', position: { x: first.size.width - 7, y: (first as any)._viewport.headerHeight + 10 }, setPointerCapture: vi.fn(), releasePointerCapture: release })
    if (throws) expect(() => { parent.visible = false }).toThrow('capture release')
    else parent.visible = false
    expect(release).toHaveBeenCalledOnce()
    expect(first.navigationKey).toBe(null)
    expect(second.navigationKey).toBe('flat-2')
    second.handleOwnedKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ key: 'flat-2' }))
    parent.dispose()
  })

  it.each([false, true])('clears navigation and scrollbar capture when an ancestor hides, redisplay=%s', redisplay => {
    const parent = new RenderStackPanel(), nested = new RenderStackPanel()
    const activate = vi.fn(), release = vi.fn(), capture = vi.fn()
    const grid = new RenderTreeGrid({ columns, roots: createFlatRoots(30), treeColumnKey: 'name', focusMode: 'owner', onActivate: activate })
    parent.addChild(nested); nested.addChild(grid)
    layout(grid, 340, 90)
    grid.setNavigationKey('flat-0')
    const viewport = (grid as any)._viewport
    const down = { pointerId: 1, type: 'down' as const, position: { x: grid.size.width - 7, y: viewport.headerHeight + 10 }, setPointerCapture: capture, releasePointerCapture: release }
    grid.onPointerDown(down)
    expect(capture).toHaveBeenCalledOnce()
    parent.visible = false
    expect(release).toHaveBeenCalledOnce()
    expect(grid.navigationKey).toBe(null)
    expect((grid as any)._revealKeyOnNextLayout).toBe(null)
    expect(grid.setNavigationKey('flat-0')).toBe(false)
    expect(grid.handleOwnedKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))).toBe(false)
    grid.onPointerDown({ ...down, position: { x: 30, y: viewport.headerHeight + 10 } })
    grid.onDoubleClick({ x: 30, y: viewport.headerHeight + 10 })
    if (redisplay) parent.visible = true
    expect(grid.handleOwnedKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false)
    expect(activate).not.toHaveBeenCalled()
    if (redisplay) {
      grid.handleOwnedKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
      grid.handleOwnedKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))
      expect(activate).toHaveBeenCalledWith(expect.objectContaining({ key: 'flat-0' }))
    }
    parent.dispose()
    expect(release).toHaveBeenCalledOnce()
  })

  it('clears every owner grid even when a capture release redisplays the ancestor and throws', () => {
    const parent = new RenderStackPanel()
    const first = new RenderTreeGrid({ columns, roots: createFlatRoots(30), treeColumnKey: 'name', focusMode: 'owner' })
    const second = new RenderTreeGrid({ columns, roots: createFlatRoots(30), treeColumnKey: 'name', focusMode: 'owner' })
    parent.addChild(first); parent.addChild(second)
    layout(first, 340, 90); layout(second, 340, 90)
    first.setNavigationKey('flat-0'); second.setNavigationKey('flat-1')
    const release = vi.fn(() => { parent.visible = true; throw new Error('capture release') })
    first.onPointerDown({ pointerId: 1, type: 'down', position: { x: first.size.width - 7, y: (first as any)._viewport.headerHeight + 10 }, setPointerCapture: vi.fn(), releasePointerCapture: release })
    expect(() => { parent.visible = false }).toThrow('capture release')
    expect(release).toHaveBeenCalledOnce()
    expect(parent.visible).toBe(true)
    expect(first.navigationKey).toBe(null)
    expect(second.navigationKey).toBe(null)
    expect(first.handleOwnedKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false)
    expect(second.handleOwnedKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false)
    parent.dispose()
  })

  it('keeps native focus on the owner and requires explicit row navigation before activation', () => {
    const input = new RenderTextBox({ value: 'query' })
    input.requestFocus()
    const activate = vi.fn()
    const grid = new RenderTreeGrid({ columns, roots: createRoots(), treeColumnKey: 'name', focusMode: 'owner', defaultExpandAll: true, onActivate: activate })
    layout(grid)
    grid.focusIn()
    expect(grid.isFocused).toBe(false)
    expect(grid.handleOwnedKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false)
    expect(activate).not.toHaveBeenCalled()
    grid.selectedKey = 'a-alt'
    expect(grid.handleOwnedKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))).toBe(true)
    expect(grid.navigationKey).toBe('a-alt')
    grid.handleOwnedKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ key: 'a-alt' }))
    expect(FocusManager.instance.current).toBe(input)
    expect(inputElement().value).toBe('query')
    grid.dispose(); input.dispose()
  })

  it('uses tree navigation after a pointer press in another column without editing or checking', () => {
    const roots = createRoots()
    const activate = vi.fn(), change = vi.fn(), check = vi.fn()
    const grid = new RenderTreeGrid({ columns, roots, treeColumnKey: 'name', focusMode: 'owner', editable: true, selectionMode: 'check', onActivate: activate, onCellChange: change, onCheck: check })
    layout(grid, 700)
    const cell = (grid as any)._cellGlobalRect(0, 4)
    grid.onPointerDown({ type: 'down', pointerId: 1, position: { x: cell.x + 15, y: cell.y + cell.h / 2 } })
    expect(grid.navigationKey).toBe('root-a')
    expect(grid.getFocusedKey()).toBe('name')
    expect(roots[0]!.row.active).toBe(true)
    grid.handleOwnedKeyDown(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    expect(grid.expandedKeys).toContain('root-a')
    grid.handleOwnedKeyDown(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    expect(grid.navigationKey).toBe('a-chem')
    grid.handleOwnedKeyDown(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    expect(grid.navigationKey).toBe('root-a')
    for (const key of [' ', 'F2', 'Tab', 'Home', 'End']) expect(grid.handleOwnedKeyDown(new KeyboardEvent('keydown', { key }))).toBe(false)
    expect(grid.editingCell).toBe(null)
    expect(change).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled()
    expect(grid.isFocused).toBe(false)
    grid.dispose()
  })

  it('preserves stable row targets across reorder and drops hidden or removed targets', () => {
    const grid = new RenderTreeGrid({ columns, roots: createRoots(), treeColumnKey: 'name', focusMode: 'owner', defaultExpandAll: true })
    layout(grid)
    expect(grid.setNavigationKey('a-alt')).toBe(true)
    grid.roots = [...grid.roots].reverse()
    expect(grid.navigationKey).toBe('a-alt')
    grid.expandedKeys = []
    layout(grid)
    expect(grid.expandedKeys).toEqual([])
    expect(grid.navigationKey).toBe(null)
    expect(grid.setNavigationKey('a-alt')).toBe(false)
    grid.setNavigationKey('root-a')
    grid.roots = []
    expect(grid.navigationKey).toBe(null)
    grid.dispose()
  })

  it('ignores canceled, composing and modified keys and clears navigation on hide or dispose', () => {
    const grid = new RenderTreeGrid({ columns, roots: createRoots(), treeColumnKey: 'name', focusMode: 'owner' })
    layout(grid)
    const canceled = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }); canceled.preventDefault()
    for (const event of [canceled, new KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true }), new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true })]) expect(grid.handleOwnedKeyDown(event)).toBe(false)
    expect(grid.navigationKey).toBe(null)
    grid.setNavigationKey('root-a')
    grid.visible = false; grid.visible = true
    expect(grid.navigationKey).toBe(null)
    grid.setNavigationKey('root-a'); grid.dispose()
    expect(grid.navigationKey).toBe(null)
    expect(grid.setNavigationKey('root-a')).toBe(false)
    expect(grid.handleOwnedKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))).toBe(false)
  })
})
