import { TextMeasurer } from '../core/text_measurer'
import { TextInputController } from '../core/text_input_controller'
import { SingleLineTextInput } from '../core/single_line_text_input'
import { TextEditSession } from '../core/text_edit_session'
import { PendingPointerGesture } from '../gestures/pending_pointer_gesture'
import type { GestureArenaMember } from '../gestures/gesture_arena'
import { paintSingleLineEditableText } from '../rendering/single_line_text_renderer'
import { FocusManager, type Focusable } from '../core/focus_manager'
import { type PopupAnchorTarget, GET_POPUP_ANCHOR_RECT } from '../core/popup_anchor'
import { PopupManager, clampRectToPopupViewport, type PopupContext } from '../core/popup_manager'
import { PopupPanelShell, type PopupPanelLayout } from '../core/popup_shell'
import type { BoxConstraints, LayoutContext, Offset, RenderObject } from '../core/render_object'
import { runCleanupSteps, type DisposeFn } from '../core/disposable'
import { HitTestResult, isPrimaryPointerButton, type PointerEvent as PopupPointerEvent, type WheelPointerEvent } from '../gestures/hit_test'
import type { InteractiveRenderObject, PointerEvent } from '../gestures/recognizers'
import { RenderBox } from '../layout/render_box'
import { DrawList } from '../rendering/draw_list'
import { paintSingleLineText } from '../rendering/text_painter'
import type { PaintContext } from '../rendering/paint_context'
import { drawPopupPanel } from '../rendering/popup_painter'
import {
  blendColor,
  deriveDropdownStyle,
  derivePopupStyle,
  deriveTextInputStyle,
  deriveTreeStyle,
  resolveBgColor,
  resolveTextColor,
} from '../theme/component_styles'
import { layoutFormFieldInlineContent, measureFormFieldHeight, pointInFormFieldRect, type FormFieldStatus } from './form_field_shell'
import { paintTriggerFieldShell } from './trigger_field_shell'
import { paintIconGlyph } from './icon'
import { RenderTreeView, type TreeNode } from './tree'
import {
  ValueEditorEventEmitter,
  type ValueEditor,
  type ValueEditorValueChangeListener,
} from './value_editor'

type DropCheckTreeLayout = PopupPanelLayout & {
  searchRect: { x: number; y: number; w: number; h: number } | null
  treeRect: { x: number; y: number; w: number; h: number }
}

export interface DropCheckTreeEditQueryContext<T = any> {
  query: string
  roots: readonly TreeNode<T>[]
  checkedKeys: readonly string[]
}

export interface DropCheckTreeEditExpandOnOpenContext<T = any> {
  roots: readonly TreeNode<T>[]
  checkedKeys: readonly string[]
}

export interface DropCheckTreeEditSummaryContext<T = any> {
  roots: readonly TreeNode<T>[]
  checkedKeys: readonly string[]
  checkedNodes: readonly TreeNode<T>[]
}

export type DropCheckTreeEditQueryProcessor<T = any> =
  (context: DropCheckTreeEditQueryContext<T>) => TreeNode<T>[]

export type DropCheckTreeEditQueryTextBuilder<T = any> =
  (node: TreeNode<T>) => string[]

export type DropCheckTreeEditExpandedKeysResolver<T = any> =
  (context: DropCheckTreeEditExpandOnOpenContext<T>) => readonly string[]

export type DropCheckTreeEditSummaryBuilder<T = any> =
  (context: DropCheckTreeEditSummaryContext<T>) => string

export interface DropCheckTreeEditDebugState {
  popupVisible: boolean
  queryText: string
  showQueryInField: boolean
  displayText: string
  focused: boolean
  disabled: boolean
  readonly: boolean
  checkedKeys: string[]
  checkedLabel: string
  filteredCount: number
  expandedKeys: string[]
}

export type DropCheckTreeEditValueChangeReason = 'selection' | 'clear'

interface DropCheckTreePopupOpenOptions<T = any> {
  anchor: PopupAnchorTarget
  checkedKeys: readonly string[]
  ownerInput: boolean
  isCurrent: () => boolean
  maxVisibleItems: number
  initialQuery: string
  resolveRoots: (query: string) => TreeNode<T>[]
  onCheck: (checkedKeys: string[], checkedNodes: TreeNode<T>[]) => void
  onClose: () => void
  openExpandedKeys?: readonly string[]
  checkedAncestorKeys: readonly string[]
}

class DropCheckTreePopup<T = any> extends PopupPanelShell {
  private _tree: RenderTreeView<T> | null = null
  private _anchor?: PopupAnchorTarget
  private _checkedKeys = new Set<string>()
  private _ownerInput = false
  private _maxVisibleItems = 8
  private _searchText = ''
  private _resolveRoots?: (query: string) => TreeNode<T>[]
  private _onCheck?: (checkedKeys: string[], checkedNodes: TreeNode<T>[]) => void
  private _onClose?: () => void
  private _isCurrent?: () => boolean
  private _expandedKeys = new Set<string>()
  private _filteredRoots: TreeNode<T>[] = []
  private _scopeKeys = new Set<string>()
  private _session = 0
  private _revision = 0
  private _loadingRoots = false
  private _disposed = false

  get searchText(): string { return this._searchText }
  get checkedKeys(): string[] { return [...this._checkedKeys] }
  get filteredRoots(): TreeNode<T>[] { return this._filteredRoots }
  get filteredCount(): number { return countTreeNodes(this._filteredRoots) }
  get expandedKeys(): string[] { return this._tree?.expandedKeys ?? [...this._expandedKeys] }
  get navigationKey(): string | null { return this._tree?.navigationKey ?? null }

  set checkedKeys(keys: readonly string[]) {
    if (sameStringArray([...this._checkedKeys], keys)) return
    this._checkedKeys = new Set(keys)
    this.refresh()
  }

  pruneExpandedKeys(keys: readonly string[]): void {
    const valid = new Set(keys)
    this._expandedKeys = new Set([...this._expandedKeys].filter(key => valid.has(key)))
  }

