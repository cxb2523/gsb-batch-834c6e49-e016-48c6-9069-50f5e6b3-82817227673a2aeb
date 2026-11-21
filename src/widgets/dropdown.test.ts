import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoxConstraints } from '../core/render_object'
import { PaintContext } from '../rendering/paint_context'
import { InputComposer } from '../core/input_composer'
import { FocusManager, FocusScope, FocusScopeType } from '../core/focus_manager'
import { PopupManager } from '../core/popup_manager'
import { GET_POPUP_ANCHOR_RECT } from '../core/popup_anchor'
import { TextMeasurer } from '../core/text_measurer'
import { ImGuiDarkTheme, ImGuiLightTheme } from '../theme/default_theme'
import { deriveDropdownStyle, derivePopupStyle, deriveTextInputStyle, deriveTreeStyle, resolveBgColor, resolveTextColor } from '../theme/component_styles'
import { colorToCSS } from '../theme/theme'
import { RenderStackPanel } from '../layout/render_flex'
import { EventDispatcher } from '../gestures/recognizers'
import { DropdownPopup, RenderComboBox } from './dropdown'
import { layoutFormFieldInlineContent } from './form_field_shell'
import { RenderTextBox } from './text_field'
import { TooltipService } from './tooltip'

const constraints: BoxConstraints = {
  minWidth: 0,
  maxWidth: 160,
  minHeight: 0,
  maxHeight: 40,
}

function createRecordingPaintContext(theme = ImGuiDarkTheme): { context: PaintContext; fillStyles: string[]; strokeStyles: string[] } {
  const fillStyles: string[] = []
  const strokeStyles: string[] = []
  let fillStyle: unknown = ''
  let strokeStyle: unknown = ''
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fill: vi.fn(() => {
      if (typeof fillStyle === 'string' && fillStyle) fillStyles.push(fillStyle)
    }),
    stroke: vi.fn(() => {
      if (typeof strokeStyle === 'string' && strokeStyle) strokeStyles.push(strokeStyle)
    }),
    fillRect: vi.fn(() => {
      if (typeof fillStyle === 'string' && fillStyle) fillStyles.push(fillStyle)
    }),
    strokeRect: vi.fn(() => {
      if (typeof strokeStyle === 'string' && strokeStyle) strokeStyles.push(strokeStyle)
    }),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    set fillStyle(value: unknown) { fillStyle = value },
    get fillStyle() { return fillStyle as string },
    set strokeStyle(value: unknown) { strokeStyle = value },
    get strokeStyle() { return strokeStyle as string },
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D
  return { context: new PaintContext(ctx, theme), fillStyles, strokeStyles }
}

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

function paintDropdown(dropdown: RenderComboBox, theme = ImGuiDarkTheme): { fillStyles: string[]; strokeStyles: string[] } {
  const painted = createRecordingPaintContext(theme)
  dropdown.performPaint(painted.context, { x: 0, y: 0 })
  return painted
}

function paintDropdownPopup(popup: DropdownPopup, theme = ImGuiDarkTheme): { fillStyles: string[]; strokeStyles: string[] } {
  const painted = createRecordingPaintContext(theme)
  popup.paint(painted.context)
  return painted
}

function setPopupTestContext(theme = ImGuiDarkTheme, viewport = { width: 320, height: 240, dpr: 1 }): void {
  PopupManager.instance.setContextProvider(() => ({ theme, viewport }))
}

function staticAnchor(x: number, y: number, w: number, h: number) {
  return {
    [GET_POPUP_ANCHOR_RECT]: () => ({ x, y, width: w, height: h }),
  }
}

