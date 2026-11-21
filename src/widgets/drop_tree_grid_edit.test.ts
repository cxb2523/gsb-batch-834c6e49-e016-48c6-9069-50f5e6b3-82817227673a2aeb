// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoxConstraints, LayoutContext } from '../core/render_object'
import { FocusManager, FocusScope, FocusScopeType } from '../core/focus_manager'
import { InputComposer } from '../core/input_composer'
import { PopupManager } from '../core/popup_manager'
import { TextMeasurer } from '../core/text_measurer'
import { PaintContext } from '../rendering/paint_context'
import { ImGuiDarkTheme } from '../theme/default_theme'
import type { GridColumnDef } from './grid/grid_types'
import type { TreeGridNode } from './tree_grid'
import { RenderStackPanel } from '../layout/render_flex'
import { EventDispatcher } from '../gestures/recognizers'
import { deriveGridCellStyle } from '../theme/component_styles'
import { DropTreeGridPopup, RenderDropTreeGridEdit, defaultDropTreeGridEditQueryProcessor } from './drop_tree_grid_edit'

interface DirectoryRow {
  name: string
  code: string
  category: string
  py?: string
}

const constraints: BoxConstraints = {
  minWidth: 0,
  maxWidth: 220,
  minHeight: 0,
  maxHeight: 40,
}

const narrowConstraints: BoxConstraints = {
  minWidth: 0,
  maxWidth: 120,
  minHeight: 0,
  maxHeight: 40,
}

const layoutContext: LayoutContext = { theme: ImGuiDarkTheme }

const columns: GridColumnDef<DirectoryRow>[] = [
  { type: 'text', key: 'name', title: '名称', width: 180, fixed: true },
  { type: 'text', key: 'code', title: '编码', width: 100 },
  { type: 'text', key: 'category', title: '类别', width: 100 },
]

const roots: TreeGridNode<DirectoryRow>[] = [
  {
    key: 'diag-root',
    row: { name: 'Catalog', code: 'DX', category: '目录', py: 'zdml' },
    selectable: false,
    children: [
      {
        key: 'diag-resp',
        row: { name: 'DeviceGroup', code: 'DX-RESP', category: '分类', py: 'hxxt' },
        selectable: false,
        children: [
          { key: 'diag-cold', row: { name: 'DeviceAlpha', code: 'CODE06', category: 'Catalog', py: 'shxdgr' } },
          { key: 'diag-bronch', row: { name: 'DeviceGamma', code: 'J20.900', category: 'Catalog', py: 'jxzqgy' } },
        ],
      },
      {
        key: 'diag-cardio',
        row: { name: 'PriorityGroup', code: 'DX-CARD', category: '分类', py: 'xhxt' },
        selectable: false,
        children: [
          { key: 'diag-hyp', row: { name: 'PriorityBeta', code: 'CODE10', category: 'Catalog', py: 'gxyb' } },
        ],
      },
    ],
  },
]

function createTextRecordingPaintContext(theme = ImGuiDarkTheme): { context: PaintContext; fillText: ReturnType<typeof vi.fn> } {
  const fillText = vi.fn()
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
    fillText,
    measureText: vi.fn(text => ({ width: String(text).length * 8 }) as TextMetrics),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    set fillStyle(_value: unknown) {},
    get fillStyle() { return '' },
    set strokeStyle(_value: unknown) {},
    get strokeStyle() { return '' },
    lineWidth: 1,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'middle' as CanvasTextBaseline,
  } as unknown as CanvasRenderingContext2D
  return { context: new PaintContext(ctx, theme), fillText }
}

function setPopupTestContext(): void {
  PopupManager.instance.setContextProvider(() => ({
    theme: ImGuiDarkTheme,
    viewport: { width: 800, height: 520, dpr: 1 },
  }))
}

function createDropTreeGrid(value = ''): RenderDropTreeGridEdit<DirectoryRow> {
  const field = new RenderDropTreeGridEdit<DirectoryRow>({
    columns,
    roots,
    treeColumnKey: 'name',
    labelKey: 'name',
    value,
    placeholder: '检索Catalog',
    searchable: true,
    clearable: true,
    queryTextBuilder: node => [node.key, node.row.name, node.row.code, node.row.py ?? ''],
    metaKey: 'code',
  })
  field.performLayout(constraints, layoutContext)
  return field
}

function paintField(field: RenderDropTreeGridEdit<DirectoryRow>): string[] {
  const painted = createTextRecordingPaintContext()
  field.performPaint(painted.context, { x: 0, y: 0 })
  return painted.fillText.mock.calls.map(call => String(call[0]))
}

afterEach(() => {
  PopupManager.instance.dispose()
  FocusManager.instance.dispose()
  InputComposer.instance.dispose()
  vi.restoreAllMocks()
})

function inputField(field: RenderDropTreeGridEdit<DirectoryRow>, value: string): HTMLTextAreaElement {
  field.requestFocus()
  const textarea = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
  textarea.value = value
  textarea.setSelectionRange(value.length, value.length)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  return textarea
}