  clearNavigation(): void {
    this._tree?.setNavigationKey(null)
  }

  setQuery(query: string): void {
    this._searchText = query
    this.clearNavigation()
    this.refresh()
  }

  private _loadRoots(): boolean {
    if (!this._resolveRoots || this._disposed || this._isCurrent?.() === false) return false
    const revision = ++this._revision
    if (this._loadingRoots) return false
    this._loadingRoots = true
    let roots: TreeNode<T>[]
    try { roots = this._resolveRoots(this._searchText) }
    finally { this._loadingRoots = false }
    if (revision !== this._revision || this._disposed || this._isCurrent?.() === false) return false
    this._filteredRoots = roots
    this._scopeKeys = new Set(collectCheckTargetKeys(roots))
    return true
  }

  refresh(): void {
    try {
      if (!this._loadRoots()) {
        if (this.visible && this._isCurrent?.() !== false) {
          this._filteredRoots = []
          this._scopeKeys.clear()
          this._syncTree()
          PopupManager.instance.requestPaint()
        }
        return
      }
    } catch (error) {
      this._filteredRoots = []
      this._scopeKeys.clear()
      this._syncTree()
      PopupManager.instance.requestPaint()
      throw error
    }
    this._syncTree()
    PopupManager.instance.requestPaint()
  }

  open(options: DropCheckTreePopupOpenOptions<T>): void {
    if (this._disposed) return
    if (this.visible) this.close()
    const session = ++this._session
    this._anchor = options.anchor
    this._checkedKeys = new Set(options.checkedKeys)
    this._ownerInput = options.ownerInput
    this._isCurrent = options.isCurrent
    this._maxVisibleItems = options.maxVisibleItems
    this._searchText = options.initialQuery
    this._resolveRoots = options.resolveRoots
    this._onCheck = options.onCheck
    this._onClose = options.onClose
    if (options.openExpandedKeys) this._expandedKeys = new Set(options.openExpandedKeys)
    this._expandedKeys = new Set([...this._expandedKeys, ...options.checkedAncestorKeys])
    try {
      if (!this._loadRoots() || session !== this._session) {
        if (session === this._session && !this.visible) this._discardRoots()
        return
      }
      this._tree = this._createTree()
    } catch (error) {
      if (session === this._session && !this.visible) this._discardRoots()
      throw error
    }
    this.openPopup({ owner: options.anchor, ...(this._ownerInput ? { interactionMode: 'nonmodal' as const, closeOnTransient: true } : {}) })
    if (!this._ownerInput && this._tree) FocusManager.instance.setFocus(this._tree)
    PopupManager.instance.requestPaint()
  }

  private _discardRoots(): void {
    this._filteredRoots = []
    this._scopeKeys.clear()
    this._resolveRoots = undefined
    this._onCheck = undefined
    this._onClose = undefined
    this._isCurrent = undefined
  }

  private _createTree(): RenderTreeView<T> {
    const session = this._session
    const tree = new RenderTreeView<T>({
      roots: this.filteredRoots,
      selectionMode: 'check',
      focusMode: this._ownerInput ? 'owner' : 'self',
      defaultCheckedKeys: [...this._checkedKeys],
      defaultExpandedKeys: this._defaultExpandedKeys(),
      onCheck: payload => {
        if (session !== this._session || tree !== this._tree || !this.visible || this._isCurrent?.() === false) return
        const revision = this._revision
        // Only replace this projection's check targets. Hidden and unresolved values survive.
        const local = new Set(payload.checkedKeys)
        const next = new Set([...this._checkedKeys].filter(key => !this._scopeKeys.has(key) || local.has(key)))
        for (const key of local) if (this._scopeKeys.has(key)) next.add(key)
        this._checkedKeys = next
        runCleanupSteps([
          () => this._onCheck?.([...next], payload.checkedNodes),
          () => {
            if (session === this._session && revision === this._revision && this.visible && this._isCurrent?.() !== false) this.refresh()
          },
        ])
      },
      onExpand: () => {
        if (session !== this._session) return
        if (!this._searchText.trim()) this._expandedKeys = new Set(tree.expandedKeys)
        PopupManager.instance.requestPaint()
      },
    })
    return tree
  }

  private _syncTree(): void {
    if (!this._tree) return
    const navigation = this._tree.navigationKey
    this._tree.setRoots(this.filteredRoots)
    this._tree.checkedKeys = [...this._checkedKeys]
    this._tree.expandedKeys = this._defaultExpandedKeys()
    if (this._ownerInput) this._tree.setNavigationKey(navigation)
  }

  private _defaultExpandedKeys(): string[] {
    if (this._searchText.trim()) return collectExpandableNodeKeys(this.filteredRoots)
    return [...this._expandedKeys]
  }

  focusRoots(): readonly RenderObject[] {
    return this.visible && this._tree && !this._ownerInput ? [this._tree] : []
  }

  override hitTest(point: Offset, context: PopupContext): boolean {
    if (!this.visible) return false
    const layout = this._layout(context)
    return point.x >= layout.panelX && point.x <= layout.panelX + layout.panelW && point.y >= layout.panelY && point.y <= layout.panelY + layout.panelH
  }

  onOutsidePointerDown(event: PopupPointerEvent): boolean {
    if (!this._anchor) return false
    const rect = this._anchor[GET_POPUP_ANCHOR_RECT]()
    if (event.position.x < rect.x || event.position.x > rect.x + rect.width || event.position.y < rect.y || event.position.y > rect.y + rect.height) return false
    this.close()
    return true
  }

  onPointerDown(event: PopupPointerEvent, context = PopupManager.instance.context): void {
    if (!this.visible || !isPrimaryPointerButton(event)) return
    this._syncTreeLayout(this._layout(context), context)
    this._tree?.onPointerDown(event)
    PopupManager.instance.requestPaint()
  }
  onPointerMove(event: PopupPointerEvent): void { if (this.visible) this._tree?.onPointerMove(event) }
  onPointerUp(event: PopupPointerEvent): void { if (this.visible) this._tree?.onPointerUp(event) }
  onPointerCancel(event: PopupPointerEvent): void { this._tree?.onPointerCancel(event) }

