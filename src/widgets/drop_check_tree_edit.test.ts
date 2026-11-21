// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoxConstraints, LayoutContext } from '../core/render_object'
import { FocusManager, FocusScope, FocusScopeType } from '../core/focus_manager'
import { InputComposer } from '../core/input_composer'
import { PopupManager } from '../core/popup_manager'
import { TextMeasurer } from '../core/text_measurer'
import { PaintContext } from '../rendering/paint_context'
import { ImGuiDarkTheme } from '../theme/default_theme'
import type { TreeNode } from './tree'
import { RenderStackPanel } from '../layout/render_flex'
import { EventDispatcher } from '../gestures/recognizers'
import { RenderDropCheckTreeEdit, defaultDropCheckTreeEditQueryProcessor } from './drop_check_tree_edit'

const constraints: BoxConstraints = {
  minWidth: 0,
  maxWidth: 220,
  minHeight: 0,
  maxHeight: 40,
}

const layoutContext: LayoutContext = { theme: ImGuiDarkTheme }

const departmentRoots: TreeNode<{ py?: string }>[] = [
  {
    key: 'dept-internal',
    label: 'Team group A',
    selectable: false,
    checkable: false,
    data: { py: 'nkxt' },
    children: [
      { key: 'dept-cardiology', label: 'TeamAlpha', data: { py: 'xnk' } },
      { key: 'dept-respiratory', label: 'TeamDevice', data: { py: 'hxk' } },
    ],
  },
  {
    key: 'dept-surgery',
    label: 'Team group B',
    selectable: false,
    checkable: false,
    data: { py: 'wkxt' },
    children: [
      { key: 'dept-general-surgery', label: 'TeamGeneral', data: { py: 'pwk' } },
      { key: 'dept-neurosurgery', label: 'TeamSpecial', data: { py: 'sjwk' } },
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
    viewport: { width: 640, height: 480, dpr: 1 },
  }))
}

function createDropCheckTree(checkedKeys: readonly string[] = []): RenderDropCheckTreeEdit<any> {
  const field = new RenderDropCheckTreeEdit({
    roots: departmentRoots,
    checkedKeys,
    placeholder: '检索适用Team范围',
    searchable: true,
    clearable: true,
    queryTextBuilder: node => [node.key, node.label, node.data?.py ?? ''],
  })
  field.performLayout(constraints, layoutContext)
  return field
}

