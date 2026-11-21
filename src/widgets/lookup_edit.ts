import { PopupManager } from '../core/popup_manager'
import { FocusManager, type Focusable } from '../core/focus_manager'
import { runCleanupSteps, type DisposeFn } from '../core/disposable'
import { GET_POPUP_ANCHOR_RECT, type PopupAnchorTarget } from '../core/popup_anchor'
import type { BoxConstraints, LayoutContext, Offset } from '../core/render_object'
import { RenderObject } from '../core/render_object'
import { TextInputController } from '../core/text_input_controller'
import { SingleLineTextInput } from '../core/single_line_text_input'
import { TextEditSession } from '../core/text_edit_session'
import { normalizeUtf16ScalarRange } from '../core/text_selection'
import { PendingPointerGesture } from '../gestures/pending_pointer_gesture'
import type { GestureArenaMember } from '../gestures/gesture_arena'
import { paintSingleLineEditableText } from '../rendering/single_line_text_renderer'
import { TextMeasurer } from '../core/text_measurer'
import type { PointerEvent, InteractiveRenderObject } from '../gestures/recognizers'
import { HitTestResult, isPrimaryPointerButton } from '../gestures/hit_test'
import type { PointerEventListener, PointerEventListenerOptions } from '../gestures/pointer_event_listeners'
import { RenderBox } from '../layout/render_box'
import { DrawList } from '../rendering/draw_list'
import { paintSingleLineText } from '../rendering/text_painter'
import type { PaintContext } from '../rendering/paint_context'
import {
  blendColor,
  deriveDropdownStyle,
  deriveTextInputStyle,
  resolveBgColor,
  resolveTextColor,
} from '../theme/component_styles'
import {
  layoutFormFieldInlineContent,
  measureFormFieldHeight,
  pointInFormFieldRect,
  type FormFieldStatus,
} from './form_field_shell'
import {
  paintTriggerFieldShell,
} from './trigger_field_shell'
import { DropdownGridPopup } from './grid/popup/dropdown_grid_popup'
import { LookupValueIndex } from './grid/lookup_value_index'
import { paintIconGlyph } from './icon'
import {
  ValueEditorEventEmitter,
  type ValueEditor,
  type ValueEditorValueChangeListener,
} from './value_editor'

export interface LookupEditColumn {
  key: string
  title: string
  width?: number
}

export interface LookupEditQueryContext<T extends Record<string, any> = Record<string, any>> {
  query: string
  rows: readonly T[]
  columns: readonly LookupEditColumn[]
  valueKey: string
  labelKey: string
  metaKey?: string
  queryKeys: readonly string[]
  selectedValue: string
}

export interface LookupEditQueryResult<T extends Record<string, any> = Record<string, any>> {
  rows: T[]
}

export type LookupEditQueryProcessor<T extends Record<string, any> = Record<string, any>> =
  (context: LookupEditQueryContext<T>) => LookupEditQueryResult<T>

export interface LookupEditDebugState {
  popupVisible: boolean
  queryText: string
  showQueryInField: boolean
  displayText: string
  focused: boolean
  disabled: boolean
  readonly: boolean
  value: string
  selectedLabel: string
  filteredCount: number
}

export type LookupEditValueChangeReason = 'selection' | 'clear'
export type LookupEditTextPointerEventType = 'pointeractivate' | 'dblclick'