afterEach(() => {
  TooltipService.clearCurrent()
  PopupManager.instance.dispose()
  FocusManager.instance.dispose()
  InputComposer.instance.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('DropdownPopup lifecycle', () => {
  it('supports opt-in Tab close and owner navigation', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const popup = new DropdownPopup()
    const onTab = vi.fn()
    popup.open({
      options: [{ value: 'ts', label: 'TypeScript' }],
      selectedValue: 'ts',
      anchor: staticAnchor(0, 0, 160, 24),
      searchable: false,
      maxVisibleItems: 8,
      onSelect: vi.fn(),
      onTab,
      onClose: vi.fn(),
    })

    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    expect(popup.onKeyDown(event)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(onTab).toHaveBeenCalledWith(1)
    expect(popup.visible).toBe(false)
  })

  it('keeps a clearable dropdown open when clear is rejected', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const popup = new DropdownPopup()
    const onClear = vi.fn(() => false)
    popup.open({
      options: [{ value: 'ts', label: 'TypeScript' }],
      selectedValue: 'ts',
      anchor: staticAnchor(0, 0, 160, 24),
      searchable: false,
      maxVisibleItems: 8,
      clearable: true,
      onSelect: vi.fn(),
      onClear,
      onClose: vi.fn(),
    })

    ;(popup as any)._select({ value: 'ts', label: 'TypeScript' })
    expect(onClear).toHaveBeenCalledOnce()
    expect(popup.visible).toBe(true)
  })

  it('keeps only one cursor timer when reopened', () => {
    vi.useFakeTimers()
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    const popup = new DropdownPopup()
    const opts = {
      options: [{ value: 'ts', label: 'TypeScript' }],
      selectedValue: 'ts',
      anchor: staticAnchor(0, 0, 100, 24),
      searchable: true,
      maxVisibleItems: 8,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    }

    popup.open(opts)
    popup.open(opts)

    expect(popup.visible).toBe(true)
    expect(setIntervalSpy).toHaveBeenCalledTimes(2)
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)

    popup.dispose()

    expect(popup.visible).toBe(false)
    expect(PopupManager.instance.current).toBe(null)
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2)
  })

  it('does not end a newer input session when closed', () => {
    const popup = new DropdownPopup()
    const newerInput = vi.fn()

    popup.open({
      options: [{ value: 'ts', label: 'TypeScript' }],
      selectedValue: '',
      anchor: staticAnchor(0, 0, 100, 24),
      searchable: true,
      maxVisibleItems: 8,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    })

    InputComposer.instance.begin({ onInput: newerInput }, 'newer')
    popup.close()

    expect(InputComposer.instance.hasSession).toBe(true)

    const input = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    input.value = 'still active'
    input.dispatchEvent(new Event('input'))

    expect(newerInput).toHaveBeenCalledWith('still active')
  })

  it('uses popup context changes on the next paint while open', () => {
    const popup = new DropdownPopup()

    popup.open({
      options: [{ value: 'ts', label: 'TypeScript' }],
      selectedValue: 'ts',
      anchor: staticAnchor(0, 0, 100, 24),
      searchable: false,
      maxVisibleItems: 8,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    })
    setPopupTestContext(ImGuiLightTheme)

    const painted = paintDropdownPopup(popup, ImGuiLightTheme)

    expect(painted.fillStyles.length).toBeGreaterThan(0)
  })

  it('clears hover when the pointer leaves the popup horizontally', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const popup = new DropdownPopup()
    const dropdownStyle = deriveDropdownStyle(ImGuiDarkTheme)
    const popupStyle = derivePopupStyle(ImGuiDarkTheme)

    popup.open({
      options: [
        { value: 'ts', label: 'TypeScript' },
        { value: 'js', label: 'JavaScript' },
      ],
      selectedValue: 'ts',
      anchor: staticAnchor(0, 0, 160, 24),
      searchable: false,
      maxVisibleItems: 8,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    })

    popup.onPointerMove({
      pointerId: 0,
      position: {
        x: 10,
        y: 24 + 2 + popupStyle.padding + dropdownStyle.itemHeight * 1.5,
      },
      type: 'move',
    }, PopupManager.instance.context)
    expect((popup as any)._hoveredValue).toBe('js')

    popup.onPointerMove({
      pointerId: 0,
      position: {
        x: 220,
        y: 24 + 2 + popupStyle.padding + dropdownStyle.itemHeight * 1.5,
      },
      type: 'move',
    }, PopupManager.instance.context)

    expect((popup as any)._hoveredValue).toBe('')
    expect((popup as any)._keyboardIndex).toBe(0)
  })

  it('supports wheel scrolling and scrollbar track clicks when options overflow', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const popup = new DropdownPopup()

    popup.open({
      options: Array.from({ length: 12 }, (_, index) => ({
        value: `value-${index}`,
        label: `Option ${index}`,
      })),
      selectedValue: 'value-0',
      anchor: staticAnchor(0, 0, 160, 24),
      searchable: false,
      maxVisibleItems: 4,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    })

    expect(popup.onWheel({
      pointerId: 0,
      position: { x: 12, y: 40 },
      type: 'wheel',
      deltaX: 120,
      deltaY: 0,
    }, PopupManager.instance.context)).toBe(false)

    expect(popup.onWheel({
      pointerId: 0,
      position: { x: 12, y: 40 },
      type: 'wheel',
      deltaX: 0,
      deltaY: 120,
    }, PopupManager.instance.context)).toBe(true)

    expect(popup.debugState().scrollOffset).toBe(3)

    const scrollbar = (popup as any)._scrollbarMetrics(PopupManager.instance.context) as {
      x: number
      y: number
      w: number
      h: number
    }

    popup.onPointerDown({
      pointerId: 0,
      position: {
        x: scrollbar.x + scrollbar.w / 2,
        y: scrollbar.y + scrollbar.h - 2,
      },
      type: 'down',
    }, PopupManager.instance.context)

    expect(popup.debugState().scrollOffset).toBeGreaterThan(1)
  })

  it('clears scrollbar drag state when closed mid-drag', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const popup = new DropdownPopup()

    popup.open({
      options: Array.from({ length: 12 }, (_, index) => ({
        value: `value-${index}`,
        label: `Option ${index}`,
      })),
      selectedValue: 'value-0',
      anchor: staticAnchor(0, 0, 160, 24),
      searchable: false,
      maxVisibleItems: 4,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    })

    const scrollbar = (popup as any)._scrollbarMetrics(PopupManager.instance.context) as {
      x: number
      thumbY: number
      thumbH: number
    }

    popup.onPointerDown({
      pointerId: 3,
      position: {
        x: scrollbar.x + 2,
        y: scrollbar.thumbY + scrollbar.thumbH / 2,
      },
      type: 'down',
    }, PopupManager.instance.context)

    expect((popup as any)._scrollbarDragging).toBe(true)

    popup.close()

    expect((popup as any)._scrollbarDragging).toBe(false)
    expect((popup as any)._scrollbarPointerKey).toBeUndefined()
  })

  it('keeps a scrollbar drag owned by pointer type and raw id together', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const popup = new DropdownPopup()
    popup.open({
      options: Array.from({ length: 12 }, (_, index) => ({
        value: `value-${index}`,
        label: `Option ${index}`,
      })),
      selectedValue: 'value-0',
      anchor: staticAnchor(0, 0, 160, 24),
      searchable: false,
      maxVisibleItems: 4,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    })
    const scrollbar = (popup as any)._scrollbarMetrics(PopupManager.instance.context) as {
      x: number
      thumbY: number
      thumbH: number
    }
    const downY = scrollbar.thumbY + scrollbar.thumbH / 2

    popup.onPointerDown({
      pointerId: 0,
      pointerType: 'touch',
      position: { x: scrollbar.x + 2, y: downY },
      type: 'down',
    }, PopupManager.instance.context)
    popup.onPointerMove({
      pointerId: 0,
      pointerType: 'mouse',
      position: { x: scrollbar.x + 2, y: downY + 20 },
      type: 'move',
    }, PopupManager.instance.context)
    popup.onPointerUp({
      pointerId: 0,
      pointerType: 'mouse',
      position: { x: scrollbar.x + 2, y: downY + 20 },
      type: 'up',
    })

    expect(popup.debugState().scrollOffset).toBe(0)
    expect((popup as any)._scrollbarDragging).toBe(true)

    popup.onPointerMove({
      pointerId: 0,
      pointerType: 'touch',
      position: { x: scrollbar.x + 2, y: downY + 20 },
      type: 'move',
    }, PopupManager.instance.context)
    popup.onPointerUp({
      pointerId: 0,
      pointerType: 'touch',
      position: { x: scrollbar.x + 2, y: downY + 20 },
      type: 'up',
    })

    expect(popup.debugState().scrollOffset).toBeGreaterThan(0)
    expect((popup as any)._scrollbarDragging).toBe(false)
  })

  it('consumes trigger clicks as toggle-close when the popup is already open', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const popup = new DropdownPopup()

    popup.open({
      options: [{ value: 'ts', label: 'TypeScript' }],
      selectedValue: 'ts',
      anchor: staticAnchor(0, 0, 160, 24),
      searchable: false,
      maxVisibleItems: 8,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    })

    const consumed = PopupManager.instance.handlePointerDown({
      pointerId: 0,
      position: { x: 12, y: 12 },
      type: 'down',
    })

    expect(consumed).toBe(true)
    expect(popup.visible).toBe(false)
  })

  it('does not start a hidden input session when search is disabled', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const popup = new DropdownPopup()
    const onSelect = vi.fn()

    popup.open({
      options: [
        { value: 'ts', label: 'TypeScript' },
        { value: 'js', label: 'JavaScript' },
      ],
      selectedValue: 'ts',
      anchor: staticAnchor(0, 0, 160, 24),
      searchable: false,
      maxVisibleItems: 8,
      onSelect,
      onClose: vi.fn(),
    })

    expect(InputComposer.instance.hasSession).toBe(false)
    expect(popup.debugState()).toMatchObject({
      searchable: false,
      searchText: '',
      keyboardIndex: 0,
    })

    expect(popup.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }))).toBe(true)
    expect(popup.debugState().keyboardIndex).toBe(1)
    expect(popup.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))).toBe(true)

    expect(onSelect).toHaveBeenCalledWith('js', { value: 'js', label: 'JavaScript' })
    expect(popup.visible).toBe(false)
  })

  it('does not consume IME composition control keys', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const popup = new DropdownPopup()
    const onSelect = vi.fn()
    popup.open({
      options: [
        { value: 'ts', label: 'TypeScript' },
        { value: 'js', label: 'JavaScript' },
      ],
      selectedValue: 'ts',
      anchor: staticAnchor(0, 0, 160, 24),
      searchable: true,
      maxVisibleItems: 8,
      onSelect,
      onClose: vi.fn(),
    })
    const initialKeyboardIndex = popup.debugState().keyboardIndex
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      cancelable: true,
    })
    const legacyArrow = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      cancelable: true,
    })
    Object.defineProperty(legacyArrow, 'keyCode', { value: 229 })

    expect(popup.onKeyDown(enter)).toBe(false)
    expect(popup.onKeyDown(legacyArrow)).toBe(false)
    expect(enter.defaultPrevented).toBe(false)
    expect(legacyArrow.defaultPrevented).toBe(false)
    expect(popup.debugState().keyboardIndex).toBe(initialKeyboardIndex)
    expect(onSelect).not.toHaveBeenCalled()
    expect(popup.visible).toBe(true)

    popup.dispose()
  })

  it('closes on Tab without consuming focus movement in non-search mode', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const popup = new DropdownPopup()

    popup.open({
      options: [{ value: 'ts', label: 'TypeScript' }],
      selectedValue: 'ts',
      anchor: staticAnchor(0, 0, 160, 24),
      searchable: false,
      maxVisibleItems: 8,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    })

    expect(popup.onKeyDown(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))).toBe(false)
    expect(popup.visible).toBe(false)
  })

  it('widens long option popups and keeps them inside the viewport', () => {
    vi.spyOn(TextMeasurer, 'measureWidth').mockImplementation(text => String(text).length * 8)
    setPopupTestContext(ImGuiDarkTheme, { width: 400, height: 240, dpr: 1 })
    const popup = new DropdownPopup()

    popup.open({
      options: [{
        value: 'skin',
        label: '皮肤粘膜未见异常，无肝掌，全身浅表淋巴结无肿大。未见皮下出血点，未见皮疹',
      }],
      selectedValue: '',
      anchor: staticAnchor(300, 20, 80, 24),
      searchable: false,
      maxVisibleItems: 8,
      maxPopupWidth: 560,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    })

    const rect = (popup as any)._popupRect(PopupManager.instance.context) as { x: number; w: number }

    expect(rect.w).toBeGreaterThan(80)
    expect(rect.x).toBeGreaterThanOrEqual(8)
    expect(rect.x + rect.w).toBeLessThanOrEqual(392)
  })

  it('opens above the anchor when there is not enough space below', () => {
    setPopupTestContext(ImGuiDarkTheme, { width: 320, height: 160, dpr: 1 })
    const popup = new DropdownPopup()

    popup.open({
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
        { value: 'c', label: 'Gamma' },
      ],
      selectedValue: '',
      anchor: staticAnchor(20, 128, 160, 24),
      searchable: false,
      maxVisibleItems: 8,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    })

    const rect = (popup as any)._popupRect(PopupManager.instance.context) as { y: number; h: number }

    expect(rect.y + rect.h).toBeLessThanOrEqual(126)
  })

  it('keeps the selected keyboard row visible when viewport height reduces visible rows', () => {
    setPopupTestContext(ImGuiDarkTheme, { width: 240, height: 128, dpr: 1 })
    const popup = new DropdownPopup()

    popup.open({
      options: Array.from({ length: 8 }, (_, index) => ({
        value: `value-${index}`,
        label: `Option ${index}`,
      })),
      selectedValue: 'value-7',
      anchor: staticAnchor(10, 84, 160, 24),
      searchable: false,
      maxVisibleItems: 8,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    })

    const state = popup.debugState()
    const visibleRows = (popup as any)._popupLayout(PopupManager.instance.context).visibleRows as number

    expect(state.keyboardIndex).toBe(7)
    expect(state.scrollOffset).toBeGreaterThan(0)
    expect(7).toBeLessThan(state.scrollOffset + visibleRows)
  })

  it('ellipsizes overflowing popup option text', () => {
    vi.spyOn(TextMeasurer, 'measureWidth').mockImplementation(text => String(text).length * 8)
    setPopupTestContext(ImGuiDarkTheme, { width: 240, height: 180, dpr: 1 })
    const popup = new DropdownPopup()
    const { context, fillText } = createTextRecordingPaintContext(ImGuiDarkTheme)

    popup.open({
      options: [{ value: 'long', label: 'VeryLongDropdownOptionLabel' }],
      selectedValue: '',
      anchor: staticAnchor(20, 20, 80, 24),
      searchable: false,
      maxVisibleItems: 8,
      maxPopupWidth: 120,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    })
    popup.paint(context)

    const paintedLabel = fillText.mock.calls.find(call => String(call[0]).includes('...'))?.[0]

    expect(paintedLabel).toBeTruthy()
    expect(paintedLabel).not.toBe('VeryLongDropdownOptionLabel')
  })

  it('shows a tooltip for clipped popup option text while hovered', () => {
    vi.spyOn(TextMeasurer, 'measureWidth').mockImplementation(text => String(text).length * 8)
    setPopupTestContext(ImGuiDarkTheme, { width: 240, height: 180, dpr: 1 })
    const service = {
      show: vi.fn(),
      hide: vi.fn(),
      updatePos: vi.fn(),
    }
    TooltipService.installCurrent(service)
    const popup = new DropdownPopup()
    const dropdownStyle = deriveDropdownStyle(ImGuiDarkTheme)
    const popupStyle = derivePopupStyle(ImGuiDarkTheme)

    popup.open({
      options: [{ value: 'long', label: 'VeryLongDropdownOptionLabel' }],
      selectedValue: '',
      anchor: staticAnchor(20, 20, 80, 24),
      searchable: false,
      maxVisibleItems: 8,
      maxPopupWidth: 120,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    })
    popup.onPointerMove({
      pointerId: 1,
      position: {
        x: 30,
        y: 20 + 24 + 2 + popupStyle.padding + dropdownStyle.itemHeight / 2,
      },
      type: 'move',
    }, PopupManager.instance.context)

    expect(service.show).toHaveBeenCalledWith('VeryLongDropdownOptionLabel', expect.any(Object), 250)
    expect(service.updatePos).toHaveBeenCalled()
  })

  it('clears a clearable selected popup when the selected option is clicked again', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const popup = new DropdownPopup()
    const dropdownStyle = deriveDropdownStyle(ImGuiDarkTheme)
    const popupStyle = derivePopupStyle(ImGuiDarkTheme)
    const onSelect = vi.fn()
    const onClear = vi.fn()

    popup.open({
      options: [
        { value: 'yes', label: '是' },
        { value: 'no', label: '否' },
      ],
      selectedValue: 'yes',
      anchor: staticAnchor(0, 0, 160, 24),
      searchable: false,
      maxVisibleItems: 8,
      clearable: true,
      onSelect,
      onClear,
      onClose: vi.fn(),
    })

    expect(popup.debugState().clearable).toBe(true)

    popup.onPointerMove({
      pointerId: 1,
      position: {
        x: 16,
        y: 24 + 2 + popupStyle.padding + dropdownStyle.itemHeight / 2,
      },
      type: 'move',
    }, PopupManager.instance.context)
    expect((popup as any)._hoveredValue).toBe('yes')

    popup.onPointerDown({
      pointerId: 1,
      position: {
        x: 16,
        y: 24 + 2 + popupStyle.padding + dropdownStyle.itemHeight / 2,
      },
      type: 'down',
    }, PopupManager.instance.context)

    expect(onClear).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
    expect(popup.visible).toBe(false)
  })

  it('selects normally when clicking an unselected option in a clearable popup', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const popup = new DropdownPopup()
    const dropdownStyle = deriveDropdownStyle(ImGuiDarkTheme)
    const popupStyle = derivePopupStyle(ImGuiDarkTheme)
    const onSelect = vi.fn()
    const onClear = vi.fn()

    popup.open({
      options: [
        { value: 'yes', label: '是' },
        { value: 'no', label: '否' },
      ],
      selectedValue: 'yes',
      anchor: staticAnchor(0, 0, 160, 24),
      searchable: false,
      maxVisibleItems: 8,
      clearable: true,
      onSelect,
      onClear,
      onClose: vi.fn(),
    })

    popup.onPointerDown({
      pointerId: 1,
      position: {
        x: 16,
        y: 24 + 2 + popupStyle.padding + dropdownStyle.itemHeight * 1.5,
      },
      type: 'down',
    }, PopupManager.instance.context)

    expect(onSelect).toHaveBeenCalledWith('no', { value: 'no', label: '否' })
    expect(onClear).not.toHaveBeenCalled()
    expect(popup.visible).toBe(false)
  })
})