function paintField(field: RenderDropCheckTreeEdit<any>): string[] {
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

function inputField(field: RenderDropCheckTreeEdit<any>, value: string): HTMLTextAreaElement {
  field.requestFocus()
  const input = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
  input.value = value
  input.setSelectionRange(value.length, value.length)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return input
}

describe('RenderDropCheckTreeEdit', () => {
  it('implements the array value editor contract with copied values and logical blur', () => {
    setPopupTestContext()
    const onChange = vi.fn()
    const valueChange = vi.fn()
    const blur = vi.fn()
    const field = new RenderDropCheckTreeEdit({
      roots: departmentRoots,
      checkedKeys: ['dept-cardiology'],
      onChange,
    })
    field.performLayout(constraints, layoutContext)
    field.subscribeValueChange(valueChange)
    field.subscribeBlur(blur)

    const modelValue = ['dept-general-surgery']
    field.setValue(modelValue)
    modelValue.push('dept-neurosurgery')

    expect(field.getValue()).toEqual(['dept-general-surgery'])
    expect(onChange).not.toHaveBeenCalled()
    expect(valueChange).not.toHaveBeenCalled()

    field.requestFocus()
    field.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))
    const popup = PopupManager.instance.top as any
    const selectedNodes = [departmentRoots[0]!.children![0]!]
    popup._onCheck(['dept-cardiology'], selectedNodes)

    expect(valueChange).toHaveBeenCalledWith({
      value: ['dept-cardiology'],
      previousValue: ['dept-general-surgery'],
      reason: 'selection',
      detail: selectedNodes,
    })
    expect(onChange).toHaveBeenCalledOnce()
    expect(blur).not.toHaveBeenCalled()

    field.blur()
    field.blur()

    expect(blur).toHaveBeenCalledOnce()
    field.dispose()
  })

  it.each(['disabled', 'readonly'] as const)(
    'publishes one logical blur when an open check tree editor becomes %s',
    state => {
      setPopupTestContext()
      const blur = vi.fn()
      const field = createDropCheckTree()
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

  it('keeps text editing open and toggles popup from the arrow', () => {
    setPopupTestContext()
    const field = createDropCheckTree()

    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    expect(PopupManager.instance.top).not.toBe(null)

    field.onPointerUp({ pointerId: 0, position: { x: 8, y: 8 }, type: 'up' })
    const arrow = (field as any)._triggerLayout().trailingRect
    field.onPointerDown({ pointerId: 0, position: { x: arrow.x + arrow.w / 2, y: arrow.y + arrow.h / 2 }, type: 'down' })
    expect(PopupManager.instance.top).toBe(null)
  })

  it('opens with typed query and filters tree roots through the default processor', () => {
    setPopupTestContext()
    const field = createDropCheckTree()
    FocusManager.instance.setFocus(field)

    const consumed = field.onKeyDown(new KeyboardEvent('keydown', {
      key: 'Device',
      bubbles: true,
      cancelable: true,
    }))

    expect(consumed).toBe(false)
    inputField(field, 'Device')
    const popup = PopupManager.instance.top as any
    expect(popup).not.toBe(null)
    expect(popup.searchText).toBe('Device')
    expect(popup.filteredRoots.map((node: TreeNode<any>) => node.label)).toEqual(['Team group A'])
    expect(popup.filteredRoots[0]?.children?.map((node: TreeNode<any>) => node.label)).toEqual(['TeamDevice'])
    expect(paintField(field)).toContain('Device')
  })

  it('does not execute the query processor from debugState', () => {
    setPopupTestContext()
    const queryProcessor = vi.fn(() => [departmentRoots[1]!])
    const field = new RenderDropCheckTreeEdit({
      roots: departmentRoots,
      searchable: true,
      queryProcessor,
    })
    field.performLayout(constraints, layoutContext)

    expect(field.debugState().filteredCount).toBe(6)
    expect(queryProcessor).not.toHaveBeenCalled()

    FocusManager.instance.setFocus(field)
    inputField(field, 'Team')
    expect(queryProcessor).toHaveBeenCalled()

    queryProcessor.mockClear()
    expect(field.debugState().filteredCount).toBe(3)
    expect(queryProcessor).not.toHaveBeenCalled()
  })

  it('closes query presentation on Escape Tab disabled and exposes checked debug state', () => {
    setPopupTestContext()
    const field = createDropCheckTree(['dept-cardiology'])
    FocusManager.instance.setFocus(field)

    inputField(field, 'Special')

    expect(field.debugState()).toMatchObject({
      popupVisible: true,
      queryText: 'Special',
      showQueryInField: true,
      displayText: 'Special',
      checkedKeys: ['dept-cardiology'],
      checkedLabel: 'TeamAlpha',
      filteredCount: 2,
    })
    expect(field.debugState().expandedKeys).toContain('dept-surgery')

    expect(field.onKeyDown(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))).toBe(false)
    expect(field.debugState()).toMatchObject({
      popupVisible: false,
      queryText: '',
      showQueryInField: false,
      displayText: 'TeamAlpha',
    })

    inputField(field, 'Special')
    field.disabled = true

    expect(field.debugState()).toMatchObject({
      popupVisible: false,
      queryText: '',
      showQueryInField: false,
      disabled: true,
      checkedKeys: ['dept-cardiology'],
      checkedLabel: 'TeamAlpha',
    })
  })

  it('commits checked leaf nodes through tree keyboard interaction and updates the summary', () => {
    setPopupTestContext()
    const onChange = vi.fn()
    const field = new RenderDropCheckTreeEdit({
      roots: departmentRoots,
      searchable: false,
      clearable: true,
      expandAllOnOpen: true,
      onChange,
    })
    field.performLayout(constraints, layoutContext)

    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    const popup = PopupManager.instance.top as any
    expect(popup).not.toBe(null)

    FocusManager.instance.setFocus(popup._tree)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))

    expect(field.checkedKeys).toEqual(['dept-cardiology'])
    expect(onChange).toHaveBeenCalledWith(
      ['dept-cardiology'],
      [expect.objectContaining({ key: 'dept-cardiology', label: 'TeamAlpha' })],
    )
    expect(paintField(field)).toContain('TeamAlpha')
  })

  it('does not grow collapsed parent rows when checking the parent checkbox', () => {
    setPopupTestContext()
    const field = new RenderDropCheckTreeEdit({
      roots: [{
        key: 'medical-tech',
        label: 'Team group C',
        children: [
          { key: 'lab', label: 'TeamInspection' },
          { key: 'imaging', label: '影像Team' },
        ],
      }],
      searchable: false,
    })
    field.performLayout(constraints, layoutContext)

    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    const popup = PopupManager.instance.top as any
    popup.paint(createTextRecordingPaintContext().context)
    const beforeLayout = popup._layout(PopupManager.instance.context)
    const tree = popup._tree as any
    const rowLayout = tree._rowLayout(tree._flatNodes[0], beforeLayout.treeRect.x, beforeLayout.treeRect.y, ImGuiDarkTheme)
    const checkboxRect = rowLayout.checkboxRect
    expect(checkboxRect).not.toBe(null)

    popup.onPointerDown({
      pointerId: 0,
      position: {
        x: checkboxRect.x + checkboxRect.w / 2,
        y: checkboxRect.y + checkboxRect.h / 2,
      },
      type: 'down',
    })

    const afterLayout = popup._layout(PopupManager.instance.context)
    expect(field.checkedKeys).toEqual(['lab', 'imaging'])
    expect(tree.expandedKeys).toEqual([])
    expect(afterLayout.panelH).toBe(beforeLayout.panelH)
    expect(afterLayout.treeRect.h).toBe(beforeLayout.treeRect.h)
  })

  it('consumes wheel inside the popup even when the tree itself does not overflow', () => {
    setPopupTestContext()
    const field = createDropCheckTree()

    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    const popup = PopupManager.instance.top as any
    const layout = popup._layout(PopupManager.instance.context)
    expect(PopupManager.instance.handleWheel({
      pointerId: 0,
      position: {
        x: layout.treeRect.x + 8,
        y: layout.treeRect.y + 8,
      },
      type: 'wheel',
      deltaX: 0,
      deltaY: 120,
    })).toBe(true)
  })

  it('clears checked keys from the trigger clear affordance', () => {
    setPopupTestContext()
    const onChange = vi.fn()
    const field = new RenderDropCheckTreeEdit({
      roots: departmentRoots,
      checkedKeys: ['dept-cardiology', 'dept-respiratory'],
      clearable: true,
      onChange,
    })
    field.performLayout(constraints, layoutContext)
    const clearRect = (field as any)._triggerLayout().clearRect as { x: number; y: number; w: number; h: number }

    field.onPointerDown({
      pointerId: 0,
      position: { x: clearRect.x + clearRect.w / 2, y: clearRect.y + clearRect.h / 2 },
      type: 'down',
    })

    expect(field.checkedKeys).toEqual([])
    expect(onChange).toHaveBeenCalledWith([], [])
  })

  it('syncs popup roots after rebinding while preserving checked keys', () => {
    setPopupTestContext()
    const field = createDropCheckTree(['dept-cardiology'])
    FocusManager.instance.setFocus(field)

    inputField(field, 'Team')

    const popup = PopupManager.instance.top as any
    field.roots = [
      {
        key: 'dept-support',
        label: 'TeamSupport',
        data: { py: 'zcpt' },
        children: [
          { key: 'dept-medical-record', label: 'TeamArchive', data: { py: 'bak' } },
        ],
      },
    ]

    expect(field.checkedKeys).toEqual(['dept-cardiology'])
    expect(popup._tree.roots.map((node: TreeNode<any>) => node.label)).toEqual(['TeamSupport'])
    expect(field.debugState().filteredCount).toBe(2)
  })

  it('does not open when readonly', () => {
    setPopupTestContext()
    const field = new RenderDropCheckTreeEdit({
      roots: departmentRoots,
      checkedKeys: ['dept-cardiology'],
      readonly: true,
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

  it('supports expandAllOnOpen and custom expandedKeysOnOpen strategies', () => {
    setPopupTestContext()
    const expandAllField = new RenderDropCheckTreeEdit({
      roots: departmentRoots,
      searchable: false,
      expandAllOnOpen: true,
    })
    expandAllField.performLayout(constraints, layoutContext)
    expandAllField.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })
    let popup = PopupManager.instance.top as any
    expect(popup._tree.expandedKeys).toEqual(['dept-internal', 'dept-surgery'])
    popup.close()

    const customField = new RenderDropCheckTreeEdit({
      roots: departmentRoots,
      searchable: false,
      checkedKeys: ['dept-general-surgery'],
      expandedKeysOnOpen: ['dept-internal'],
    })
    customField.performLayout(constraints, layoutContext)
    customField.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })
    popup = PopupManager.instance.top as any
    expect(popup._tree.expandedKeys).toEqual(['dept-internal', 'dept-surgery'])
  })

  it('exposes full checked labels in tooltip when the trigger summary is abbreviated or clipped', () => {
    const measureWidth = vi.spyOn(TextMeasurer, 'measureWidth').mockImplementation(text => String(text).length * 8)
    const field = new RenderDropCheckTreeEdit({
      roots: departmentRoots,
      checkedKeys: ['dept-cardiology', 'dept-respiratory', 'dept-general-surgery'],
      maxSummaryItems: 2,
    })
    field.performLayout({
      minWidth: 0,
      maxWidth: 72,
      minHeight: 0,
      maxHeight: 40,
    }, layoutContext)

    field.performPaint(createTextRecordingPaintContext().context, { x: 0, y: 0 })
    expect(field.tooltip).toBe('TeamAlpha、TeamDevice、TeamGeneral')
    expect(paintField(field).some(text => text.includes('...'))).toBe(true)

    field.performLayout({
      minWidth: 0,
      maxWidth: 280,
      minHeight: 0,
      maxHeight: 40,
    }, layoutContext)
    field.performPaint(createTextRecordingPaintContext().context, { x: 0, y: 0 })
    expect(field.tooltip).toBe('TeamAlpha、TeamDevice、TeamGeneral')

    measureWidth.mockRestore()
  })
})