export class RenderLookupEdit<T extends Record<string, any> = Record<string, any>>
  extends RenderBox
  implements
    InteractiveRenderObject,
    Focusable,
    GestureArenaMember,
    ValueEditor<string, LookupEditValueChangeReason, T | null> {
  readonly preventsPointerActivationOnAccept = true

  private _columns: LookupEditColumn[]
  private _rows: T[]
  private readonly _valueIndex = new LookupValueIndex<T>(value => String(value ?? ''))
  valueKey: string
  labelKey: string
  private _value: string
  placeholder: string
  onChange?: (value: string, row: T | null) => void
  private _searchable: boolean
  maxVisibleItems: number
  private _readonly: boolean
  private _disabled: boolean
  private _status: FormFieldStatus
  private _helperText: string
  private _prefixText: string
  private _suffixText: string
  private _clearable: boolean
  metaKey?: string
  metaFormatter?: (row: T) => string
  queryKeys?: string[]
  queryProcessor?: LookupEditQueryProcessor<T>
  private _focusRegistered = false

  private _focused = false
  private _hovered = false
  private _popup: DropdownGridPopup
  private _disposed = false
  private readonly _textPointerListeners: Array<{
    type: LookupEditTextPointerEventType
    listener: PointerEventListener
    capture: boolean
    off: DisposeFn
  }> = []
  private _textActivationKey = Symbol('lookup-text')
  private readonly _selectionGesture = new PendingPointerGesture()
  private _dragStart?: Offset
  private _dragPosition?: Offset
  private _dragging = false
  private readonly _textInput = new TextInputController({ onInvalidate: () => this.markNeedsPaint() })
  private readonly _singleLineInput = new SingleLineTextInput({
    controller: this._textInput,
    getDisplayText: () => this._displayText(),
    measureText: text => this._measureText(text),
    getViewportWidth: () => this._editableWidth(),
    getTextOrigin: () => ({ x: this._triggerLayout().valueRect.x, y: this.globalOffset.y + 4 }),
  })
  private readonly _editSession = new TextEditSession({
    controller: this._textInput,
    isActive: () => this._focused && this._textInput.hasSession && !this._disposed,
    syncSelectionFromComposer: opts => this._textInput.syncSelectionFromComposer(opts),
    scrollToCursor: () => this._singleLineInput.scrollToCursor(),
    updateComposerPosition: () => this._singleLineInput.updateComposerPosition(),
    invalidate: () => this.markNeedsPaint(),
  })
  private _queryGeneration = 0
  private _queryText = ''
  private _showQueryInField = false
  private readonly _valueEditorEvents = new ValueEditorEventEmitter<
    string,
    LookupEditValueChangeReason,
    T | null
  >()

  constructor(opts: {
    columns: LookupEditColumn[]
    rows: T[]
    valueKey: string
    labelKey: string
    value?: string
    placeholder?: string
    onChange?: (value: string, row: T | null) => void
    searchable?: boolean
    maxVisibleItems?: number
    readonly?: boolean
    disabled?: boolean
    status?: FormFieldStatus
    helperText?: string
    prefixText?: string
    suffixText?: string
    clearable?: boolean
    metaKey?: string
    metaFormatter?: (row: T) => string
    queryKeys?: string[]
    queryProcessor?: LookupEditQueryProcessor<T>
  }) {
    super()
    this._columns = opts.columns
    this._rows = opts.rows
    this.valueKey = opts.valueKey
    this.labelKey = opts.labelKey
    this._value = opts.value ?? ''
    this.placeholder = opts.placeholder ?? '请选择...'
    this.onChange = opts.onChange
    this._searchable = opts.searchable ?? true
    this.maxVisibleItems = opts.maxVisibleItems ?? 8
    this._readonly = opts.readonly ?? false
    this._disabled = opts.disabled ?? false
    this._status = opts.status ?? 'default'
    this._helperText = opts.helperText ?? ''
    this._prefixText = opts.prefixText ?? ''
    this._suffixText = opts.suffixText ?? ''
    this._clearable = opts.clearable ?? false
    this.metaKey = opts.metaKey
    this.metaFormatter = opts.metaFormatter
    this.queryKeys = opts.queryKeys
    this.queryProcessor = opts.queryProcessor
    this._valueIndex.sync(this._rows, this.valueKey)
    this._popup = new DropdownGridPopup()
    this._syncFocusRegistration()
  }

  addTextPointerEventListener(
    type: LookupEditTextPointerEventType,
    listener: PointerEventListener,
    options: PointerEventListenerOptions = {},
  ): DisposeFn {
    if (this._disposed) return () => {}
    const capture = options.capture === true
    const existing = this._textPointerListeners.find(entry => entry.type === type && entry.listener === listener && entry.capture === capture)
    if (existing) return existing.off
    const once = options.once === true
    const registration = { type, listener, capture, off: () => {} }
    const remove = this.addPointerEventListener(type, event => {
      if (event.target !== this || event.targetEntry.key !== this._textActivationKey || !this._canEditText()) return
      if (once) registration.off()
      listener(event)
    }, { capture })
    registration.off = () => {
      remove()
      const index = this._textPointerListeners.indexOf(registration)
      if (index >= 0) this._textPointerListeners.splice(index, 1)
    }
    this._textPointerListeners.push(registration)
    return registration.off
  }

  removeTextPointerEventListener(
    type: LookupEditTextPointerEventType,
    listener: PointerEventListener,
    options: Pick<PointerEventListenerOptions, 'capture'> = {},
  ): void {
    this._textPointerListeners.find(entry => entry.type === type && entry.listener === listener && entry.capture === (options.capture === true))?.off()
  }

  private _canEditText(): boolean {
    return this.searchable && !this.disabled && !this.readonly && !this._disposed
  }

  private _hitRegion(position: Offset): string {
    if (!this._hitField(position)) return 'lookup-helper'
    const layout = this._triggerLayout()
    if (pointInFormFieldRect(layout.clearRect, position)) return 'lookup-clear'
    if (pointInFormFieldRect(layout.trailingRect, position)) return 'lookup-arrow'
    if (this._canEditText() && pointInFormFieldRect(layout.valueRect, position) && position.x < layout.valueRect.x + this._editableWidth()) return 'lookup-text'
    return 'lookup-field'
  }

  override hitTestPath(point: Offset, result: HitTestResult): boolean {
    const path = new HitTestResult()
    if (!super.hitTestPath(point, path)) return false
    const region = this._hitRegion(point)
    const key = region === 'lookup-text' ? this._textActivationKey : region
    for (const entry of path.path) result.add(entry.target === this ? { ...entry, key } : entry)
    return true
  }

  private _invalidateTextActivation(): void {
    // Never pair an old press with a release after the field becomes active again.
    this._textActivationKey = Symbol('lookup-text')
  }

  get searchable(): boolean { return this._searchable }
  set searchable(searchable: boolean) {
    if (this._searchable === searchable) return
    this._searchable = searchable
    this._invalidateTextActivation()
    this._popup.close()
    this._editSession.end()
    this._resetQueryPresentation()
    if (searchable) this._startInputSession()
    this.markNeedsPaint()
  }

  get columns(): LookupEditColumn[] { return this._columns }
  set columns(columns: LookupEditColumn[]) {
    if (columns === this._columns) return
    this._columns = columns
    if (this._popup.visible) {
      this._popup.setColumns(columns)
      this._refreshQueryRows()
    }
    this.markNeedsPaint()
  }

  get rows(): T[] { return this._rows }
  set rows(rows: T[]) {
    if (rows === this._rows) return
    this._rows = rows
    this._valueIndex.sync(rows, this.valueKey)
    this._syncCommittedInput()
    if (this._popup.visible) this._refreshQueryRows()
    this.markNeedsPaint()
  }

  refreshLookup(): void {
    this._valueIndex.sync(this._rows, this.valueKey, true)
    this._syncCommittedInput()
    if (this._popup.visible) this._refreshQueryRows()
    this.markNeedsPaint()
  }

  get value(): string { return this._value }
  set value(value: string) {
    const nextValue = String(value ?? '')
    if (this._value === nextValue) return
    this._value = nextValue
    if (!this._showQueryInField) this._resetQueryPresentation()
    this.markNeedsPaint()
  }

  getValue(): string {
    return this.value
  }

  setValue(value: string): void {
    const nextValue = String(value ?? '')
    if (this.value === nextValue) return
    this._popup.close()
    this._resetQueryPresentation()
    this.value = nextValue
  }

  subscribeValueChange(
    listener: ValueEditorValueChangeListener<
      string,
      LookupEditValueChangeReason,
      T | null
    >,
  ): DisposeFn {
    return this._valueEditorEvents.subscribeValueChange(listener)
  }

  subscribeBlur(listener: () => void): DisposeFn {
    return this._valueEditorEvents.subscribeBlur(listener)
  }

  get disabled(): boolean { return this._disabled }
  set disabled(disabled: boolean) {
    if (this._disabled === disabled) return
    this._disabled = disabled
    if (disabled) {
      runCleanupSteps([
        () => { this._hovered = false },
        () => this._endLogicalFocusSession(),
        () => this._resetQueryPresentation(),
        () => this._syncFocusRegistration(),
        () => this.markNeedsPaint(),
      ])
      return
    }
    this._syncFocusRegistration()
    this.markNeedsPaint()
  }

  get status(): FormFieldStatus { return this._status }
  set status(status: FormFieldStatus) {
    if (this._status === status) return
    this._status = status
    this.markNeedsPaint()
  }

  get helperText(): string { return this._helperText }
  set helperText(helperText: string) {
    if (this._helperText === helperText) return
    this._helperText = helperText
    this.markNeedsLayout()
    this.markNeedsPaint()
  }

  get prefixText(): string { return this._prefixText }
  set prefixText(prefixText: string) {
    if (this._prefixText === prefixText) return
    this._prefixText = prefixText
    this.markNeedsPaint()
  }

  get suffixText(): string { return this._suffixText }
  set suffixText(suffixText: string) {
    if (this._suffixText === suffixText) return
    this._suffixText = suffixText
    this.markNeedsPaint()
  }

  get clearable(): boolean { return this._clearable }
  set clearable(clearable: boolean) {
    if (this._clearable === clearable) return
    this._clearable = clearable
    this.markNeedsPaint()
  }

  get readonly(): boolean { return this._readonly }
  set readonly(readonly: boolean) {
    if (this._readonly === readonly) return
    this._readonly = readonly
    if (readonly) {
      runCleanupSteps([
        () => { this._hovered = false },
        () => this._endLogicalFocusSession(),
        () => this._resetQueryPresentation(),
        () => this._syncFocusRegistration(),
        () => this.markNeedsPaint(),
      ])
      return
    }
    this._syncFocusRegistration()
    this.markNeedsPaint()
  }

  visitChildren(_visitor: (child: RenderObject) => void): void {}

  get isFocused(): boolean {
    return this._focused || this._popup.visible
  }

  focusIn(): void {
    if (this.disabled || this.readonly || this._focused || this._disposed) return
    this._focused = true
    this._startInputSession()
    this.markNeedsPaint()
  }

  focusOut(): void {
    if (!this._focused) return
    this._invalidateTextActivation()
    this._focused = false
    runCleanupSteps([
      () => this._editSession.end(),
      () => this._resetSelectionGesture(),
      () => this._popup.close(),
      () => this._resetQueryPresentation(),
      () => this.markNeedsPaint(),
      () => this._valueEditorEvents.emitBlur(),
    ])
  }

  private _startInputSession(): void {
    if (!this.searchable || !this._focused || this.disabled || this.readonly || this._disposed || this._textInput.hasSession) return
    const text = this._displayText()
    this._editSession.start({
      initialValue: text,
      initialSelection: { start: 0, end: text.length, syncComposer: true },
      refreshOnStart: true,
      onInput: (value, session) => {
        if (this._textInput.composing) return
        this._applyQuery(value)
        session.refresh({ syncSelectionFromComposer: true, resetBlink: true })
      },
      onCompositionUpdate: (_text, session) => session.refresh({ resetBlink: true }),
      onCompositionEnd: (value, session) => {
        this._applyQuery(value)
        session.refresh({ syncSelectionFromComposer: true, resetBlink: true })
      },
      onKeyDown: (event, session) => {
        if (event.defaultPrevented || this._isComposingKey(event)) return
        if (this.onKeyDown(event)) return
        session.defer(() => {}, { syncSelectionFromComposer: true, resetBlink: true })
      },
    })
  }

  private _applyQuery(value: string): void {
    if (!this._focused || this.disabled || this.readonly || this._disposed) return
    this._queryGeneration += 1
    this._queryText = value
    this._showQueryInField = true
    if (!this._popup.visible) this._openPopup(value, true)
    else this._refreshQueryRows()
    this.markNeedsPaint()
  }

  private _isComposingKey(event: KeyboardEvent): boolean {
    return event.isComposing || event.keyCode === 229 || event.key === 'Process' || this._textInput.composing
  }

  private _endLogicalFocusSession(): void {
    this._invalidateTextActivation()
    const wasFocused = this.isFocused
    runCleanupSteps([
      () => { this._focused = false },
      () => this._editSession.end(),
      () => this._resetSelectionGesture(),
      () => this._popup.close(),
      () => this.markNeedsPaint(),
      () => { if (wasFocused) this._valueEditorEvents.emitBlur() },
    ])
  }

  requestFocus(): void {
    if (this.disabled || this.readonly || typeof window === 'undefined') return
    FocusManager.instance.setFocus(this)
  }

  blur(): void {
    this._invalidateTextActivation()
    this._popup.close()
    this._resetQueryPresentation()
    if (typeof window === 'undefined') {
      this.focusOut()
      return
    }
    FocusManager.instance.clearFocusOf(this)
  }

  [GET_POPUP_ANCHOR_RECT](): { x: number; y: number; width: number; height: number } {
    const g = this.globalOffset
    return { x: g.x, y: g.y, width: this.size.width, height: this._inputStyle().height }
  }

  performLayout(constraints: BoxConstraints, context: LayoutContext): void {
    const inputStyle = deriveTextInputStyle(context.theme)
    this.size = {
      width: constraints.maxWidth === Infinity ? 220 : constraints.maxWidth,
      height: measureFormFieldHeight(inputStyle, inputStyle.height, this.helperText),
    }
    if (this._focused && this._textInput.hasSession) this._editSession.refresh({ invalidate: false })
  }

  performPaint(context: PaintContext, offset: Offset): void {
    const dl = new DrawList(context)
    const { x, y } = offset
    const { width: w } = this.size
    const input = deriveTextInputStyle(context.theme)
    const dropdown = deriveDropdownStyle(context.theme)
    const readonlyVisual = this.readonly && !this.disabled
    const shell = paintTriggerFieldShell(context, offset, w, {
      focused: readonlyVisual ? false : this._popup.visible || this._focused,
      hovered: readonlyVisual ? false : this._hovered,
      disabled: this.disabled,
      status: this.status,
      helperText: this.helperText,
      prefixText: this.prefixText,
      suffixText: this.suffixText,
      showClearButton: this._showClearButton(),
      reserveTrailingWidth: dropdown.fontSize,
    })
    const fieldHeight = shell.fieldHeight
    if (readonlyVisual) {
      const readonlyTint = blendColor(
        resolveBgColor(input.inputBg, 'normal'),
        input.placeholderText,
        0.06,
      )
      dl.fillRect(offset.x + 1, offset.y + 1, Math.max(0, w - 2), Math.max(0, fieldHeight - 2), readonlyTint, Math.max(0, input.borderRadius - 1))
    }
    const displayText = this._displayText()
    const displayMeta = this._displayMetaText()
    const hasCommittedLabel = this._selectedLabel().length > 0
    const showingPlaceholder = displayText.length === 0 && (!hasCommittedLabel || this._showQueryInField)
    const textColor = this.disabled
      ? input.textDisabled
      : showingPlaceholder
        ? input.placeholderText
        : resolveTextColor(dropdown.itemText, 'normal')
    const text = showingPlaceholder ? this.placeholder : displayText
    const metaFontSize = Math.max(11, dropdown.fontSize - 1)
    const metaTextColor = this.disabled ? input.textDisabled : input.placeholderText
    const metaWidth = displayMeta
      ? TextMeasurer.measureWidth(displayMeta, metaFontSize, dropdown.fontFamily)
      : 0
    const metaGap = displayMeta ? 8 : 0
    const metaX = shell.valueRect.x + Math.max(0, shell.valueRect.w - metaWidth)
    const textClipWidth = Math.max(0, shell.valueRect.w - metaWidth - metaGap)
    dl.pushClip(shell.valueRect.x, y, textClipWidth, fieldHeight)
    if (this._focused && this.searchable && this._textInput.hasSession) {
      paintSingleLineEditableText({
        dl,
        controller: this._textInput,
        displayText,
        measureText: value => this._measureText(value),
        fontSize: dropdown.fontSize,
        fontFamily: dropdown.fontFamily,
        textX: shell.valueRect.x - this._textInput.scrollX,
        textY: y + fieldHeight / 2,
        lineTop: y + 4,
        lineBottom: y + fieldHeight - 4,
        textColor,
        selectionBg: input.selectionBg,
        caretColor: input.caretColor,
        compositionTextColor: input.compositionText,
        compositionUnderlineColor: input.focusedBorder,
        placeholder: showingPlaceholder ? this.placeholder : undefined,
        placeholderColor: input.placeholderText,
      })
    } else paintSingleLineText(dl, {
      text,
      x: shell.valueRect.x,
      y: y + fieldHeight / 2,
      maxWidth: textClipWidth,
      color: textColor,
      fontSize: dropdown.fontSize,
      fontFamily: dropdown.fontFamily,
    })
    dl.popClip()
    if (displayMeta) {
      dl.pushClip(metaX, y, Math.max(0, shell.valueRect.x + shell.valueRect.w - metaX), fieldHeight)
      dl.fillText(displayMeta, metaX, y + fieldHeight / 2, metaTextColor, metaFontSize, dropdown.fontFamily, 'left', 'middle')
      dl.popClip()
    }

    const arrowX = (shell.trailingRect?.x ?? (x + w - input.padding - dropdown.fontSize)) + dropdown.fontSize / 2
    const arrowY = y + fieldHeight / 2
    const arrowColor = this.disabled
      ? input.textDisabled
      : readonlyVisual
        ? input.placeholderText
      : resolveTextColor(dropdown.arrowText, this._popup.visible || this._focused ? 'selected' : 'normal')
    if (readonlyVisual) {
      paintIconGlyph(context, {
        name: 'lock',
        x: arrowX - dropdown.fontSize / 2,
        y: arrowY - dropdown.fontSize / 2,
        size: dropdown.fontSize,
        color: arrowColor,
      })
    } else {
      const ctx = context.ctx
      ctx.save()
      ctx.fillStyle = `rgba(${arrowColor.r},${arrowColor.g},${arrowColor.b},${arrowColor.a})`
      ctx.beginPath()
      const ar = dropdown.fontSize * 0.3
      if (this._popup.visible) {
        ctx.moveTo(arrowX, arrowY - ar)
        ctx.lineTo(arrowX - ar, arrowY + ar)
        ctx.lineTo(arrowX + ar, arrowY + ar)
      } else {
        ctx.moveTo(arrowX, arrowY + ar)
        ctx.lineTo(arrowX - ar, arrowY - ar)
        ctx.lineTo(arrowX + ar, arrowY - ar)
      }
      ctx.closePath()
      ctx.fill()
      ctx.restore()
    }
  }

  onPointerDown(e: PointerEvent): void {
    if (this._selectionGesture.hasOwner && !this._selectionGesture.owns(e)) return
    if (!isPrimaryPointerButton(e) || this.disabled || !this._hitField(e.position)) return
    const layout = this._triggerLayout()
    if (pointInFormFieldRect(layout.clearRect, e.position)) {
      this._clearValue()
      return
    }
    if (this.readonly || this._disposed) return
    const wasFocused = this._focused
    FocusManager.instance.setFocus(this)
    if (!this._focused || this._disposed || this.disabled || this.readonly) return
    this._startInputSession()
    if (!this.searchable || pointInFormFieldRect(layout.trailingRect, e.position)) {
      if (this._popup.visible) this._popup.close()
      else this._openPopup('', false)
      return
    }
    this._editSession.focusComposer()
    if (!this._popup.visible) this._openPopup(this._queryText, this._showQueryInField)
    if (!this._focused || this._disposed || this.disabled || this.readonly) return
    if (wasFocused) {
      this._singleLineInput.setSelectionFromGlobal(e.position.x, { syncComposer: true })
    }
    this._dragStart = e.position
    this._dragPosition = e.position
    if (e.joinGestureArena) this._selectionGesture.begin(e, this)
    else {
      this._selectionGesture.captureImmediately(e)
      this._dragging = true
    }
    this._editSession.refresh({ resetBlink: true })
  }

  onDoubleClick(position: Offset): void {
    if (this._hitRegion(position) !== 'lookup-text') return
    this.requestFocus()
    this._resetSelectionGesture()
    this._singleLineInput.selectWordFromGlobal(position.x, { text: this._displayText(), syncComposer: true })
    this._editSession.refresh({ resetBlink: true })
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (event.defaultPrevented || this.disabled || this.readonly || this._disposed || this._isComposingKey(event)) return false
    if (event.key === 'Tab') {
      this._popup.close()
      this._resetQueryPresentation()
      return false
    }
    if (this._popup.visible) return PopupManager.instance.withContextFor(this._popup, () => this._popup.onKeyDown(event))
    if (event.key === 'Enter' || event.key === 'ArrowDown' || (!this.searchable && event.key === ' ')) {
      event.preventDefault()
      this._openPopup('', false)
      return true
    }
    if (!this.searchable && (event.key === 'Backspace' || event.key === 'Delete') && this._showClearButton()) {
      event.preventDefault()
      this._clearValue()
      return true
    }
    return false
  }

  onPointerMove(e: PointerEvent): void {
    if (this._selectionGesture.hasOwner && !this._selectionGesture.owns(e)) return
    const wasHovered = this._hovered
    this._hovered = !this.disabled && !this.readonly && this._hitField(e.position)
    if (wasHovered !== this._hovered) this.markNeedsPaint()
    this._dragPosition = e.position
    if (this._selectionGesture.isPending && this._dragStart) {
      const dx = e.position.x - this._dragStart.x
      const dy = e.position.y - this._dragStart.y
      if (Math.max(Math.abs(dx), Math.abs(dy)) >= 5) {
        this._selectionGesture.resolve(Math.abs(dx) >= Math.abs(dy) ? 'accepted' : 'rejected')
      }
    }
    if (this._dragging && this._focused) {
      this._singleLineInput.setSelectionFromGlobal(e.position.x, { extend: true, syncComposer: true })
      this._editSession.refresh({ resetBlink: true })
    }
  }

  acceptGesture(pointerId: number, pointerType: 'mouse' | 'touch' | 'pen' = 'mouse'): void {
    if (!this._selectionGesture.accept(pointerId, pointerType)) return
    this._dragging = true
    if (this._dragPosition) {
      this._singleLineInput.setSelectionFromGlobal(this._dragPosition.x, { extend: true, syncComposer: true })
      this._editSession.refresh({ resetBlink: true })
    }
  }

  rejectGesture(pointerId: number, pointerType: 'mouse' | 'touch' | 'pen' = 'mouse'): void {
    if (!this._selectionGesture.reject(pointerId, pointerType)) return
    this._dragging = false
    this._dragStart = undefined
    this._dragPosition = undefined
  }

  onPointerUp(e: PointerEvent): void {
    if (this._selectionGesture.hasOwner && !this._selectionGesture.owns(e)) return
    this._resetSelectionGesture()
  }

  onPointerCancel(e: PointerEvent): void {
    if (this._selectionGesture.hasOwner && !this._selectionGesture.owns(e)) return
    this._invalidateTextActivation()
    this._resetSelectionGesture()
    this._hovered = false
    this.markNeedsPaint()
  }

  private _resetSelectionGesture(): void {
    this._selectionGesture.resolveTerminal('rejected', () => {
      this._dragging = false
      this._dragStart = undefined
      this._dragPosition = undefined
    })
  }

  onPointerLeave(_e: PointerEvent): void {
    if (!this._hovered) return
    this._hovered = false
    this.markNeedsPaint()
  }

  override detach(): void {
    runCleanupSteps([() => this.blur(), () => super.detach()])
  }

  protected override onVisibilityChanged(visible: boolean): void {
    if (!visible) this.blur()
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._invalidateTextActivation()
    runCleanupSteps([
      () => { for (const entry of [...this._textPointerListeners]) entry.off() },
      () => this._resetSelectionGesture(),
      () => this._textInput.dispose(),
      () => this._valueEditorEvents.dispose(),
      () => this._resetQueryPresentation(),
      () => this._popup.dispose(),
      () => this._valueIndex.clear(),
      () => {
        if (this._focusRegistered && typeof window !== 'undefined') {
          FocusManager.instance.unregister(this)
          this._focusRegistered = false
        }
        this._focused = false
        this._hovered = false
      },
      () => super.dispose(),
    ])
  }

  debugState(): LookupEditDebugState {
    return {
      popupVisible: this._popup.visible,
      queryText: this._queryText,
      showQueryInField: this._showQueryInField,
      displayText: this._displayText(),
      focused: this._focused,
      disabled: this.disabled,
      readonly: this.readonly,
      value: this.value,
      selectedLabel: this._selectedLabel(),
      filteredCount: this._debugFilteredCount(),
    }
  }

  private _openPopup(initialQuery: string, showQueryInField: boolean): void {
    if (this.disabled || this.readonly || this._disposed || this._popup.visible) return
    this._queryText = initialQuery
    this._showQueryInField = showQueryInField
    const generation = ++this._queryGeneration
    const rows = this._resolveQueryRows(initialQuery)
    if (generation !== this._queryGeneration || !this._focused || this.disabled || this.readonly || this._disposed || !this.visible || this._popup.visible) return
    this._popup.open({
      columns: this.columns,
      rows,
      valueKey: this.valueKey,
      labelKey: this.labelKey,
      selectedValue: this.value,
      anchor: this as PopupAnchorTarget,
      searchable: false,
      ownerInput: true,
      searchBehavior: 'external',
      searchText: initialQuery,
      maxVisibleItems: this.maxVisibleItems,
      onSelect: (value, row) => {
        this.value = value
        // Finish the old session before callbacks can open another popup or dispose us.
        this._popup.close()
        this._resetQueryPresentation()
        this._emitValueChange(value, row as T, 'selection')
        return false
      },
      onClose: () => {
        this._resetQueryPresentation()
        this.markNeedsPaint()
      },
    })
    this.markNeedsPaint()
  }

  private _resetQueryPresentation(): void {
    this._queryGeneration += 1
    this._queryText = ''
    this._showQueryInField = false
    this._resetSelectionGesture()
    if (this._focused && this._textInput.hasSession && !this._disposed) {
      const label = this._selectedLabel()
      this._textInput.setComposerValue(label)
      this._textInput.setSelection(0, label.length, { syncComposer: true })
      this._textInput.setScrollX(0)
      this._editSession.refresh()
    }
  }

  private _syncCommittedInput(): void {
    if (this._showQueryInField || !this._focused || !this._textInput.hasSession || this._textInput.composing) return
    const label = this._selectedLabel()
    const previousText = this._textInput.composerValue
    if (previousText === label) return
    this._textInput.syncSelectionFromComposer()
    const selectedAll = this._textInput.selStart === 0 && this._textInput.selEnd === previousText.length
    const range = normalizeUtf16ScalarRange(label, {
      start: Math.min(this._textInput.selStart, label.length),
      end: selectedAll ? label.length : Math.min(this._textInput.selEnd, label.length),
    })
    const cursor = selectedAll || this._textInput.cursorPos >= range.end ? range.end : range.start
    this._textInput.setComposerValue(label)
    this._textInput.setSelection(range.start, range.end, { cursorPos: cursor, syncComposer: true })
    this._editSession.refresh({ resetBlink: true })
  }

  private _refreshQueryRows(): void {
    const generation = ++this._queryGeneration
    const rows = this._resolveQueryRows(this._queryText)
    if (generation === this._queryGeneration && this._popup.visible && !this._disposed) this._popup.setRows(rows)
  }

  private _editableWidth(): number {
    const style = deriveDropdownStyle(this.currentTheme)
    const meta = this._displayMetaText()
    const metaWidth = meta ? TextMeasurer.measureWidth(meta, Math.max(11, style.fontSize - 1), style.fontFamily) + 8 : 0
    return Math.max(0, this._triggerLayout().valueRect.w - metaWidth)
  }

  private _measureText(text: string): number {
    const style = deriveDropdownStyle(this.currentTheme)
    return TextMeasurer.measureWidth(text, style.fontSize, style.fontFamily)
  }

  private _debugFilteredCount(): number {
    return this._popup.visible ? this._popup.debugState().filteredRows.length : this.rows.length
  }

  private _showClearButton(): boolean {
    return this.clearable && !this.disabled && !this.readonly && this.value.length > 0
  }

  private _selectedRow(): T | null {
    this._valueIndex.sync(this.rows, this.valueKey)
    return this._valueIndex.get(this.value) ?? null
  }

  private _resolveQueryRows(query: string): T[] {
    const processor = this.queryProcessor ?? defaultLookupQueryProcessor<T>
    return processor({
      query,
      rows: this.rows,
      columns: this.columns,
      valueKey: this.valueKey,
      labelKey: this.labelKey,
      metaKey: this.metaKey,
      queryKeys: this._queryKeys(),
      selectedValue: this.value,
    }).rows
  }

  private _selectedLabel(): string {
    const row = this._selectedRow()
    return row ? String(row[this.labelKey] ?? '') : ''
  }

  private _displayText(): string {
    if (this._textInput.composing) return this._textInput.composerValue
    if (this._popup.visible && this._showQueryInField) return this._queryText
    return this._selectedLabel()
  }

  private _displayMetaText(): string {
    if ((this._popup.visible && this._showQueryInField) || this._textInput.composing) return ''
    const row = this._selectedRow()
    if (!row) return ''
    if (this.metaFormatter) return String(this.metaFormatter(row) ?? '')
    if (this.metaKey) return String(row[this.metaKey] ?? '')
    return ''
  }

  private _triggerLayout() {
    const style = this._inputStyle()
    return layoutFormFieldInlineContent(style, this.globalOffset, this.size.width, style.height, {
      prefixText: this.prefixText,
      suffixText: this.suffixText,
      showClearButton: this._showClearButton(),
      reserveTrailingWidth: deriveDropdownStyle(this.currentTheme).fontSize,
    })
  }

  private _clearValue(): void {
    if (!this._showClearButton()) return
    this._popup.close()
    this._resetQueryPresentation()
    FocusManager.instance.setFocus(this)
    this.value = ''
    this._emitValueChange('', null, 'clear')
    this.markNeedsPaint()
  }

  private _emitValueChange(
    value: string,
    row: T | null,
    reason: LookupEditValueChangeReason,
  ): void {
    runCleanupSteps([
      () => this.onChange?.(value, row),
      () => this._valueEditorEvents.emitValueChange({
        value,
        reason,
        detail: row,
      }),
    ])
  }

  private _syncFocusRegistration(): void {
    if (typeof window === 'undefined') return
    if (this.disabled || this.readonly) {
      if (this._focusRegistered) {
        FocusManager.instance.unregister(this)
        this._focusRegistered = false
      }
      return
    }
    if (!this._focusRegistered) {
      FocusManager.instance.register(this)
      this._focusRegistered = true
    }
  }

  private _hitField(position: Offset): boolean {
    const g = this.globalOffset
    const fieldHeight = this._inputStyle().height
    return position.x >= g.x &&
      position.x <= g.x + this.size.width &&
      position.y >= g.y &&
      position.y <= g.y + fieldHeight
  }

  private _inputStyle(): ReturnType<typeof deriveTextInputStyle> {
    return deriveTextInputStyle(this.currentTheme)
  }

  private _queryKeys(): string[] {
    if (this.queryKeys && this.queryKeys.length > 0) return [...this.queryKeys]
    return dedupeLookupKeys([
      this.valueKey,
      this.labelKey,
      this.metaKey,
      ...this.columns.map(column => column.key),
    ])
  }
}