describe('RenderDropTreeGridEdit', () => {
  it('implements the value editor contract without blurring during popup selection', () => {
    setPopupTestContext()
    const onChange = vi.fn()
    const valueChange = vi.fn()
    const blur = vi.fn()
    const field = new RenderDropTreeGridEdit<DirectoryRow>({
      columns,
      roots,
      treeColumnKey: 'name',
      labelKey: 'name',
      value: 'diag-hyp',
      onChange,
    })
    field.performLayout(constraints, layoutContext)
    field.subscribeValueChange(valueChange)
    field.subscribeBlur(blur)

    field.setValue('diag-diabetes')

    expect(field.getValue()).toBe('diag-diabetes')
    expect(onChange).not.toHaveBeenCalled()
    expect(valueChange).not.toHaveBeenCalled()

    field.requestFocus()
    field.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))
    const popup = PopupManager.instance.top as any
    const selectedNode = { key: 'diag-hyp', row: { name: 'PriorityBeta', code: 'CODE10', category: 'Catalog' } }
    popup._select(selectedNode)

    expect(valueChange).toHaveBeenCalledWith({
      value: 'diag-hyp',
      previousValue: 'diag-diabetes',
      reason: 'selection',
      detail: selectedNode,
    })
    expect(onChange).toHaveBeenCalledOnce()
    expect(blur).not.toHaveBeenCalled()

    field.blur()
    field.blur()

    expect(blur).toHaveBeenCalledOnce()
    field.dispose()
  })

  it('keeps legacy selection while suppressing unchanged formal value events', () => {
    setPopupTestContext()
    const onChange = vi.fn()
    const valueChange = vi.fn()
    const field = new RenderDropTreeGridEdit<DirectoryRow>({
      columns,
      roots,
      treeColumnKey: 'name',
      labelKey: 'name',
      value: 'diag-hyp',
      onChange,
    })
    field.performLayout(constraints, layoutContext)
    field.subscribeValueChange(valueChange)

    field.requestFocus()
    field.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))
    const popup = PopupManager.instance.top as any
    const currentNode = roots[0]!.children![1]!.children![0]!
    popup._select(currentNode)

    expect(onChange).toHaveBeenCalledOnce()
    expect(valueChange).not.toHaveBeenCalled()
    expect(field.getValue()).toBe('diag-hyp')
    expect(field.debugState().popupVisible).toBe(false)
    expect(field.isFocused).toBe(true)

    field.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))
    const nextNode = roots[0]!.children![0]!.children![0]!
    popup._select(nextNode)

    expect(onChange).toHaveBeenCalledTimes(2)
    expect(valueChange).toHaveBeenCalledOnce()
    expect(valueChange).toHaveBeenCalledWith({
      value: 'diag-cold',
      previousValue: 'diag-hyp',
      reason: 'selection',
      detail: nextNode,
    })
    field.dispose()
  })

  it.each(['disabled', 'readonly'] as const)(
    'publishes one logical blur when an open tree grid editor becomes %s',
    state => {
      setPopupTestContext()
      const blur = vi.fn()
      const field = createDropTreeGrid()
      field.subscribeBlur(blur)

      field.requestFocus()
      field.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))
      expect(field.debugState().popupVisible).toBe(true)

      field[state] = true
      field[state] = true

      expect(field.isFocused).toBe(false)
      expect(field.debugState().popupVisible).toBe(false)
      expect(blur).toHaveBeenCalledOnce()
      field.dispose()
    },
  )

  it('keeps text clicks editable and toggles popup with the arrow', () => {
    setPopupTestContext()
    const field = createDropTreeGrid()

    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    expect(PopupManager.instance.top).not.toBe(null)

    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    expect(field.debugState().popupVisible).toBe(true)
    field.onPointerUp({ pointerId: 0, type: 'up', position: { x: 8, y: 8 } })
    const arrow = (field as any)._triggerLayout().trailingRect
    field.onPointerDown({ pointerId: 0, type: 'down', position: { x: arrow.x + 1, y: arrow.y + 1 } })
    expect(PopupManager.instance.top).toBe(null)
  })

  it('opens with typed query and filters tree roots through the default processor', () => {
    setPopupTestContext()
    const field = createDropTreeGrid()
    FocusManager.instance.setFocus(field)

    inputField(field, 'Priority')
    const popup = PopupManager.instance.top as any
    expect(popup).not.toBe(null)
    expect(popup.searchText).toBe('Priority')
    expect(popup.filteredRoots.map((node: TreeGridNode<DirectoryRow>) => node.row.name)).toEqual(['Catalog'])
    expect(popup.filteredRoots[0]?.children?.map((node: TreeGridNode<DirectoryRow>) => node.row.name)).toEqual(['PriorityGroup'])
    expect(paintField(field)).toContain('Priority')
  })

  it('closes query presentation on Escape Tab disabled and exposes expanded debug state', () => {
    setPopupTestContext()
    const field = createDropTreeGrid('diag-cold')
    FocusManager.instance.setFocus(field)

    inputField(field, 'Priority')

    expect(field.debugState()).toMatchObject({
      popupVisible: true,
      queryText: 'Priority',
      showQueryInField: true,
      displayText: 'Priority',
      value: 'diag-cold',
      selectedLabel: 'DeviceAlpha',
      filteredCount: 3,
    })
    expect(field.debugState().expandedKeys).toEqual(['diag-root', 'diag-cardio'])

    expect(field.onKeyDown(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))).toBe(false)
    expect(field.debugState()).toMatchObject({
      popupVisible: false,
      queryText: '',
      showQueryInField: false,
      displayText: 'DeviceAlpha',
    })

    inputField(field, 'Priority')
    field.disabled = true

    expect(field.debugState()).toMatchObject({
      popupVisible: false,
      queryText: '',
      showQueryInField: false,
      disabled: true,
      value: 'diag-cold',
    })
  })

  it('uses custom queryProcessor to control filtered tree order', () => {
    setPopupTestContext()
    const queryProcessor = vi.fn(() => [
      {
        ...roots[0]!,
        children: [roots[0]!.children![1]!, roots[0]!.children![0]!],
      },
    ])
    const field = new RenderDropTreeGridEdit<DirectoryRow>({
      columns,
      roots,
      treeColumnKey: 'name',
      labelKey: 'name',
      searchable: true,
      queryProcessor,
    })
    field.performLayout(constraints, layoutContext)
    FocusManager.instance.setFocus(field)

    inputField(field, 'Catalog')

    const popup = PopupManager.instance.top as any
    expect(queryProcessor).toHaveBeenCalled()
    expect(popup.filteredRoots[0]?.children?.map((node: TreeGridNode<DirectoryRow>) => node.row.name)).toEqual(['PriorityGroup', 'DeviceGroup'])
  })

  it('does not execute the query processor from debugState', () => {
    setPopupTestContext()
    const queryProcessor = vi.fn(() => [{
      ...roots[0]!,
      children: [roots[0]!.children![1]!],
    }])
    const field = new RenderDropTreeGridEdit<DirectoryRow>({
      columns,
      roots,
      treeColumnKey: 'name',
      labelKey: 'name',
      searchable: true,
      queryProcessor,
    })
    field.performLayout(constraints, layoutContext)

    expect(field.debugState().filteredCount).toBe(6)
    expect(queryProcessor).not.toHaveBeenCalled()

    FocusManager.instance.setFocus(field)
    inputField(field, 'Catalog')
    expect(queryProcessor).toHaveBeenCalled()

    queryProcessor.mockClear()
    expect(field.debugState().filteredCount).toBe(3)
    expect(queryProcessor).not.toHaveBeenCalled()
  })

  it('commits selection and renders the selected label with meta text', () => {
    setPopupTestContext()
    const onChange = vi.fn()
    const field = new RenderDropTreeGridEdit<DirectoryRow>({
      columns,
      roots,
      treeColumnKey: 'name',
      labelKey: 'name',
      onChange,
      clearable: true,
      metaKey: 'code',
    })
    field.performLayout(constraints, layoutContext)
    FocusManager.instance.setFocus(field)

    inputField(field, 'Priority')
    const popup = PopupManager.instance.top as any
    popup._select({ key: 'diag-hyp', row: { name: 'PriorityBeta', code: 'CODE10', category: 'Catalog' } })

    expect(field.value).toBe('diag-hyp')
    expect(onChange).toHaveBeenCalledWith(
      'diag-hyp',
      expect.objectContaining({ key: 'diag-hyp' }),
    )
    expect(paintField(field)).toContain('PriorityBeta')
    expect(paintField(field)).toContain('CODE10')
  })

  it('syncs popup grid roots when the external roots change while open', () => {
    setPopupTestContext()
    const field = createDropTreeGrid()
    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    const popup = PopupManager.instance.top as any
    expect(popup._grid.roots[0]?.row.name).toBe('Catalog')

    field.roots = [
      {
        key: 'exam-root',
        row: { name: 'Inventory', code: 'EX', category: '目录', py: 'jcml' },
        selectable: false,
        children: [
          { key: 'exam-ct', row: { name: 'Alpha product', code: 'SKU301', category: '项目', py: 'tlct' } },
        ],
      },
    ]

    expect(popup._grid.roots[0]?.row.name).toBe('Inventory')
    expect(field.value).toBe('')
  })

  it('refreshes filtered tree grid roots and columns when rebound while open', () => {
    setPopupTestContext()
    const field = createDropTreeGrid('diag-cold')
    FocusManager.instance.setFocus(field)

    inputField(field, 'Alpha')

    const popup = PopupManager.instance.top as any
    field.columns = [
      { type: 'text', key: 'category', title: '分类', width: 100 },
      { type: 'text', key: 'name', title: '名称', width: 180 },
    ]
    field.roots = [
      {
        key: 'exam-root',
        row: { name: 'Inventory', code: 'EX', category: '目录', py: 'jcml' },
        selectable: false,
        children: [
          { key: 'exam-head-ct', row: { name: 'Alpha product', code: 'SKU301', category: '项目', py: 'tlct' } },
        ],
      },
    ]

    expect(field.value).toBe('diag-cold')
    expect(popup.columns.map((column: GridColumnDef<DirectoryRow>) => column.key)).toEqual(['category', 'name'])
    expect(popup._grid.roots[0]?.children?.map((node: TreeGridNode<DirectoryRow>) => node.row.name)).toEqual(['Alpha product'])
    expect(field.debugState().filteredCount).toBe(2)
  })

  it('syncs popup selection when the external value changes while open', () => {
    setPopupTestContext()
    const field = createDropTreeGrid('diag-cold')
    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    const popup = PopupManager.instance.top as any
    expect(popup.selectedValue).toBe('diag-cold')
    expect(popup._grid.selectedKey).toBe('diag-cold')

    field.value = 'diag-hyp'

    expect(popup.selectedValue).toBe('diag-hyp')
    expect(popup._grid.selectedKey).toBe('diag-hyp')
  })

  it('preserves the standalone search box and clears tree grid hover when entering it', () => {
    setPopupTestContext()
    const field = createDropTreeGrid()
    const popup = new DropTreeGridPopup<DirectoryRow>() as any
    popup.open({
      anchor: field, columns, treeColumnKey: 'name', selectedValue: '', searchable: true,
      initialQuery: '', maxVisibleItems: 8, resolveRoots: () => roots, onSelect: vi.fn(), onClose: vi.fn(),
    })
    popup.paint(createTextRecordingPaintContext().context)
    const layout = popup._layout()
    popup._grid._hoveredItemIndex = 2

    popup.onPanelPointerMove({
      pointerId: 0,
      position: {
        x: layout.searchRect.x + 12,
        y: layout.searchRect.y + 12,
      },
      type: 'move',
    }, PopupManager.instance.context, layout)

    expect(popup._grid._hoveredItemIndex).toBe(-1)
  })

  it('centers the no-match hint inside the body below the column header', () => {
    setPopupTestContext()
    const field = createDropTreeGrid()
    FocusManager.instance.setFocus(field)
    inputField(field, '无')

    const popup = PopupManager.instance.top as any
    expect(popup.filteredRoots).toHaveLength(0)
    const painted = createTextRecordingPaintContext()
    popup.paint(painted.context)
    const layout = popup._layout()
    const hint = painted.fillText.mock.calls.find(call => call[0] === '无匹配节点')

    expect(hint).toBeDefined()
    expect(Math.abs(hint![1] - (layout.gridRect.x + layout.gridRect.w / 2))).toBeLessThanOrEqual(0.5)
    expect(Math.abs(hint![2] - (layout.gridRect.y + layout.headerH + (layout.gridRect.h - layout.headerH) / 2))).toBeLessThanOrEqual(0.5)
    expect(hint![2]).toBeGreaterThan(layout.gridRect.y + layout.headerH)
  })

  it('reveals the current selection inside the popup viewport when opened', () => {
    setPopupTestContext()
    const manyRoots: TreeGridNode<DirectoryRow>[] = [
      {
        key: 'root',
        row: { name: '目录', code: 'ROOT', category: '目录' },
        selectable: false,
        children: Array.from({ length: 18 }, (_, index) => ({
          key: `node-${index}`,
          row: { name: `项目 ${index}`, code: `CODE-${index}`, category: '项目' },
        })),
      },
    ]
    const field = new RenderDropTreeGridEdit<DirectoryRow>({
      columns,
      roots: manyRoots,
      treeColumnKey: 'name',
      labelKey: 'name',
      value: 'node-15',
      expandAllOnOpen: true,
    })
    field.performLayout(constraints, layoutContext)

    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    const popup = PopupManager.instance.top as any
    popup.paint(createTextRecordingPaintContext().context)
    expect(popup._grid.debugState().scrollY).toBeGreaterThan(0)
  })

  it('sizes the default popup wide enough to show all configured columns without manual resize', () => {
    setPopupTestContext()
    const field = createDropTreeGrid()

    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    const popup = PopupManager.instance.top as any
    const layout = popup._layout()
    const totalColumnWidth = columns.reduce((sum, column) => sum + (column.width ?? 0), 0)

    expect(layout.gridRect.w).toBeGreaterThanOrEqual(totalColumnWidth)
  })

  it('does not reserve scrollbar gutters when all expanded popup rows are visible', () => {
    setPopupTestContext()
    const field = new RenderDropTreeGridEdit<DirectoryRow>({
      columns,
      roots,
      treeColumnKey: 'name',
      labelKey: 'name',
      searchable: true,
      expandedKeysOnOpen: ['diag-root', 'diag-resp', 'diag-cardio'],
    })
    field.performLayout(constraints, layoutContext)

    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    const popup = PopupManager.instance.top as any
    popup.paint(createTextRecordingPaintContext().context)
    const grid = popup._grid as any
    const viewport = grid._viewport
    const visibleCount = grid.debugState().visibleKeys.length

    expect(viewport.viewWidth).toBe(viewport.size.width)
    expect(viewport.viewHeight).toBe(viewport.size.height - viewport.headerHeight)
    expect(viewport.totalContentHeight(visibleCount)).toBe(viewport.viewHeight)
  })

  it('merges expandedKeysOnOpen with the selected path', () => {
    setPopupTestContext()
    const field = new RenderDropTreeGridEdit<DirectoryRow>({
      columns,
      roots,
      treeColumnKey: 'name',
      labelKey: 'name',
      value: 'diag-hyp',
      expandedKeysOnOpen: ['diag-root'],
    })
    field.performLayout(constraints, layoutContext)

    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    const popup = PopupManager.instance.top as any
    expect(popup._grid.expandedKeys).toContain('diag-root')
    expect(popup._grid.expandedKeys).toContain('diag-cardio')
  })

  it('syncs runtime columns and tree column changes into the open popup', () => {
    setPopupTestContext()
    const field = createDropTreeGrid()
    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    const popup = PopupManager.instance.top as any
    const nextColumns: GridColumnDef<DirectoryRow>[] = [
      { type: 'text', key: 'category', title: '类别', width: 96 },
      { type: 'text', key: 'name', title: '名称', width: 180 },
    ]

    field.columns = nextColumns

    expect(popup.columns).toBe(nextColumns)
    expect(popup._grid.columns).toEqual(nextColumns)

    field.treeColumnKey = 'category'

    expect(popup.treeColumnKey).toBe('category')
    expect(popup._grid.treeColumnKey).toBe('category')

    field.columns = [
      { type: 'text', key: 'code', title: '编码', width: 120 },
    ]

    expect(field.treeColumnKey).toBe('code')
    expect(popup.treeColumnKey).toBe('code')
    expect(popup._grid.treeColumnKey).toBe('code')
  })

  it('shows the full selected text in tooltip when the trigger text is clipped', () => {
    setPopupTestContext()
    const measureWidth = vi.spyOn(TextMeasurer, 'measureWidth').mockImplementation(text => String(text).length * 8)
    const field = new RenderDropTreeGridEdit<DirectoryRow>({
      columns,
      roots,
      treeColumnKey: 'name',
      labelKey: 'name',
      value: 'diag-cold',
      metaKey: 'code',
    })
    field.performLayout(narrowConstraints, layoutContext)

    const painted = paintField(field)

    expect(field.tooltip).toBe('DeviceAlpha  CODE06')
    expect(painted.some(text => text.includes('...'))).toBe(true)

    measureWidth.mockRestore()
  })

  it('keeps readonly instances inert and out of the focus chain', () => {
    setPopupTestContext()
    const field = new RenderDropTreeGridEdit<DirectoryRow>({
      columns,
      roots,
      treeColumnKey: 'name',
      labelKey: 'name',
      readonly: true,
      value: 'diag-hyp',
    })
    field.performLayout(constraints, layoutContext)

    field.focusIn()
    expect(field.isFocused).toBe(false)

    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    expect(PopupManager.instance.top).toBe(null)
    expect(FocusManager.instance.current).not.toBe(field)
    expect(FocusManager.instance.scopeStack[0]?.focusables.includes(field)).toBe(false)
  })
})