function popupOf(field: RenderDropCheckTreeEdit<any>): any { return (field as any)._popup }
function keyField(field: RenderDropCheckTreeEdit<any>, key: string, options: KeyboardEventInit = {}): boolean {
  return field.onKeyDown(new KeyboardEvent('keydown', { key, cancelable: true, ...options }))
}
function checkNode(field: RenderDropCheckTreeEdit<any>, key: string): void {
  const popup = popupOf(field)
  popup.paint(createTextRecordingPaintContext().context)
  const tree = popup._tree
  const index = tree._flatNodes.findIndex((flat: any) => flat.node.key === key)
  const flat = tree._flatNodes[index]
  const g = tree.globalOffset
  const rect = tree._rowLayout(flat, g.x - tree._scrollX, g.y + index * tree._rowHeight - tree._scrollY, ImGuiDarkTheme).checkboxRect
  if (!rect) throw new Error(`No checkbox for ${key}`)
  const position = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
  PopupManager.instance.handlePointerDown({ pointerId: 3, type: 'down', position })
  PopupManager.instance.handlePointerUp({ pointerId: 3, type: 'up', position })
}

describe('DropCheckTreeEdit inline search', () => {
  it('keeps a newly checked value when a checkedKeys-dependent query removes it from the results', () => {
    setPopupTestContext()
    const field = createDropCheckTree()
    field.queryProcessor = ({ checkedKeys }) => departmentRoots.flatMap(root => {
      const children = root.children?.filter(node => !checkedKeys.includes(node.key)) ?? []
      return children.length ? [{ ...root, children }] : []
    })
    inputField(field, 'anything')
    popupOf(field)._tree.setNavigationKey('dept-cardiology')
    keyField(field, 'Enter')
    expect(field.checkedKeys).toEqual(['dept-cardiology'])
    expect(popupOf(field).navigationKey).toBe(null)
    keyField(field, 'Enter')
    expect(field.checkedKeys).toEqual(['dept-cardiology'])
    field.dispose()
  })

  it('keeps the native search empty instead of copying the summary and preserves hidden selections', () => {
    setPopupTestContext()
    const field = createDropCheckTree(['dept-cardiology'])
    const change = vi.fn(), valueChange = vi.fn(), blur = vi.fn()
    field.onChange = change; field.subscribeValueChange(valueChange); field.subscribeBlur(blur)
    expect(paintField(field)).toContain('TeamAlpha')
    field.requestFocus()
    const input = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    expect(input.value).toBe('')
    expect(paintField(field)).toContain('已选 1 项')
    inputField(field, 'Device')
    expect(popupOf(field)._layout(PopupManager.instance.context).searchRect).toBe(null)
    expect(keyField(field, 'Enter')).toBe(true)
    expect(change).not.toHaveBeenCalled()
    for (const key of ['dept-internal', 'dept-respiratory']) {
      keyField(field, 'ArrowDown'); expect(popupOf(field).navigationKey).toBe(key)
    }
    keyField(field, 'Enter')
    expect(field.checkedKeys).toEqual(['dept-cardiology', 'dept-respiratory'])
    expect(input.value).toBe('Device')
    expect(popupOf(field).visible).toBe(true)
    expect(popupOf(field)._tree.isFocused).toBe(false)
    expect(FocusManager.instance.current).toBe(field)
    expect(paintField(field)).toContain('已选 2 项')
    expect(valueChange).toHaveBeenCalledWith(expect.objectContaining({ value: ['dept-cardiology', 'dept-respiratory'], detail: departmentRoots[0]!.children }))
    expect(blur).not.toHaveBeenCalled()
    keyField(field, 'Escape')
    expect(field.debugState().displayText).toBe('TeamAlpha、TeamDevice')
    expect(input.value).toBe('')
    expect(change).toHaveBeenCalledOnce()
    field.dispose()
  })

  it('selects across queries and deselects only targets in the current result', () => {
    setPopupTestContext()
    const field = createDropCheckTree(['dept-cardiology'])
    inputField(field, 'Device'); checkNode(field, 'dept-respiratory')
    inputField(field, 'Special'); checkNode(field, 'dept-neurosurgery')
    expect(field.checkedKeys).toEqual(['dept-cardiology', 'dept-respiratory', 'dept-neurosurgery'])
    inputField(field, 'Device'); checkNode(field, 'dept-respiratory')
    expect(field.checkedKeys).toEqual(['dept-cardiology', 'dept-neurosurgery'])
    inputField(field, '')
    expect(popupOf(field)._tree.checkedKeys).toEqual(['dept-cardiology', 'dept-neurosurgery'])
    field.dispose()
  })

  it('limits parent check and half-check state to filtered targets without touching hidden selections', () => {
    setPopupTestContext()
    const field = new RenderDropCheckTreeEdit({ roots: [{ key: 'group', label: 'Group', children: [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }] }, { key: 'z', label: 'Zeta' }], checkedKeys: ['b', 'z'] })
    field.performLayout(constraints, layoutContext)
    inputField(field, 'Alpha')
    const tree = popupOf(field)._tree
    expect(tree.checkedKeys).toEqual([])
    checkNode(field, 'group')
    expect(field.checkedKeys).toEqual(['b', 'z', 'a'])
    expect(tree.halfCheckedKeys).toEqual([])
    expect(tree.checkedKeys).toEqual(['a'])
    checkNode(field, 'group')
    expect(field.checkedKeys).toEqual(['b', 'z'])
    inputField(field, '')
    expect(tree.halfCheckedKeys).toEqual(['group'])
    field.dispose()
  })

  it.each(['parent-only', 'custom-pruned', 'unknown'] as const)('never promotes %s into an artificial leaf value', mode => {
    setPopupTestContext()
    const roots: TreeNode[] = [{ key: 'parent', label: 'Group', children: [{ key: 'a', label: 'Alpha' }] }]
    const field = new RenderDropCheckTreeEdit({ roots, queryProcessor: mode === 'parent-only' ? undefined : () => mode === 'unknown' ? [{ key: 'foreign', label: 'Unknown' }] : [{ key: 'parent', label: 'Group' }] })
    field.performLayout(constraints, layoutContext)
    inputField(field, 'Group')
    expect(popupOf(field)._tree.roots[0].checkable).toBe(false)
    keyField(field, 'ArrowDown'); keyField(field, 'Enter')
    expect(field.checkedKeys).toEqual([])
    field.dispose()
  })

  it('caches queries for paints but refreshes their checkedKeys context when checks or controlled values change', () => {
    setPopupTestContext()
    const field = createDropCheckTree()
    const processor = vi.fn(defaultDropCheckTreeEditQueryProcessor(node => [node.key, node.label]))
    field.queryProcessor = processor
    inputField(field, 'Device')
    expect(processor).toHaveBeenCalledOnce()
    for (let i = 0; i < 3; i++) { paintField(field); popupOf(field).paint(createTextRecordingPaintContext().context); field.debugState() }
    expect(processor).toHaveBeenCalledOnce()
    field.checkedKeys = ['dept-cardiology']
    expect(processor).toHaveBeenCalledTimes(2)
    expect(processor.mock.calls[1]![0].checkedKeys).toEqual(['dept-cardiology'])
    checkNode(field, 'dept-respiratory')
    expect(processor).toHaveBeenCalledTimes(3)
    expect(processor.mock.calls[2]![0].checkedKeys).toEqual(['dept-cardiology', 'dept-respiratory'])
    expect(field.debugState().queryText).toBe('Device')
    field.dispose()
  })

  it('keeps query and stable navigation on reorder, clears removed targets and preserves unresolved values', () => {
    setPopupTestContext()
    const field = createDropCheckTree(['missing'])
    inputField(field, 'Team')
    popupOf(field)._tree.setNavigationKey('dept-respiratory')
    field.roots = [...departmentRoots].reverse()
    expect(popupOf(field).navigationKey).toBe('dept-respiratory')
    field.roots = [departmentRoots[1]!]
    expect(popupOf(field).navigationKey).toBe(null)
    keyField(field, 'Enter')
    expect(field.checkedKeys).toEqual(['missing'])
    expect(field.debugState().queryText).toBe('Team')
    field.dispose()
  })

  it('refreshes in-place data without canceling composition and resolves selected details from current full roots', () => {
    setPopupTestContext()
    const field = createDropCheckTree(['dept-cardiology'])
    field.roots = departmentRoots.map(root => ({ ...root, children: root.children?.map(node => ({ ...node })) }))
    const input = inputField(field, 'Device'), change = vi.fn()
    field.onChange = change
    input.dispatchEvent(new CompositionEvent('compositionstart'))
    input.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'Device' }))
    field.roots[0]!.children![1]!.label = '新TeamDevice'
    field.refreshTree()
    expect(document.getElementById('__ds_ui_input__')).toBe(input)
    expect(InputComposer.instance.composing).toBe(true)
    expect(keyField(field, 'Enter')).toBe(false)
    input.value = 'Device'; input.setSelectionRange(1, 1)
    input.dispatchEvent(new CompositionEvent('compositionend', { data: 'Device' }))
    keyField(field, 'ArrowDown'); keyField(field, 'ArrowDown'); keyField(field, 'Enter')
    expect(input.value).toBe('Device')
    expect(change.mock.calls[0]![1]).toEqual(field.roots[0]!.children)
    expect(change.mock.calls[0]![1][1]).toBe(field.roots[0]!.children![1])
    field.dispose()
  })

  it('retires IME on external setValue and ignores late events from its old native carrier', () => {
    setPopupTestContext()
    const field = createDropCheckTree(['dept-cardiology'])
    const old = inputField(field, 'Special')
    old.dispatchEvent(new CompositionEvent('compositionstart'))
    field.setValue(['dept-respiratory'])
    const current = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    expect(current).not.toBe(old)
    expect(current.value).toBe('')
    expect(field.debugState()).toMatchObject({ checkedKeys: ['dept-respiratory'], queryText: '', showQueryInField: false, popupVisible: false, displayText: 'TeamDevice' })
    old.value = '旧'; old.dispatchEvent(new CompositionEvent('compositionend', { data: '旧' })); old.dispatchEvent(new Event('input'))
    expect(field.debugState().popupVisible).toBe(false)
    expect(current.value).toBe('')
    expect(FocusManager.instance.current).toBe(field)
    field.dispose()
  })

  it('uses Space only for explicit candidate navigation and returns editing shortcuts to native input', () => {
    setPopupTestContext()
    const field = createDropCheckTree()
    inputField(field, 'Device')
    expect(keyField(field, ' ')).toBe(false)
    keyField(field, 'ArrowDown'); keyField(field, 'ArrowDown')
    expect(keyField(field, ' ')).toBe(true)
    expect(field.checkedKeys).toEqual(['dept-respiratory'])
    for (const [key, options] of [['Home', {}], ['End', {}], ['ArrowLeft', { shiftKey: true }], ['a', { ctrlKey: true }], ['Backspace', {}], ['x', {}]] as const) {
      keyField(field, 'ArrowDown')
      expect(keyField(field, key, options)).toBe(false)
      expect(popupOf(field).navigationKey).toBe(null)
    }
    expect(field.checkedKeys).toEqual(['dept-respiratory'])
    field.dispose()
  })

  it('keeps count and buttons outside text selection and distinguishes query editing from clearing all values', () => {
    setPopupTestContext()
    const field = createDropCheckTree(['dept-cardiology']), change = vi.fn()
    field.onChange = change
    const input = inputField(field, 'alpha beta')
    field.onDoubleClick?.({ x: (field as any)._triggerLayout().valueRect.x + 8, y: 10 })
    expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(5)
    const count = (field as any)._countRect(), position = { x: count.x + count.w / 2, y: 10 }
    field.onPointerDown({ type: 'down', pointerId: 5, position })
    field.onDoubleClick?.(position)
    expect(input.selectionEnd).toBe(5)
    field.onPointerMove({ type: 'move', pointerId: 5, position })
    expect(field.tooltip).toBe('TeamAlpha')
    expect(keyField(field, 'Backspace')).toBe(false)
    inputField(field, '')
    expect(field.checkedKeys).toEqual(['dept-cardiology'])
    const clear = (field as any)._triggerLayout().clearRect, clearPos = { x: clear.x + clear.w / 2, y: 10 }
    field.onPointerMove({ type: 'move', pointerId: 5, position: clearPos })
    expect(field.tooltip).toBe('清空全部选择')
    field.onPointerDown({ type: 'down', pointerId: 5, position: clearPos })
    expect(field.checkedKeys).toEqual([])
    expect(change).toHaveBeenCalledWith([], [])
    expect(input.value).toBe('')
    field.dispose()
  })

  it('preserves summaryBuilder output without feeding its text back into the native search', () => {
    setPopupTestContext()
    const field = createDropCheckTree(['dept-cardiology'])
    field.summaryBuilder = () => '自定义范围'
    expect(paintField(field)).toContain('自定义范围')
    field.requestFocus()
    expect((document.getElementById('__ds_ui_input__') as HTMLTextAreaElement).value).toBe('')
    keyField(field, 'Escape')
    expect(paintField(field)).toContain('自定义范围')
    expect(field.debugState().queryText).toBe('')
    field.dispose()
  })

  it.each(['set-value', 'disabled', 'readonly', 'dispose', 'rebind', 'pure', 'roundtrip'] as const)('rejects a query invalidated by %s', action => {
    setPopupTestContext()
    const field = createDropCheckTree()
    const processor = vi.fn(context => {
      if (action === 'set-value') field.setValue(['dept-cardiology'])
      if (action === 'disabled') field.disabled = true
      if (action === 'readonly') field.readonly = true
      if (action === 'dispose') field.dispose()
      if (action === 'rebind') field.roots = [...context.roots]
      if (action === 'pure' || action === 'roundtrip') { field.searchable = false; if (action === 'roundtrip') field.searchable = true }
      return context.roots
    })
    field.queryProcessor = processor
    inputField(field, 'Device')
    expect(processor).toHaveBeenCalledOnce()
    expect(popupOf(field).visible).toBe(false)
    field.dispose()
  })

  it.each([false, true])('does not refresh or close a new popup reopened by a check callback, throws=%s', throws => {
    setPopupTestContext()
    const field = createDropCheckTree()
    const values = vi.fn(); field.subscribeValueChange(values)
    inputField(field, 'Device')
    keyField(field, 'ArrowDown'); keyField(field, 'ArrowDown')
    const old = popupOf(field)._tree
    field.onChange = () => { field.blur(); field.requestFocus(); keyField(field, 'Enter'); if (throws) throw new Error('checked callback') }
    if (throws) expect(() => keyField(field, 'Enter')).toThrow('checked callback')
    else keyField(field, 'Enter')
    expect(popupOf(field).visible).toBe(true)
    expect(popupOf(field)._tree).not.toBe(old)
    expect(field.checkedKeys).toEqual(['dept-respiratory'])
    expect(values).toHaveBeenCalledOnce()
    field.dispose()
  })

  it('ignores callbacks retained from a disposed popup tree', () => {
    setPopupTestContext()
    const field = createDropCheckTree()
    inputField(field, 'Device')
    const old = popupOf(field)._tree.onCheck
    keyField(field, 'Escape'); inputField(field, 'Special')
    old({ checkedKeys: ['dept-respiratory'], checkedNodes: [departmentRoots[0]!.children![1]!] })
    expect(field.checkedKeys).toEqual([])
    expect(field.debugState().queryText).toBe('Special')
    field.dispose()
  })

  it.each(['self', 'ancestor', 'readonly', 'disabled', 'detach', 'dispose'] as const)('ends query and text capture on %s without changing checked values', action => {
    setPopupTestContext()
    const parent = new RenderStackPanel(), field = createDropCheckTree(['dept-cardiology'])
    parent.addChild(field)
    inputField(field, 'Device')
    const release = vi.fn()
    field.onPointerDown({ pointerId: 7, type: 'down', position: { x: 15, y: 10 }, setPointerCapture: vi.fn(), releasePointerCapture: release })
    if (action === 'self') field.visible = false
    if (action === 'ancestor') parent.visible = false
    if (action === 'readonly') field.readonly = true
    if (action === 'disabled') field.disabled = true
    if (action === 'detach') field.detach()
    if (action === 'dispose') field.dispose()
    expect(popupOf(field).visible).toBe(false)
    expect(field.isFocused).toBe(false)
    expect(InputComposer.instance.hasSession).toBe(false)
    expect(release).toHaveBeenCalledOnce()
    expect(field.checkedKeys).toEqual(['dept-cardiology'])
    parent.dispose()
  })

  it('invalidates an old text press after hide and redisplay without consuming once', () => {
    setPopupTestContext()
    const field = createDropCheckTree()
    const canvas = document.createElement('canvas'); document.body.appendChild(canvas)
    const dispatcher = new EventDispatcher(canvas); dispatcher.addRoot(field)
    const click = vi.fn(); field.addPointerEventListener('pointeractivate', click, { once: true })
    const mouse = (type: string) => canvas.dispatchEvent(new MouseEvent(type, { clientX: 12, clientY: 10, button: 0, bubbles: true, cancelable: true }))
    try {
      mouse('mousedown'); field.visible = false; field.visible = true
      field.performLayout(constraints, layoutContext); mouse('mouseup')
      expect(click).not.toHaveBeenCalled()
      mouse('mousedown'); mouse('mouseup')
      expect(click).toHaveBeenCalledOnce()
    } finally { dispatcher.dispose(); field.dispose(); canvas.remove() }
  })

  it('keeps navigation and native focus inside a modal scope', () => {
    setPopupTestContext()
    const field = createDropCheckTree()
    const scope = new FocusScope(FocusScopeType.Modal); scope.setFocusRoots([field]); scope.add(field)
    FocusManager.instance.pushScope(scope)
    inputField(field, 'Device'); checkNode(field, 'dept-respiratory')
    expect(FocusManager.instance.current).toBe(field)
    expect(field.checkedKeys).toEqual(['dept-respiratory'])
    expect(popupOf(field)._tree.isFocused).toBe(false)
    field.dispose(); FocusManager.instance.popScope(null, scope)
  })

  it('prevents Enter default submission even when opening query processing throws', () => {
    setPopupTestContext()
    const field = createDropCheckTree()
    field.requestFocus(); field.queryProcessor = () => { throw new Error('query failed') }
    const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    expect(() => field.onKeyDown(event)).toThrow('query failed')
    expect(event.defaultPrevented).toBe(true)
    expect(popupOf(field).visible).toBe(false)
    field.dispose()
  })
})
