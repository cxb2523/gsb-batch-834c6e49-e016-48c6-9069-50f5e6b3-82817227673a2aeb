import { TextInputController } from '../core/text_input_controller'
import { SingleLineTextInput } from '../core/single_line_text_input'
import { TextEditSession } from '../core/text_edit_session'
import { normalizeUtf16ScalarRange } from '../core/text_selection'
import { PendingPointerGesture } from '../gestures/pending_pointer_gesture'
import type { GestureArenaMember } from '../gestures/gesture_arena'
import { paintSingleLineEditableText } from '../rendering/single_line_text_renderer'
import { FocusManager, type Focusable } from '../core/focus_manager'
import {
  type PopupAnchor,
  type PopupAnchorTarget,
  GET_POPUP_ANCHOR_RECT,
  resolvePopupAnchorRect,
  resolvePopupAnchorTarget,
} from '../core/popup_anchor'
import { PopupManager, clampRectToPopupViewport, type PopupContext } from '../core/popup_manager'
import { ResizablePopupPanelShell, type PopupResizablePanelLayout } from '../core/popup_shell'
import type { BoxConstraints, LayoutContext, Offset, RenderObject } from '../core/render_object'
import { runCleanupSteps, type DisposeFn } from '../core/disposable'
import { TextMeasurer } from '../core/text_measurer'
import { HitTestResult, isPrimaryPointerButton, type PointerEvent as PopupPointerEvent, type WheelPointerEvent } from '../gestures/hit_test'
import type { InteractiveRenderObject, PointerEvent } from '../gestures/recognizers'
import { RenderBox } from '../layout/render_box'
import { DrawList } from '../rendering/draw_list'
import { paintSingleLineText } from '../rendering/text_painter'
import type { PaintContext } from '../rendering/paint_context'
import { drawPopupPanel } from '../rendering/popup_painter'
import {
  blendColor,
  deriveGridCellStyle,
  deriveDropdownStyle,
  derivePopupStyle,
  deriveScrollbarStyle,
  deriveTextInputStyle,
  deriveWindowChromeStyle,
  resolveBgColor,
  resolveTextColor,
  type PopupStyleTokens,
  type TextInputStyleTokens,
} from '../theme/component_styles'
import type { ResolvedTheme } from '../theme/theme'
import { layoutFormFieldInlineContent, measureFormFieldHeight, pointInFormFieldRect, type FormFieldStatus } from './form_field_shell'
import { paintTriggerFieldShell } from './trigger_field_shell'
import { paintIconGlyph } from './icon'
import { PopupTextInput } from './popup_text_input'
import { RenderTreeGrid, type TreeGridNode } from './tree_grid'
import type { GridColumnDef } from './grid/grid_types'
import {
  ValueEditorEventEmitter,
  type ValueEditor,
  type ValueEditorValueChangeListener,
} from './value_editor'

type DropTreeGridLayout = PopupResizablePanelLayout & {
  theme: ResolvedTheme
  popupStyle: PopupStyleTokens
  inputStyle: TextInputStyleTokens
  minPanelW: number
  minPanelH: number
  panelX: number
  panelY: number
  panelW: number
  panelH: number
  itemH: number
  headerH: number
  colWidths: number[]
  searchInputH: number
  searchH: number
  gridH: number
  searchRect: { x: number; y: number; w: number; h: number } | null
  gridRect: { x: number; y: number; w: number; h: number }
}

export interface DropTreeGridEditQueryContext<T extends Record<string, any> = any> {
  query: string
  roots: readonly TreeGridNode<T>[]
  columns: readonly GridColumnDef<T>[]
  treeColumnKey: keyof T & string
  labelKey: keyof T & string
  selectedValue: string
}

export interface DropTreeGridEditExpandOnOpenContext<T extends Record<string, any> = any> {
  roots: readonly TreeGridNode<T>[]
  selectedValue: string
}

export type DropTreeGridEditQueryProcessor<T extends Record<string, any> = any> =
  (context: DropTreeGridEditQueryContext<T>) => TreeGridNode<T>[]

export type DropTreeGridEditQueryTextBuilder<T extends Record<string, any> = any> =
  (node: TreeGridNode<T>) => string[]

export type DropTreeGridEditExpandedKeysResolver<T extends Record<string, any> = any> =
  (context: DropTreeGridEditExpandOnOpenContext<T>) => readonly string[]

export interface DropTreeGridEditDebugState {
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
  expandedKeys: string[]
}

export type DropTreeGridEditValueChangeReason = 'selection' | 'clear'

export interface DropTreeGridPopupDebugState {
  searchText: string
  searchable: boolean
  selectedValue: string
  filteredCount: number
  expandedKeys: string[]
  panelX: number
  panelY: number
  panelW: number
  panelH: number
  anchorRect: { x: number; y: number; w: number; h: number }
  gridRect: { x: number; y: number; w: number; h: number }
  resizeGripRect: { x: number; y: number; w: number; h: number }
}

export interface DropTreeGridPopupOpenOptions<T extends Record<string, any> = any> {
  anchor: PopupAnchor
  columns: GridColumnDef<T>[]
  treeColumnKey: keyof T & string
  selectedValue: string
  searchable: boolean
  ownerInput?: boolean
  isCurrent?: () => boolean
  maxVisibleItems: number
  initialQuery: string
  resolveRoots: (query: string) => TreeGridNode<T>[]
  onSelect: (node: TreeGridNode<T>) => boolean | void
  onSearchTextChange?: (value: string) => void
  onClose: () => void
  openExpandedKeys?: readonly string[]
}

export class DropTreeGridPopup<T extends Record<string, any> = any> extends ResizablePopupPanelShell {
  private static readonly MIN_PANEL_WIDTH = 280
  private static readonly MIN_FLEX_COL_WIDTH = 80
  private static readonly RESIZE_GRIP_SIZE = 16

