// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoxConstraints, LayoutContext } from '../core/render_object'
import { FocusManager, FocusScope, FocusScopeType } from '../core/focus_manager'
import { InputComposer } from '../core/input_composer'
import { PopupManager } from '../core/popup_manager'
import { TextMeasurer } from '../core/text_measurer'
import { PaintContext } from '../rendering/paint_context'
import { deriveTreeStyle } from '../theme/component_styles'
import { ImGuiDarkTheme } from '../theme/default_theme'
import type { TreeNode } from './tree'
import { EventDispatcher } from '../gestures/recognizers'
import { RenderWindow } from './window'
import { RenderStackPanel } from '../layout/render_flex'
import { RenderDropTreeEdit, defaultDropTreeEditQueryProcessor } from './drop_tree_edit'

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

function createDropTree(value = ''): RenderDropTreeEdit<any> {
  const field = new RenderDropTreeEdit({
    roots: departmentRoots,
    value,
    placeholder: '检索Team目录',
    searchable: true,
    clearable: true,
    queryTextBuilder: node => [node.key, node.label, node.data?.py ?? ''],
  })
  field.performLayout(constraints, layoutContext)
  return field
}

function paintField(field: RenderDropTreeEdit<any>): string[] {
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

function inputField(field: RenderDropTreeEdit<any>, value: string): HTMLTextAreaElement {
  field.requestFocus()
  const textarea = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
  textarea.value = value
  textarea.setSelectionRange(value.length, value.length)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  return textarea
}

describe('RenderDropTreeEdit', () => {
  it('implements the value editor contract without blurring during popup selection', () => {
    setPopupTestContext()
    const onChange = vi.fn()
    const valueChange = vi.fn()
    const blur = vi.fn()
    const field = new RenderDropTreeEdit({
      roots: departmentRoots,
      value: 'dept-cardiology',
      onChange,
    })
    field.performLayout(constraints, layoutContext)
    field.subscribeValueChange(valueChange)
    field.subscribeBlur(blur)

    field.setValue('dept-general-surgery')

    expect(field.getValue()).toBe('dept-general-surgery')
    expect(onChange).not.toHaveBeenCalled()
    expect(valueChange).not.toHaveBeenCalled()

    field.requestFocus()
    field.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))
    const popup = PopupManager.instance.top as any
    popup._select(departmentRoots[0]!.children![1]!)

    expect(valueChange).toHaveBeenCalledWith({
      value: 'dept-respiratory',
      previousValue: 'dept-general-surgery',
      reason: 'selection',
      detail: departmentRoots[0]!.children![1]!,
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
    const field = new RenderDropTreeEdit({
      roots: departmentRoots,
      value: 'dept-cardiology',
      onChange,
    })
    field.performLayout(constraints, layoutContext)
    field.subscribeValueChange(valueChange)

    field.requestFocus()
    field.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))
    const popup = PopupManager.instance.top as any
    popup._select(departmentRoots[0]!.children![0]!)

    expect(onChange).toHaveBeenCalledOnce()
    expect(valueChange).not.toHaveBeenCalled()
    expect(field.getValue()).toBe('dept-cardiology')
    expect(field.debugState().popupVisible).toBe(false)
    expect(field.isFocused).toBe(true)

    field.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))
    popup._select(departmentRoots[0]!.children![1]!)

    expect(onChange).toHaveBeenCalledTimes(2)
    expect(valueChange).toHaveBeenCalledOnce()
    expect(valueChange).toHaveBeenCalledWith({
      value: 'dept-respiratory',
      previousValue: 'dept-cardiology',
      reason: 'selection',
      detail: departmentRoots[0]!.children![1]!,
    })
    field.dispose()
  })

  it.each(['disabled', 'readonly'] as const)(
    'publishes one logical blur when an open tree editor becomes %s',
    state => {
      setPopupTestContext()
      const blur = vi.fn()
      const field = createDropTree()
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

  it('keeps text clicks editable and toggles the popup from the arrow', () => {
    setPopupTestContext()
    const field = createDropTree()

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
    const field = createDropTree()
    FocusManager.instance.setFocus(field)

    inputField(field, 'Device')
    const popup = PopupManager.instance.top as any
    expect(popup).not.toBe(null)
    expect(popup.searchText).toBe('Device')
    expect(popup.filteredRoots.map((node: TreeNode<any>) => node.label)).toEqual(['Team group A'])
    expect(popup.filteredRoots[0]?.children?.map((node: TreeNode<any>) => node.label)).toEqual(['TeamDevice'])
    expect(paintField(field)).toContain('Device')
  })

  it('closes query presentation on Escape Tab disabled and exposes expanded debug state', () => {
    setPopupTestContext()
    const field = createDropTree('dept-cardiology')
    FocusManager.instance.setFocus(field)

    inputField(field, 'Special')

    expect(field.debugState()).toMatchObject({
      popupVisible: true,
      queryText: 'Special',
      showQueryInField: true,
      displayText: 'Special',
      value: 'dept-cardiology',
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
      value: 'dept-cardiology',
    })
  })

  it('uses custom queryProcessor to control filtered tree order', () => {
    setPopupTestContext()
    const queryProcessor = vi.fn(() => [departmentRoots[1]!, departmentRoots[0]!])
    const field = new RenderDropTreeEdit({
      roots: departmentRoots,
      searchable: true,
      queryProcessor,
    })
    field.performLayout(constraints, layoutContext)
    FocusManager.instance.setFocus(field)

    inputField(field, 'Team')

    const popup = PopupManager.instance.top as any
    expect(queryProcessor).toHaveBeenCalled()
    expect(popup.filteredRoots.map((node: TreeNode<any>) => node.label)).toEqual(['Team group B', 'Team group A'])
  })

  it('does not execute the query processor from debugState', () => {
    setPopupTestContext()
    const queryProcessor = vi.fn(() => [departmentRoots[1]!])
    const field = new RenderDropTreeEdit({
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

  it('commits selection and renders the selected node label', () => {
    setPopupTestContext()
    const onChange = vi.fn()
    const field = new RenderDropTreeEdit({
      roots: departmentRoots,
      onChange,
      clearable: true,
    })
    field.performLayout(constraints, layoutContext)
    FocusManager.instance.setFocus(field)

    inputField(field, 'Device')
    const popup = PopupManager.instance.top as any
    popup._select({ key: 'dept-respiratory', label: 'TeamDevice', data: { py: 'hxk' } })

    expect(field.value).toBe('dept-respiratory')
    expect(onChange).toHaveBeenCalledWith(
      'dept-respiratory',
      expect.objectContaining({ key: 'dept-respiratory', label: 'TeamDevice' }),
    )
    expect(paintField(field)).toContain('TeamDevice')
  })

  it('consumes wheel inside the popup even when the tree itself does not overflow', () => {
    setPopupTestContext()
    const field = createDropTree()

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

  it('centers the no-match hint inside the tree viewport', () => {
    setPopupTestContext()
    const field = createDropTree()
    FocusManager.instance.setFocus(field)
    inputField(field, '无')

    const popup = PopupManager.instance.top as any
    expect(popup.filteredRoots).toHaveLength(0)
    const painted = createTextRecordingPaintContext()
    popup.paint(painted.context)
    const layout = popup._layout(PopupManager.instance.context)
    const hint = painted.fillText.mock.calls.find(call => call[0] === '无匹配节点')

    expect(hint).toBeDefined()
    expect(Math.abs(hint![1] - (layout.treeRect.x + layout.treeRect.w / 2))).toBeLessThanOrEqual(0.5)
    expect(Math.abs(hint![2] - (layout.treeRect.y + layout.treeRect.h / 2))).toBeLessThanOrEqual(0.5)
  })

  it('syncs popup tree roots when the external roots change while open', () => {
    setPopupTestContext()
    const field = createDropTree()
    FocusManager.instance.setFocus(field)

    inputField(field, 'Team')

    const popup = PopupManager.instance.top as any
    expect(popup._tree.roots.map((node: TreeNode<any>) => node.label)).toEqual(['Team group A', 'Team group B'])

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

    expect(field.value).toBe('')
    expect(popup._tree.roots.map((node: TreeNode<any>) => node.label)).toEqual(['TeamSupport'])
    expect(field.debugState().filteredCount).toBe(2)
  })

  it('syncs popup tree selection when the external value changes while open', () => {
    setPopupTestContext()
    const field = createDropTree('dept-cardiology')
    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    const popup = PopupManager.instance.top as any
    expect(popup.selectedValue).toBe('dept-cardiology')
    expect(popup._tree.selectedKey).toBe('dept-cardiology')

    field.value = 'dept-neurosurgery'

    expect(popup.selectedValue).toBe('dept-neurosurgery')
    expect(popup._tree.selectedKey).toBe('dept-neurosurgery')
  })

  it('reveals the current selection inside the popup viewport when opened', () => {
    setPopupTestContext()
    const roots = Array.from({ length: 16 }, (_, index) => ({
      key: `dept-${index}`,
      label: `Team ${index}`,
    }))
    const field = new RenderDropTreeEdit({
      roots,
      value: 'dept-12',
    })
    field.performLayout(constraints, layoutContext)

    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    const popup = PopupManager.instance.top as any
    const painted = createTextRecordingPaintContext()
    popup.paint(painted.context)

    expect(popup._tree.debugState().scrollY).toBeGreaterThan(0)
  })

  it('restores the selected label after closing an uncommitted query', () => {
    setPopupTestContext()
    const field = createDropTree('dept-cardiology')
    FocusManager.instance.setFocus(field)

    inputField(field, 'Special')
    expect(paintField(field)).toContain('Special')

    const popup = PopupManager.instance.top as any
    popup.close()

    expect(paintField(field)).toContain('TeamAlpha')
    expect(paintField(field)).not.toContain('Special')
  })

  it('does not persist search-expanded branches into the normal expanded state', () => {
    setPopupTestContext()
    const field = createDropTree()

    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    let popup = PopupManager.instance.top as any
    popup._tree.expandedKeys = ['dept-internal']
    popup.close()

    inputField(field, 'Team')

    popup = PopupManager.instance.top as any
    expect(popup._tree.expandedKeys).toEqual(['dept-internal', 'dept-surgery'])
    popup.close()

    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    popup = PopupManager.instance.top as any
    expect(popup._tree.expandedKeys).toEqual(['dept-internal'])
  })

  it('can expand specific branches on open through business-provided keys', () => {
    setPopupTestContext()
    const field = new RenderDropTreeEdit({
      roots: departmentRoots,
      expandedKeysOnOpen: ['dept-surgery'],
    })
    field.performLayout(constraints, layoutContext)

    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    const popup = PopupManager.instance.top as any
    expect(popup._tree.expandedKeys).toEqual(['dept-surgery'])
  })

  it('can expand all branches on open when configured', () => {
    setPopupTestContext()
    const field = new RenderDropTreeEdit({
      roots: departmentRoots,
      expandAllOnOpen: true,
    })
    field.performLayout(constraints, layoutContext)

    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    const popup = PopupManager.instance.top as any
    expect(popup._tree.expandedKeys).toEqual(['dept-internal', 'dept-surgery'])
  })

  it('does not commit category nodes and only leaf nodes become selected values', () => {
    setPopupTestContext()
    const onChange = vi.fn()
    const field = new RenderDropTreeEdit({
      roots: departmentRoots,
      onChange,
    })
    field.performLayout(constraints, layoutContext)

    field.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    const popup = PopupManager.instance.top as any
    popup._select({ key: 'dept-internal', label: 'Team group A', selectable: false })

    expect(field.value).toBe('')
    expect(onChange).not.toHaveBeenCalled()

    popup._select({ key: 'dept-cardiology', label: 'TeamAlpha' })

    expect(field.value).toBe('dept-cardiology')
    expect(onChange).toHaveBeenCalledWith('dept-cardiology', expect.objectContaining({ key: 'dept-cardiology' }))
  })

  it('ellipsizes selected trigger text when width is constrained', () => {
    const measureWidth = vi.spyOn(TextMeasurer, 'measureWidth').mockImplementation(text => String(text).length * 8)
    const field = new RenderDropTreeEdit({
      roots: [
        {
          key: 'root',
          label: '目录',
          selectable: false,
          children: [{ key: 'long', label: '非常长的业务Team名称' }],
        },
      ],
      value: 'long',
    })
    field.performLayout({
      minWidth: 0,
      maxWidth: 72,
      minHeight: 0,
      maxHeight: 40,
    }, layoutContext)

    expect(paintField(field).some(text => text.includes('...'))).toBe(true)

    measureWidth.mockRestore()
  })

  it('does not open popup when readonly and unregisters from focus order', () => {
    setPopupTestContext()
    const field = new RenderDropTreeEdit({
      roots: departmentRoots,
      value: 'dept-cardiology',
      readonly: true,
      clearable: true,
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
    expect(field.isFocused).toBe(false)

    const consumed = field.onKeyDown(new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    }))
    expect(consumed).toBe(false)
    expect(PopupManager.instance.top).toBe(null)
    expect(field.value).toBe('dept-cardiology')
    expect(FocusManager.instance.scopeStack[0]?.focusables.includes(field)).toBe(false)
  })
})

function treePopup(field: RenderDropTreeEdit<any>): any { return (field as any)._popup }
function treeKey(field: RenderDropTreeEdit<any>, key: string, options: KeyboardEventInit = {}): boolean {
  return field.onKeyDown(new KeyboardEvent('keydown', { key, cancelable: true, ...options }))
}

describe('DropTreeEdit field input and owned navigation', () => {
  it('keeps real focus in the field and requires explicit candidate navigation before Enter', () => {
    setPopupTestContext()
    const field = createDropTree()
    const change = vi.fn(), blur = vi.fn()
    field.onChange = change
    field.subscribeBlur(blur)
    const textarea = inputField(field, 'xnk')
    expect(treePopup(field).debugState().searchable).toBe(false)
    expect(treePopup(field)._tree.isFocused).toBe(false)
    expect(FocusManager.instance.current).toBe(field)
    expect(document.activeElement).toBe(textarea)
    expect(treeKey(field, 'Enter')).toBe(true)
    expect(change).not.toHaveBeenCalled()
    expect(treePopup(field).navigationKey).toBe(null)
    treeKey(field, 'ArrowDown')
    expect(treePopup(field).navigationKey).toBe('dept-internal')
    treeKey(field, 'Enter')
    expect(change).not.toHaveBeenCalled()
    treeKey(field, 'ArrowDown')
    expect(treePopup(field).navigationKey).toBe('dept-cardiology')
    treeKey(field, 'Enter')
    expect(field.value).toBe('dept-cardiology')
    expect(textarea.value).toBe('TeamAlpha')
    expect(change).toHaveBeenCalledOnce()
    expect(blur).not.toHaveBeenCalled()
    field.dispose()
  })

  it('routes horizontal arrows to the tree only in navigation mode and returns editing keys to the input', () => {
    setPopupTestContext()
    const field = createDropTree()
    inputField(field, 'Team')
    expect(treeKey(field, 'ArrowLeft')).toBe(false)
    treeKey(field, 'ArrowDown')
    treeKey(field, 'ArrowRight')
    expect(treePopup(field).navigationKey).toBe('dept-cardiology')
    treeKey(field, 'ArrowLeft')
    expect(treePopup(field).navigationKey).toBe('dept-internal')
    for (const [key, options] of [['Home', {}], ['End', {}], ['ArrowLeft', { ctrlKey: true }], ['ArrowRight', { shiftKey: true }], [' ', {}], ['Delete', {}]] as const) {
      treeKey(field, 'ArrowDown')
      expect(treeKey(field, key, options)).toBe(false)
      expect(treePopup(field).navigationKey).toBe(null)
    }
    expect(field.value).toBe('')
    expect(FocusManager.instance.current).toBe(field)
    field.dispose()
  })

  it('consumes empty or category-only Enter without submitting a form or choosing an ancestor', () => {
    setPopupTestContext()
    const field = createDropTree()
    const parent = new RenderStackPanel()
    parent.addChild(field)
    const submit = vi.fn(), change = vi.fn()
    ;(parent as any).handleUnhandledKeyDownFromDescendant = submit
    field.onChange = change
    inputField(field, 'missing')
    FocusManager.instance.handleKeyDownEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    expect(submit).not.toHaveBeenCalled()
    inputField(field, 'Team group A')
    expect(treePopup(field).filteredRoots[0].children).toBeUndefined()
    treeKey(field, 'ArrowDown')
    treeKey(field, 'Enter')
    expect(change).not.toHaveBeenCalled()
    expect(field.value).toBe('')
    parent.dispose()
  })

  it('restores normal expansion after clearing search and does not save search folding', () => {
    setPopupTestContext()
    const field = createDropTree()
    field.requestFocus()
    treeKey(field, 'Enter')
    treeKey(field, 'ArrowDown')
    treeKey(field, 'ArrowRight')
    expect(field.debugState().expandedKeys).toEqual(['dept-internal'])
    inputField(field, 'Team')
    expect(field.debugState().expandedKeys).toEqual(['dept-internal', 'dept-surgery'])
    treeKey(field, 'ArrowDown')
    treeKey(field, 'ArrowLeft')
    expect(field.debugState().expandedKeys).not.toContain('dept-internal')
    inputField(field, ' ')
    expect(field.debugState().expandedKeys).toEqual(['dept-internal'])
    treeKey(field, 'Escape')
    treeKey(field, 'Enter')
    expect(field.debugState().expandedKeys).toEqual(['dept-internal'])
    field.dispose()
  })

  it('honors explicit open expansion over remembered state and prunes invalid keys', () => {
    setPopupTestContext()
    const field = createDropTree('dept-cardiology')
    field.expandedKeysOnOpen = ['missing', 'dept-surgery']
    field.requestFocus()
    treeKey(field, 'Enter')
    expect(field.debugState().expandedKeys).toEqual(['dept-surgery', 'dept-internal'])
    treePopup(field)._tree.expandedKeys = ['dept-internal']
    treeKey(field, 'Escape')
    treeKey(field, 'Enter')
    expect(field.debugState().expandedKeys).toEqual(['dept-surgery', 'dept-internal'])
    field.dispose()
  })

  it('caches query results across paints and diagnostics and refreshes only on data/query changes', () => {
    setPopupTestContext()
    const field = createDropTree()
    const processor = vi.fn(defaultDropTreeEditQueryProcessor(node => [node.key, node.label]))
    field.queryProcessor = processor
    inputField(field, 'Team')
    expect(processor).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 3; i++) {
      paintField(field)
      treePopup(field).paint(createTextRecordingPaintContext().context)
      treePopup(field).debugState()
      field.debugState()
    }
    expect(processor).toHaveBeenCalledTimes(1)
    field.refreshTree()
    expect(processor).toHaveBeenCalledTimes(2)
    field.dispose()
  })

  it('preserves the active key across reorder and clears it when roots remove the node', () => {
    setPopupTestContext()
    const field = createDropTree()
    const textarea = inputField(field, 'Team')
    treeKey(field, 'ArrowDown')
    treeKey(field, 'ArrowDown')
    expect(treePopup(field).navigationKey).toBe('dept-cardiology')
    field.roots = [...departmentRoots].reverse()
    expect(treePopup(field).navigationKey).toBe('dept-cardiology')
    expect(textarea.value).toBe('Team')
    field.roots = [departmentRoots[1]!]
    expect(treePopup(field).navigationKey).toBe(null)
    treeKey(field, 'Enter')
    expect(field.value).toBe('')
    expect(treePopup(field).visible).toBe(true)
    field.dispose()
  })

  it('keeps query and IME base during roots updates, then filters the committed composition', () => {
    setPopupTestContext()
    const field = createDropTree('dept-cardiology')
    const textarea = inputField(field, 'hxk')
    textarea.dispatchEvent(new CompositionEvent('compositionstart'))
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: '心' }))
    field.roots = departmentRoots.map(root => ({ ...root, children: root.children?.map(node => ({ ...node, label: node.key === 'dept-cardiology' ? '新TeamAlpha' : node.label })) }))
    expect(document.getElementById('__ds_ui_input__')).toBe(textarea)
    expect(textarea.value).toBe('hxk')
    expect(InputComposer.instance.composing).toBe(true)
    expect(field.debugState().queryText).toBe('hxk')
    expect(treePopup(field).filteredRoots[0].children.map((node: TreeNode) => node.key)).toEqual(['dept-respiratory'])
    expect(treeKey(field, 'Enter')).toBe(false)
    textarea.value = 'xnk'
    textarea.setSelectionRange(3, 3)
    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '心' }))
    treeKey(field, 'ArrowDown')
    treeKey(field, 'Enter')
    expect(textarea.value).toBe('新TeamAlpha')
    field.dispose()
  })

  it.each([false, true])('isolates delayed IME after setValue with popup open=%s', open => {
    setPopupTestContext()
    const field = createDropTree('dept-cardiology')
    field.requestFocus()
    const old = open ? inputField(field, 'Team') : document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    old.dispatchEvent(new CompositionEvent('compositionstart'))
    old.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'Device' }))
    field.setValue('dept-neurosurgery')
    const current = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    expect(current).not.toBe(old)
    expect(current.value).toBe('TeamSpecial')
    old.value = 'Device'
    old.dispatchEvent(new CompositionEvent('compositionend', { data: 'Device' }))
    old.dispatchEvent(new Event('input'))
    expect(current.value).toBe('TeamSpecial')
    expect(field.debugState()).toMatchObject({ value: 'dept-neurosurgery', popupVisible: false, showQueryInField: false })
    field.dispose()
  })

  it('syncs a rebound selected label without input and keeps an unresolved value', () => {
    const field = createDropTree('dept-cardiology')
    field.requestFocus()
    const textarea = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    field.roots = [{ key: 'dept-cardiology', label: '新Team' }]
    expect(textarea.value).toBe('新Team')
    field.roots = []
    expect(textarea.value).toBe('')
    expect(field.value).toBe('dept-cardiology')
    field.dispose()
  })

  it.each(['disabled', 'dispose', 'rebind'] as const)('does not publish an invalid query after callback %s', action => {
    setPopupTestContext()
    const field = createDropTree()
    const processor = vi.fn(context => {
      if (action === 'disabled') field.disabled = true
      if (action === 'dispose') field.dispose()
      if (action === 'rebind') field.roots = [...context.roots]
      return [...context.roots]
    })
    field.queryProcessor = processor
    inputField(field, 'Team')
    expect(processor).toHaveBeenCalledOnce()
    expect(field.debugState().popupVisible).toBe(false)
    if (action !== 'rebind') expect(InputComposer.instance.hasSession).toBe(false)
    field.dispose()
  })

  it('clears stale navigation when an explicit query refresh throws', () => {
    setPopupTestContext()
    const field = createDropTree()
    inputField(field, 'Team')
    treeKey(field, 'ArrowDown')
    field.queryProcessor = () => { throw new Error('query failed') }
    expect(() => field.refreshTree()).toThrow('query failed')
    expect(treePopup(field).navigationKey).toBe(null)
    expect(field.debugState().filteredCount).toBe(0)
    expect(treeKey(field, 'Enter')).toBe(true)
    expect(field.value).toBe('')
    field.dispose()
  })

  it.each([false, true])('preserves a popup reopened by a selection callback, throws=%s', throws => {
    setPopupTestContext()
    const field = createDropTree()
    inputField(field, 'xnk')
    treeKey(field, 'ArrowDown')
    treeKey(field, 'ArrowDown')
    field.onChange = () => {
      treeKey(field, 'ArrowDown')
      if (throws) throw new Error('callback failed')
    }
    if (throws) expect(() => treeKey(field, 'Enter')).toThrow('callback failed')
    else treeKey(field, 'Enter')
    expect(field.value).toBe('dept-cardiology')
    expect(field.debugState().popupVisible).toBe(true)
    field.dispose()
  })

  it.each(['hidden', 'ancestor', 'readonly', 'disabled', 'detach', 'dispose'] as const)('ends input and capture on %s', action => {
    setPopupTestContext()
    const parent = new RenderStackPanel()
    const field = createDropTree()
    parent.addChild(field)
    inputField(field, 'Team')
    const release = vi.fn()
    field.onPointerDown({ pointerId: 1, type: 'down', position: { x: 10, y: 10 }, setPointerCapture: vi.fn(), releasePointerCapture: release })
    if (action === 'hidden') field.visible = false
    if (action === 'ancestor') parent.visible = false
    if (action === 'readonly') field.readonly = true
    if (action === 'disabled') field.disabled = true
    if (action === 'detach') field.detach()
    if (action === 'dispose') field.dispose()
    expect(field.isFocused).toBe(false)
    expect(field.debugState().popupVisible).toBe(false)
    expect(InputComposer.instance.hasSession).toBe(false)
    expect(release).toHaveBeenCalledOnce()
    parent.dispose()
  })

  it('keeps modal input focus when clicking an expander and a leaf', () => {
    setPopupTestContext()
    const field = createDropTree()
    const scope = new FocusScope(FocusScopeType.Modal)
    scope.setFocusRoots([field])
    scope.add(field)
    FocusManager.instance.pushScope(scope)
    inputField(field, 'xnk')
    const popup = treePopup(field)
    popup.paint(createTextRecordingPaintContext().context)
    const tree = popup._tree
    const row = tree.nodeRect('dept-internal')
    const arrowX = tree.globalOffset.x + deriveTreeStyle(ImGuiDarkTheme).paddingH + tree.debugState().indentWidth / 2
    const position = { x: arrowX, y: row.y + row.height / 2 }
    PopupManager.instance.handlePointerDown({ pointerId: 2, type: 'down', position })
    PopupManager.instance.handlePointerUp({ pointerId: 2, type: 'up', position })
    expect(FocusManager.instance.current).toBe(field)
    expect(tree.isFocused).toBe(false)
    expect(tree.expandedKeys).not.toContain('dept-internal')
    expect(InputComposer.instance.hasSession).toBe(true)
    treeKey(field, 'ArrowRight')
    expect(tree.expandedKeys).toContain('dept-internal')
    popup.paint(createTextRecordingPaintContext().context)
    const leaf = tree.nodeRect('dept-cardiology')
    const leafPoint = { x: leaf.x + 100, y: leaf.y + leaf.height / 2 }
    PopupManager.instance.handlePointerDown({ pointerId: 3, type: 'down', position: leafPoint })
    PopupManager.instance.handlePointerUp({ pointerId: 3, type: 'up', position: leafPoint })
    expect(field.value).toBe('dept-cardiology')
    expect(FocusManager.instance.current).toBe(field)
    field.dispose()
    FocusManager.instance.popScope(null, scope)
  })

  it('preserves the standalone popup keyboard and search mode for nonsearchable fields', () => {
    setPopupTestContext()
    const field = createDropTree()
    field.searchable = false
    field.requestFocus()
    treeKey(field, ' ')
    expect(PopupManager.instance.current).toBe(treePopup(field))
    expect(treePopup(field)._tree.isFocused).toBe(true)
    expect(InputComposer.instance.hasSession).toBe(false)
    expect(treePopup(field)._tree.handleOwnedKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))).toBe(false)
    field.dispose()
  })
})

