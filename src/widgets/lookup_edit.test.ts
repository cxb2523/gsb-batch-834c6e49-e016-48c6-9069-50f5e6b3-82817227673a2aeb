// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoxConstraints, LayoutContext, RenderObject, Offset } from '../core/render_object'
import { InputComposer } from '../core/input_composer'
import { FocusManager, FocusScope, FocusScopeType } from '../core/focus_manager'
import { PopupManager } from '../core/popup_manager'
import { TextMeasurer } from '../core/text_measurer'
import { PaintContext } from '../rendering/paint_context'
import { ImGuiDarkTheme } from '../theme/default_theme'
import { DropdownGridPopup } from './grid/popup/dropdown_grid_popup'
import { GestureArenaManager, type GestureArenaMember } from '../gestures/gesture_arena'
import { RenderStackPanel } from '../layout/render_flex'
import { RenderWindow } from './window'
import { EventDispatcher } from '../gestures/recognizers'
import { RenderLookupEdit } from './lookup_edit'

const constraints: BoxConstraints = {
  minWidth: 0,
  maxWidth: 220,
  minHeight: 0,
  maxHeight: 40,
}

const layoutContext: LayoutContext = { theme: ImGuiDarkTheme }

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

const catalogRows = [
  { code: 'DX001', name: 'DeviceAlpha', icd: 'CODE06' },
  { code: 'DX002', name: 'PriorityBeta', icd: 'CODE10' },
  { code: 'DX003', name: '支气管炎', icd: 'J20.900' },
]

function createLookup(value = ''): RenderLookupEdit<any> {
  const lookup = new RenderLookupEdit({
    columns: [
      { key: 'code', title: '编码', width: 88 },
      { key: 'name', title: 'Item name' },
      { key: 'icd', title: 'CODE', width: 96 },
    ],
    rows: catalogRows,
    valueKey: 'code',
    labelKey: 'name',
    value,
    placeholder: '输入关键字检索Catalog',
    searchable: true,
    clearable: true,
  })
  lookup.performLayout(constraints, layoutContext)
  return lookup
}

function paintLookup(lookup: RenderLookupEdit<any>): string[] {
  const painted = createTextRecordingPaintContext()
  lookup.performPaint(painted.context, { x: 0, y: 0 })
  return painted.fillText.mock.calls.map(call => String(call[0]))
}

const pointerCleanup: Array<() => void> = []

afterEach(() => {
  for (const dispose of pointerCleanup.splice(0).reverse()) dispose()
  PopupManager.instance.dispose()
  FocusManager.instance.dispose()
  InputComposer.instance.dispose()
  vi.restoreAllMocks()
})