  private readonly _searchInput = new PopupTextInput(() => PopupManager.instance.requestPaint())
  private _grid: RenderTreeGrid<T> | null = null
  private _anchor?: PopupAnchor
  private _columns: GridColumnDef<T>[] = []
  private _treeColumnKey: keyof T & string = '' as keyof T & string
  private _selectedValue = ''
  private _searchable = false
  private _maxVisibleItems = 8
  private _searchText = ''
  private _resolveRoots?: (query: string) => TreeGridNode<T>[]
  private _onSelect?: (node: TreeGridNode<T>) => boolean | void
  private _onSearchTextChange?: (value: string) => void
  private _onClose?: () => void
  private _expandedKeys = new Set<string>()
  private _filteredRoots: TreeGridNode<T>[] = []
  private _ownerInput = false
  private _isCurrent?: () => boolean
  private _session = 0
  private _revision = 0
  private _disposed = false
  private _loadingRoots = false

  get columns(): GridColumnDef<T>[] { return this._columns }

  set columns(columns: GridColumnDef<T>[]) {
    if (columns === this._columns) return
    this._columns = columns
    this.refresh()
  }

  get treeColumnKey(): keyof T & string { return this._treeColumnKey }

  set treeColumnKey(key: keyof T & string) {
    if (key === this._treeColumnKey) return
    this._treeColumnKey = key
    this.refresh()
  }

  configure(columns: GridColumnDef<T>[], treeColumnKey: keyof T & string): void {
    this._columns = columns
    this._treeColumnKey = treeColumnKey
    this.refresh()
  }

  get selectedValue(): string { return this._selectedValue }

  set selectedValue(value: string) {
    const nextValue = String(value ?? '')
    if (nextValue === this._selectedValue) return
    this._selectedValue = nextValue
    if (this._grid) {
      if (this._ownerInput) this._grid.setNavigationKey(null)
      this._grid.selectedKey = nextValue
      this._grid.expandedKeys = this._defaultExpandedKeys()
      this._grid.revealNode(nextValue)
    }
    PopupManager.instance.requestPaint()
  }

  get searchText(): string { return this._searchText }

  get expandedKeys(): string[] {
    return this._grid ? this._grid.expandedKeys : [...this._expandedKeys]
  }

  get filteredRoots(): TreeGridNode<T>[] {
    return this._filteredRoots
  }

  get filteredCount(): number {
    return this._grid ? countTreeGridNodes(this._grid.roots) : 0
  }

  debugState(): DropTreeGridPopupDebugState {
    const popupContext = PopupManager.instance.context
    const layout = this._layout(popupContext)
    const anchorRect = this._anchor
      ? resolvePopupAnchorRect(this._anchor)
      : { x: 0, y: 0, w: 240, h: deriveTextInputStyle(popupContext.theme).height }
    return {
      searchText: this._searchText,
      searchable: this._searchable,
      selectedValue: this._selectedValue,
      filteredCount: this.filteredCount,
      expandedKeys: this.expandedKeys,
      panelX: layout.panelX,
      panelY: layout.panelY,
      panelW: layout.panelW,
      panelH: layout.panelH,
      anchorRect,
      gridRect: layout.gridRect,
      resizeGripRect: layout.resizeGripRect,
    }
  }

  refresh(): void {
    try {
      if (!this._loadRoots()) {
        if (this.visible && this._isCurrent?.() !== false) {
          this._filteredRoots = []
          this._syncGrid()
          PopupManager.instance.requestPaint()
        }
        return
      }
    } catch (error) {
      this._filteredRoots = []
      this._syncGrid()
      PopupManager.instance.requestPaint()
      throw error
    }
    this._syncGrid()
    PopupManager.instance.requestPaint()
  }

  setQuery(value: string): void {
    this._searchText = value
    this.clearNavigation()
    this.refresh()
  }

  clearNavigation(): void {
    if (!this._ownerInput) return
    this._grid?.setNavigationKey(null)
    PopupManager.instance.requestPaint()
  }

  get navigationKey(): string | null { return this._grid?.navigationKey ?? null }

  pruneExpandedKeys(keys: readonly string[]): void {
    const valid = new Set(keys)
    this._expandedKeys = new Set([...this._expandedKeys].filter(key => valid.has(key)))
  }

  private _loadRoots(): boolean {
    if (!this._resolveRoots || this._disposed || this._isCurrent?.() === false) return false
    const revision = ++this._revision
    if (this._loadingRoots) return false
    this._loadingRoots = true
    let roots: TreeGridNode<T>[]
    try { roots = this._resolveRoots(this._searchText) }
    finally { this._loadingRoots = false }
    if (revision !== this._revision || this._disposed || this._isCurrent?.() === false) return false
    this._filteredRoots = roots
    return true
  }