describe('RenderComboBox contexts', () => {
  it('focuses through keyboard navigation without auto-opening the popup', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const dropdown = new RenderComboBox({
      options: [{ value: 'ts', label: 'TypeScript' }],
      value: 'ts',
    })

    dropdown.layout(constraints, false, { theme: ImGuiDarkTheme })
    FocusManager.instance.setFocus(dropdown)

    expect(dropdown.isFocused).toBe(true)
    expect((dropdown as any)._popup.visible).toBe(false)

    dropdown.dispose()
  })

  it('opens on Enter after focus and closes the popup while advancing focus on Tab', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const first = new RenderComboBox({
      options: [{ value: 'ts', label: 'TypeScript' }],
      value: 'ts',
    })
    const second = new RenderComboBox({
      options: [{ value: 'js', label: 'JavaScript' }],
      value: 'js',
    })

    first.layout(constraints, false, { theme: ImGuiDarkTheme })
    second.layout(constraints, false, { theme: ImGuiDarkTheme })

    FocusManager.instance.setFocus(first)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))

    expect((first as any)._popup.visible).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))

    expect((first as any)._popup.visible).toBe(false)
    expect(FocusManager.instance.current).toBe(second)

    first.dispose()
    second.dispose()
  })

  it('opens on the first click after the control is already focused', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const dropdown = new RenderComboBox({
      options: [{ value: 'ts', label: 'TypeScript' }],
      value: 'ts',
    })

    dropdown.layout(constraints, false, { theme: ImGuiDarkTheme })
    FocusManager.instance.setFocus(dropdown)

    dropdown.onPointerDown({ pointerId: 1, position: { x: 10, y: 10 }, type: 'down' })

    expect((dropdown as any)._popup.visible).toBe(true)

    dropdown.dispose()
  })

  it('lets ArrowDown move the popup selection after keyboard open', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const dropdown = new RenderComboBox({
      options: [
        { value: 'ts', label: 'TypeScript' },
        { value: 'js', label: 'JavaScript' },
      ],
      value: 'ts',
    })

    dropdown.layout(constraints, false, { theme: ImGuiDarkTheme })
    FocusManager.instance.setFocus(dropdown)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))

    expect(((dropdown as any)._popup as DropdownPopup).debugState().keyboardIndex).toBe(1)

    dropdown.dispose()
  })

  it('closes its owned popup when detached', () => {
    const dropdown = new RenderComboBox({
      options: [{ value: 'ts', label: 'TypeScript' }],
    })
    const popup = (dropdown as any)._popup as DropdownPopup

    dropdown.layout({ minWidth: 0, maxWidth: 120, minHeight: 0, maxHeight: 24 })
    dropdown.onPointerDown({ pointerId: 1, position: { x: 10, y: 10 }, type: 'down' })

    expect(popup.visible).toBe(true)
    expect(PopupManager.instance.current).toBe(popup)

    dropdown.detach()

    expect(popup.visible).toBe(false)
    expect(PopupManager.instance.current).toBe(null)
  })

  it('recomputes shell height when relaid out with a new theme context', () => {
    const dropdown = new RenderComboBox({
      options: [{ value: 'ts', label: 'TypeScript' }],
      value: 'ts',
    })

    dropdown.layout(constraints, false, { theme: ImGuiDarkTheme })
    const beforeHeight = dropdown.size.height

    dropdown.layout(constraints, false, {
      theme: {
        ...ImGuiLightTheme,
        fontSize: ImGuiLightTheme.fontSize + 2,
        controlHeight: ImGuiLightTheme.controlHeight + 4,
      },
    })

    expect(dropdown.size.height).toBeGreaterThan(beforeHeight)
  })

  it('keeps disabled dropdowns closed and reserves helper text below the field shell', () => {
    const dropdown = new RenderComboBox({
      options: [{ value: 'ts', label: 'TypeScript' }],
      value: 'ts',
      disabled: true,
      helperText: '请选择一个选项',
    })
    const style = deriveTextInputStyle(ImGuiDarkTheme)

    dropdown.layout(constraints, false, { theme: ImGuiDarkTheme })
    dropdown.onPointerDown({ pointerId: 1, position: { x: 10, y: 10 }, type: 'down' })

    expect(dropdown.size.height).toBe(style.height + style.helperGap + style.helperLineHeight)
    expect(dropdown[GET_POPUP_ANCHOR_RECT]().height).toBe(style.height)
    expect((dropdown as any)._popup.visible).toBe(false)

    dropdown.dispose()
  })

  it('supports custom trigger height consistent with text input fields', () => {
    const dropdown = new RenderComboBox({
      options: [{ value: 'ts', label: 'TypeScript' }],
      value: 'ts',
      fieldHeight: 44,
    })

    dropdown.layout(constraints, false, { theme: ImGuiDarkTheme })

    expect(dropdown.size.height).toBe(44)
    expect(dropdown[GET_POPUP_ANCHOR_RECT]().height).toBe(44)

    dropdown.fieldHeight = 48
    dropdown.layout(constraints, false, { theme: ImGuiDarkTheme })

    expect(dropdown.size.height).toBe(48)
    expect(dropdown[GET_POPUP_ANCHOR_RECT]().height).toBe(48)

    dropdown.dispose()
  })

  it('keeps readonly dropdowns unfocused, closed, and non-clearable', () => {
    const onChange = vi.fn()
    const dropdown = new RenderComboBox({
      options: [{ value: 'ts', label: 'TypeScript' }],
      value: 'ts',
      readonly: true,
      clearable: true,
      onChange,
    })
    const style = deriveTextInputStyle(ImGuiDarkTheme)
    const dropdownStyle = deriveDropdownStyle(ImGuiDarkTheme)

    dropdown.layout(constraints, false, { theme: ImGuiDarkTheme })
    dropdown.focusIn()
    dropdown.onPointerMove({ pointerId: 1, position: { x: 10, y: 10 }, type: 'move' })
    dropdown.onPointerDown({ pointerId: 1, position: { x: 10, y: 10 }, type: 'down' })

    expect(dropdown.isFocused).toBe(false)
    expect((dropdown as any)._hovered).toBe(false)
    expect((dropdown as any)._popup.visible).toBe(false)

    const clearLayout = layoutFormFieldInlineContent(style, { x: 0, y: 0 }, dropdown.size.width, style.height, {
      showClearButton: true,
      reserveTrailingWidth: dropdownStyle.fontSize,
    })
    dropdown.onPointerDown({
      pointerId: 1,
      position: {
        x: clearLayout.clearRect!.x + clearLayout.clearRect!.w / 2,
        y: clearLayout.clearRect!.y + clearLayout.clearRect!.h / 2,
      },
      type: 'down',
    })

    expect(dropdown.value).toBe('ts')
    expect(dropdown.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false)
    expect(onChange).not.toHaveBeenCalled()

    dropdown.dispose()
  })

  it('closes and unregisters when a dropdown becomes readonly', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const dropdown = new RenderComboBox({
      options: [{ value: 'ts', label: 'TypeScript' }],
      value: 'ts',
    })

    dropdown.layout(constraints, false, { theme: ImGuiDarkTheme })
    dropdown.onPointerDown({ pointerId: 1, position: { x: 10, y: 10 }, type: 'down' })

    expect((dropdown as any)._popup.visible).toBe(true)
    expect(dropdown.isFocused).toBe(true)

    dropdown.readonly = true

    expect((dropdown as any)._popup.visible).toBe(false)
    expect(FocusManager.instance.current).not.toBe(dropdown)
    expect(dropdown.isFocused).toBe(false)

    dropdown.dispose()
  })

  it('closes, unfocuses, and clears hover when a dropdown becomes disabled', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const dropdown = new RenderComboBox({
      options: [{ value: 'ts', label: 'TypeScript' }],
      value: 'ts',
    })

    dropdown.layout(constraints, false, { theme: ImGuiDarkTheme })
    dropdown.onPointerMove({ pointerId: 1, position: { x: 10, y: 10 }, type: 'move' })
    dropdown.onPointerDown({ pointerId: 1, position: { x: 10, y: 10 }, type: 'down' })

    expect((dropdown as any)._popup.visible).toBe(true)
    expect(dropdown.isFocused).toBe(true)
    expect((dropdown as any)._hovered).toBe(true)

    dropdown.disabled = true

    expect((dropdown as any)._popup.visible).toBe(false)
    expect(FocusManager.instance.current).not.toBe(dropdown)
    expect(dropdown.isFocused).toBe(false)
    expect(FocusManager.instance.scopeStack[0]?.focusables.includes(dropdown)).toBe(false)
    expect((dropdown as any)._hovered).toBe(false)

    dropdown.dispose()
  })

  it('closes its popup without firing change when options are rebound', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const onChange = vi.fn()
    const dropdown = new RenderComboBox({
      options: [{ value: 'ts', label: 'TypeScript' }],
      value: 'ts',
      onChange,
    })

    dropdown.layout(constraints, false, { theme: ImGuiDarkTheme })
    dropdown.onPointerDown({ pointerId: 1, position: { x: 10, y: 10 }, type: 'down' })

    expect((dropdown as any)._popup.visible).toBe(true)

    dropdown.options = [{ value: 'js', label: 'JavaScript' }]

    expect((dropdown as any)._popup.visible).toBe(false)
    expect(dropdown.options.map(option => option.value)).toEqual(['js'])
    expect(dropdown.value).toBe('ts')
    expect(onChange).not.toHaveBeenCalled()

    dropdown.dispose()
  })

  it('clears through the shared trigger clear affordance', () => {
    const onChange = vi.fn()
    const valueListener = vi.fn()
    const blurListener = vi.fn()
    const dropdown = new RenderComboBox({
      options: [
        { value: 'ts', label: 'TypeScript' },
        { value: 'js', label: 'JavaScript' },
      ],
      value: 'ts',
      clearable: true,
      onChange,
    })
    dropdown.subscribeValueChange(valueListener)
    dropdown.subscribeBlur(blurListener)
    const style = deriveTextInputStyle(ImGuiDarkTheme)
    const dropdownStyle = deriveDropdownStyle(ImGuiDarkTheme)

    dropdown.layout(constraints, false, { theme: ImGuiDarkTheme })
    dropdown.setValue('js')
    dropdown.setValue('ts')
    expect(valueListener).not.toHaveBeenCalled()

    dropdown.focusIn()
    dropdown.focusOut()
    expect(blurListener).toHaveBeenCalledTimes(1)

    const layout = layoutFormFieldInlineContent(style, { x: 0, y: 0 }, dropdown.size.width, style.height, {
      showClearButton: true,
      reserveTrailingWidth: dropdownStyle.fontSize,
    })

    dropdown.onPointerDown({
      pointerId: 1,
      position: {
        x: layout.clearRect!.x + layout.clearRect!.w / 2,
        y: layout.clearRect!.y + layout.clearRect!.h / 2,
      },
      type: 'down',
    })

    expect(dropdown.value).toBe('')
    expect(onChange).toHaveBeenCalledWith('', null)
    expect(valueListener).toHaveBeenCalledWith({
      value: '',
      previousValue: undefined,
      reason: 'clear',
      detail: null,
    })

    dropdown.dispose()
  })

  it('keeps its owned popup focused and publishes blur only after public blur', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const blurListener = vi.fn()
    const dropdown = new RenderComboBox({
      options: [
        { value: 'ts', label: 'TypeScript' },
        { value: 'js', label: 'JavaScript' },
      ],
      value: 'ts',
      searchable: true,
    })
    dropdown.subscribeBlur(blurListener)
    dropdown.layout(constraints, false, { theme: ImGuiDarkTheme })

    dropdown.requestFocus()
    dropdown.onKeyDown(new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      cancelable: true,
    }))

    expect((dropdown as any)._popup.visible).toBe(true)
    expect(dropdown.isFocused).toBe(true)
    expect(blurListener).not.toHaveBeenCalled()

    dropdown.blur()
    dropdown.blur()

    expect((dropdown as any)._popup.visible).toBe(false)
    expect(dropdown.isFocused).toBe(false)
    expect(blurListener).toHaveBeenCalledOnce()

    dropdown.dispose()
  })

  it('closes the popup when a selection callback throws', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const error = new Error('dropdown selection failed')
    const valueListener = vi.fn()
    const options = [
      { value: 'ts', label: 'TypeScript' },
      { value: 'js', label: 'JavaScript' },
    ]
    const dropdown = new RenderComboBox({
      options,
      value: 'ts',
      onChange: () => { throw error },
    })
    dropdown.subscribeValueChange(valueListener)
    dropdown.layout(constraints, false, { theme: ImGuiDarkTheme })

    dropdown.requestFocus()
    dropdown.onKeyDown(new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      cancelable: true,
    }))
    const popup = (dropdown as any)._popup as DropdownPopup

    expect(() => (popup as any)._select(options[1])).toThrow(error)
    expect(dropdown.value).toBe('js')
    expect(valueListener).toHaveBeenCalledOnce()
    expect(popup.visible).toBe(false)
    expect(dropdown.isFocused).toBe(true)

    dropdown.dispose()
  })

  it.each(['disabled', 'readonly'] as const)(
    'publishes one logical blur when an open dropdown becomes %s',
    state => {
      setPopupTestContext(ImGuiDarkTheme)
      const blurListener = vi.fn()
      const dropdown = new RenderComboBox({
        options: [
          { value: 'ts', label: 'TypeScript' },
          { value: 'js', label: 'JavaScript' },
        ],
        value: 'ts',
      })
      dropdown.subscribeBlur(blurListener)
      dropdown.layout(constraints, false, { theme: ImGuiDarkTheme })

      dropdown.requestFocus()
      dropdown.onKeyDown(new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        cancelable: true,
      }))
      expect((dropdown as any)._popup.visible).toBe(true)

      dropdown[state] = true
      dropdown[state] = true

      expect((dropdown as any)._popup.visible).toBe(false)
      expect(dropdown.isFocused).toBe(false)
      expect(blurListener).toHaveBeenCalledOnce()

      dropdown.dispose()
    },
  )

  it('renders prefix and suffix adornments through the shared trigger shell', () => {
    vi.spyOn(TextMeasurer, 'measureWidth').mockImplementation(text => String(text).length * 8)
    const dropdown = new RenderComboBox({
      options: [{ value: 'ts', label: 'TypeScript' }],
      value: 'ts',
      prefixText: '@',
      suffixText: '.dev',
    })
    const painted = createTextRecordingPaintContext()

    dropdown.layout(constraints, false, { theme: ImGuiDarkTheme })
    dropdown.performPaint(painted.context, { x: 0, y: 0 })

    expect(painted.fillText.mock.calls.some(call => call[0] === '@')).toBe(true)
    expect(painted.fillText.mock.calls.some(call => call[0] === '.dev')).toBe(true)

    dropdown.dispose()
  })

  it('uses token-derived focused shell and arrow colors when open', () => {
    const dropdown = new RenderComboBox({
      options: [{ value: 'ts', label: 'TypeScript' }],
      value: 'ts',
    })
    const inputStyle = deriveTextInputStyle(ImGuiDarkTheme)
    const dropdownStyle = deriveDropdownStyle(ImGuiDarkTheme)
    dropdown.layout(constraints, false, { theme: ImGuiDarkTheme })
    dropdown.onPointerDown({ pointerId: 1, position: { x: 10, y: 10 }, type: 'down' })

    const painted = paintDropdown(dropdown)

    expect(painted.fillStyles[0]).toBe(colorToCSS(resolveBgColor(inputStyle.inputBg, 'focused')))
    expect(painted.strokeStyles[0]).toBe(colorToCSS(resolveBgColor(inputStyle.inputBorder, 'focused')))
    expect(painted.fillStyles).toContain(colorToCSS(resolveTextColor(dropdownStyle.arrowText, 'selected')))
    dropdown.dispose()
  })

  it('restores focus to the dropdown instead of the previous text field after selection', () => {
    setPopupTestContext(ImGuiDarkTheme)
    const textField = new RenderTextBox({ value: 'hello' })
    const dropdown = new RenderComboBox({
      options: [
        { value: 'ts', label: 'TypeScript' },
        { value: 'js', label: 'JavaScript' },
      ],
      value: 'ts',
    })
    const dropdownStyle = deriveDropdownStyle(ImGuiDarkTheme)
    const popupStyle = derivePopupStyle(ImGuiDarkTheme)

    textField.layout(constraints, false, { theme: ImGuiDarkTheme })
    dropdown.layout(constraints, false, { theme: ImGuiDarkTheme })
    FocusManager.instance.setFocus(textField)

    expect(FocusManager.instance.current).toBe(textField)
    expect(textField.isFocused).toBe(true)

    dropdown.onPointerDown({ pointerId: 1, position: { x: 10, y: 10 }, type: 'down' })

    const popup = (dropdown as any)._popup as DropdownPopup
    expect(popup.visible).toBe(true)
    expect(FocusManager.instance.current).toBe(dropdown)

    popup.onPointerDown({
      pointerId: 0,
      position: {
        x: 10,
        y: dropdown.size.height + 2 + popupStyle.padding + dropdownStyle.itemHeight * 1.5,
      },
      type: 'down',
    }, PopupManager.instance.context)

    expect(dropdown.value).toBe('js')
    expect(popup.visible).toBe(false)
    expect(PopupManager.instance.current).toBe(null)
    expect(FocusManager.instance.current).toBe(dropdown)
    expect(dropdown.isFocused).toBe(true)
    expect(textField.isFocused).toBe(false)
  })

  it('uses token-derived search shell and item backgrounds in searchable popup', () => {
    const popup = new DropdownPopup()
    const inputStyle = deriveTextInputStyle(ImGuiDarkTheme)
    const dropdownStyle = deriveDropdownStyle(ImGuiDarkTheme)
    const treeStyle = deriveTreeStyle(ImGuiDarkTheme)

    popup.open({
      options: [
        { value: 'ts', label: 'TypeScript' },
        { value: 'js', label: 'JavaScript' },
      ],
      selectedValue: 'ts',
      anchor: staticAnchor(0, 0, 160, 24),
      searchable: true,
      maxVisibleItems: 8,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    })
    ;(popup as any)._hoveredValue = 'js'

    const painted = paintDropdownPopup(popup)

    expect(painted.fillStyles).toContain(colorToCSS(treeStyle.panelBg))
    expect(painted.fillStyles).toContain(colorToCSS(resolveBgColor(inputStyle.inputBg, 'focused')))
    expect(painted.strokeStyles).toContain(colorToCSS(resolveBgColor(inputStyle.inputBorder, 'focused')))
    expect(painted.fillStyles).toContain(colorToCSS(resolveBgColor(dropdownStyle.itemBg, 'selected')))
    expect(painted.fillStyles).toContain(colorToCSS(resolveBgColor(dropdownStyle.itemBg, 'hovered')))
    expect(painted.strokeStyles).toContain(colorToCSS(dropdownStyle.separator))

    popup.dispose()
  })

  it('renders IME text between prefix and suffix in the searchable popup', () => {
    const popup = new DropdownPopup()
    popup.open({
      options: [{ value: 'ts', label: 'TypeScript' }],
      selectedValue: '',
      anchor: staticAnchor(0, 0, 160, 24),
      searchable: true,
      maxVisibleItems: 8,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    })
    ;(popup as any)._searchText = 'abcdef'
    ;(popup as any)._searchInput.setValue('abcdef')
    ;(popup as any)._searchInput.setSelection(2, 2, { cursorPos: 2, syncComposer: true })

    const ta = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    ta.dispatchEvent(new CompositionEvent('compositionstart'))
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: '中' }))

    const painted = createTextRecordingPaintContext()
    popup.paint(painted.context)

    expect(painted.fillText.mock.calls.some(call => call[0] === 'ab')).toBe(true)
    expect(painted.fillText.mock.calls.some(call => call[0] === '中')).toBe(true)
    expect(painted.fillText.mock.calls.some(call => call[0] === 'cdef')).toBe(true)

    popup.dispose()
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
    const dropdown = new RenderComboBox({
      options: [{ value: 'critical', label: '这是一个很长的业务状态文本' }],
      value: 'critical',
    })

    dropdown.layout({
      minWidth: 0,
      maxWidth: 96,
      minHeight: 0,
      maxHeight: 40,
    }, false, { theme: ImGuiLightTheme })
    dropdown.performPaint(new PaintContext(ctx, ImGuiLightTheme), { x: 0, y: 0 })

    const input = deriveTextInputStyle(ImGuiLightTheme)
    const layout = layoutFormFieldInlineContent(input, { x: 0, y: 0 }, dropdown.size.width, input.height, {
      reserveTrailingWidth: deriveDropdownStyle(ImGuiLightTheme).fontSize,
    })

    expect(rect).toHaveBeenCalledWith(
      layout.valueRect.x,
      0,
      layout.valueRect.w,
      input.height,
    )

    dropdown.dispose()
  })

  it('exposes full selected text as tooltip when the trigger label is clipped', () => {
    vi.spyOn(TextMeasurer, 'measureWidth').mockImplementation(text => String(text).length * 8)
    const dropdown = new RenderComboBox({
      options: [{ value: 'critical', label: '这是一个很长的业务状态文本' }],
      value: 'critical',
    })

    dropdown.layout({
      minWidth: 0,
      maxWidth: 96,
      minHeight: 0,
      maxHeight: 40,
    }, false, { theme: ImGuiLightTheme })
    dropdown.performPaint(createTextRecordingPaintContext(ImGuiLightTheme).context, { x: 0, y: 0 })

    expect(dropdown.tooltip).toBe('这是一个很长的业务状态文本')

    dropdown.layout({
      minWidth: 0,
      maxWidth: 260,
      minHeight: 0,
      maxHeight: 40,
    }, false, { theme: ImGuiLightTheme })
    dropdown.performPaint(createTextRecordingPaintContext(ImGuiLightTheme).context, { x: 0, y: 0 })

    expect(dropdown.tooltip).toBeUndefined()

    dropdown.dispose()
  })

  it('ellipsizes selected trigger text when width is constrained', () => {
    vi.spyOn(TextMeasurer, 'measureWidth').mockImplementation(text => String(text).length * 8)
    const dropdown = new RenderComboBox({
      options: [{ value: 'critical', label: '这是一个很长的业务状态文本' }],
      value: 'critical',
    })
    const painted = createTextRecordingPaintContext(ImGuiLightTheme)

    dropdown.layout({
      minWidth: 0,
      maxWidth: 96,
      minHeight: 0,
      maxHeight: 40,
    }, false, { theme: ImGuiLightTheme })
    dropdown.performPaint(painted.context, { x: 0, y: 0 })

    expect(painted.fillText.mock.calls.some(call => String(call[0]).includes('...'))).toBe(true)

    dropdown.dispose()
  })
})