export function defaultLookupQueryProcessor<T extends Record<string, any> = Record<string, any>>(
  context: LookupEditQueryContext<T>,
): LookupEditQueryResult<T> {
  const query = normalizeLookupQueryValue(context.query)
  if (!query) return { rows: [...context.rows] }

  const matches = context.rows.flatMap((row, rowIndex) => {
    const score = bestLookupMatchScore(row, rowIndex, context, query)
    return score ? [{ row, score }] : []
  })

  matches.sort((a, b) =>
    a.score.matchType - b.score.matchType ||
    a.score.fieldPriority - b.score.fieldPriority ||
    a.score.matchIndex - b.score.matchIndex ||
    a.score.exactLengthDelta - b.score.exactLengthDelta ||
    a.score.rowIndex - b.score.rowIndex)

  return { rows: matches.map(match => match.row) }
}

function dedupeLookupKeys(keys: Array<string | undefined>): string[] {
  const result: string[] = []
  for (const key of keys) {
    if (!key || result.includes(key)) continue
    result.push(key)
  }
  return result
}

function normalizeLookupQueryValue(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

function bestLookupMatchScore<T extends Record<string, any>>(
  row: T,
  rowIndex: number,
  context: LookupEditQueryContext<T>,
  query: string,
): {
  matchType: number
  fieldPriority: number
  matchIndex: number
  exactLengthDelta: number
  rowIndex: number
} | null {
  let best: {
    matchType: number
    fieldPriority: number
    matchIndex: number
    exactLengthDelta: number
    rowIndex: number
  } | null = null

  for (let fieldIndex = 0; fieldIndex < context.queryKeys.length; fieldIndex += 1) {
    const key = context.queryKeys[fieldIndex]!
    const text = normalizeLookupQueryValue(row[key])
    if (!text) continue
    let matchType = -1
    let matchIndex = -1
    if (text === query) {
      matchType = 0
      matchIndex = 0
    } else if (text.startsWith(query)) {
      matchType = 1
      matchIndex = 0
    } else {
      const containsIndex = text.indexOf(query)
      if (containsIndex >= 0) {
        matchType = 2
        matchIndex = containsIndex
      }
    }
    if (matchType < 0) continue
    const fieldPriority = key === context.valueKey
      ? 0
      : key === context.labelKey
        ? 1
        : key === context.metaKey
          ? 2
          : 3 + fieldIndex
    const candidate = {
      matchType,
      fieldPriority,
      matchIndex,
      exactLengthDelta: Math.max(0, text.length - query.length),
      rowIndex,
    }
    if (!best ||
      candidate.matchType < best.matchType ||
      (candidate.matchType === best.matchType && candidate.fieldPriority < best.fieldPriority) ||
      (candidate.matchType === best.matchType && candidate.fieldPriority === best.fieldPriority && candidate.matchIndex < best.matchIndex) ||
      (candidate.matchType === best.matchType && candidate.fieldPriority === best.fieldPriority && candidate.matchIndex === best.matchIndex && candidate.exactLengthDelta < best.exactLengthDelta)) {
      best = candidate
    }
  }

  return best
}