  open(options: DropTreeGridPopupOpenOptions<T>): void {
    if (this._disposed) return
    if (this.visible) this.close()
    const session = ++this._session
    this._ownerInput = options.ownerInput ?? false
    this._isCurrent = options.isCurrent
    this._anchor = options.anchor
    this._columns = options.columns
    this._treeColumnKey = options.treeColumnKey
    this._selectedValue = options.selectedValue
    this._searchable = !this._ownerInput && options.searchable
    this._maxVisibleItems = options.maxVisibleItems
    this._resolveRoots = options.resolveRoots
    this._onSelect = options.onSelect
    this._onSearchTextChange = options.onSearchTextChange
    this._onClose = options.onClose
    this._searchText = options.initialQuery
    if (options.openExpandedKeys) this._expandedKeys = new Set(options.openExpandedKeys)
    try {
      if (!this._loadRoots() || session !== this._session) {
        this._discardOpening(session)
        return
      }
      this._grid = this._createGrid()
    } catch (error) {
      this._discardOpening(session)
      throw error
    }
    this.openPopup({ owner: resolvePopupAnchorTarget(options.anchor), ...(this._ownerInput ? { interactionMode: 'nonmodal' as const, closeOnTransient: true } : {}) })
    if (this._searchable) {
      this._searchInput.beginSession({
        value: this._searchText,
        placeholder: '搜索...',
        onInput: value => {
          this._searchText = value
          this.refresh()
          if (session !== this._session) return
          this._onSearchTextChange?.(value)
          PopupManager.instance.requestPaint()
        },
        onCompositionUpdate: () => {
          PopupManager.instance.requestPaint()
        },
        onCompositionEnd: value => {
          this._searchText = value
          this.refresh()
          if (session !== this._session) return
          this._onSearchTextChange?.(value)
          PopupManager.instance.requestPaint()
        },
        onKeyDown: event => {
          this._handleNavigationKey(event)
        },
      })
    } else if (this._grid && !this._ownerInput) {
      FocusManager.instance.setFocus(this._grid)
    }
    PopupManager.instance.requestPaint()
  }

  override close(): void {
    super.close()
  }

  override hitTest(point: Offset, popupContext: PopupContext): boolean {
    if (!this.visible) return false
    const layout = this.getPanelLayout(popupContext)
    return point.x >= layout.panelX &&
      point.x <= layout.panelX + layout.panelW &&
      point.y >= layout.panelY &&
      point.y <= layout.panelY + layout.panelH
  }

  private _discardOpening(session: number): void {
    if (session !== this._session || this.visible) return
    this._resolveRoots = undefined
    this._isCurrent = undefined
    this._filteredRoots = []
    this._onSelect = undefined
    this._onSearchTextChange = undefined
    this._onClose = undefined
  }

  onOutsidePointerDown(event: PopupPointerEvent): boolean {
    if (!this._anchor) return false
    const rect = resolvePopupAnchorRect(this._anchor)
    const hitAnchor = event.position.x >= rect.x &&
      event.position.x <= rect.x + rect.w &&
      event.position.y >= rect.y &&
      event.position.y <= rect.y + rect.h
    if (!hitAnchor) return false
    this.close()
    return true
  }

  override onEscape(event: KeyboardEvent): boolean {
    if (!this.visible) return false
    event.preventDefault()
    this.close()
    return true
  }

  onKeyDown(event: KeyboardEvent): boolean {
    return this._handleNavigationKey(event)
  }

  focusRoots(): readonly RenderObject[] {
    return this.visible && this._grid && !this._ownerInput ? [this._grid] : []
  }

  paint(context: PaintContext): void {
    if (!this.visible) return
    const popupContext = PopupManager.instance.context
    const layout = this._layout(popupContext)
    this._syncGridLayout(layout, popupContext)
    const dl = new DrawList(context)
    drawPopupPanel(dl, layout.panelX, layout.panelY, layout.panelW, layout.panelH, layout.popupStyle)
    if (layout.searchRect) {
      this._searchInput.paint(context, layout.searchRect, context.theme)
    }
    if (this._grid) {
      this._grid.paint(context, this._grid.offset)
      if (this.filteredRoots.length === 0) {
        const bodyY = layout.gridRect.y + layout.headerH
        const bodyH = Math.max(0, layout.gridRect.h - layout.headerH)
        dl.pushClip(layout.gridRect.x, bodyY, layout.gridRect.w, bodyH)
        dl.fillText(
          '无匹配节点',
          layout.gridRect.x + layout.gridRect.w / 2,
          bodyY + bodyH / 2,
          layout.popupStyle.textDisabled,
          layout.popupStyle.fontSize,
          layout.popupStyle.fontFamily,
          'center',
          'middle',
        )
        dl.popClip()
      }
    }
    this._paintResizeGrip(dl, layout)
  }

  disposePopup(): void {
    if (this._disposed) return
    this._disposed = true
    this._session += 1
    this._revision += 1
    runCleanupSteps([
      () => this.close(),
      () => this._teardownGrid(),
      () => this._searchInput.dispose(),
      () => {
        this._filteredRoots = []
        this._resolveRoots = undefined
        this._isCurrent = undefined
        this._onSelect = undefined
        this._onSearchTextChange = undefined
        this._onClose = undefined
      },
    ])
  }

  protected override getResizablePanelLayout(popupContext: PopupContext): PopupResizablePanelLayout {
    return this._layout(popupContext)
  }

  protected override getMinPanelWidth(layout: PopupResizablePanelLayout): number {
    return (layout as DropTreeGridLayout).minPanelW
  }

  protected override getMinPanelHeight(layout: PopupResizablePanelLayout): number {
    return (layout as DropTreeGridLayout).minPanelH
  }

  protected override onPanelPointerDown(event: PopupPointerEvent, popupContext: PopupContext, layout: PopupResizablePanelLayout): void {
    if (!isPrimaryPointerButton(event)) return
    const typed = layout as DropTreeGridLayout
    if (typed.searchRect && this._searchInput.hitTest(event.position, typed.searchRect)) {
      this._cancelGridPointerState(event)
      this._searchInput.handlePointerDown(event.position, typed.searchRect, event.clickCount)
      return
    }
    this._grid?.onPointerDown(event)
    if (this.visible) PopupManager.instance.requestPaint()
  }

  protected override onPanelPointerMove(event: PopupPointerEvent, popupContext: PopupContext, layout: PopupResizablePanelLayout): void {
    const typed = layout as DropTreeGridLayout
    if (typed.searchRect && this._searchInput.hitTest(event.position, typed.searchRect)) {
      this._cancelGridPointerState(event)
      this._searchInput.handlePointerMove(event.position)
      return
    }
    this._searchInput.handlePointerCancel()
    this._grid?.onPointerMove(event)
  }