for (const [key, expected] of [['ArrowDown', 'b'], ['Home', 'a'], ['End', 'c'], ['b', 'b']]) {
  it(`keyboard ${key} takes over an existing mouse hover`, () => {
    setPopupTestContext()
    const popup = new DropdownPopup()
    const onSelect = vi.fn()
    popup.open({ options: ['a', 'b', 'c'].map(value => ({ value, label: value })), selectedValue: 'a', anchor: staticAnchor(0, 0, 160, 24), searchable: false, maxVisibleItems: 8, onSelect, onClose: vi.fn() })
    ;(popup as any)._hoveredValue = 'c'
    window.dispatchEvent(new KeyboardEvent('keydown', { key }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(onSelect).toHaveBeenCalledWith(expected, expect.objectContaining({ value: expected }))
    expect(popup.visible).toBe(false)
    popup.dispose()
  })
}

it('owner-input candidate mode leaves text, horizontal navigation and IME with the host and requires explicit candidate navigation for Enter', () => {
  setPopupTestContext(ImGuiDarkTheme)
  const popup = new DropdownPopup(), onSelect = vi.fn()
  popup.open({ options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], selectedValue: 'a', anchor: staticAnchor(0, 0, 100, 20), searchable: false, ownerInput: true, maxVisibleItems: 8, onSelect, onClose: vi.fn() })
  for (const key of ['x', 'Backspace', 'ArrowLeft', 'Home', 'End', 'Enter']) {
    const event = new KeyboardEvent('keydown', { key, cancelable: true }); expect(popup.onKeyDown(event)).toBe(false); expect(event.defaultPrevented).toBe(false)
  }
  expect(popup.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true }))).toBe(false)
  expect(popup.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))).toBe(true)
  expect(popup.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true)
  expect(onSelect).toHaveBeenCalledWith('b', { value: 'b', label: 'B' }); popup.dispose()
})