function inputText(lookup: RenderLookupEdit<any>, value: string): void {
  FocusManager.instance.setFocus(lookup)
  const textarea = (document.getElementById('__ds_ui_input__') as HTMLTextAreaElement)
  textarea.value = value
  textarea.setSelectionRange(value.length, value.length)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

function pointerHarness(lookup: RenderLookupEdit<any>, root: RenderObject = lookup) {
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  const dispatcher = new EventDispatcher(canvas)
  dispatcher.addRoot(root)
  pointerCleanup.push(() => { dispatcher.dispose(); root.dispose(); canvas.remove() })
  const mouse = (type: string, options: MouseEventInit = {}) => canvas.dispatchEvent(new MouseEvent(type, {
    button: 0, bubbles: true, cancelable: true, ...options,
  }))
  const click = (position: Offset, detail = 1) => {
    mouse('mousedown', { clientX: position.x, clientY: position.y, detail })
    mouse('mouseup', { clientX: position.x, clientY: position.y, detail })
  }
  const doubleClick = (position: Offset) => {
    click(position)
    click(position, 2)
    mouse('dblclick', { clientX: position.x, clientY: position.y, detail: 2 })
  }
  return { mouse, click, doubleClick }
}

describe('RenderLookupEdit', () => {
  it('delivers independent text clicks and excludes arrow clear decorations and helper text', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    lookup.prefixText = '前缀'
    lookup.suffixText = '后缀'
    lookup.helperText = '帮助'
    lookup.performLayout(constraints, layoutContext)
    const clicks = vi.fn()
    const doubles = vi.fn()
    lookup.addTextPointerEventListener('pointeractivate', clicks)
    lookup.addTextPointerEventListener('dblclick', doubles)
    const { click, doubleClick } = pointerHarness(lookup)
    const layout = (lookup as any)._triggerLayout()
    const center = (rect: { x: number; y: number; w: number; h: number }) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 })
    for (const rect of [layout.prefixRect, layout.suffixRect, layout.trailingRect]) doubleClick(center(rect))
    doubleClick({ x: 10, y: lookup.size.height - 1 })
    expect(clicks).not.toHaveBeenCalled()
    expect(doubles).not.toHaveBeenCalled()
    click(center(layout.clearRect))
    expect(lookup.value).toBe('')
    expect(clicks).not.toHaveBeenCalled()
    // The clear button disappeared into the text viewport; its release is still not a text click.
    const valueRect = (lookup as any)._triggerLayout().valueRect
    click({ x: valueRect.x + 5, y: valueRect.y + valueRect.h / 2 })
    expect(clicks).toHaveBeenCalledOnce()
    expect(clicks.mock.calls[0]![0].target).toBe(lookup)
    expect(clicks.mock.calls[0]![0].type).toBe('pointeractivate')
  })

  it('keeps caret placement and default word selection after text listeners run', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    lookup.rows = [{ code: 'DX001', name: 'alpha beta' }]
    const events: string[] = []
    lookup.addTextPointerEventListener('pointeractivate', () => events.push('click'))
    lookup.addTextPointerEventListener('dblclick', () => events.push('double'))
    const { click, doubleClick } = pointerHarness(lookup)
    const rect = (lookup as any)._triggerLayout().valueRect
    const position = { x: rect.x + 10, y: rect.y + rect.h / 2 }
    click(position)
    const textarea = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 10])
    click({ ...position, x: position.x + 20 })
    expect(textarea.selectionStart).toBe(textarea.selectionEnd)
    doubleClick(position)
    expect(events).toEqual(['click', 'click', 'click', 'click', 'double'])
    expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe('alpha')
  })

  it('cancels default double-click selection with preventDefault while stopPropagation preserves it', () => {
    setPopupTestContext()
    const parent = new RenderStackPanel()
    parent.size = { width: 300, height: 100 }
    const lookup = createLookup('DX001')
    lookup.rows = [{ code: 'DX001', name: 'alpha beta' }]
    parent.addChild(lookup)
    const parentDouble = vi.fn()
    parent.addPointerEventListener('dblclick', parentDouble)
    const off = lookup.addTextPointerEventListener('dblclick', event => event.preventDefault())
    const { doubleClick } = pointerHarness(lookup, parent)
    const rect = (lookup as any)._triggerLayout().valueRect
    const position = { x: rect.x + 10, y: rect.y + 10 }
    doubleClick(position)
    const textarea = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    expect(textarea.selectionStart).toBe(textarea.selectionEnd)
    expect(parentDouble).toHaveBeenCalledOnce()
    off()
    parentDouble.mockClear()
    lookup.addTextPointerEventListener('dblclick', event => event.stopPropagation())
    // Reset logical click continuity by moving beyond the double-click distance.
    doubleClick({ ...position, x: position.x + 10 })
    expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe('alpha')
    expect(parentDouble).not.toHaveBeenCalled()
  })

  it('supports once duplicate registration and cancellation without consuming once on arrow clicks', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    const once = vi.fn()
    const normal = vi.fn()
    lookup.addTextPointerEventListener('pointeractivate', once, { once: true })
    const off = lookup.addTextPointerEventListener('pointeractivate', normal)
    lookup.addTextPointerEventListener('pointeractivate', normal)
    const captured = vi.fn()
    lookup.addTextPointerEventListener('pointeractivate', captured, { capture: true })
    lookup.removeTextPointerEventListener('pointeractivate', captured, { capture: true })
    const { click } = pointerHarness(lookup)
    const layout = (lookup as any)._triggerLayout()
    click({ x: layout.trailingRect.x + 2, y: 10 })
    expect(once).not.toHaveBeenCalled()
    const position = { x: layout.valueRect.x + 10, y: 10 }
    click(position)
    click({ ...position, x: position.x + 10 })
    expect(once).toHaveBeenCalledOnce()
    expect(normal).toHaveBeenCalledTimes(2)
    expect(captured).not.toHaveBeenCalled()
    off()
    off()
    click({ ...position, x: position.x + 20 })
    expect(normal).toHaveBeenCalledTimes(2)
  })

  it('removes once text listeners before reentrant activation and clears listeners on dispose', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    const { click } = pointerHarness(lookup)
    const once = vi.fn(() => click({ x: 30, y: 10 }))
    lookup.addTextPointerEventListener('pointeractivate', once, { once: true })
    click({ x: 10, y: 10 })
    expect(once).toHaveBeenCalledOnce()
    const listener = vi.fn()
    lookup.addTextPointerEventListener('pointeractivate', listener)
    lookup.removeTextPointerEventListener('pointeractivate', listener)
    click({ x: 50, y: 10 })
    expect(listener).not.toHaveBeenCalled()
    lookup.addTextPointerEventListener('pointeractivate', listener)
    lookup.dispose()
    expect((lookup as any)._textPointerListeners).toHaveLength(0)
    const off = lookup.addTextPointerEventListener('pointeractivate', listener)
    off()
    expect((lookup as any)._textPointerListeners).toHaveLength(0)
  })

  it.each(['self', 'ancestor'] as const)('does not activate an interrupted text press after hiding and showing %s', hiddenTarget => {
    setPopupTestContext()
    const parent = new RenderStackPanel()
    parent.size = { width: 300, height: 100 }
    const lookup = createLookup('DX001')
    parent.addChild(lookup)
    const clickListener = vi.fn()
    const onceClick = vi.fn()
    const doubleListener = vi.fn()
    const onceDouble = vi.fn()
    lookup.addTextPointerEventListener('pointeractivate', clickListener)
    lookup.addTextPointerEventListener('pointeractivate', onceClick, { once: true })
    lookup.addTextPointerEventListener('dblclick', doubleListener)
    lookup.addTextPointerEventListener('dblclick', onceDouble, { once: true })
    const { mouse, click, doubleClick } = pointerHarness(lookup, parent)
    mouse('mousedown', { clientX: 10, clientY: 10 })
    const target = hiddenTarget === 'self' ? lookup : parent
    target.visible = false
    target.visible = true
    // A real layout restores the hidden box before release, so identity alone must reject the old press.
    parent.size = { width: 300, height: 100 }
    lookup.performLayout(constraints, layoutContext)
    mouse('mouseup', { clientX: 10, clientY: 10 })
    expect(clickListener).not.toHaveBeenCalled()
    expect(onceClick).not.toHaveBeenCalled()
    expect(doubleListener).not.toHaveBeenCalled()
    expect(onceDouble).not.toHaveBeenCalled()
    expect(lookup.isFocused).toBe(false)
    click({ x: 10, y: 10 })
    expect(clickListener).toHaveBeenCalledOnce()
    expect(clickListener.mock.calls[0]![0].clickCount).toBe(1)
    expect(onceClick).toHaveBeenCalledOnce()
    expect(doubleListener).not.toHaveBeenCalled()
    doubleClick({ x: 20, y: 10 })
    expect(doubleListener).toHaveBeenCalledOnce()
    expect(onceDouble).toHaveBeenCalledOnce()
    expect(onceClick).toHaveBeenCalledOnce()
    expect(lookup.isFocused).toBe(true)
    const textarea = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    expect(textarea.selectionEnd).toBeGreaterThan(textarea.selectionStart)
  })

  it('does not turn a hidden second press into a double click or consume its once listener', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    const clicks = vi.fn()
    const onceDouble = vi.fn()
    lookup.addTextPointerEventListener('pointeractivate', clicks)
    lookup.addTextPointerEventListener('dblclick', onceDouble, { once: true })
    const { mouse, click, doubleClick } = pointerHarness(lookup)
    click({ x: 10, y: 10 })
    mouse('mousedown', { clientX: 10, clientY: 10, detail: 2 })
    lookup.visible = false
    lookup.visible = true
    lookup.performLayout(constraints, layoutContext)
    mouse('mouseup', { clientX: 10, clientY: 10, detail: 2 })
    mouse('dblclick', { clientX: 10, clientY: 10, detail: 2 })
    expect(clicks).toHaveBeenCalledOnce()
    expect(onceDouble).not.toHaveBeenCalled()
    expect(lookup.isFocused).toBe(false)
    doubleClick({ x: 10, y: 10 })
    expect(onceDouble).toHaveBeenCalledOnce()
    expect(clicks.mock.calls.slice(1).map(call => call[0].clickCount)).toEqual([1, 2])
    expect(lookup.isFocused).toBe(true)
  })

  it('does not emit text clicks for drag selection or cancelled pointer sequences', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    const listener = vi.fn()
    lookup.addTextPointerEventListener('pointeractivate', listener)
    const { mouse } = pointerHarness(lookup)
    mouse('mousedown', { clientX: 10, clientY: 10 })
    mouse('mousemove', { clientX: 70, clientY: 10 })
    mouse('mouseup', { clientX: 70, clientY: 10 })
    expect(listener).not.toHaveBeenCalled()
    mouse('mousedown', { clientX: 10, clientY: 10 })
    lookup.visible = false
    mouse('mouseup', { clientX: 10, clientY: 10 })
    expect(listener).not.toHaveBeenCalled()
  })

  it.each(['disabled', 'readonly', 'select-only', 'disposed'] as const)('does not invoke text listeners while %s', state => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    const listener = vi.fn()
    lookup.addTextPointerEventListener('pointeractivate', listener)
    lookup.addTextPointerEventListener('dblclick', listener)
    const { doubleClick } = pointerHarness(lookup)
    if (state === 'disabled') lookup.disabled = true
    if (state === 'readonly') lookup.readonly = true
    if (state === 'select-only') lookup.searchable = false
    if (state === 'disposed') lookup.dispose()
    doubleClick({ x: 10, y: 10 })
    expect(listener).not.toHaveBeenCalled()
  })


  it.each(['replace', 'refresh'] as const)('synchronizes a rebound label and clamps the field selection via %s', mode => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    lookup.rows = lookup.rows.map(row => ({ ...row }))
    const onChange = vi.fn()
    lookup.onChange = onChange
    lookup.requestFocus()
    const textarea = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    textarea.setSelectionRange(2, 6)
    const rows = lookup.rows.map(row => row.code === 'DX001' ? { ...row, name: 'New' } : row)
    if (mode === 'replace') lookup.rows = rows
    else {
      lookup.rows[0] = rows[0]!
      lookup.refreshLookup()
    }
    expect(lookup.debugState().displayText).toBe('New')
    expect(textarea.value).toBe('New')
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 3])
    expect(lookup.value).toBe('DX001')
    expect(lookup.debugState().popupVisible).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
    textarea.setRangeText('X', textarea.selectionStart, textarea.selectionEnd, 'end')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    expect(lookup.debugState().queryText).toBe('NeX')
    lookup.dispose()
  })

  it('keeps full selection after a longer label is rebound and clears stale input when the selected row disappears', () => {
    const lookup = createLookup('DX001')
    lookup.requestFocus()
    const textarea = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    lookup.rows = [{ code: 'DX001', name: '重新绑定后的较长Item name' }]
    expect(textarea.value).toBe('重新绑定后的较长Item name')
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, textarea.value.length])
    lookup.rows = []
    expect(textarea.value).toBe('')
    expect(lookup.debugState()).toMatchObject({ value: 'DX001', displayText: '' })
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 0])
    lookup.dispose()
  })

  it('preserves draft input and selection when query results are rebound or explicitly refreshed', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    inputText(lookup, 'Priority')
    const textarea = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    textarea.setSelectionRange(1, 2)
    lookup.rows = [{ code: 'DX001', name: '已改名' }, { code: 'DX002', name: 'PriorityBeta' }]
    lookup.refreshLookup()
    expect(textarea.value).toBe('Priority')
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([1, 2])
    expect(lookup.debugState()).toMatchObject({ queryText: 'Priority', displayText: 'Priority', value: 'DX001', filteredCount: 1 })
    lookup.dispose()
  })

  it('keeps the composition base and native selection stable while the selected label is rebound', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    lookup.requestFocus()
    const textarea = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    textarea.dispatchEvent(new CompositionEvent('compositionstart'))
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'Priority' }))
    lookup.rows = [{ code: 'DX001', name: '重新绑定后的较长Item name' }, catalogRows[1]!]
    expect(textarea.value).toBe('DeviceAlpha')
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 'DeviceAlpha'.length])
    expect(paintLookup(lookup)).toEqual(['Priority'])
    textarea.value = 'Priority'
    textarea.setSelectionRange(1, 1)
    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: 'Priority' }))
    expect(lookup.debugState()).toMatchObject({ queryText: 'Priority', filteredCount: 1, value: 'DX001' })
    lookup.dispose()
  })

  it.each([false, true])('ends input and selection capture when an ancestor is hidden with popup open=%s', popupOpen => {
    setPopupTestContext()
    const parent = new RenderStackPanel()
    const nested = new RenderStackPanel()
    const lookup = createLookup('DX001')
    parent.addChild(nested)
    nested.addChild(lookup)
    const blur = vi.fn()
    lookup.subscribeBlur(blur)
    inputText(lookup, 'Priority')
    const releasePointerCapture = vi.fn()
    if (popupOpen) {
      lookup.onPointerDown({ pointerId: 5, type: 'down', position: { x: 30, y: 10 }, setPointerCapture: vi.fn(), releasePointerCapture })
    } else lookup.onKeyDown(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    parent.visible = false
    expect(lookup.debugState()).toMatchObject({ focused: false, popupVisible: false, queryText: '', value: 'DX001' })
    expect(InputComposer.instance.hasSession).toBe(false)
    expect(FocusManager.instance.current).not.toBe(lookup)
    expect(blur).toHaveBeenCalledOnce()
    expect(releasePointerCapture).toHaveBeenCalledTimes(popupOpen ? 1 : 0)
    parent.visible = true
    expect(lookup.isFocused).toBe(false)
    lookup.requestFocus()
    expect((document.getElementById('__ds_ui_input__') as HTMLTextAreaElement).value).toBe('DeviceAlpha')
    parent.dispose()
  })

  it('preserves focus and the input session outside the hidden subtree during blur reentry', () => {
    setPopupTestContext()
    const parent = new RenderStackPanel()
    const lookup = createLookup('DX001')
    const next = createLookup('DX002')
    parent.addChild(lookup)
    inputText(lookup, 'Priority')
    lookup.subscribeBlur(() => next.requestFocus())
    parent.visible = false
    expect(lookup.debugState()).toMatchObject({ focused: false, popupVisible: false })
    expect(FocusManager.instance.current).toBe(next)
    expect(InputComposer.instance.hasSession).toBe(true)
    expect((document.getElementById('__ds_ui_input__') as HTMLTextAreaElement).value).toBe('PriorityBeta')
    parent.dispose()
    next.dispose()
  })

  it('finishes hidden-subtree cleanup even when a blur callback throws', () => {
    setPopupTestContext()
    const parent = new RenderStackPanel()
    const lookup = createLookup('DX001')
    parent.addChild(lookup)
    inputText(lookup, 'Priority')
    lookup.subscribeBlur(() => { throw new Error('blur failed') })
    expect(() => { parent.visible = false }).toThrow('blur failed')
    expect(parent.visible).toBe(false)
    expect(parent.size).toEqual({ width: 0, height: 0 })
    expect(lookup.debugState()).toMatchObject({ focused: false, popupVisible: false, queryText: '' })
    expect(InputComposer.instance.hasSession).toBe(false)
    expect(FocusManager.instance.current).not.toBe(lookup)
    parent.dispose()
  })


  it('keeps draft edits separate from the committed value and clears only via the clear button', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    const onChange = vi.fn()
    lookup.onChange = onChange
    lookup.requestFocus()
    const textarea = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 'DeviceAlpha'.length])
    inputText(lookup, 'Priority')
    inputText(lookup, '')
    expect(lookup.value).toBe('DX001')
    expect(lookup.debugState()).toMatchObject({ displayText: '', filteredCount: 3 })
    expect(onChange).not.toHaveBeenCalled()
    const clear = (lookup as any)._triggerLayout().clearRect
    lookup.onPointerDown({ pointerId: 1, type: 'down', position: { x: clear.x + 1, y: clear.y + 1 } })
    expect(lookup.value).toBe('')
    expect(textarea.value).toBe('')
    expect(onChange).toHaveBeenCalledWith('', null)
    lookup.dispose()
  })

  it('cancels on Escape and Tab without accepting the highlighted row', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    const next = createLookup()
    const onChange = vi.fn()
    lookup.onChange = onChange
    inputText(lookup, 'Priority')
    const textarea = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    expect(FocusManager.instance.handleKeyDownEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))).toBe(true)
    expect(textarea.value).toBe('DeviceAlpha')
    expect(lookup.value).toBe('DX001')
    inputText(lookup, 'Priority')
    FocusManager.instance.handleKeyDownEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
    expect(FocusManager.instance.current).toBe(next)
    expect(lookup.debugState()).toMatchObject({ popupVisible: false, displayText: 'DeviceAlpha' })
    expect(onChange).not.toHaveBeenCalled()
    lookup.dispose()
    next.dispose()
  })

  it('waits for IME commit and leaves composition navigation keys to the input', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    inputText(lookup, '')
    const textarea = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    textarea.dispatchEvent(new CompositionEvent('compositionstart'))
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'Priority' }))
    expect(paintLookup(lookup)).toContain('Priority')
    const popup = PopupManager.instance.top as DropdownGridPopup
    const index = popup.debugState().keyboardIndex
    for (const key of ['Enter', 'Escape', 'ArrowDown', 'ArrowUp']) {
      expect(lookup.onKeyDown(new KeyboardEvent('keydown', { key, cancelable: true }))).toBe(false)
      expect(popup.onKeyDown(new KeyboardEvent('keydown', { key, isComposing: true, cancelable: true }))).toBe(false)
    }
    expect(popup.debugState().keyboardIndex).toBe(index)
    expect(lookup.value).toBe('DX001')
    textarea.value = 'Priority'
    textarea.setSelectionRange(1, 1)
    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: 'Priority' }))
    expect(lookup.debugState()).toMatchObject({ queryText: 'Priority', filteredCount: 1 })
    FocusManager.instance.handleKeyDownEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    expect(lookup.value).toBe('DX002')
    lookup.dispose()
  })

  it('preserves a new popup opened from a selection callback', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    lookup.onChange = () => lookup.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }))
    inputText(lookup, 'Priority')
    lookup.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    expect(lookup.debugState()).toMatchObject({ value: 'DX002', popupVisible: true, queryText: '' })
    expect((PopupManager.instance.top as DropdownGridPopup).debugState().filteredRows).toHaveLength(3)
    lookup.dispose()
  })

  it.each(['hidden', 'detached', 'disposed'] as const)('ends the field input and releases selection capture when %s', state => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    inputText(lookup, 'Priority')
    const releasePointerCapture = vi.fn()
    lookup.onPointerDown({ pointerId: 5, type: 'down', position: { x: 30, y: 10 }, setPointerCapture: vi.fn(), releasePointerCapture })
    if (state === 'hidden') lookup.visible = false
    if (state === 'detached') lookup.detach()
    if (state === 'disposed') lookup.dispose()
    expect(lookup.debugState().popupVisible).toBe(false)
    expect(InputComposer.instance.hasSession).toBe(false)
    expect(releasePointerCapture).toHaveBeenCalledOnce()
    expect(FocusManager.instance.current).not.toBe(lookup)
    lookup.dispose()
  })

  it('yields vertical gestures and captures only horizontal selection for its own pointer', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    const capture = vi.fn()
    const release = vi.fn()
    const arena = new GestureArenaManager()
    const joinGestureArena = (member: GestureArenaMember) => arena.add({ pointerId: 7, pointerType: 'touch' }, member)
    const down = { pointerId: 7, pointerType: 'touch' as const, type: 'down' as const, position: { x: 20, y: 10 }, joinGestureArena, setPointerCapture: capture, releasePointerCapture: release }
    lookup.onPointerDown(down)
    lookup.onPointerMove({ ...down, type: 'move', position: { x: 21, y: 30 } })
    expect(capture).not.toHaveBeenCalled()
    lookup.onPointerDown(down)
    lookup.onPointerMove({ ...down, pointerId: 8, type: 'move', position: { x: 100, y: 10 } })
    expect(capture).not.toHaveBeenCalled()
    lookup.onPointerMove({ ...down, type: 'move', position: { x: 60, y: 11 } })
    expect(capture).toHaveBeenCalledOnce()
    lookup.onPointerUp({ ...down, type: 'up', pointerId: 8 })
    expect(release).not.toHaveBeenCalled()
    lookup.onPointerCancel({ ...down, type: 'cancel' })
    expect(release).toHaveBeenCalledOnce()
    lookup.dispose()
  })

  it('switches searchable dynamically without leaving an input session in select-only mode', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    inputText(lookup, 'Priority')
    lookup.searchable = false
    expect(InputComposer.instance.hasSession).toBe(false)
    lookup.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }))
    expect(lookup.debugState().popupVisible).toBe(true)
    expect(FocusManager.instance.current).toBe(lookup)
    lookup.searchable = true
    expect(lookup.debugState()).toMatchObject({ popupVisible: false, displayText: 'DeviceAlpha' })
    expect(InputComposer.instance.hasSession).toBe(true)
    lookup.dispose()
  })

  it('does not reopen after a query processor ends the focus session', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    lookup.queryProcessor = () => {
      lookup.disabled = true
      return { rows: catalogRows }
    }
    inputText(lookup, 'Priority')
    expect(lookup.debugState()).toMatchObject({ popupVisible: false, disabled: true, value: 'DX001' })
    expect(InputComposer.instance.hasSession).toBe(false)
    lookup.dispose()
  })

  it('allows mouse selection inside the field modal focus scope', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    const scope = new FocusScope(FocusScopeType.Modal)
    scope.setFocusRoots([lookup])
    scope.add(lookup)
    FocusManager.instance.pushScope(scope)
    inputText(lookup, 'Priority')
    const popup = PopupManager.instance.top as DropdownGridPopup
    const layout = (popup as any)._layout()
    const position = { x: layout.panelX + 30, y: layout.panelY + layout.popupStyle.padding + layout.headerH + layout.itemH / 2 }
    expect(PopupManager.instance.isInteractiveAt(position)).toBe(true)
    expect(PopupManager.instance.handlePointerDown({ pointerId: 2, type: 'down', position })).toBe(true)
    PopupManager.instance.handlePointerUp({ pointerId: 2, type: 'up', position })
    expect(lookup.value).toBe('DX002')
    expect(FocusManager.instance.current).toBe(lookup)
    lookup.dispose()
    FocusManager.instance.popScope(null, scope)
  })

  it('routes selection through its nearest window and honors preventDefault before committing', () => {
    setPopupTestContext()
    const main = new RenderWindow({ title: 'Main', width: 400, height: 200 })
    const child = new RenderWindow({ title: 'A', width: 300, height: 100 })
    const other = new RenderWindow({ title: 'B', width: 300, height: 100 })
    const lookup = createLookup('DX001')
    main.addChild(child)
    child.addChild(lookup)
    const mainListener = vi.fn()
    const otherListener = vi.fn()
    main.addKeyboardEventListener('keydown', mainListener)
    other.addKeyboardEventListener('keydown', otherListener)
    const cancel = child.addKeyboardEventListener('keydown', event => event.preventDefault(), { capture: true })
    inputText(lookup, 'Priority')
    FocusManager.instance.handleKeyDownEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    expect(lookup.value).toBe('DX001')
    expect(lookup.debugState().popupVisible).toBe(true)
    expect(mainListener).not.toHaveBeenCalled()
    expect(otherListener).not.toHaveBeenCalled()
    cancel()
    child.addKeyboardEventListener('keydown', event => event.stopPropagation(), { capture: true })
    FocusManager.instance.handleKeyDownEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    expect(lookup.value).toBe('DX002')
    main.dispose()
    other.dispose()
  })


  it('keeps selected-value lookup indexed and supports explicit same-length refresh', () => {
    let valueReads = 0
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      get code() {
        valueReads += 1
        return `DX${index}`
      },
      name: `Catalog ${index}`,
    }))
    const lookup = new RenderLookupEdit({
      columns: [{ key: 'name', title: 'Name' }],
      rows,
      valueKey: 'code',
      labelKey: 'name',
      value: 'DX9999',
    })
    lookup.performLayout(constraints, layoutContext)
    expect(valueReads).toBe(rows.length)

    paintLookup(lookup)
    paintLookup(lookup)
    lookup.debugState()
    expect(valueReads).toBe(rows.length)

    rows[9_999] = { code: 'UPDATED', name: 'Updated Catalog' }
    lookup.value = 'UPDATED'
    lookup.refreshLookup()
    expect(paintLookup(lookup)).toContain('Updated Catalog')
    lookup.dispose()
  })

  it('keeps text clicks editable and toggles the popup with the arrow', () => {
    setPopupTestContext()
    const lookup = createLookup()

    lookup.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    expect(PopupManager.instance.top).toBeInstanceOf(DropdownGridPopup)

    lookup.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })

    expect(lookup.debugState().popupVisible).toBe(true)
    lookup.onPointerUp({ pointerId: 0, position: { x: 8, y: 8 }, type: 'up' })
    const arrow = (lookup as any)._triggerLayout().trailingRect
    lookup.onPointerDown({ pointerId: 0, position: { x: arrow.x + 2, y: 8 }, type: 'down' })
    expect(PopupManager.instance.top).toBe(null)
  })

  it('edits the field while the popup only displays grid results', () => {
    setPopupTestContext()
    const lookup = createLookup()
    FocusManager.instance.setFocus(lookup)

    inputText(lookup, 'Priority')
    const popup = PopupManager.instance.top as DropdownGridPopup
    expect(popup).toBeInstanceOf(DropdownGridPopup)
    expect(popup.debugState().searchable).toBe(false)
    expect((popup as any)._searchInput.input.hasSession).toBe(false)
    expect((document.getElementById('__ds_ui_input__') as HTMLTextAreaElement).value).toBe('Priority')
    expect(FocusManager.instance.current).toBe(lookup)
    expect(document.activeElement).toBe((document.getElementById('__ds_ui_input__') as HTMLTextAreaElement))
    expect(popup.debugState().filteredRows.map(row => row.name)).toEqual(['PriorityBeta'])
    expect(paintLookup(lookup)).toContain('Priority')
  })

  it('closes typed query presentation on Escape Tab disabled and exposes debug state', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    FocusManager.instance.setFocus(lookup)

    inputText(lookup, '支')

    expect(lookup.debugState()).toMatchObject({
      popupVisible: true,
      queryText: '支',
      showQueryInField: true,
      displayText: '支',
      value: 'DX001',
      selectedLabel: 'DeviceAlpha',
      filteredCount: 1,
    })

    expect(lookup.onKeyDown(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))).toBe(false)
    expect(lookup.debugState()).toMatchObject({
      popupVisible: false,
      queryText: '',
      showQueryInField: false,
      displayText: 'DeviceAlpha',
    })

    inputText(lookup, '支')
    lookup.disabled = true

    expect(lookup.debugState()).toMatchObject({
      popupVisible: false,
      queryText: '',
      showQueryInField: false,
      disabled: true,
      value: 'DX001',
    })
  })

  it('uses custom queryProcessor to control filtered row order', () => {
    setPopupTestContext()
    const queryProcessor = vi.fn(() => ({
      rows: [catalogRows[2]!, catalogRows[0]!],
    }))
    const lookup = new RenderLookupEdit({
      columns: [
        { key: 'code', title: '编码', width: 88 },
        { key: 'name', title: 'Item name' },
      ],
      rows: catalogRows,
      valueKey: 'code',
      labelKey: 'name',
      searchable: true,
      queryProcessor,
    })
    lookup.performLayout(constraints, layoutContext)
    FocusManager.instance.setFocus(lookup)

    inputText(lookup, '支')

    const popup = PopupManager.instance.top as DropdownGridPopup
    expect(queryProcessor).toHaveBeenCalled()
    expect(popup.debugState().filteredRows.map(row => row.name)).toEqual(['支气管炎', 'DeviceAlpha'])
  })

  it('does not execute the query processor from debugState', () => {
    setPopupTestContext()
    const queryProcessor = vi.fn(() => ({ rows: [catalogRows[1]!] }))
    const lookup = new RenderLookupEdit({
      columns: [
        { key: 'code', title: '编码', width: 88 },
        { key: 'name', title: 'Item name' },
      ],
      rows: catalogRows,
      valueKey: 'code',
      labelKey: 'name',
      searchable: true,
      queryProcessor,
    })
    lookup.performLayout(constraints, layoutContext)

    expect(lookup.debugState().filteredCount).toBe(catalogRows.length)
    expect(queryProcessor).not.toHaveBeenCalled()

    FocusManager.instance.setFocus(lookup)
    inputText(lookup, 'Priority')
    expect(queryProcessor).toHaveBeenCalledTimes(1)

    queryProcessor.mockClear()
    expect(lookup.debugState().filteredCount).toBe(1)
    expect(queryProcessor).not.toHaveBeenCalled()
  })

  it('commits selection and renders the selected label', () => {
    setPopupTestContext()
    const onChange = vi.fn()
    const valueListener = vi.fn()
    const blurListener = vi.fn()
    const lookup = new RenderLookupEdit({
      columns: [
        { key: 'code', title: '编码', width: 88 },
        { key: 'name', title: 'Item name' },
      ],
      rows: catalogRows,
      valueKey: 'code',
      labelKey: 'name',
      onChange,
      clearable: true,
    })
    lookup.subscribeValueChange(valueListener)
    lookup.subscribeBlur(blurListener)
    lookup.performLayout(constraints, layoutContext)
    lookup.setValue('DX001')
    expect(valueListener).not.toHaveBeenCalled()
    FocusManager.instance.setFocus(lookup)

    inputText(lookup, 'Priority')
    const popup = PopupManager.instance.top as DropdownGridPopup
    ;(popup as any)._select(catalogRows[1])

    expect(lookup.value).toBe('DX002')
    expect(onChange).toHaveBeenCalledWith('DX002', catalogRows[1])
    expect(valueListener).toHaveBeenCalledWith({
      value: 'DX002',
      previousValue: undefined,
      reason: 'selection',
      detail: catalogRows[1],
    })
    expect(paintLookup(lookup)).toContain('PriorityBeta')
    expect(blurListener).not.toHaveBeenCalled()

    FocusManager.instance.clearFocusOf(lookup)
    expect(blurListener).toHaveBeenCalledTimes(1)
  })

  it('keeps field input focused and clears its local query on public blur', () => {
    setPopupTestContext()
    const blurListener = vi.fn()
    const lookup = createLookup('DX001')
    lookup.subscribeBlur(blurListener)

    lookup.requestFocus()
    inputText(lookup, 'D')

    expect(lookup.debugState()).toMatchObject({
      popupVisible: true,
      queryText: 'D',
      showQueryInField: true,
    })
    expect(lookup.isFocused).toBe(true)
    expect(blurListener).not.toHaveBeenCalled()

    lookup.blur()
    lookup.blur()

    expect(lookup.debugState()).toMatchObject({
      popupVisible: false,
      queryText: '',
      showQueryInField: false,
    })
    expect(lookup.isFocused).toBe(false)
    expect(blurListener).toHaveBeenCalledOnce()

    lookup.dispose()
  })

  it('closes the popup when a selection callback throws', () => {
    setPopupTestContext()
    const error = new Error('lookup selection failed')
    const valueListener = vi.fn()
    const lookup = createLookup('DX001')
    lookup.onChange = () => { throw error }
    lookup.subscribeValueChange(valueListener)

    lookup.requestFocus()
    inputText(lookup, 'D')
    const popup = PopupManager.instance.top as DropdownGridPopup

    expect(() => (popup as any)._select(catalogRows[1])).toThrow(error)
    expect(lookup.value).toBe('DX002')
    expect(valueListener).toHaveBeenCalledOnce()
    expect(lookup.debugState().popupVisible).toBe(false)
    expect(lookup.isFocused).toBe(true)

    lookup.dispose()
  })

  it.each(['disabled', 'readonly'] as const)(
    'publishes one logical blur when an open lookup becomes %s',
    state => {
      setPopupTestContext()
      const blurListener = vi.fn()
      const lookup = createLookup('DX001')
      lookup.subscribeBlur(blurListener)

      lookup.requestFocus()
      inputText(lookup, 'D')
      expect(lookup.debugState().popupVisible).toBe(true)

      lookup[state] = true
      lookup[state] = true

      expect(lookup.debugState().popupVisible).toBe(false)
      expect(lookup.isFocused).toBe(false)
      expect(blurListener).toHaveBeenCalledOnce()

      lookup.dispose()
    },
  )

  it('restores the selected label after closing an uncommitted query', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    FocusManager.instance.setFocus(lookup)

    inputText(lookup, '支')
    expect(paintLookup(lookup)).toContain('支')

    const popup = PopupManager.instance.top as DropdownGridPopup
    popup.close()

    expect(paintLookup(lookup)).toContain('DeviceAlpha')
    expect(paintLookup(lookup)).not.toContain('支')
  })

  it('refreshes open popup rows when rows or columns are rebound without clearing value', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    FocusManager.instance.setFocus(lookup)

    inputText(lookup, 'Priority')
    const popup = PopupManager.instance.top as DropdownGridPopup

    lookup.rows = [
      { code: 'DX004', name: 'Priority脂血症', icd: 'E78.500' },
      { code: 'DX005', name: 'CategoryEta', icd: 'J18.900' },
    ]
    lookup.columns = [
      { key: 'name', title: 'Item name' },
      { key: 'icd', title: 'CODE', width: 96 },
    ]

    expect(lookup.value).toBe('DX001')
    expect(popup.debugState().filteredRows.map(row => row.name)).toEqual(['Priority脂血症'])
    expect(popup.debugState()).toMatchObject({
      searchBehavior: 'external',
      keyboardIndex: 0,
    })
  })

  it('clears the committed value with Delete in select-only mode', () => {
    setPopupTestContext()
    const onChange = vi.fn()
    const lookup = new RenderLookupEdit({
      columns: [
        { key: 'code', title: '编码', width: 88 },
        { key: 'name', title: 'Item name' },
      ],
      rows: catalogRows,
      valueKey: 'code',
      labelKey: 'name',
      value: 'DX002',
      onChange,
      clearable: true,
      searchable: false,
    })
    lookup.performLayout(constraints, layoutContext)
    FocusManager.instance.setFocus(lookup)

    const consumed = lookup.onKeyDown(new KeyboardEvent('keydown', {
      key: 'Delete',
      bubbles: true,
      cancelable: true,
    }))

    expect(consumed).toBe(true)
    expect(lookup.value).toBe('')
    expect(onChange).toHaveBeenCalledWith('', null)
  })

  it('renders selected meta text and suppresses it while querying', () => {
    setPopupTestContext()
    const lookup = new RenderLookupEdit({
      columns: [
        { key: 'code', title: '编码', width: 88 },
        { key: 'name', title: 'Item name' },
      ],
      rows: catalogRows,
      valueKey: 'code',
      labelKey: 'name',
      value: 'DX001',
      metaKey: 'icd',
      searchable: true,
    })
    lookup.performLayout(constraints, layoutContext)

    expect(paintLookup(lookup)).toContain('DeviceAlpha')
    expect(paintLookup(lookup)).toContain('CODE06')

    FocusManager.instance.setFocus(lookup)
    inputText(lookup, 'Priority')

    const painted = paintLookup(lookup)
    expect(painted).toContain('Priority')
    expect(painted).not.toContain('CODE06')
  })

  it('does not open popup when readonly', () => {
    setPopupTestContext()
    const lookup = new RenderLookupEdit({
      columns: [
        { key: 'code', title: '编码', width: 88 },
        { key: 'name', title: 'Item name' },
      ],
      rows: catalogRows,
      valueKey: 'code',
      labelKey: 'name',
      value: 'DX001',
      readonly: true,
      clearable: true,
    })
    lookup.performLayout(constraints, layoutContext)

    lookup.focusIn()
    expect(lookup.isFocused).toBe(false)

    lookup.onPointerDown({
      pointerId: 0,
      position: { x: 8, y: 8 },
      type: 'down',
    })
    expect(PopupManager.instance.top).toBe(null)
    expect(lookup.isFocused).toBe(false)

    const consumed = lookup.onKeyDown(new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    }))
    expect(consumed).toBe(false)
    expect(PopupManager.instance.top).toBe(null)
    expect(lookup.value).toBe('DX001')
    expect(FocusManager.instance.scopeStack[0]?.focusables.includes(lookup)).toBe(false)
  })

  it('does not treat printable keys as search input when searchable is false', () => {
    setPopupTestContext()
    const lookup = new RenderLookupEdit({
      columns: [
        { key: 'code', title: '编码', width: 88 },
        { key: 'name', title: 'Item name' },
      ],
      rows: catalogRows,
      valueKey: 'code',
      labelKey: 'name',
      searchable: false,
    })
    lookup.performLayout(constraints, layoutContext)
    FocusManager.instance.setFocus(lookup)

    const consumed = lookup.onKeyDown(new KeyboardEvent('keydown', { key: 'Priority', cancelable: true }))

    expect(consumed).toBe(false)
    expect(PopupManager.instance.top).toBe(null)
  })

  it('unregisters from focus order when readonly is enabled dynamically', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    FocusManager.instance.setFocus(lookup)
    lookup.onPointerMove({ pointerId: 1, position: { x: 8, y: 8 }, type: 'move' })

    expect(lookup.isFocused).toBe(true)
    expect(FocusManager.instance.scopeStack[0]?.focusables.includes(lookup)).toBe(true)
    expect((lookup as any)._hovered).toBe(true)

    inputText(lookup, '支')

    expect(lookup.debugState()).toMatchObject({
      popupVisible: true,
      queryText: '支',
      showQueryInField: true,
    })

    lookup.readonly = true

    expect(lookup.isFocused).toBe(false)
    expect(lookup.debugState()).toMatchObject({
      popupVisible: false,
      queryText: '',
      showQueryInField: false,
      readonly: true,
    })
    expect((lookup as any)._hovered).toBe(false)
    expect(FocusManager.instance.current).not.toBe(lookup)
    expect(FocusManager.instance.scopeStack[0]?.focusables.includes(lookup)).toBe(false)
  })

  it('closes popup and clears interactive state when disabled dynamically', () => {
    setPopupTestContext()
    const lookup = createLookup('DX001')
    FocusManager.instance.setFocus(lookup)
    lookup.onPointerMove({ pointerId: 1, position: { x: 8, y: 8 }, type: 'move' })

    expect(lookup.isFocused).toBe(true)
    expect((lookup as any)._hovered).toBe(true)

    inputText(lookup, '支')

    expect(lookup.debugState()).toMatchObject({
      popupVisible: true,
      queryText: '支',
      showQueryInField: true,
    })

    lookup.disabled = true

    expect(lookup.isFocused).toBe(false)
    expect(lookup.debugState()).toMatchObject({
      popupVisible: false,
      queryText: '',
      showQueryInField: false,
      disabled: true,
    })
    expect((lookup as any)._hovered).toBe(false)
    expect(FocusManager.instance.current).not.toBe(lookup)
    expect(FocusManager.instance.scopeStack[0]?.focusables.includes(lookup)).toBe(false)
  })

  it('clips trigger display text to the field value rect when width is constrained', () => {
    const rect = vi.fn()
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      roundRect: vi.fn(),
      rect,
      clip: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      fillText: vi.fn(),
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
    const lookup = new RenderLookupEdit({
      columns: [
        { key: 'code', title: '编码', width: 88 },
        { key: 'name', title: 'Item name' },
        { key: 'icd', title: 'CODE', width: 96 },
      ],
      rows: catalogRows,
      valueKey: 'code',
      labelKey: 'name',
      value: 'DX001',
      metaKey: 'icd',
      clearable: true,
    })

    lookup.performLayout({
      minWidth: 0,
      maxWidth: 120,
      minHeight: 0,
      maxHeight: 40,
    }, layoutContext)
    lookup.performPaint(new PaintContext(ctx, ImGuiDarkTheme), { x: 0, y: 0 })

    expect(rect).toHaveBeenCalled()

    lookup.dispose()
  })

  it('ellipsizes selected trigger text when width is constrained', () => {
    vi.spyOn(TextMeasurer, 'measureWidth').mockImplementation(text => String(text).length * 8)
    const lookup = new RenderLookupEdit({
      columns: [
        { key: 'code', title: '编码', width: 88 },
        { key: 'name', title: 'Item name' },
      ],
      rows: [
        { code: 'DX-LONG', name: '非常长的业务Catalog显示名称' },
      ],
      valueKey: 'code',
      labelKey: 'name',
      value: 'DX-LONG',
      clearable: true,
    })

    lookup.performLayout({
      minWidth: 0,
      maxWidth: 96,
      minHeight: 0,
      maxHeight: 40,
    }, layoutContext)

    expect(paintLookup(lookup).some(text => text.includes('...'))).toBe(true)

    lookup.dispose()
  })
})