  protected override onPanelPointerUp(event: PopupPointerEvent): void {
    if (!isPrimaryPointerButton(event)) return
    this._searchInput.handlePointerUp()
    this._grid?.onPointerUp(event)
  }

  protected override onPanelPointerCancel(event: PopupPointerEvent): void {
    this._searchInput.handlePointerCancel()
    this._grid?.onPointerCancel(event)
  }

  protected override onPanelWheel(event: WheelPointerEvent, _popupContext: PopupContext, layout: PopupResizablePanelLayout): void {
    const typed = layout as DropTreeGridLayout
    const inGrid = event.position.x >= typed.gridRect.x &&
      event.position.x <= typed.gridRect.x + typed.gridRect.w &&
      event.position.y >= typed.gridRect.y &&
      event.position.y <= typed.gridRect.y + typed.gridRect.h
    if (!inGrid) return
    this._grid?.onWheel(event)
  }

  protected override onPopupClose(): void {
    this._session += 1
    this._revision += 1
    const tree = this._grid
    this._grid = null
    if (tree && !this._searchText.trim()) this._captureExpandedKeys(tree)
    this._filteredRoots = []
    this._resolveRoots = undefined
    this._isCurrent = undefined
    this._onSelect = undefined
    this._onSearchTextChange = undefined
    const close = this._onClose
    this._onClose = undefined
    runCleanupSteps([
      () => super.onPopupClose(),
      () => this._searchInput.endSession(),
      () => tree?.dispose(),
      () => close?.(),
    ])
  }

  private _createGrid(): RenderTreeGrid<T> {
    const session = this._session
    const select = (node: TreeGridNode<T>) => { if (session === this._session) this._select(node) }
    const grid = new RenderTreeGrid<T>({
      columns: this._columns,
      focusMode: this._ownerInput ? 'owner' : 'self',
      roots: this.filteredRoots,
      treeColumnKey: this._treeColumnKey,
      sortable: false,
      resizableColumns: false,
      reserveScrollbars: false,
      defaultExpandedKeys: this._defaultExpandedKeys(),
      onSelect: select,
      onActivate: select,
      onExpand: () => {
        if (session !== this._session) return
        if (!this._searchText.trim()) this._captureExpandedKeys(grid)
        PopupManager.instance.requestPaint()
      },
    })
    grid.selectedKey = this._selectedValue
    return grid
  }

  private _select(node: TreeGridNode<T>): void {
    if (node.selectable === false || !this.visible || this._isCurrent?.() === false) return
    const session = this._session
    let accepted: boolean | void = true
    runCleanupSteps([
      () => { accepted = this._onSelect?.(node) },
      () => {
        if (!this.visible || session !== this._session) return
        if (accepted === false) PopupManager.instance.requestPaint()
        else this.close()
      },
    ])
  }

  private _cancelGridPointerState(event: PopupPointerEvent): void {
    this._grid?.onPointerCancel({ ...event, type: 'cancel' })
  }

  private _syncGrid(): void {
    if (!this._grid) return
    const navigation = this._ownerInput ? this._grid.navigationKey : null
    this._grid.columns = [...this._columns]
    this._grid.treeColumnKey = this._treeColumnKey
    this._grid.roots = this.filteredRoots
    this._grid.selectedKey = this._selectedValue
    this._grid.expandedKeys = this._defaultExpandedKeys()
    if (this._ownerInput) {
      this._grid.setNavigationKey(navigation)
      if (navigation === null && this._selectedValue) this._grid.revealNode(this._selectedValue)
    } else if (this._selectedValue) this._grid.revealNode(this._selectedValue)
  }

  private _handleNavigationKey(event: KeyboardEvent): boolean {
    if (!this.visible || event.defaultPrevented || event.isComposing || event.keyCode === 229 || this._searchInput.composing) return false
    if (event.key === 'Tab') {
      this.close()
      return false
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      this.close()
      return true
    }
    if (this._ownerInput) {
      const handled = this._grid?.handleOwnedKeyDown(event) ?? false
      if (handled || event.key === 'Enter') {
        event.preventDefault()
        PopupManager.instance.requestPaint()
        return true
      }
      return false
    }
    if (!this._grid) return false
    if (event.key === 'ArrowDown' ||
      event.key === 'ArrowUp' ||
      event.key === 'ArrowLeft' ||
      event.key === 'ArrowRight' ||
      event.key === 'Enter') {
      event.preventDefault()
      FocusManager.instance.setFocus(this._grid)
      return this._grid.onKeyDown(event)
    }
    return false
  }

  private _syncGridLayout(layout: DropTreeGridLayout, popupContext: PopupContext): void {
    if (!this._grid) return
    const current = this._grid.columns
    if (current.length !== this._columns.length || current.some((column, index) =>
      column.key !== this._columns[index]!.key || column.width !== (layout.colWidths[index] ?? this._columns[index]!.width))) {
      this._grid.columns = this._columns.map((column, index) => ({ ...column, width: layout.colWidths[index] ?? column.width }))
    }
    this._grid.offset = { x: layout.gridRect.x, y: layout.gridRect.y }
    this._grid.layout({
      minWidth: layout.gridRect.w,
      maxWidth: layout.gridRect.w,
      minHeight: layout.gridRect.h,
      maxHeight: layout.gridRect.h,
    }, false, { theme: popupContext.theme })
  }