  onWheel(event: WheelPointerEvent, context = PopupManager.instance.context): boolean {
    if (!this.hitTest(event.position, context)) return false
    this._tree?.onWheel(event)
    return true
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.visible || event.defaultPrevented || event.isComposing || event.keyCode === 229) return false
    if (event.key === 'Tab') { this.close(); return false }
    if (event.key === 'Escape') { event.preventDefault(); this.close(); return true }
    if (this._ownerInput) {
      const handled = this._tree?.handleOwnedKeyDown(event) ?? false
      if (handled || event.key === 'Enter') { event.preventDefault(); return true }
      return false
    }
    if (this._tree && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)) {
      FocusManager.instance.setFocus(this._tree)
      return this._tree.onKeyDown(event)
    }
    return false
  }

  override onEscape(event: KeyboardEvent): boolean {
    if (!this.visible) return false
    event.preventDefault(); this.close(); return true
  }

  paint(context: PaintContext): void {
    if (!this.visible) return
    const layout = this._layout(PopupManager.instance.context)
    this._syncTreeLayout(layout, PopupManager.instance.context)
    const dl = new DrawList(context), popup = derivePopupStyle(context.theme)
    drawPopupPanel(dl, layout.panelX, layout.panelY, layout.panelW, layout.panelH, popup)
    this._tree?.paint(context, { x: layout.treeRect.x, y: layout.treeRect.y })
    if (!this.filteredCount) dl.fillText('无匹配节点', layout.treeRect.x + 8, layout.treeRect.y + layout.treeRect.h / 2, popup.textDisabled, popup.fontSize, popup.fontFamily, 'left', 'middle')
  }

  protected override getPanelLayout(context: PopupContext): PopupPanelLayout { return this._layout(context) }

  private _syncTreeLayout(layout: DropCheckTreeLayout, context: PopupContext): void {
    if (!this._tree) return
    this._tree.offset = { x: layout.treeRect.x, y: layout.treeRect.y }
    this._tree.layout({ minWidth: layout.treeRect.w, maxWidth: layout.treeRect.w, minHeight: layout.treeRect.h, maxHeight: layout.treeRect.h }, false, { theme: context.theme })
  }

  private _layout(context: PopupContext): DropCheckTreeLayout {
    const popup = derivePopupStyle(context.theme), input = deriveTextInputStyle(context.theme), tree = deriveTreeStyle(context.theme)
    const anchor = this._anchor?.[GET_POPUP_ANCHOR_RECT]() ?? { x: 0, y: 0, width: 240, height: input.height }
    const panelW = Math.max(0, Math.min(Math.max(280, anchor.width), context.viewport.width - 16))
    const rowHeight = tree.fontSize + tree.paddingH * 1.5
    const visibleCount = Math.max(1, Math.min(this._maxVisibleItems, countVisibleTreeNodes(this.filteredRoots, this.expandedKeys)))
    const treeH = Math.max(0, Math.min(Math.max(rowHeight + 8, rowHeight * visibleCount), context.viewport.height - 16 - popup.padding * 2))
    const panelH = popup.padding * 2 + treeH
    let y = anchor.y + anchor.height + 4
    if (y + panelH > (context.viewport.y ?? 0) + context.viewport.height - 8) y = anchor.y - panelH - 4
    const rect = clampRectToPopupViewport({ x: anchor.x, y, width: panelW, height: panelH }, context, 8)
    return { panelX: rect.x, panelY: rect.y, panelW, panelH, searchRect: null, treeRect: { x: rect.x + popup.padding, y: rect.y + popup.padding, w: Math.max(0, panelW - popup.padding * 2), h: treeH } }
  }

  protected override onPopupClose(): void {
    this._session += 1
    this._revision += 1
    const tree = this._tree, close = this._onClose
    this._tree = null
    if (tree && !this._searchText.trim()) this._expandedKeys = new Set(tree.expandedKeys)
    this._discardRoots()
    runCleanupSteps([() => tree?.dispose(), () => close?.()])
  }

  disposePopup(): void {
    if (this._disposed) return
    this._disposed = true
    this._session += 1
    this._revision += 1
    runCleanupSteps([() => this.close(), () => { this._tree?.dispose(); this._tree = null }, () => this._discardRoots()])
  }
}