function searchableCombo(value = 'a'): RenderComboBox {
  const combo = new RenderComboBox({
    options: [
      { value: 'dead', label: 'Alpha disabled', disabled: true },
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
      { value: 'a2', label: 'Alpha Two' },
    ],
    value, searchable: true, clearable: true,
  })
  combo.layout(constraints, false, { theme: ImGuiDarkTheme })
  return combo
}
function inputCombo(combo: RenderComboBox, value: string): HTMLTextAreaElement {
  combo.requestFocus()
  const textarea = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
  textarea.value = value
  textarea.setSelectionRange(value.length, value.length)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  return textarea
}
function comboPopup(combo: RenderComboBox): DropdownPopup { return (combo as any)._popup }
function comboKey(combo: RenderComboBox, key: string): boolean {
  return combo.onKeyDown(new KeyboardEvent('keydown', { key, cancelable: true }))
}

describe('RenderComboBox inline search', () => {
  it('edits in the field and filters by case-insensitive label without changing the value', () => {
    setPopupTestContext()
    const combo = searchableCombo()
    const change = vi.fn()
    combo.onChange = change
    combo.requestFocus()
    expect(comboPopup(combo).visible).toBe(false)
    const textarea = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    expect(textarea.value).toBe('Alpha')
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 5])
    inputCombo(combo, 'ALP')
    expect(comboPopup(combo).debugState().filteredOptions.map(option => option.value)).toEqual(['dead', 'a', 'a2'])
    expect(comboPopup(combo).debugState().searchable).toBe(false)
    expect((comboPopup(combo) as any)._searchInput.input.hasSession).toBe(false)
    expect(FocusManager.instance.current).toBe(combo)
    expect(document.activeElement).toBe(textarea)
    expect(combo.value).toBe('a')
    expect(change).not.toHaveBeenCalled()
    inputCombo(combo, '')
    expect(comboPopup(combo).debugState().filteredOptions).toHaveLength(4)
    expect(combo.value).toBe('a')
    combo.dispose()
  })

  it('highlights an enabled match and supports direct Enter and navigation past disabled options', () => {
    setPopupTestContext()
    const combo = searchableCombo('')
    const change = vi.fn()
    combo.onChange = change
    const textarea = inputCombo(combo, 'alpha')
    expect(comboPopup(combo).debugState().keyboardIndex).toBe(1)
    expect(comboKey(combo, 'Enter')).toBe(true)
    expect(combo.value).toBe('a')
    expect(textarea.value).toBe('Alpha')
    expect(comboPopup(combo).visible).toBe(false)
    expect(change).toHaveBeenCalledOnce()
    inputCombo(combo, 'alpha')
    comboKey(combo, 'ArrowDown')
    expect(comboPopup(combo).debugState().keyboardIndex).toBe(2)
    comboKey(combo, 'ArrowDown')
    expect(comboPopup(combo).debugState().keyboardIndex).toBe(1)
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', ' ', 'Backspace', 'Delete']) expect(comboKey(combo, key)).toBe(false)
    combo.dispose()
  })

  it('keeps an empty search open and consumes Enter without committing or submitting its form', () => {
    setPopupTestContext()
    const combo = searchableCombo()
    const parent = new RenderStackPanel()
    parent.addChild(combo)
    const submit = vi.fn()
    ;(parent as any).handleUnhandledKeyDownFromDescendant = submit
    const textarea = inputCombo(combo, 'no-match')
    expect(comboPopup(combo).debugState().filteredOptions).toEqual([])
    expect(FocusManager.instance.handleKeyDownEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))).toBe(true)
    expect(submit).not.toHaveBeenCalled()
    expect(combo.value).toBe('a')
    expect(textarea.value).toBe('no-match')
    expect(comboPopup(combo).visible).toBe(true)
    const painted = createTextRecordingPaintContext()
    comboPopup(combo).paint(painted.context)
    expect(painted.fillText.mock.calls.some(call => call[0] === '无匹配项')).toBe(true)
    parent.dispose()
  })

  it('cancels with Escape and Tab and clears the value only with the explicit clear affordance', () => {
    setPopupTestContext()
    const combo = searchableCombo()
    const next = new RenderTextBox({ value: 'next' })
    const change = vi.fn()
    combo.onChange = change
    const textarea = inputCombo(combo, 'Beta')
    comboKey(combo, 'Escape')
    expect(textarea.value).toBe('Alpha')
    expect(combo.value).toBe('a')
    inputCombo(combo, 'Beta')
    FocusManager.instance.handleKeyDownEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
    expect(FocusManager.instance.current).toBe(next)
    expect(comboPopup(combo).visible).toBe(false)
    expect(combo.value).toBe('a')
    expect(change).not.toHaveBeenCalled()
    inputCombo(combo, '')
    const clear = (combo as any)._triggerLayout().clearRect
    combo.onPointerDown({ pointerId: 1, type: 'down', position: { x: clear.x + 1, y: clear.y + 1 } })
    expect(combo.value).toBe('')
    expect((document.getElementById('__ds_ui_input__') as HTMLTextAreaElement).value).toBe('')
    expect(change).toHaveBeenCalledWith('', null)
    combo.dispose()
    next.dispose()
  })

  it('preserves options-rebind closing semantics and synchronizes the committed label and input', () => {
    setPopupTestContext()
    const combo = searchableCombo()
    const change = vi.fn()
    combo.onChange = change
    const textarea = inputCombo(combo, 'Beta')
    combo.options = [{ value: 'a', label: 'Rebound Alpha' }]
    expect(comboPopup(combo).visible).toBe(false)
    expect(textarea.value).toBe('Rebound Alpha')
    expect(combo.value).toBe('a')
    textarea.setSelectionRange(6, 8)
    combo.options = [{ value: 'a', label: 'New' }]
    expect(textarea.value).toBe('New')
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([3, 3])
    combo.options = []
    expect(textarea.value).toBe('')
    expect(combo.value).toBe('a')
    expect(change).not.toHaveBeenCalled()
    combo.dispose()
  })

  it.each(['rebind-open', 'rebind-closed', 'set-value'] as const)('cancels composing input and isolates delayed native events on %s', operation => {
    setPopupTestContext()
    const combo = searchableCombo()
    const change = vi.fn()
    combo.onChange = change
    combo.requestFocus()
    if (operation !== 'rebind-closed') inputCombo(combo, 'Alpha')
    const old = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    old.dispatchEvent(new CompositionEvent('compositionstart'))
    old.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'Beta' }))
    if (operation === 'set-value') combo.setValue('b')
    else combo.options = combo.options.map(option => ({ ...option, label: option.value === 'a' ? 'Alpha rebound' : option.label }))
    const current = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    const expected = operation === 'set-value' ? 'Beta' : 'Alpha rebound'
    expect(current).not.toBe(old)
    expect(old.isConnected).toBe(false)
    expect(FocusManager.instance.current).toBe(combo)
    expect(document.activeElement).toBe(current)
    expect(current.value).toBe(expected)
    expect([current.selectionStart, current.selectionEnd]).toEqual([0, expected.length])
    expect((combo as any)._textInput.composing).toBe(false)
    expect(InputComposer.instance.composing).toBe(false)
    expect(comboPopup(combo).visible).toBe(false)
    expect((combo as any)._queryText).toBe(null)
    old.value = 'stale Beta'
    old.setSelectionRange(old.value.length, old.value.length)
    old.dispatchEvent(new CompositionEvent('compositionend', { data: 'Beta' }))
    old.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: 'Beta' }))
    expect(current.value).toBe(expected)
    expect(comboPopup(combo).visible).toBe(false)
    expect((combo as any)._queryText).toBe(null)
    expect(combo.value).toBe(operation === 'set-value' ? 'b' : 'a')
    expect(change).not.toHaveBeenCalled()
    inputCombo(combo, 'Alpha')
    comboKey(combo, 'Enter')
    expect(combo.value).toBe('a')
    expect(change).toHaveBeenCalledOnce()
    combo.dispose()
  })

  it('does not let an old composition end interrupt the next composition after cancellation', () => {
    setPopupTestContext()
    const combo = searchableCombo()
    const old = inputCombo(combo, 'Alpha')
    old.dispatchEvent(new CompositionEvent('compositionstart'))
    old.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'old' }))
    combo.setValue('b')
    const current = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    current.dispatchEvent(new CompositionEvent('compositionstart'))
    current.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'Alpha' }))
    old.value = 'old'
    old.dispatchEvent(new CompositionEvent('compositionend', { data: 'old' }))
    old.dispatchEvent(new Event('input'))
    expect(InputComposer.instance.composing).toBe(true)
    expect((combo as any)._textInput.composing).toBe(true)
    expect(comboPopup(combo).visible).toBe(false)
    expect(current.value).toBe('Beta')
    current.value = 'Alpha'
    current.setSelectionRange(5, 5)
    current.dispatchEvent(new CompositionEvent('compositionend', { data: 'Alpha' }))
    expect(comboPopup(combo).debugState().filteredOptions.map(option => option.value)).toEqual(['dead', 'a', 'a2'])
    comboKey(combo, 'Enter')
    expect(combo.value).toBe('a')
    combo.dispose()
  })

  it('does not cancel another editor composition when an unfocused ComboBox is rebound or disposed', () => {
    const combo = searchableCombo()
    const other = new RenderTextBox({ value: 'other' })
    other.requestFocus()
    const current = document.getElementById('__ds_ui_input__') as HTMLTextAreaElement
    current.dispatchEvent(new CompositionEvent('compositionstart'))
    current.dispatchEvent(new CompositionEvent('compositionupdate', { data: '新' }))
    combo.options = combo.options.map(option => ({ ...option }))
    combo.setValue('b')
    combo.dispose()
    expect(document.getElementById('__ds_ui_input__')).toBe(current)
    expect(document.activeElement).toBe(current)
    expect(FocusManager.instance.current).toBe(other)
    expect(InputComposer.instance.composing).toBe(true)
    expect(current.value).toBe('other')
    other.dispose()
  })

  it('preserves IME navigation and filters only the committed composition', () => {
    setPopupTestContext()
    const combo = searchableCombo()
    const textarea = inputCombo(combo, '')
    textarea.dispatchEvent(new CompositionEvent('compositionstart'))
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'Beta' }))
    for (const key of ['Enter', 'Escape', 'ArrowUp', 'ArrowDown']) {
      const event = new KeyboardEvent('keydown', { key, cancelable: true })
      expect(combo.shouldIgnoreKeyDown(event)).toBe(true)
      expect(FocusManager.instance.handleKeyDownEvent(event)).toBe(false)
    }
    expect(comboPopup(combo).debugState().filteredOptions).toHaveLength(4)
    expect(combo.value).toBe('a')
    textarea.value = 'Beta'
    textarea.setSelectionRange(4, 4)
    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: 'Beta' }))
    expect(comboPopup(combo).debugState().filteredOptions.map(option => option.value)).toEqual(['b'])
    comboKey(combo, 'Enter')
    expect(combo.value).toBe('b')
    combo.dispose()
  })

  it('switches searchable at runtime without leaving an input session or changing pure-selection key behavior', () => {
    setPopupTestContext()
    const combo = searchableCombo()
    inputCombo(combo, 'Beta')
    combo.searchable = false
    expect(combo.onDoubleClick).toBeUndefined()
    expect(InputComposer.instance.hasSession).toBe(false)
    expect(comboPopup(combo).visible).toBe(false)
    expect(comboKey(combo, ' ')).toBe(true)
    expect(comboPopup(combo).visible).toBe(true)
    expect(InputComposer.instance.hasSession).toBe(false)
    combo.searchable = true
    expect(comboPopup(combo).visible).toBe(false)
    expect(InputComposer.instance.hasSession).toBe(true)
    expect((document.getElementById('__ds_ui_input__') as HTMLTextAreaElement).value).toBe('Alpha')
    combo.dispose()
  })

  it.each(['hidden', 'ancestor-hidden', 'disabled', 'readonly', 'detach', 'dispose'] as const)('ends input and candidates when %s', state => {
    setPopupTestContext()
    const parent = new RenderStackPanel()
    const combo = searchableCombo()
    parent.addChild(combo)
    const blur = vi.fn()
    combo.subscribeBlur(blur)
    inputCombo(combo, 'Beta')
    const release = vi.fn()
    combo.onPointerDown({ pointerId: 5, type: 'down', position: { x: 10, y: 10 }, setPointerCapture: vi.fn(), releasePointerCapture: release })
    if (state === 'hidden') combo.visible = false
    if (state === 'ancestor-hidden') parent.visible = false
    if (state === 'disabled') combo.disabled = true
    if (state === 'readonly') combo.readonly = true
    if (state === 'detach') combo.detach()
    if (state === 'dispose') combo.dispose()
    expect(comboPopup(combo).visible).toBe(false)
    expect(combo.isFocused).toBe(false)
    expect(InputComposer.instance.hasSession).toBe(false)
    expect(release).toHaveBeenCalledOnce()
    if (state !== 'dispose') expect(blur).toHaveBeenCalledOnce()
    parent.dispose()
  })

  it.each([false, true])('preserves a popup reopened by the selection callback, including throws=%s', throws => {
    setPopupTestContext()
    const combo = searchableCombo()
    inputCombo(combo, 'Beta')
    combo.onChange = () => {
      comboKey(combo, 'ArrowDown')
      if (throws) throw new Error('selection failed')
    }
    if (throws) expect(() => comboKey(combo, 'Enter')).toThrow('selection failed')
    else comboKey(combo, 'Enter')
    expect(combo.value).toBe('b')
    expect(comboPopup(combo).visible).toBe(true)
    expect(comboPopup(combo).debugState().filteredOptions).toHaveLength(4)
    combo.dispose()
  })

  it('supports candidate selection inside a modal scope while the field keeps input focus', () => {
    setPopupTestContext()
    const combo = searchableCombo()
    const scope = new FocusScope(FocusScopeType.Modal)
    scope.setFocusRoots([combo])
    scope.add(combo)
    FocusManager.instance.pushScope(scope)
    inputCombo(combo, 'Beta')
    const state = comboPopup(combo).debugState()
    const position = { x: state.layout.rect.x + 15, y: state.contentY + state.itemHeight / 2 }
    expect(PopupManager.instance.handlePointerDown({ pointerId: 4, type: 'down', position })).toBe(true)
    PopupManager.instance.handlePointerUp({ pointerId: 4, type: 'up', position })
    expect(combo.value).toBe('b')
    expect(FocusManager.instance.current).toBe(combo)
    expect(InputComposer.instance.hasSession).toBe(true)
    combo.dispose()
    FocusManager.instance.popScope(null, scope)
  })

  it('does not reactivate a text press after hiding and showing the field', () => {
    setPopupTestContext()
    const combo = searchableCombo()
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const dispatcher = new EventDispatcher(canvas)
    dispatcher.addRoot(combo)
    const clicked = vi.fn()
    combo.addPointerEventListener('pointeractivate', clicked, { once: true })
    const mouse = (type: string, x = 10) => canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: 10, button: 0, bubbles: true, cancelable: true }))
    try {
      mouse('mousedown')
      combo.visible = false
      combo.visible = true
      combo.layout(constraints, false, { theme: ImGuiDarkTheme })
      mouse('mouseup')
      expect(clicked).not.toHaveBeenCalled()
      mouse('mousedown')
      mouse('mouseup')
      expect(clicked).toHaveBeenCalledOnce()
    } finally { dispatcher.dispose(); combo.dispose(); canvas.remove() }
  })

  it('leaves existing owner-input popups explicit unless activation is requested', () => {
    setPopupTestContext()
    const popup = new DropdownPopup()
    const onSelect = vi.fn()
    const options = [{ value: 'a', label: 'Alpha' }]
    popup.open({ options, selectedValue: '', anchor: staticAnchor(0, 0, 100, 20), searchable: false, ownerInput: true, maxVisibleItems: 8, onSelect, onClose: vi.fn() })
    popup.updateOptions(options)
    expect(popup.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))).toBe(false)
    expect(onSelect).not.toHaveBeenCalled()
    popup.updateOptions(options, '', { activate: true })
    expect(popup.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))).toBe(true)
    expect(onSelect).toHaveBeenCalledWith('a', options[0])
    popup.dispose()
  })
})