  private _layout(popupContext: PopupContext = PopupManager.instance.context): DropTreeGridLayout {
    const theme = popupContext.theme
    const popupStyle = derivePopupStyle(theme)
    const inputStyle = deriveTextInputStyle(theme)
    const gridStyle = deriveGridCellStyle(theme)
    const itemH = gridStyle.rowHeight
    const headerH = gridStyle.headerHeight
    const searchInputH = inputStyle.height
    const searchH = this._searchable ? searchInputH + popupStyle.padding : 0
    const anchorRect = this._anchor
      ? resolvePopupAnchorRect(this._anchor)
      : { x: 0, y: 0, w: 240, h: inputStyle.height }
    const totalFixed = this._columns.reduce((sum, column) => sum + (column.width ?? 0), 0)
    const flexCount = this._columns.filter(column => !column.width).length
    const totalVisibleCount = Math.max(countVisibleTreeGridNodes(this.filteredRoots, this._grid?.expandedKeys ?? this._defaultExpandedKeys()), 1)
    const visibleCount = Math.max(1, Math.min(totalVisibleCount, this._maxVisibleItems))
    const gridScrollbarW = totalVisibleCount > visibleCount ? deriveScrollbarStyle(theme).gutterSize : 0
    const minColumnContentW = totalFixed + flexCount * DropTreeGridPopup.MIN_FLEX_COL_WIDTH
    const minContentW = minColumnContentW + gridScrollbarW
    const minPanelW = Math.max(
      anchorRect.w,
      DropTreeGridPopup.MIN_PANEL_WIDTH,
      minContentW + popupStyle.padding * 2,
    )
    const requestedPanelW = this.panelWidthOverride ?? minPanelW
    const maxPanelW = Math.max(minPanelW, popupContext.viewport.width - 8)
    const panelW = Math.max(minPanelW, Math.min(requestedPanelW, maxPanelW))
    const contentW = Math.max(minContentW, panelW - popupStyle.padding * 2)
    const columnContentW = Math.max(minColumnContentW, contentW - gridScrollbarW)
    const flexW = flexCount > 0
      ? Math.max(DropTreeGridPopup.MIN_FLEX_COL_WIDTH, (columnContentW - totalFixed) / flexCount)
      : 0
    const colWidths = this._columns.map(column => column.width ?? flexW)
    const minGridH = headerH + itemH
    const naturalGridH = headerH + visibleCount * itemH
    const minPanelH = searchH + minGridH + popupStyle.padding * 2
    const requestedPanelH = this.panelHeightOverride ?? (searchH + naturalGridH + popupStyle.padding * 2)
    const maxPanelH = Math.max(minPanelH, popupContext.viewport.height - 8)
    const panelH = Math.max(minPanelH, Math.min(requestedPanelH, maxPanelH))
    const gridH = Math.max(minGridH, panelH - searchH - popupStyle.padding * 2)

    let panelY = anchorRect.y + anchorRect.h + 2
    if (panelY + panelH > (popupContext.viewport.y ?? 0) + popupContext.viewport.height - 4) panelY = anchorRect.y - panelH - 4
    const panelRect = clampRectToPopupViewport({ x: anchorRect.x, y: panelY, width: panelW, height: panelH }, popupContext, 4)
    const panelX = panelRect.x
    panelY = panelRect.y

    const searchRect = this._searchable
      ? {
          x: panelX + popupStyle.padding,
          y: panelY + popupStyle.padding,
          w: panelW - popupStyle.padding * 2,
          h: searchInputH,
        }
      : null
    const gridY = searchRect ? searchRect.y + searchRect.h + popupStyle.padding : panelY + popupStyle.padding

    return {
      theme,
      popupStyle,
      inputStyle,
      minPanelW,
      minPanelH,
      panelX,
      panelY,
      panelW,
      panelH,
      itemH,
      headerH,
      colWidths,
      searchInputH,
      searchH,
      gridH,
      searchRect,
      gridRect: {
        x: panelX + popupStyle.padding,
        y: gridY,
        w: panelW - popupStyle.padding * 2,
        h: gridH,
      },
      resizeGripRect: this.createResizeGripRect(
        panelX,
        panelY,
        panelW,
        panelH,
        DropTreeGridPopup.RESIZE_GRIP_SIZE,
      ),
    }
  }

  private _captureExpandedKeys(grid: RenderTreeGrid<T>): void {
    this._expandedKeys = new Set(grid.expandedKeys)
  }

  private _defaultExpandedKeys(): string[] {
    if (this._searchText.trim()) return collectExpandableTreeGridNodeKeys(this.filteredRoots)
    return Array.from(new Set([
      ...this._expandedKeys,
      ...collectTreeGridAncestorKeys(this.filteredRoots, this._selectedValue),
    ]))
  }

  private _teardownGrid(): void {
    if (!this._grid) return
    if (!this._searchText.trim()) this._captureExpandedKeys(this._grid)
    this._grid.dispose()
    this._grid = null
  }

  private _paintResizeGrip(dl: DrawList, layout: DropTreeGridLayout): void {
    const gripColor = resolveTextColor(
      deriveWindowChromeStyle(layout.theme).gripText,
      this.panelResizing ? 'pressed' : this.panelResizeGripHovered ? 'hovered' : 'normal',
    )
    const grip = layout.resizeGripRect
    const baseX = grip.x + grip.w - 2
    const baseY = grip.y + grip.h - 2
    const gap = 4
    const dotRadius = 1.5
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3 - i; j += 1) {
        dl.fillCircle(baseX - i * gap, baseY - j * gap, dotRadius, gripColor)
      }
    }
  }
}