function gridPopup(field: RenderDropTreeGridEdit<DirectoryRow>): any { return (field as any)._popup }
function fieldKey(field: RenderDropTreeGridEdit<DirectoryRow>, key: string, options: KeyboardEventInit = {}): boolean {
  return field.onKeyDown(new KeyboardEvent('keydown', { key, cancelable: true, ...options }))
}

describe('DropTreeGridEdit field search', () => {
  it.each([false, true])('normalizes in-place tree-column changes before queries without canceling IME=%s', composing => {
    setPopupTestContext()
    const field = createDropTreeGrid()
    field.columns = [...columns]
    const textarea = inputField(field, 'gxyb')
    fieldKey(field, 'ArrowDown')
    if (composing) textarea.dispatchEvent(new CompositionEvent('compositionstart'))
    const processor = vi.fn(defaultDropTreeGridEditQueryProcessor<DirectoryRow>(field.queryTextBuilder))
    field.queryProcessor = processor
    field.columns.splice(0, 1)
    field.refreshTreeGrid()
    expect(field.treeColumnKey).toBe('code')
    expect(processor).toHaveBeenCalledOnce()
    expect(processor.mock.calls[0]![0].treeColumnKey).toBe('code')
    expect(gridPopup(field)._grid.treeColumnKey).toBe('code')
    expect(gridPopup(field).navigationKey).toBe(composing ? null : 'diag-root')
    expect(field.debugState().queryText).toBe('gxyb')
    expect(field.debugState().filteredCount).toBe(3)
    expect(document.getElementById('__ds_ui_input__')).toBe(textarea)
    expect(textarea.value).toBe('gxyb')
    expect(InputComposer.instance.composing).toBe(composing)
    field.dispose()
  })

  it('keeps manual scrolling across paints while retaining the candidate target', () => {
    setPopupTestContext()
    const field = createDropTreeGrid()
    field.roots = Array.from({ length: 30 }, (_, index) => ({ key: `flat-${index}`, row: { name: `候选 ${index}`, code: `CODE${index}`, category: '项目' } }))
    inputField(field, '')
    const popup = gridPopup(field)
    const context = createTextRecordingPaintContext().context
    fieldKey(field, 'ArrowDown')
    popup.paint(context)
    const grid = popup._grid
    const rect = popup.debugState().gridRect
    popup.onWheel({ type: 'wheel', pointerId: 1, position: { x: rect.x + 100, y: rect.y + 60 }, deltaX: 0, deltaY: 60 })
    const scroll = grid.debugState().scrollY
    expect(scroll).toBeGreaterThan(0)
    popup.paint(context)
    expect(grid.debugState().scrollY).toBe(scroll)
    expect(popup.navigationKey).toBe('flat-0')
    expect(FocusManager.instance.current).toBe(field)
    field.dispose()
  })

  it('filters in the field, keeps real focus, and commits only an explicitly navigated row', () => {
    setPopupTestContext()
    const field = createDropTreeGrid()
    const change = vi.fn(), blur = vi.fn()
    field.onChange = change
    field.subscribeBlur(blur)
    const textarea = inputField(field, 'gxyb')
    expect(gridPopup(field).debugState().searchable).toBe(false)
    expect(field.debugState().filteredCount).toBe(3)
    expect(gridPopup(field)._grid.isFocused).toBe(false)
    expect(FocusManager.instance.current).toBe(field)
    expect(document.activeElement).toBe(textarea)
    expect(fieldKey(field, 'Enter')).toBe(true)
    expect(change).not.toHaveBeenCalled()
    for (const key of ['diag-root', 'diag-cardio', 'diag-hyp']) {
      fieldKey(field, 'ArrowDown')
      expect(gridPopup(field).navigationKey).toBe(key)
    }
    fieldKey(field, 'Enter')
    expect(field.value).toBe('diag-hyp')
    expect(textarea.value).toBe('PriorityBeta')
    expect(paintField(field)).toContain('PriorityBeta')
    expect(paintField(field)).toContain('CODE10')
    expect(change).toHaveBeenCalledOnce()
    expect(blur).not.toHaveBeenCalled()
    field.dispose()
  })

  it.each(['ArrowDown', 'ArrowUp'] as const)('opens and establishes a candidate on the first %s', key => {
    setPopupTestContext()
    const field = createDropTreeGrid('diag-hyp')
    field.requestFocus()
    const e = new KeyboardEvent('keydown', { key, cancelable: true })
    expect(field.onKeyDown(e)).toBe(true)
    expect(e.defaultPrevented).toBe(true)
    expect(gridPopup(field).navigationKey).toBe('diag-hyp')
    field.dispose()
  })

  it('caches filtering across paints and recalculates when searchable columns or tree column change', () => {
    setPopupTestContext()
    const field = createDropTreeGrid()
    const base = defaultDropTreeGridEditQueryProcessor<DirectoryRow>()
    const processor = vi.fn(base)
    field.queryTextBuilder = undefined
    field.queryProcessor = processor
    const textarea = inputField(field, 'CODE10')
    expect(field.debugState().filteredCount).toBe(3)
    expect(processor).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 3; i++) {
      gridPopup(field).paint(createTextRecordingPaintContext().context)
      gridPopup(field).debugState()
      field.debugState()
    }
    expect(processor).toHaveBeenCalledTimes(1)
    field.columns = [columns[0]!, columns[2]!]
    expect(field.debugState().filteredCount).toBe(0)
    expect(textarea.value).toBe('CODE10')
    field.columns = [columns[1]!, columns[0]!]
    expect(field.debugState().filteredCount).toBe(3)
    field.treeColumnKey = 'category'
    expect(field.treeColumnKey).toBe('code')
    expect(gridPopup(field)._grid.treeColumnKey).toBe('code')
    expect(processor).toHaveBeenCalledTimes(4)
    field.dispose()
  })

  it('restores navigation by key after reorder and clears targets removed by roots', () => {
    setPopupTestContext()
    const field = createDropTreeGrid()
    inputField(field, 'diag')
    fieldKey(field, 'ArrowDown')
    fieldKey(field, 'ArrowDown')
    fieldKey(field, 'ArrowDown')
    expect(gridPopup(field).navigationKey).toBe('diag-cold')
    field.roots = roots.map(root => ({ ...root, children: [...(root.children ?? [])].reverse() }))
    expect(gridPopup(field).navigationKey).toBe('diag-cold')
    field.roots = []
    expect(gridPopup(field).navigationKey).toBe(null)
    expect(fieldKey(field, 'Enter')).toBe(true)
    expect(field.value).toBe('')
    field.dispose()
  })

  it('separates search expansion from normal expansion and returns edit keys to the field', () => {
    setPopupTestContext()
    const field = createDropTreeGrid()
    field.requestFocus()
    fieldKey(field, 'Enter')
    fieldKey(field, 'ArrowDown')
    fieldKey(field, 'ArrowRight')
    expect(field.debugState().expandedKeys).toEqual(['diag-root'])
    inputField(field, 'diag')
    expect(field.debugState().expandedKeys).toEqual(['diag-root', 'diag-resp', 'diag-cardio'])
    fieldKey(field, 'ArrowDown')
    fieldKey(field, 'ArrowLeft')
    expect(field.debugState().expandedKeys).not.toContain('diag-root')
    inputField(field, ' ')
    expect(field.debugState().expandedKeys).toEqual(['diag-root'])
    for (const [key, options] of [['Home', {}], ['End', {}], ['ArrowRight', { shiftKey: true }], [' ', {}], ['Delete', {}]] as const) {
      fieldKey(field, 'ArrowDown')
      expect(fieldKey(field, key, options)).toBe(false)
      expect(gridPopup(field).navigationKey).toBe(null)
    }
    field.dispose()
  })

  it('keeps roots-update IME input and synchronizes label/meta after confirming the latest node', () => {
    setPopupTestContext()
    const field = createDropTreeGrid('diag-hyp')
    const textarea = inputField(field, 'gxyb')
    textarea.dispatchEvent(new CompositionEvent('compositionstart'))
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'Priority' }))
    field.roots = roots.map(root => ({ ...root, children: root.children?.map(group => ({ ...group, children: group.children?.map(node => ({ ...node, row: { ...node.row, name: node.key === 'diag-hyp' ? '新PriorityBeta' : node.row.name } })) })) }))
    expect(document.getElementById('__ds_ui_input__')).toBe(textarea)
    expect(InputComposer.instance.composing).toBe(true)
    expect(textarea.value).toBe('gxyb')
    expect(fieldKey(field, 'Enter')).toBe(false)
    textarea.value = 'gxyb'
    textarea.setSelectionRange(4, 4)
    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: 'Priority' }))
    fieldKey(field, 'ArrowDown')
    fieldKey(field, 'Enter')
    expect(textarea.value).toBe('新PriorityBeta')
    expect(paintField(field)).toContain('CODE10')
    field.dispose()
  })

  it('cancels IME on setValue and ignores old native events while preserving the owner focus', () => {
    setPopupTestContext()
    const field = createDropTreeGrid('diag-cold')
    const old = inputField(field, 'gxyb')
    old.dispatchEvent(new CompositionEvent('compositionstart'))
    old.dispatchEvent(new CompositionEvent('compositionupdate', { data: '旧' }))
    field.setValue('diag-hyp')
    const current = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    expect(current).not.toBe(old)
    expect(current.value).toBe('PriorityBeta')
    old.value = '旧'
    old.dispatchEvent(new CompositionEvent('compositionend', { data: '旧' }))
    old.dispatchEvent(new Event('input'))
    expect(field.debugState()).toMatchObject({ value: 'diag-hyp', popupVisible: false, queryText: '' })
    expect(current.value).toBe('PriorityBeta')
    expect(FocusManager.instance.current).toBe(field)
    field.dispose()
  })

  it.each(['set-value', 'pure', 'roundtrip', 'disabled', 'dispose', 'rebind'] as const)('does not publish a query invalidated by %s', action => {
    setPopupTestContext()
    const field = createDropTreeGrid()
    const base = defaultDropTreeGridEditQueryProcessor<DirectoryRow>(node => [node.key, node.row.name, node.row.py ?? ''])
    const query = vi.fn(context => {
      if (action === 'set-value') field.setValue('diag-cold')
      if (action === 'pure' || action === 'roundtrip') {
        field.searchable = false
        if (action === 'roundtrip') field.searchable = true
      }
      if (action === 'disabled') field.disabled = true
      if (action === 'dispose') field.dispose()
      if (action === 'rebind') field.roots = [...context.roots]
      return base(context)
    })
    field.queryProcessor = query
    inputField(field, 'gxyb')
    expect(query).toHaveBeenCalledOnce()
    expect(field.debugState().popupVisible).toBe(false)
    if (action === 'set-value') expect(field.debugState()).toMatchObject({ value: 'diag-cold', displayText: 'DeviceAlpha', showQueryInField: false })
    if (action === 'pure') expect(InputComposer.instance.hasSession).toBe(false)
    field.dispose()
  })

  it.each([false, true])('preserves a popup reopened from selection, including throwing=%s', throws => {
    setPopupTestContext()
    const field = createDropTreeGrid()
    inputField(field, 'gxyb')
    for (let i = 0; i < 3; i++) fieldKey(field, 'ArrowDown')
    field.onChange = () => {
      fieldKey(field, 'Enter')
      if (throws) throw new Error('selection failed')
    }
    if (throws) expect(() => fieldKey(field, 'Enter')).toThrow('selection failed')
    else fieldKey(field, 'Enter')
    expect(field.debugState()).toMatchObject({ value: 'diag-hyp', popupVisible: true })
    field.dispose()
  })

  it('ignores an activation retained from the old grid after reopen', () => {
    setPopupTestContext()
    const field = createDropTreeGrid()
    inputField(field, 'gxyb')
    const activate = gridPopup(field)._grid.onActivate
    fieldKey(field, 'Escape')
    inputField(field, 'shxdgr')
    activate({ key: 'diag-hyp', row: { name: 'PriorityBeta', code: 'CODE10', category: 'Catalog' } })
    expect(field.debugState()).toMatchObject({ value: '', queryText: 'shxdgr', popupVisible: true })
    field.dispose()
  })

  it.each(['hidden', 'ancestor', 'disabled', 'readonly', 'detach', 'dispose'] as const)('ends field input and capture on %s', action => {
    setPopupTestContext()
    const parent = new RenderStackPanel()
    const field = createDropTreeGrid()
    parent.addChild(field)
    inputField(field, 'Catalog')
    const release = vi.fn()
    field.onPointerDown({ pointerId: 7, type: 'down', position: { x: 10, y: 10 }, setPointerCapture: vi.fn(), releasePointerCapture: release })
    if (action === 'hidden') field.visible = false
    if (action === 'ancestor') parent.visible = false
    if (action === 'disabled') field.disabled = true
    if (action === 'readonly') field.readonly = true
    if (action === 'detach') field.detach()
    if (action === 'dispose') field.dispose()
    expect(field.isFocused).toBe(false)
    expect(gridPopup(field).visible).toBe(false)
    expect(InputComposer.instance.hasSession).toBe(false)
    expect(release).toHaveBeenCalledOnce()
    parent.dispose()
  })

  it('keeps modal focus during expansion and clears popup resizing on close', () => {
    setPopupTestContext()
    const field = createDropTreeGrid()
    const scope = new FocusScope(FocusScopeType.Modal)
    scope.setFocusRoots([field]); scope.add(field)
    FocusManager.instance.pushScope(scope)
    inputField(field, 'gxyb')
    const popup = gridPopup(field)
    popup.paint(createTextRecordingPaintContext().context)
    const grid = popup._grid
    const cell = grid._cellGlobalRect(0, 0)
    const row = grid._visibleItems[0]
    const layout = grid._treeCellLayout(row, cell.x, cell.y, ImGuiDarkTheme, deriveGridCellStyle(ImGuiDarkTheme))
    const arrow = layout.arrowHitRect
    const position = { x: arrow.x + arrow.w / 2, y: arrow.y + arrow.h / 2 }
    PopupManager.instance.handlePointerDown({ pointerId: 3, type: 'down', position })
    PopupManager.instance.handlePointerUp({ pointerId: 3, type: 'up', position })
    expect(grid.expandedKeys).not.toContain('diag-root')
    expect(FocusManager.instance.current).toBe(field)
    expect(grid.isFocused).toBe(false)
    fieldKey(field, 'ArrowRight')
    expect(grid.expandedKeys).toContain('diag-root')
    const grip = popup.debugState().resizeGripRect
    const down = { pointerId: 8, type: 'down' as const, position: { x: grip.x + grip.w / 2, y: grip.y + grip.h / 2 } }
    popup.onPointerDown(down, PopupManager.instance.context)
    expect(popup._resizing).toBe(true)
    const initialWidth = popup.debugState().panelW
    popup.onPointerMove({ ...down, type: 'move', position: { x: down.position.x + 30, y: down.position.y + 20 } }, PopupManager.instance.context)
    expect(FocusManager.instance.current).toBe(field)
    popup.close()
    expect(popup._resizing).toBe(false)
    expect(popup.debugState().panelW).toBeGreaterThan(initialWidth)
    field.dispose()
    FocusManager.instance.popScope(null, scope)
  })

  it('does not revive a hidden press or consume once after redisplay', () => {
    setPopupTestContext()
    const field = createDropTreeGrid()
    const canvas = document.createElement('canvas'); document.body.appendChild(canvas)
    const dispatcher = new EventDispatcher(canvas); dispatcher.addRoot(field)
    const click = vi.fn()
    field.addPointerEventListener('pointeractivate', click, { once: true })
    const mouse = (type: string) => canvas.dispatchEvent(new MouseEvent(type, { clientX: 10, clientY: 10, bubbles: true, cancelable: true, button: 0 }))
    try {
      mouse('mousedown'); field.visible = false; field.visible = true
      field.performLayout(constraints, layoutContext); mouse('mouseup')
      expect(click).not.toHaveBeenCalled()
      mouse('mousedown'); mouse('mouseup')
      expect(click).toHaveBeenCalledOnce()
    } finally { dispatcher.dispose(); field.dispose(); canvas.remove() }
  })

  it('preserves the standalone pure-selection popup and keyboard behavior', () => {
    setPopupTestContext()
    const field = createDropTreeGrid()
    field.searchable = false
    field.requestFocus()
    expect(fieldKey(field, ' ')).toBe(true)
    expect(PopupManager.instance.current).toBe(gridPopup(field))
    expect(gridPopup(field)._grid.isFocused).toBe(true)
    expect(InputComposer.instance.hasSession).toBe(false)
    field.dispose()
  })
})