it('routes owned tree navigation through the field window and honors capture cancellation', () => {
  setPopupTestContext()
  const main = new RenderWindow({ title: 'Main', width: 500, height: 300 })
  const child = new RenderWindow({ title: 'A', width: 400, height: 200 })
  const field = createDropTree('dept-cardiology')
  main.addChild(child)
  child.addChild(field)
  const outer = vi.fn()
  main.addKeyboardEventListener('keydown', outer)
  const off = child.addKeyboardEventListener('keydown', event => event.preventDefault(), { capture: true })
  inputField(field, 'xnk')
  FocusManager.instance.handleKeyDownEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }))
  expect(treePopup(field).navigationKey).toBe(null)
  off()
  FocusManager.instance.handleKeyDownEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }))
  expect(treePopup(field).navigationKey).toBe('dept-cardiology')
  expect(outer).not.toHaveBeenCalled()
  main.dispose()
})

it('does not revive a hidden text press or consume once after the field is shown again', () => {
  setPopupTestContext()
  const field = createDropTree()
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  const dispatcher = new EventDispatcher(canvas)
  dispatcher.addRoot(field)
  const click = vi.fn()
  field.addPointerEventListener('pointeractivate', click, { once: true })
  const mouse = (type: string) => canvas.dispatchEvent(new MouseEvent(type, { clientX: 10, clientY: 10, bubbles: true, cancelable: true, button: 0 }))
  try {
    mouse('mousedown')
    field.visible = false
    field.visible = true
    field.performLayout(constraints, layoutContext)
    mouse('mouseup')
    expect(click).not.toHaveBeenCalled()
    mouse('mousedown')
    mouse('mouseup')
    expect(click).toHaveBeenCalledOnce()
  } finally { dispatcher.dispose(); field.dispose(); canvas.remove() }
})