export class RenderDropTreeGridEdit<T extends Record<string, any> = any>
  extends RenderBox
  implements
    InteractiveRenderObject,
    Focusable,
    GestureArenaMember,
    PopupAnchorTarget,
    ValueEditor<string, DropTreeGridEditValueChangeReason, TreeGridNode<T> | null> {
  private _columns: GridColumnDef<T>[]
  private _treeColumnKey: keyof T & string
  labelKey: keyof T & string
  private _roots: TreeGridNode<T>[]
  private _value: string
  placeholder: string
  onChange?: (value: string, node: TreeGridNode<T> | null) => void
  private _searchable: boolean
  maxVisibleItems: number
  private _readonly: boolean
  private _disabled: boolean
  private _status: FormFieldStatus
  private _helperText: string
  private _prefixText: string
  private _suffixText: string
  private _clearable: boolean
  metaKey?: keyof T & string
  metaFormatter?: (node: TreeGridNode<T>) => string
  expandAllOnOpen: boolean
  expandedKeysOnOpen?: readonly string[] | DropTreeGridEditExpandedKeysResolver<T>
  queryTextBuilder?: DropTreeGridEditQueryTextBuilder<T>
  queryProcessor?: DropTreeGridEditQueryProcessor<T>
  private _focusRegistered = false

  private _focused = false
  private _hovered = false
  private _popup = new DropTreeGridPopup<T>()
  private _disposed = false
  private _textActivationKey = Symbol('drop-tree-grid-text')
  private readonly _selectionGesture = new PendingPointerGesture()
  private _dragStart?: Offset
  private _dragPosition?: Offset
  private _dragging = false
  readonly preventsPointerActivationOnAccept = true
  onDoubleClick?: (position: Offset) => void
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
  private _popupSession = 0
  private _queryCancellation = 0
  private _queryText = ''
  private _showQueryInField = false
  private readonly _valueEditorEvents = new ValueEditorEventEmitter<
    string,
    DropTreeGridEditValueChangeReason,
    TreeGridNode<T> | null
  >()

  constructor(options: {
    columns: GridColumnDef<T>[]
    roots: TreeGridNode<T>[]
    treeColumnKey: keyof T & string
    labelKey: keyof T & string
    value?: string
    metaKey?: keyof T & string
    metaFormatter?: (node: TreeGridNode<T>) => string
    placeholder?: string
    onChange?: (value: string, node: TreeGridNode<T> | null) => void
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
    expandedKeysOnOpen?: readonly string[] | DropTreeGridEditExpandedKeysResolver<T>
    queryTextBuilder?: DropTreeGridEditQueryTextBuilder<T>
    queryProcessor?: DropTreeGridEditQueryProcessor<T>
  }) {
    super()
    this._columns = options.columns
    this._roots = options.roots
    this._treeColumnKey = this._resolveTreeColumnKey(options.treeColumnKey)
    this.labelKey = options.labelKey
    this._value = options.value ?? ''
    this.metaKey = options.metaKey
    this.metaFormatter = options.metaFormatter
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

  get roots(): TreeGridNode<T>[] { return this._roots }
  set roots(roots: TreeGridNode<T>[]) {
    if (roots === this._roots) return
    this._roots = roots
    this.refreshTreeGrid()
  }

  refreshTreeGrid(): void {
    this._treeColumnKey = this._resolveTreeColumnKey(this._treeColumnKey)
    this._popup.pruneExpandedKeys(collectExpandableTreeGridNodeKeys(this.roots))
    this._popup.configure(this.columns, this.treeColumnKey)
    this._syncCommittedInput()
    if (this._focused && this._textInput.hasSession && !this._textInput.composing) this._editSession.refresh({ invalidate: false })
    this.markNeedsPaint()
  }

  get value(): string { return this._value }
  set value(value: string) {
    const nextValue = String(value ?? '')
    if (this._value === nextValue) return
    this._value = nextValue
    if (this._popup.visible) this._popup.selectedValue = nextValue
    this._syncCommittedInput()
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
      DropTreeGridEditValueChangeReason,
      TreeGridNode<T> | null
    >,
  ): DisposeFn {
    return this._valueEditorEvents.subscribeValueChange(listener)
  }

  subscribeBlur(listener: () => void): DisposeFn {
    return this._valueEditorEvents.subscribeBlur(listener)
  }

  get columns(): GridColumnDef<T>[] { return this._columns }
  set columns(columns: GridColumnDef<T>[]) {
    if (this._columns === columns) return
    this._columns = columns
    this._treeColumnKey = this._resolveTreeColumnKey(this._treeColumnKey)
    this.refreshTreeGrid()
  }

  get treeColumnKey(): keyof T & string { return this._treeColumnKey }
  set treeColumnKey(key: keyof T & string) {
    const nextKey = this._resolveTreeColumnKey(key)
    if (this._treeColumnKey === nextKey) return
    this._treeColumnKey = nextKey
    this.refreshTreeGrid()
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
    const fullTooltipText = this._fullTooltipText()
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
    if (this._showQueryInField || this._textInput.composing) this.tooltip = undefined
    else this._syncOverflowTooltip(text, displayMeta, fullTooltipText, shell.valueRect.w, dropdown.fontSize, metaFontSize, dropdown.fontFamily, showingPlaceholder)
    dl.pushClip(shell.valueRect.x, y, textClipWidth, fieldHeight)
    if (this.searchable && this._focused && this._textInput.hasSession) {
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
    this._popup.clearNavigation()
    if (!this._popup.visible) this._openPopup()
    if (!this._focused || this._disposed || this.disabled || this.readonly || !this.searchable) return
    if (!pointInFormFieldRect(layout.valueRect, e.position) || e.position.x >= layout.valueRect.x + this._editableWidth()) return
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
      const navigationKey = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape'].includes(event.key)
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !navigationKey) {
        this._popup.clearNavigation()
        return false
      }
      if (!this._popup.visible && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
        try {
          this._openPopup()
          if (event.key !== 'Enter' && this.searchable && this._popup.visible) {
            PopupManager.instance.withContextFor(this._popup, () => this._popup.onKeyDown(event))
          }
        } finally {
          event.preventDefault()
        }
        return true
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

  debugState(): DropTreeGridEditDebugState {
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
      columns: this.columns,
      treeColumnKey: this.treeColumnKey,
      selectedValue: this.value,
      searchable: false,
      ownerInput,
      isCurrent: current,
      maxVisibleItems: this.maxVisibleItems,
      initialQuery,
      openExpandedKeys: this._openExpandedKeys(),
      resolveRoots: query => this._resolveQueryRoots(query),
      onSelect: node => {
        if (!current()) return false
        const previousValue = this.value
        this.value = node.key
        this._popup.close()
        this._resetQueryPresentation()
        this._emitValueChange(node.key, previousValue, node, 'selection')
        return false
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

  private _resolveQueryRoots(query: string): TreeGridNode<T>[] {
    const processor = this.queryProcessor ?? defaultDropTreeGridEditQueryProcessor<T>(this.queryTextBuilder)
    return processor({
      query,
      roots: this.roots,
      columns: this.columns,
      treeColumnKey: this.treeColumnKey,
      labelKey: this.labelKey,
      selectedValue: this.value,
    })
  }

  private _resolveTreeColumnKey(candidate: keyof T & string): keyof T & string {
    if (this._columns.some(column => column.key === candidate)) return candidate
    return (this._columns[0]?.key ?? candidate) as keyof T & string
  }

  private _openExpandedKeys(): string[] | undefined {
    const valid = new Set(collectExpandableTreeGridNodeKeys(this.roots))
    if (this.expandAllOnOpen) return [...valid]
    const configured = typeof this.expandedKeysOnOpen === 'function'
      ? this.expandedKeysOnOpen({ roots: this.roots, selectedValue: this.value })
      : this.expandedKeysOnOpen
    if (!configured) return undefined
    return [...new Set([...configured, ...collectTreeGridAncestorKeys(this.roots, this.value)])].filter(key => valid.has(key))
  }

  private _selectedNode(): TreeGridNode<T> | null {
    return findTreeGridNodeByKey(this.roots, this.value)
  }

  private _selectedLabel(): string {
    const node = this._selectedNode()
    return node ? String(node.row[this.labelKey] ?? '') : ''
  }

  private _displayText(): string {
    if (this._textInput.composing) return this._textInput.composerValue
    if (this._showQueryInField) return this._queryText
    return this._selectedLabel()
  }

  private _displayMetaText(): string {
    if (this._showQueryInField || this._textInput.composing) return ''
    const node = this._selectedNode()
    if (!node) return ''
    if (this.metaFormatter) return String(this.metaFormatter(node) ?? '')
    if (this.metaKey) return String(node.row[this.metaKey] ?? '')
    return ''
  }

  private _fullTooltipText(): string {
    const label = this._selectedLabel()
    const meta = this._displayMetaText()
    if (!label) return ''
    return meta ? `${label}  ${meta}` : label
  }

  private _syncOverflowTooltip(
    displayText: string,
    displayMeta: string,
    fullTooltipText: string,
    availableWidth: number,
    fontSize: number,
    metaFontSize: number,
    fontFamily: string,
    showingPlaceholder: boolean,
  ): void {
    if (showingPlaceholder || !displayText || !fullTooltipText) {
      this.tooltip = undefined
      return
    }
    const textWidth = TextMeasurer.measureWidth(displayText, fontSize, fontFamily)
    const metaWidth = displayMeta ? TextMeasurer.measureWidth(displayMeta, metaFontSize, fontFamily) + 8 : 0
    this.tooltip = textWidth + metaWidth > availableWidth ? fullTooltipText : undefined
  }

  private _resetQueryPresentation(): void {
    // Cancellation can happen before the popup is visible, when close() alone is a no-op.
    this._queryCancellation += 1
    this._queryText = ''
    this._showQueryInField = false
    this._resetSelectionGesture()
    if (this._textInput.composing) {
      // Ending a composition retires its native carrier, isolating delayed IME events.
      this._editSession.end()
      this._textInput.setScrollX(0)
      this._startInputSession()
      return
    }
    if (this._focused && this._textInput.hasSession && !this._disposed) {
      const text = this._selectedLabel()
      this._textInput.setComposerValue(text)
      this._textInput.setSelection(0, text.length, { syncComposer: true })
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
    const all = this._textInput.selStart === 0 && this._textInput.selEnd === previousText.length
    const range = normalizeUtf16ScalarRange(label, {
      start: Math.min(this._textInput.selStart, label.length),
      end: all ? label.length : Math.min(this._textInput.selEnd, label.length),
    })
    const cursor = all || this._textInput.cursorPos >= range.end ? range.end : range.start
    this._textInput.setComposerValue(label)
    this._textInput.setSelection(range.start, range.end, { cursorPos: cursor, syncComposer: true })
    this._editSession.refresh({ resetBlink: true })
  }

  private _debugFilteredCount(): number {
    return this._popup.visible ? this._popup.filteredCount : countTreeGridNodes(this.roots)
  }

  private _showClearButton(): boolean {
    return this.clearable && !this.disabled && !this.readonly && this.value.length > 0
  }

  private _clearValue(): void {
    if (!this._showClearButton()) return
    const previousValue = this.value
    this._popup.close()
    this._resetQueryPresentation()
    FocusManager.instance.setFocus(this)
    this.value = ''
    this._emitValueChange('', previousValue, null, 'clear')
    this.markNeedsPaint()
  }

  private _emitValueChange(
    value: string,
    previousValue: string,
    node: TreeGridNode<T> | null,
    reason: DropTreeGridEditValueChangeReason,
  ): void {
    runCleanupSteps([
      () => this.onChange?.(value, node),
      () => {
        if (value === previousValue) return
        this._valueEditorEvents.emitValueChange({
          value,
          previousValue,
          reason,
          detail: node,
        })
      },
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

  private _editableWidth(): number {
    const style = deriveDropdownStyle(this.currentTheme)
    const meta = this._displayMetaText()
    const width = meta ? TextMeasurer.measureWidth(meta, Math.max(11, style.fontSize - 1), style.fontFamily) + 8 : 0
    return Math.max(0, this._triggerLayout().valueRect.w - width)
  }

  private _measureText(text: string): number {
    const style = deriveDropdownStyle(this.currentTheme)
    return TextMeasurer.measureWidth(text, style.fontSize, style.fontFamily)
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
      onCompositionStart: () => this._popup.clearNavigation(),
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
    const rect = this._triggerLayout().valueRect
    if (!pointInFormFieldRect(rect, position) || position.x >= rect.x + this._editableWidth()) return
    this.requestFocus()
    this._resetSelectionGesture()
    this._singleLineInput.selectWordFromGlobal(position.x, { text: this._displayText(), syncComposer: true })
    this._editSession.refresh({ resetBlink: true })
  }

  private _invalidateTextActivation(): void {
    this._textActivationKey = Symbol('drop-tree-grid-text')
  }

  override hitTestPath(point: Offset, result: HitTestResult): boolean {
    if (!this.searchable) return super.hitTestPath(point, result)
    const path = new HitTestResult()
    if (!super.hitTestPath(point, path)) return false
    const layout = this._triggerLayout()
    const text = this._hitField(point) && pointInFormFieldRect(layout.valueRect, point) &&
      !pointInFormFieldRect(layout.clearRect, point) && !pointInFormFieldRect(layout.trailingRect, point) &&
      point.x < layout.valueRect.x + this._editableWidth()
    for (const entry of path.path) result.add(entry.target === this ? { ...entry, key: text ? this._textActivationKey : 'drop-tree-grid-field' } : entry)
    return true
  }

  private _inputStyle(): ReturnType<typeof deriveTextInputStyle> {
    return deriveTextInputStyle(this.currentTheme)
  }
}

export function defaultDropTreeGridEditQueryProcessor<T extends Record<string, any> = any>(
  queryTextBuilder?: DropTreeGridEditQueryTextBuilder<T>,
): DropTreeGridEditQueryProcessor<T> {
  return ({ query, roots, columns, labelKey }) => {
    const normalizedQuery = normalizeTreeGridLookupQuery(query)
    if (!normalizedQuery) return [...roots]
    const filtered: TreeGridNode<T>[] = []
    for (const node of roots) {
      const next = filterTreeGridNode(node, normalizedQuery, queryTextBuilder ?? defaultDropTreeGridQueryTextBuilder(columns, labelKey))
      if (next) filtered.push(next)
    }
    return filtered
  }
}

function defaultDropTreeGridQueryTextBuilder<T extends Record<string, any>>(
  columns: readonly GridColumnDef<T>[],
  labelKey: keyof T & string,
): DropTreeGridEditQueryTextBuilder<T> {
  return node => {
    const texts = [node.key, String(node.row[labelKey] ?? '')]
    for (const column of columns) {
      const value = node.row[column.key]
      if (value === null || value === undefined) continue
      const text = String(value)
      if (text && !texts.includes(text)) texts.push(text)
    }
    return texts
  }
}

function normalizeTreeGridLookupQuery(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

function filterTreeGridNode<T extends Record<string, any>>(
  node: TreeGridNode<T>,
  query: string,
  textBuilder: DropTreeGridEditQueryTextBuilder<T>,
): TreeGridNode<T> | null {
  const texts = textBuilder(node).map(item => normalizeTreeGridLookupQuery(item))
  const selfMatch = texts.some(text => text.includes(query))
  const nextChildren = (node.children ?? []).flatMap(child => {
    const next = filterTreeGridNode(child, query, textBuilder)
    return next ? [next] : []
  })
  if (!selfMatch && nextChildren.length === 0) return null
  return nextChildren.length > 0 ? { ...node, children: nextChildren } : { ...node, children: undefined }
}

function findTreeGridNodeByKey<T extends Record<string, any>>(roots: readonly TreeGridNode<T>[], key: string): TreeGridNode<T> | null {
  if (!key) return null
  for (const node of roots) {
    if (node.key === key) return node
    const child = node.children ? findTreeGridNodeByKey(node.children, key) : null
    if (child) return child
  }
  return null
}

function collectExpandableTreeGridNodeKeys<T extends Record<string, any>>(roots: readonly TreeGridNode<T>[]): string[] {
  const keys: string[] = []
  const visit = (nodes: readonly TreeGridNode<T>[]) => {
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

function collectTreeGridAncestorKeys<T extends Record<string, any>>(roots: readonly TreeGridNode<T>[], key: string): string[] {
  if (!key) return []
  const result: string[] = []
  const visit = (nodes: readonly TreeGridNode<T>[], ancestors: string[]): boolean => {
    for (const node of nodes) {
      if (node.key === key) {
        result.push(...ancestors)
        return true
      }
      if (node.children && visit(node.children, [...ancestors, node.key])) return true
    }
    return false
  }
  visit(roots, [])
  return result
}

function countVisibleTreeGridNodes<T extends Record<string, any>>(roots: readonly TreeGridNode<T>[], expandedKeys: readonly string[]): number {
  const expanded = new Set(expandedKeys)
  let count = 0
  const visit = (nodes: readonly TreeGridNode<T>[]) => {
    for (const node of nodes) {
      count += 1
      if (node.children && node.children.length > 0 && expanded.has(node.key)) {
        visit(node.children)
      }
    }
  }
  visit(roots)
  return count
}

function countTreeGridNodes<T extends Record<string, any>>(roots: readonly TreeGridNode<T>[]): number {
  let count = 0
  const visit = (nodes: readonly TreeGridNode<T>[]) => {
    for (const node of nodes) {
      count += 1
      if (node.children && node.children.length > 0) visit(node.children)
    }
  }
  visit(roots)
  return count
}