export class RenderDropCheckTreeEdit<T = any>
  extends RenderBox
  implements
    InteractiveRenderObject,
    GestureArenaMember,
    Focusable,
    PopupAnchorTarget,
    ValueEditor<string[], DropCheckTreeEditValueChangeReason, TreeNode<T>[]> {
  private _roots: TreeNode<T>[]
  private _checkedKeys: string[]
  placeholder: string
  onChange?: (checkedKeys: string[], nodes: TreeNode<T>[]) => void
  private _searchable: boolean
  maxVisibleItems: number
  private _readonly: boolean
  private _disabled: boolean
  private _status: FormFieldStatus
  private _helperText: string
  private _prefixText: string
  private _suffixText: string
  private _clearable: boolean
  expandAllOnOpen: boolean
  expandedKeysOnOpen?: readonly string[] | DropCheckTreeEditExpandedKeysResolver<T>
  queryTextBuilder?: DropCheckTreeEditQueryTextBuilder<T>
  queryProcessor?: DropCheckTreeEditQueryProcessor<T>
  summaryBuilder?: DropCheckTreeEditSummaryBuilder<T>
  maxSummaryItems: number
  private _focusRegistered = false

  private _focused = false
  private _hovered = false
  private _popup = new DropCheckTreePopup<T>()
  private _disposed = false
  private _textActivationKey = Symbol('drop-check-tree-text')
  private readonly _selectionGesture = new PendingPointerGesture()
  private _dragStart?: Offset
  private _dragPosition?: Offset
  private _dragging = false
  readonly preventsPointerActivationOnAccept = true
  onDoubleClick?: (position: Offset) => void
  private readonly _textInput = new TextInputController({ onInvalidate: () => this.markNeedsPaint() })
  private readonly _singleLineInput = new SingleLineTextInput({
    controller: this._textInput,
    getDisplayText: () => this._queryValue(),
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
  private _popupSession = 0
  private _queryCancellation = 0
  private _hoverPart?: 'text' | 'count' | 'clear'
  private _queryText = ''
  private _showQueryInField = false
  private readonly _valueEditorEvents = new ValueEditorEventEmitter<
    string[],
    DropCheckTreeEditValueChangeReason,
    TreeNode<T>[]
  >()

  constructor(options: {
    roots: TreeNode<T>[]
    checkedKeys?: readonly string[]
    placeholder?: string
    onChange?: (checkedKeys: string[], nodes: TreeNode<T>[]) => void
    searchable?: boolean
    maxVisibleItems?: number
    readonly?: boolean
    disabled?: boolean
    status?: FormFieldStatus
    helperText?: string
    prefixText?: string
    suffixText?: string
    clearable?: boolean
    expandAllOnOpen?: boolean
    expandedKeysOnOpen?: readonly string[] | DropCheckTreeEditExpandedKeysResolver<T>
    queryTextBuilder?: DropCheckTreeEditQueryTextBuilder<T>
    queryProcessor?: DropCheckTreeEditQueryProcessor<T>
    summaryBuilder?: DropCheckTreeEditSummaryBuilder<T>
    maxSummaryItems?: number
  }) {
    super()
    this._roots = options.roots
    this._checkedKeys = normalizeUniqueKeys(options.checkedKeys ?? [])
    this.placeholder = options.placeholder ?? '请选择...'
    this.onChange = options.onChange
    this._searchable = options.searchable ?? true
    if (this._searchable) this.onDoubleClick = position => this._selectWord(position)
    this.maxVisibleItems = options.maxVisibleItems ?? 8
    this._readonly = options.readonly ?? false
    this._disabled = options.disabled ?? false
    this._status = options.status ?? 'default'
    this._helperText = options.helperText ?? ''
    this._prefixText = options.prefixText ?? ''
    this._suffixText = options.suffixText ?? ''
    this._clearable = options.clearable ?? false
    this.expandAllOnOpen = options.expandAllOnOpen ?? false
    this.expandedKeysOnOpen = options.expandedKeysOnOpen
    this.queryTextBuilder = options.queryTextBuilder
    this.queryProcessor = options.queryProcessor
    this.summaryBuilder = options.summaryBuilder
    this.maxSummaryItems = Math.max(1, options.maxSummaryItems ?? 2)
    this._syncFocusRegistration()
  }

  get searchable(): boolean { return this._searchable }
  set searchable(searchable: boolean) {
    if (this._searchable === searchable) return
    this._searchable = searchable
    this._invalidateTextActivation()
    this.onDoubleClick = searchable ? position => this._selectWord(position) : undefined
    this._popup.close()
    this._editSession.end()
    this._resetQueryPresentation()
    this._startInputSession()
    this.markNeedsPaint()
  }

  get roots(): TreeNode<T>[] { return this._roots }
  set roots(roots: TreeNode<T>[]) {
    if (roots === this._roots) return
    this._roots = roots
    this.refreshTree()
  }

  refreshTree(): void {
    this._popup.pruneExpandedKeys(collectExpandableNodeKeys(this.roots))
    this._popup.refresh()
    this._refreshInputViewport()
    this.markNeedsPaint()
  }

  get checkedKeys(): string[] { return [...this._checkedKeys] }
  set checkedKeys(keys: readonly string[]) {
    const nextKeys = normalizeUniqueKeys(keys)
    if (sameStringArray(nextKeys, this._checkedKeys)) return
    this._checkedKeys = nextKeys
    if (this._popup.visible) this._popup.checkedKeys = nextKeys
    this._refreshInputViewport()
    this.markNeedsPaint()
  }

  getValue(): string[] {
    return this.checkedKeys
  }

  setValue(value: string[]): void {
    const nextValue = normalizeUniqueKeys(value)
    if (sameStringArray(nextValue, this._checkedKeys)) return
    this._popup.close()
    this._resetQueryPresentation()
    this.checkedKeys = nextValue
  }

  subscribeValueChange(
    listener: ValueEditorValueChangeListener<
      string[],
      DropCheckTreeEditValueChangeReason,
      TreeNode<T>[]
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

  get isFocused(): boolean { return this._focused || this._popup.visible }

  focusIn(): void {
    if (this.disabled || this.readonly || this._disposed) return
    if (this._focused) return
    this._focused = true
    if (this.searchable) { this._queryText = ''; this._showQueryInField = true }
    this._startInputSession()
    this.markNeedsPaint()
  }

  focusOut(): void {
    if (!this._focused) return
    if (!this.searchable) {
      const movingIntoOwnedPopup = this._popup.visible
      this._focused = false
      this.markNeedsPaint()
      if (!movingIntoOwnedPopup) this._valueEditorEvents.emitBlur()
      return
    }
    this._focused = false
    this._invalidateTextActivation()
    runCleanupSteps([
      () => this._editSession.end(),
      () => this._resetSelectionGesture(),
      () => this._popup.close(),
      () => this._resetQueryPresentation(),
      () => this.markNeedsPaint(),
      () => this._valueEditorEvents.emitBlur(),
    ])
  }

  private _endLogicalFocusSession(): void {
    const wasFocused = this.isFocused
    this._focused = false
    this._invalidateTextActivation()
    runCleanupSteps([
      () => this._editSession.end(),
      () => this._resetSelectionGesture(),
      () => this._popup.close(),
      () => this._resetQueryPresentation(),
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
    this._refreshInputViewport()
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
    const showingPlaceholder = displayText.length === 0
    const textColor = this.disabled ? input.textDisabled : showingPlaceholder ? input.placeholderText : resolveTextColor(dropdown.itemText, 'normal')
    const placeholder = this._showQueryInField ? '搜索…' : this.placeholder
    const textWidth = this._editableWidth()
    if (this._hoverPart === 'clear') this.tooltip = '清空全部选择'
    else if (this._hoverPart === 'count') this.tooltip = this._allCheckedLabels()
    else if (this._showQueryInField || this._textInput.composing) this.tooltip = undefined
    else this._syncOverflowTooltip(displayText || placeholder, this._fullTooltipText(), shell.valueRect.w, dropdown.fontSize, dropdown.fontFamily, showingPlaceholder)
    dl.pushClip(shell.valueRect.x, y, textWidth, fieldHeight)
    if (this.searchable && this._showQueryInField && this._focused && this._textInput.hasSession) {
      paintSingleLineEditableText({
        dl, controller: this._textInput, displayText: this._queryValue(), measureText: value => this._measureText(value),
        fontSize: dropdown.fontSize, fontFamily: dropdown.fontFamily,
        textX: shell.valueRect.x - this._textInput.scrollX, textY: y + fieldHeight / 2,
        lineTop: y + 4, lineBottom: y + fieldHeight - 4, textColor,
        selectionBg: input.selectionBg, caretColor: input.caretColor,
        compositionTextColor: input.compositionText, compositionUnderlineColor: input.focusedBorder,
        placeholder: showingPlaceholder ? placeholder : undefined, placeholderColor: input.placeholderText,
      })
    } else paintSingleLineText(dl, { text: displayText || placeholder, x: shell.valueRect.x, y: y + fieldHeight / 2,
      maxWidth: textWidth, color: textColor, fontSize: dropdown.fontSize, fontFamily: dropdown.fontFamily })
    dl.popClip()
    const count = this._countRect()
    if (count.w > 0) {
      const countX = x + count.x - this.globalOffset.x
      dl.fillRect(countX, y + 4, count.w, fieldHeight - 8, blendColor(resolveBgColor(input.inputBg, 'normal'), input.placeholderText, 0.10), 3)
      dl.pushClip(countX + 3, y + 4, Math.max(0, count.w - 6), fieldHeight - 8)
      paintSingleLineText(dl, { text: this._countText(), x: countX + 3, y: y + fieldHeight / 2,
        maxWidth: Math.max(0, count.w - 6), color: input.placeholderText, fontSize: Math.max(11, dropdown.fontSize - 1), fontFamily: dropdown.fontFamily })
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
    if (!isPrimaryPointerButton(e)) return
    if (this.disabled || this.readonly || this._disposed || !this._hitField(e.position)) return
    const layout = this._triggerLayout()
    if (pointInFormFieldRect(layout.clearRect, e.position)) {
      this._clearValue()
      return
    }
    if (!this.searchable) {
      if (this._popup.visible) this._popup.close()
      else {
        FocusManager.instance.setFocus(this)
        this._openPopup()
      }
      return
    }
    const wasFocused = this._focused
    FocusManager.instance.setFocus(this)
    if (!this._focused || this._disposed || this.disabled || this.readonly) return
    this._startInputSession()
    this._editSession.focusComposer()
    if (pointInFormFieldRect(layout.trailingRect, e.position)) {
      if (this._popup.visible) this._popup.close()
      else this._openPopup()
      return
    }
    if (pointInFormFieldRect(this._countRect(), e.position)) return
    this._beginQueryPresentation()
    this._popup.clearNavigation()
    if (!this._popup.visible) this._openPopup()
    if (!this._focused || this._disposed || this.disabled || this.readonly) return
    if (!this._showQueryInField || !pointInFormFieldRect(layout.valueRect, e.position) || e.position.x >= layout.valueRect.x + this._editableWidth()) return
    if (wasFocused) this._singleLineInput.setSelectionFromGlobal(e.position.x, { syncComposer: true })
    this._dragStart = e.position
    this._dragPosition = e.position
    if (e.joinGestureArena) this._selectionGesture.begin(e, this)
    else {
      this._selectionGesture.captureImmediately(e)
      this._dragging = true
    }
    this._editSession.refresh({ resetBlink: true })
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (event.defaultPrevented || this.disabled || this.readonly || this._disposed || this._isComposingKey(event)) return false
    if (this.searchable) {
      if (event.key === 'Tab') {
        this._popup.close()
        this._resetQueryPresentation()
        return false
      }
      const navigationKey = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', ' '].includes(event.key)
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !navigationKey) {
        this._popup.clearNavigation()
        return false
      }
      if (!this._popup.visible && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
        try {
          this._beginQueryPresentation()
          this._openPopup()
          if (event.key !== 'Enter' && this.searchable && this._popup.visible) {
            PopupManager.instance.withContextFor(this._popup, () => this._popup.onKeyDown(event))
          }
        } finally {
          event.preventDefault()
        }
        return true
      }
      if (event.key === 'Escape' && !this._popup.visible && this._showQueryInField) {
        event.preventDefault(); this._resetQueryPresentation(); return true
      }
      if (this._popup.visible) return PopupManager.instance.withContextFor(this._popup, () => this._popup.onKeyDown(event))
      return false
    }
    if (event.key === 'Escape' && this._popup.visible) {
      event.preventDefault()
      this._popup.close()
      return true
    }
    if (event.key === 'Tab' && this._popup.visible) {
      this._popup.close()
      return false
    }
    if (this._popup.visible) return false
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault()
      this._openPopup('', false)
      return true
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && this._showClearButton()) {
      event.preventDefault()
      this._clearValue()
      return true
    }
    return false
  }

  onPointerMove(e: PointerEvent): void {
    if (this._selectionGesture.hasOwner && !this._selectionGesture.owns(e)) return
    const layout = this._triggerLayout()
    this._hoverPart = pointInFormFieldRect(layout.clearRect, e.position) ? 'clear'
      : pointInFormFieldRect(this._countRect(), e.position) ? 'count' : 'text'
    this.tooltip = this._hoverPart === 'clear' ? '清空全部选择' : this._hoverPart === 'count' ? this._allCheckedLabels() : undefined
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
    this._hoverPart = undefined
    this.tooltip = undefined
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
    this._queryText = ''
    this._showQueryInField = false
    this._invalidateTextActivation()
    runCleanupSteps([
      () => this._resetSelectionGesture(),
      () => this._textInput.dispose(),
      () => this._valueEditorEvents.dispose(),
      () => this._popup.disposePopup(),
      () => {
        if (this._focusRegistered && typeof window !== 'undefined') {
          FocusManager.instance.unregister(this)
          this._focusRegistered = false
        }
        this._focused = false
        this._hovered = false
      },
      () => super.dispose(),
      () => { this.onChange = undefined },
    ])
  }

  debugState(): DropCheckTreeEditDebugState {
    return {
      popupVisible: this._popup.visible,
      queryText: this._queryText,
      showQueryInField: this._showQueryInField,
      displayText: this._displayText(),
      focused: this._focused,
      disabled: this.disabled,
      readonly: this.readonly,
      checkedKeys: this.checkedKeys,
      checkedLabel: this._checkedLabel(),
      filteredCount: this._debugFilteredCount(),
      expandedKeys: this._popup.expandedKeys,
    }
  }

  private _openPopup(
    initialQuery = this._showQueryInField ? this._queryText : '',
    showQueryInField = this._showQueryInField,
  ): void {
    if (this.disabled || this.readonly || this._disposed || this._popup.visible) return
    this._queryText = initialQuery
    this._showQueryInField = showQueryInField
    const session = ++this._popupSession
    const cancellation = this._queryCancellation
    const ownerInput = this.searchable
    const current = () => session === this._popupSession && cancellation === this._queryCancellation &&
      ownerInput === this.searchable && !this._disposed && this.visible &&
      !this.disabled && !this.readonly && (!ownerInput || this._focused)
    this._popup.open({
      anchor: this as PopupAnchorTarget,
      checkedKeys: this.checkedKeys,
      ownerInput,
      isCurrent: current,
      maxVisibleItems: this.maxVisibleItems,
      initialQuery,
      openExpandedKeys: this._openExpandedKeys(),
      checkedAncestorKeys: collectAncestorKeysForKeys(this.roots, this.checkedKeys),
      resolveRoots: query => this._resolveQueryRoots(query),
      onCheck: checkedKeys => {
        if (!current()) return
        const previousValue = this.checkedKeys
        const nextValue = normalizeUniqueKeys(checkedKeys)
        this._checkedKeys = nextValue
        this._refreshInputViewport()
        if (!sameStringArray(previousValue, nextValue)) this._emitValueChange(nextValue, previousValue, this._checkedNodes(), 'selection')
        this.markNeedsPaint()
      },
      onClose: () => {
        if (session !== this._popupSession) return
        this._popupSession += 1
        this._resetQueryPresentation()
        this.markNeedsPaint()
      },
    })
    this.markNeedsPaint()
  }

  private _resolveQueryRoots(query: string): TreeNode<T>[] {
    const processor = this.queryProcessor ?? defaultDropCheckTreeEditQueryProcessor<T>(this.queryTextBuilder)
    const roots = this.roots
    const result = processor({ query, roots, checkedKeys: this.checkedKeys })
    return projectCheckTree(result, roots)
  }

  private _openExpandedKeys(): string[] | undefined {
    const valid = new Set(collectExpandableNodeKeys(this.roots))
    if (this.expandAllOnOpen) return [...valid]
    const configured = typeof this.expandedKeysOnOpen === 'function'
      ? this.expandedKeysOnOpen({ roots: this.roots, checkedKeys: this.checkedKeys }) : this.expandedKeysOnOpen
    return configured ? [...new Set([...configured, ...collectAncestorKeysForKeys(this.roots, this.checkedKeys)])].filter(key => valid.has(key)) : undefined
  }

  private _checkedNodes(): TreeNode<T>[] {
    return this.checkedKeys
      .map(key => findTreeNodeByKey(this.roots, key))
      .filter((node): node is TreeNode<T> => node !== null)
  }

  private _displayText(): string {
    if (this._textInput.composing) return this._textInput.composerValue
    if (this._showQueryInField) return this._queryText
    return this._checkedLabel()
  }

  private _checkedLabel(): string {
    const checkedNodes = this._checkedNodes()
    if (checkedNodes.length === 0) return ''
    if (this.summaryBuilder) {
      return this.summaryBuilder({
        roots: this.roots,
        checkedKeys: this.checkedKeys,
        checkedNodes,
      })
    }
    return defaultDropCheckSummary({
      roots: this.roots,
      checkedKeys: this.checkedKeys,
      checkedNodes,
      maxSummaryItems: this.maxSummaryItems,
    })
  }

  private _fullTooltipText(): string {
    if (this._showQueryInField || this._textInput.composing) return ''
    const checkedNodes = this._checkedNodes()
    if (checkedNodes.length === 0) return ''
    return checkedNodes.map(node => node.label).join('、')
  }

  private _syncOverflowTooltip(
    displayText: string,
    fullTooltipText: string,
    availableWidth: number,
    fontSize: number,
    fontFamily: string,
    showingPlaceholder: boolean,
  ): void {
    if (showingPlaceholder || !displayText || !fullTooltipText) {
      this.tooltip = undefined
      return
    }
    const measuredWidth = TextMeasurer.measureWidth(displayText, fontSize, fontFamily)
    const summaryCollapsed = displayText !== fullTooltipText
    this.tooltip = summaryCollapsed || measuredWidth > availableWidth ? fullTooltipText : undefined
  }

  private _resetQueryPresentation(): void {
    this._queryCancellation += 1
    this._queryText = ''
    this._showQueryInField = false
    this._hoverPart = undefined
    this.tooltip = undefined
    this._resetSelectionGesture()
    if (this._textInput.composing) {
      this._editSession.end()
      this._textInput.setScrollX(0)
      this._startInputSession()
    } else if (this._focused && this._textInput.hasSession && !this._disposed) {
      this._textInput.setComposerValue('')
      this._textInput.setSelection(0, 0, { syncComposer: true })
      this._textInput.setScrollX(0)
      this._editSession.refresh()
    }
  }

  private _debugFilteredCount(): number {
    return this._popup.visible ? this._popup.filteredCount : countTreeNodes(this.roots)
  }

  private _showClearButton(): boolean {
    return this.clearable && !this.disabled && !this.readonly && this._checkedKeys.length > 0
  }

  private _clearValue(): void {
    if (!this._showClearButton()) return
    const previousValue = this.checkedKeys
    this._popup.close()
    this._resetQueryPresentation()
    FocusManager.instance.setFocus(this)
    this.checkedKeys = []
    this._emitValueChange([], previousValue, [], 'clear')
    this.markNeedsPaint()
  }

  private _emitValueChange(
    value: string[],
    previousValue: string[],
    nodes: TreeNode<T>[],
    reason: DropCheckTreeEditValueChangeReason,
  ): void {
    runCleanupSteps([
      () => this.onChange?.([...value], [...nodes]),
      () => this._valueEditorEvents.emitValueChange({
        value: [...value],
        previousValue: [...previousValue],
        reason,
        detail: [...nodes],
      }),
    ])
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

  private _measureText(text: string): number {
    const style = deriveDropdownStyle(this.currentTheme)
    return TextMeasurer.measureWidth(text, style.fontSize, style.fontFamily)
  }

  private _startInputSession(): void {
    if (!this.searchable || !this._focused || this.disabled || this.readonly || this._disposed || this._textInput.hasSession) return
    const text = this._queryText
    this._editSession.start({
      initialValue: text,
      initialSelection: { start: 0, end: text.length, syncComposer: true },
      refreshOnStart: true,
      onInput: (value, session) => {
        if (this._textInput.composing) return
        this._applyQuery(value)
        session.refresh({ syncSelectionFromComposer: true, resetBlink: true })
      },
      onCompositionStart: () => { this._showQueryInField = true; this._popup.clearNavigation() },
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

  shouldIgnoreKeyDown(event: KeyboardEvent): boolean {
    return this.searchable && this._isComposingKey(event)
  }

  private _isComposingKey(event: KeyboardEvent): boolean {
    return event.isComposing || event.keyCode === 229 || event.key === 'Process' || this._textInput.composing
  }

  private _applyQuery(value: string): void {
    if (!this.searchable || !this._focused || this.disabled || this.readonly || this._disposed) return
    this._queryText = value
    this._showQueryInField = true
    if (this._popup.visible) this._popup.setQuery(value)
    else this._openPopup(value, true)
    this.markNeedsPaint()
  }

  private _selectWord(position: Offset): void {
    if (!this.searchable || this.disabled || this.readonly || this._disposed || !this._hitField(position)) return
    if (!pointInFormFieldRect(this._triggerLayout().valueRect, position)) return
    if (!this._showQueryInField || position.x >= this._triggerLayout().valueRect.x + this._editableWidth()) return
    this.requestFocus()
    this._resetSelectionGesture()
    this._singleLineInput.selectWordFromGlobal(position.x, { text: this._queryValue(), syncComposer: true })
    this._editSession.refresh({ resetBlink: true })
  }

  private _invalidateTextActivation(): void {
    this._textActivationKey = Symbol('drop-check-tree-text')
  }

  override hitTestPath(point: Offset, result: HitTestResult): boolean {
    if (!this.searchable) return super.hitTestPath(point, result)
    const path = new HitTestResult()
    if (!super.hitTestPath(point, path)) return false
    const layout = this._triggerLayout()
    const text = this._hitField(point) && pointInFormFieldRect(layout.valueRect, point) &&
      !pointInFormFieldRect(layout.clearRect, point) && !pointInFormFieldRect(layout.trailingRect, point) &&
      point.x < layout.valueRect.x + this._editableWidth()
    for (const entry of path.path) result.add(entry.target === this ? { ...entry, key: text ? this._textActivationKey : 'drop-check-tree-field' } : entry)
    return true
  }

  private _beginQueryPresentation(): void {
    if (this._showQueryInField) return
    this._showQueryInField = true
    this._queryText = ''
    this._textInput.setComposerValue('')
    this._textInput.setSelection(0, 0, { syncComposer: true })
    this._textInput.setScrollX(0)
  }

  private _queryValue(): string { return this._textInput.composing ? this._textInput.composerValue : this._queryText }
  private _countText(): string { return `已选 ${this._checkedKeys.length} 项` }
  private _allCheckedLabels(): string { return this._checkedKeys.map(key => findTreeNodeByKey(this.roots, key)?.label ?? key).join('、') }

  private _countRect(): { x: number; y: number; w: number; h: number } {
    const layout = this._triggerLayout(), style = deriveDropdownStyle(this.currentTheme)
    const width = this._showQueryInField && this._checkedKeys.length
      ? Math.min(Math.max(0, layout.valueRect.w - 40), TextMeasurer.measureWidth(this._countText(), Math.max(11, style.fontSize - 1), style.fontFamily) + 6) : 0
    return { x: layout.valueRect.x + layout.valueRect.w - width, y: this.globalOffset.y + 4, w: width, h: this._inputStyle().height - 8 }
  }

  private _editableWidth(): number {
    const count = this._countRect()
    return Math.max(0, this._triggerLayout().valueRect.w - (count.w > 0 ? count.w + 8 : 0))
  }

  private _refreshInputViewport(): void {
    if ((this._hoverPart === 'count' && this._countRect().w === 0) || (this._hoverPart === 'clear' && !this._showClearButton())) {
      this._hoverPart = undefined
      this.tooltip = undefined
    }
    if (this._focused && this._textInput.hasSession && !this._textInput.composing) this._editSession.refresh({ invalidate: false })
  }

  private _inputStyle(): ReturnType<typeof deriveTextInputStyle> {
    return deriveTextInputStyle(this.currentTheme)
  }
}

export function defaultDropCheckTreeEditQueryProcessor<T = any>(
  queryTextBuilder?: DropCheckTreeEditQueryTextBuilder<T>,
): DropCheckTreeEditQueryProcessor<T> {
  const builder = queryTextBuilder ?? defaultDropCheckTreeQueryTextBuilder
  return ({ query, roots }) => {
    const normalizedQuery = normalizeTreeLookupQuery(query)
    if (!normalizedQuery) return [...roots]
    const filtered: TreeNode<T>[] = []
    for (const node of roots) {
      const next = filterTreeNode(node, normalizedQuery, builder)
      if (next) filtered.push(next)
    }
    return filtered
  }
}

function defaultDropCheckTreeQueryTextBuilder<T>(node: TreeNode<T>): string[] {
  return [node.key, node.label]
}

function normalizeTreeLookupQuery(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

function filterTreeNode<T>(
  node: TreeNode<T>,
  query: string,
  textBuilder: DropCheckTreeEditQueryTextBuilder<T>,
): TreeNode<T> | null {
  const texts = textBuilder(node).map(item => normalizeTreeLookupQuery(item))
  const selfMatch = texts.some(text => text.includes(query))
  const nextChildren = (node.children ?? []).flatMap(child => {
    const next = filterTreeNode(child, query, textBuilder)
    return next ? [next] : []
  })
  if (!selfMatch && nextChildren.length === 0) return null
  return nextChildren.length > 0 ? { ...node, children: nextChildren } : { ...node, children: undefined }
}

function findTreeNodeByKey<T>(roots: readonly TreeNode<T>[], key: string): TreeNode<T> | null {
  if (!key) return null
  for (const node of roots) {
    if (node.key === key) return node
    const child = node.children ? findTreeNodeByKey(node.children, key) : null
    if (child) return child
  }
  return null
}

function collectExpandableNodeKeys<T>(roots: readonly TreeNode<T>[]): string[] {
  const keys: string[] = []
  const visit = (nodes: readonly TreeNode<T>[]) => {
    for (const node of nodes) {
      if (node.children && node.children.length > 0) {
        keys.push(node.key)
        visit(node.children)
      }
    }
  }
  visit(roots)
  return keys
}

function collectAncestorKeysForKeys<T>(roots: readonly TreeNode<T>[], keys: readonly string[]): string[] {
  const ancestors = new Set<string>()
  for (const key of keys) {
    for (const ancestor of collectAncestorKeys(roots, key)) ancestors.add(ancestor)
  }
  return [...ancestors]
}

function collectAncestorKeys<T>(roots: readonly TreeNode<T>[], key: string): string[] {
  if (!key) return []
  const path: string[] = []
  const visit = (nodes: readonly TreeNode<T>[], currentAncestors: string[]): boolean => {
    for (const node of nodes) {
      if (node.key === key) {
        path.push(...currentAncestors)
        return true
      }
      if (node.children && node.children.length > 0) {
        if (visit(node.children, [...currentAncestors, node.key])) return true
      }
    }
    return false
  }
  visit(roots, [])
  return path
}

function countVisibleTreeNodes<T>(roots: readonly TreeNode<T>[], expandedKeys: readonly string[]): number {
  const expanded = new Set(expandedKeys)
  let count = 0
  const visit = (nodes: readonly TreeNode<T>[]) => {
    for (const node of nodes) {
      count += 1
      if (node.children && node.children.length > 0 && expanded.has(node.key)) visit(node.children)
    }
  }
  visit(roots)
  return count
}

function countTreeNodes<T>(roots: readonly TreeNode<T>[]): number {
  let count = 0
  const visit = (nodes: readonly TreeNode<T>[]) => {
    for (const node of nodes) {
      count += 1
      if (node.children && node.children.length > 0) visit(node.children)
    }
  }
  visit(roots)
  return count
}

function normalizeUniqueKeys(keys: readonly string[]): string[] {
  return Array.from(new Set(keys.map(key => String(key ?? '')).filter(Boolean)))
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function defaultDropCheckSummary<T>(context: DropCheckTreeEditSummaryContext<T> & { maxSummaryItems: number }): string {
  const labels = context.checkedNodes.map(node => node.label)
  if (labels.length <= context.maxSummaryItems) return labels.join('、')
  const visible = labels.slice(0, context.maxSummaryItems)
  return `${visible.join('、')} +${labels.length - visible.length}`
}

// Match TreeView's target rule against the original data, not a pruned projection.
function collectCheckTargetKeys<T>(roots: readonly TreeNode<T>[]): string[] {
  const keys: string[] = []
  const visit = (node: TreeNode<T>): boolean => {
    let childTarget = false
    for (const child of node.children ?? []) childTarget = visit(child) || childTarget
    if (childTarget) return true
    if (node.checkable === false) return false
    keys.push(node.key)
    return true
  }
  for (const node of roots) visit(node)
  return keys
}

function projectCheckTree<T>(filtered: readonly TreeNode<T>[], roots: readonly TreeNode<T>[]): TreeNode<T>[] {
  const targets = new Set(collectCheckTargetKeys(roots))
  const source = new Map<string, TreeNode<T>>()
  const index = (nodes: readonly TreeNode<T>[]): void => { for (const node of nodes) { source.set(node.key, node); index(node.children ?? []) } }
  index(roots)
  const project = (node: TreeNode<T>): { node: TreeNode<T>; hasTargets: boolean } => {
    const children = (node.children ?? []).map(project)
    const childTargets = children.some(child => child.hasTargets)
    const checkable = source.has(node.key) && source.get(node.key)!.checkable !== false && node.checkable !== false && (targets.has(node.key) || childTargets)
    return { node: { ...node, checkable, children: children.length ? children.map(child => child.node) : undefined }, hasTargets: childTargets || checkable }
  }
  return filtered.map(node => project(node).node)
}