it('ignores an activation retained from an older candidate tree after reopen', () => {
  setPopupTestContext()
  const field = createDropTree()
  inputField(field, 'xnk')
  const old = treePopup(field)._tree.onActivate
  treeKey(field, 'Escape')
  inputField(field, 'hxk')
  old({ key: 'dept-cardiology', label: 'TeamAlpha' })
  expect(field.value).toBe('')
  expect(field.debugState()).toMatchObject({ popupVisible: true, queryText: 'hxk' })
  field.dispose()
})

it('does not retain a failed opening query for later closed-state data refreshes', () => {
  setPopupTestContext()
  const field = createDropTree()
  field.requestFocus()
  const query = vi.fn(() => { throw new Error('opening failed') })
  field.queryProcessor = query
  expect(() => treeKey(field, 'Enter')).toThrow('opening failed')
  expect(field.debugState().popupVisible).toBe(false)
  query.mockClear()
  field.roots = [...departmentRoots]
  field.refreshTree()
  field.debugState()
  expect(query).not.toHaveBeenCalled()
  field.queryProcessor = context => [...context.roots]
  treeKey(field, 'Enter')
  expect(field.debugState().popupVisible).toBe(true)
  field.dispose()
})


describe('DropTreeEdit opening navigation and query cancellation', () => {
  it.each([
    ['ArrowDown', '', 'dept-internal'],
    ['ArrowUp', '', 'dept-surgery'],
    ['ArrowDown', 'dept-cardiology', 'dept-cardiology'],
    ['ArrowUp', 'dept-cardiology', 'dept-cardiology'],
  ] as const)('opens and establishes navigation on the first %s with value %s', (key, value, expected) => {
    setPopupTestContext()
    const field = createDropTree(value)
    const change = vi.fn()
    field.onChange = change
    field.requestFocus()
    const event = new KeyboardEvent('keydown', { key, cancelable: true })
    expect(field.onKeyDown(event)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(field.debugState().popupVisible).toBe(true)
    expect(treePopup(field).navigationKey).toBe(expected)
    expect(field.value).toBe(value)
    expect(change).not.toHaveBeenCalled()
    expect(FocusManager.instance.current).toBe(field)
    field.dispose()
  })

  it('respects external cancellation before opening or invoking a query', () => {
    setPopupTestContext()
    const field = createDropTree()
    const query = vi.fn(context => [...context.roots])
    field.queryProcessor = query
    field.requestFocus()
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true })
    event.preventDefault()
    expect(field.onKeyDown(event)).toBe(false)
    expect(field.debugState().popupVisible).toBe(false)
    expect(query).not.toHaveBeenCalled()
    field.dispose()
  })

  it.each(['set-value', 'pure-mode', 'mode-roundtrip'] as const)('rejects the old opening query after callback %s', action => {
    setPopupTestContext()
    const field = createDropTree()
    const change = vi.fn(), formalChange = vi.fn()
    field.onChange = change
    field.subscribeValueChange(formalChange)
    const base = defaultDropTreeEditQueryProcessor<any>(node => [node.key, node.label, node.data?.py ?? ''])
    const query = vi.fn(context => {
      if (action === 'set-value') field.setValue('dept-neurosurgery')
      else {
        field.searchable = false
        if (action === 'mode-roundtrip') field.searchable = true
      }
      return base(context)
    })
    field.queryProcessor = query
    inputField(field, 'xnk')
    expect(query).toHaveBeenCalledOnce()
    expect(field.debugState()).toMatchObject({ popupVisible: false, queryText: '', showQueryInField: false })
    expect(change).not.toHaveBeenCalled()
    expect(formalChange).not.toHaveBeenCalled()
    if (action === 'set-value') {
      expect(field.value).toBe('dept-neurosurgery')
      expect((document.getElementById('__ds_ui_input__') as HTMLTextAreaElement).value).toBe('TeamSpecial')
    }
    field.queryProcessor = base
    if (action === 'pure-mode') {
      expect(InputComposer.instance.hasSession).toBe(false)
      expect(treeKey(field, ' ')).toBe(true)
      expect(PopupManager.instance.current).toBe(treePopup(field))
      expect(treePopup(field)._tree.isFocused).toBe(true)
      expect(InputComposer.instance.hasSession).toBe(false)
      treePopup(field).close()
      field.searchable = true
    }
    inputField(field, 'hxk')
    treeKey(field, 'ArrowDown')
    treeKey(field, 'ArrowDown')
    treeKey(field, 'Enter')
    expect(field.value).toBe('dept-respiratory')
    expect(change).toHaveBeenCalledOnce()
    expect(formalChange).toHaveBeenCalledOnce()
    field.dispose()
  })

  it('cancels a visible query refresh on setValue without invalidating later roots-only refreshes', () => {
    setPopupTestContext()
    const field = createDropTree('dept-cardiology')
    inputField(field, 'Team')
    field.queryProcessor = context => {
      field.setValue('dept-neurosurgery')
      return [...context.roots]
    }
    field.refreshTree()
    expect(field.debugState()).toMatchObject({ popupVisible: false, queryText: '', value: 'dept-neurosurgery' })
    field.queryProcessor = defaultDropTreeEditQueryProcessor(node => [node.key, node.label])
    const textarea = inputField(field, 'Team')
    field.roots = [...departmentRoots].reverse()
    expect(field.debugState()).toMatchObject({ popupVisible: true, queryText: 'Team' })
    expect(textarea.value).toBe('Team')
    treeKey(field, 'ArrowDown')
    expect(treePopup(field).navigationKey).toBe('dept-neurosurgery')
    field.dispose()
  })
})
