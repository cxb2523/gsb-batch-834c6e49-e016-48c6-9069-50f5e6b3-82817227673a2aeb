// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET_POPUP_ANCHOR_RECT } from '../../core/popup_anchor'
import { PopupManager } from '../../core/popup_manager'
import { FocusManager } from '../../core/focus_manager'
import { InputComposer } from '../../core/input_composer'
import { ImGuiDarkTheme } from '../../theme/default_theme'
import { DropdownGridPopup } from './popup/dropdown_grid_popup'
import { GridCellPopupEditors } from './grid_cell_popup_editors'
import { RenderDataGrid } from '../grid_view'

function anchorTarget() {
  return {
    [GET_POPUP_ANCHOR_RECT]: () => ({ x: 12, y: 24, width: 120, height: 28 }),
  }
}

function pressSearchKey(key: string): void {
  const target = document.activeElement
  expect(target).toBeInstanceOf(HTMLTextAreaElement)
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target!.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
}

afterEach(() => {
  PopupManager.disposeInstance()
  FocusManager.instance.dispose()
  InputComposer.instance.dispose()
})

describe('GridCellPopupEditors', () => {
  function setupPopupContext(): void {
    PopupManager.instance.setContextProvider(() => ({
      theme: ImGuiDarkTheme,
      viewport: { width: 320, height: 240, dpr: 1 },
      setCursor: () => {},
    }))
  }

  it('opens select popups against the current visible row and commits the selected value', () => {
    setupPopupContext()
    const commitVisibleValue = vi.fn(() => true)
    const onEndEdit = vi.fn()
    const rows = [{ status: 'a' }]
    const controller = new GridCellPopupEditors({
      owner: anchorTarget(),
      structureEditing: { commitVisibleValue, canEditCell: () => true } as any,
      getVisibleRows: () => rows,
      onEndEdit,
      createEmbeddedGrid: vi.fn() as any,
    })

    controller.openSelectPopup(0, 1, {
      key: 'status',
      title: 'Status',
      type: 'select',
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
    })

    expect(controller.dropdownPopup.visible).toBe(true)
    expect(PopupManager.instance.current).toBe(controller.dropdownPopup)

    ;(controller.dropdownPopup as any)._select({ value: 'b', label: 'Beta' })

    expect(commitVisibleValue).toHaveBeenCalledWith(0, 'status', 'b')
    expect(onEndEdit).toHaveBeenCalledTimes(1)
    expect(controller.dropdownPopup.visible).toBe(false)
  })

  it('keeps the popup edit active when cell validation rejects the selected value', () => {
    setupPopupContext()
    const commitVisibleValue = vi.fn(() => false)
    const onEndEdit = vi.fn()
    const rows = [{ status: 'a' }]
    const controller = new GridCellPopupEditors({
      owner: anchorTarget(),
      structureEditing: { commitVisibleValue, canEditCell: () => true } as any,
      getVisibleRows: () => rows,
      onEndEdit,
      createEmbeddedGrid: vi.fn() as any,
    })

    controller.openSelectPopup(0, 0, {
      key: 'status',
      title: 'Status',
      type: 'select',
      options: [{ value: 'b', label: 'Beta' }],
    })
    ;(controller.dropdownPopup as any)._select({ value: 'b', label: 'Beta' })

    expect(commitVisibleValue).toHaveBeenCalledWith(0, 'status', 'b')
    expect(controller.dropdownPopup.visible).toBe(true)
    expect(onEndEdit).not.toHaveBeenCalled()

    controller.dropdownPopup.close()
    expect(onEndEdit).toHaveBeenCalledTimes(1)
  })

  it('seeds date popups from the visible cell value', () => {
    setupPopupContext()
    const rows = [{ dueDate: '2026-04-23' }]
    const controller = new GridCellPopupEditors({
      owner: anchorTarget(),
      structureEditing: { commitVisibleValue: vi.fn(), canEditCell: () => true } as any,
      getVisibleRows: () => rows,
      onEndEdit: vi.fn(),
      createEmbeddedGrid: vi.fn() as any,
    })

    controller.openDatePopup(0, 0, {
      key: 'dueDate',
      title: 'Due Date',
      type: 'date',
    })

    expect(controller.datePickerPopup.visible).toBe(true)
    expect(controller.datePickerPopup.debugState().selected).toEqual({
      year: 2026,
      month: 4,
      day: 23,
    })
  })

  it('preserves and commits the time portion for date-time columns', () => {
    setupPopupContext()
    const commitVisibleValue = vi.fn(() => true)
    const rows = [{ occurredAt: '2026-04-23T09:08:07' }]
    const controller = new GridCellPopupEditors({
      owner: anchorTarget(),
      structureEditing: { commitVisibleValue, canEditCell: () => true } as any,
      getVisibleRows: () => rows,
      onEndEdit: vi.fn(),
      createEmbeddedGrid: vi.fn() as any,
    })

    controller.openDatePopup(0, 0, {
      key: 'occurredAt',
      title: 'Occurred At',
      type: 'date',
      showTime: true,
      timePrecision: 'minute',
    })

    expect(controller.datePickerPopup.debugState()).toMatchObject({
      showTime: true,
      timePrecision: 'minute',
      selectedTime: { hour: 9, minute: 8, second: 0 },
    })
    ;(controller.datePickerPopup as any)._selectedTime = {
      hour: 10,
      minute: 11,
      second: 12,
    }
    ;(controller.datePickerPopup as any)._confirmAndClose()

    expect(commitVisibleValue).toHaveBeenCalledWith(
      0,
      'occurredAt',
      '2026-04-23T10:11',
    )
    expect(controller.datePickerPopup.visible).toBe(false)
  })

  it('presents instant values as local wall-clock fields and commits an equivalent local ISO value', () => {
    setupPopupContext()
    const commitVisibleValue = vi.fn(
      (_visibleRowIndex: number, _columnIndex: string, _value: string) => true,
    )
    const rows: Array<{ occurredAt: unknown }> = [{ occurredAt: null }]
    const controller = new GridCellPopupEditors({
      owner: anchorTarget(),
      structureEditing: { commitVisibleValue, canEditCell: () => true } as any,
      getVisibleRows: () => rows,
      onEndEdit: vi.fn(),
      createEmbeddedGrid: vi.fn() as any,
    })
    const column = {
      key: 'occurredAt',
      title: 'Occurred At',
      type: 'date' as const,
      showTime: true,
      timePrecision: 'second' as const,
    }
    const instant = new Date('2026-04-23T23:30:45.789-05:00')
    const values: unknown[] = [
      '2026-04-23T23:30:45-05:00',
      instant,
      instant.getTime(),
    ]

    for (const value of values) {
      rows[0]!.occurredAt = value
      controller.openDatePopup(0, 0, column)

      const expected = new Date(
        typeof value === 'string'
          ? Date.parse(value)
          : value instanceof Date ? value.getTime() : value as number,
      )
      expect(controller.datePickerPopup.debugState()).toMatchObject({
        selected: {
          year: expected.getFullYear(),
          month: expected.getMonth() + 1,
          day: expected.getDate(),
        },
        selectedTime: {
          hour: expected.getHours(),
          minute: expected.getMinutes(),
          second: expected.getSeconds(),
        },
      })

      ;(controller.datePickerPopup as any)._confirmAndClose()
      const committed = commitVisibleValue.mock.calls.at(-1)![2]
      expect(committed).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
      expect(Date.parse(committed)).toBe(
        Math.floor(expected.getTime() / 1000) * 1000,
      )
    }
  })

  it('uses local midnight when a date-only value enters date-time editing', () => {
    setupPopupContext()
    const commitVisibleValue = vi.fn(() => true)
    const rows = [{ occurredAt: '2026-04-23' }]
    const controller = new GridCellPopupEditors({
      owner: anchorTarget(),
      structureEditing: { commitVisibleValue, canEditCell: () => true } as any,
      getVisibleRows: () => rows,
      onEndEdit: vi.fn(),
      createEmbeddedGrid: vi.fn() as any,
    })

    controller.openDatePopup(0, 0, {
      key: 'occurredAt',
      title: 'Occurred At',
      type: 'date',
      showTime: true,
      timePrecision: 'minute',
    })

    expect(controller.datePickerPopup.debugState()).toMatchObject({
      selected: { year: 2026, month: 4, day: 23 },
      selectedTime: { hour: 0, minute: 0, second: 0 },
    })
    ;(controller.datePickerPopup as any)._confirmAndClose()
    expect(commitVisibleValue).toHaveBeenLastCalledWith(
      0,
      'occurredAt',
      '2026-04-23T00:00',
    )
  })

  it('ends a popup edit once when the popup closes without a selection', () => {
    setupPopupContext()
    const commitVisibleValue = vi.fn()
    const onEndEdit = vi.fn()
    const rows = [{ status: 'a' }]
    const controller = new GridCellPopupEditors({
      owner: anchorTarget(),
      structureEditing: { commitVisibleValue, canEditCell: () => true } as any,
      getVisibleRows: () => rows,
      onEndEdit,
      createEmbeddedGrid: vi.fn() as any,
    })

    controller.openSelectPopup(0, 1, {
      key: 'status',
      title: 'Status',
      type: 'select',
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
    })

    controller.dropdownPopup.close()

    expect(commitVisibleValue).not.toHaveBeenCalled()
    expect(onEndEdit).toHaveBeenCalledTimes(1)

    controller.dropdownPopup.close()

    expect(onEndEdit).toHaveBeenCalledTimes(1)
  })

  it('ignores stale popup callbacks after a popup edit session has ended', () => {
    setupPopupContext()
    const commitVisibleValue = vi.fn(() => true)
    const onEndEdit = vi.fn()
    const rows = [{ status: 'a' }, { status: 'x' }]
    const controller = new GridCellPopupEditors({
      owner: anchorTarget(),
      structureEditing: { commitVisibleValue, canEditCell: () => true } as any,
      getVisibleRows: () => rows,
      onEndEdit,
      createEmbeddedGrid: vi.fn() as any,
    })
    const column = {
      key: 'status',
      title: 'Status',
      type: 'select' as const,
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
        { value: 'x', label: 'Xray' },
      ],
    }

    controller.openSelectPopup(0, 1, column)
    const staleSelect = (controller.dropdownPopup as any)._onSelect as (value: string, option: { value: string; label: string }) => void

    controller.dropdownPopup.close()
    controller.openSelectPopup(1, 1, column)

    staleSelect('b', { value: 'b', label: 'Beta' })

    expect(commitVisibleValue).not.toHaveBeenCalledWith(0, 'status', 'b')
    expect(controller.dropdownPopup.visible).toBe(true)

    ;(controller.dropdownPopup as any)._select({ value: 'x', label: 'Xray' })

    expect(commitVisibleValue).toHaveBeenCalledTimes(1)
    expect(commitVisibleValue).toHaveBeenCalledWith(1, 'status', 'x')
    expect(onEndEdit).toHaveBeenCalledTimes(2)
  })

  it('keeps non-searchable dropdown-grid popups out of text input sessions while keyboard selection still works', () => {
    setupPopupContext()
    const onSelect = vi.fn()
    const popup = new DropdownGridPopup()

    popup.open({
      columns: [{ key: 'name', title: 'Name', width: 120 }],
      rows: [
        { id: 'a', name: 'Alpha' },
        { id: 'b', name: 'Beta' },
      ],
      valueKey: 'id',
      labelKey: 'name',
      selectedValue: 'a',
      anchor: anchorTarget(),
      searchable: false,
      maxVisibleItems: 8,
      onSelect,
      onClose: vi.fn(),
    })

    expect((popup as any)._searchInput.input.hasSession).toBe(false)
    expect(InputComposer.instance.hasSession).toBe(false)
    expect(popup.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }))).toBe(true)
    expect(popup.debugState().keyboardIndex).toBe(1)
    expect(popup.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))).toBe(true)
    expect(onSelect).toHaveBeenCalledWith('b', expect.objectContaining({ id: 'b' }))
    expect(popup.visible).toBe(false)

    popup.dispose()
  })

  it('navigates and commits a searchable drop-tree cell popup with the arrow keys', () => {
    setupPopupContext()
    const row = { department: '' }
    const commitVisibleValue = vi.fn(() => true)
    const controller = new GridCellPopupEditors<typeof row>({
      owner: anchorTarget(),
      structureEditing: { commitVisibleValue, canEditCell: () => true } as any,
      getVisibleRows: () => [row],
      onEndEdit: vi.fn(),
      createEmbeddedGrid: vi.fn() as any,
    })

    controller.openColumnEditorPopup(0, 0, {
      key: 'department', title: '执行Team', type: 'text',
      editor: {
        kind: 'drop-tree', searchable: true, expandedKeysOnOpen: ['root'],
        roots: [{ key: 'root', label: 'Team group A', selectable: false, children: [
          { key: 'cardiology', label: 'TeamAlpha' },
          { key: 'respiratory', label: 'TeamDevice' },
        ] }],
      },
    })

    const popup = controller.dropTreePopup
    const tree = popup.focusRoots()[0] as any
    expect(InputComposer.instance.hasSession).toBe(true)
    expect(popup.focusRoots()).toHaveLength(1)
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp']) {
      pressSearchKey(key)
    }
    expect(FocusManager.instance.current).toBe(tree)
    expect(tree.debugState().focusedIndex).toBe(1)
    pressSearchKey('Enter')
    expect(commitVisibleValue).toHaveBeenCalledWith(0, 'department', 'cardiology')
    expect(popup.visible).toBe(false)
    controller.dispose()
  })

  it('navigates and commits a searchable drop-tree-grid cell popup with the arrow keys', () => {
    setupPopupContext()
    const row = { exam: '' }
    const commitVisibleValue = vi.fn(() => true)
    const controller = new GridCellPopupEditors<typeof row>({
      owner: anchorTarget(),
      structureEditing: { commitVisibleValue, canEditCell: () => true } as any,
      getVisibleRows: () => [row],
      onEndEdit: vi.fn(),
      createEmbeddedGrid: vi.fn() as any,
    })

    controller.openColumnEditorPopup(0, 0, {
      key: 'exam', title: 'Inventory', type: 'text',
      editor: {
        kind: 'drop-tree-grid', searchable: true, expandedKeysOnOpen: ['root'],
        treeColumnKey: 'name', labelKey: 'name',
        columns: [{ key: 'name', title: '名称' }],
        roots: [{ key: 'root', row: { name: 'Inventory' }, selectable: false, children: [
          { key: 'blood', row: { name: 'Standard item' } },
          { key: 'urine', row: { name: '尿常规' } },
        ] }],
      },
    })

    const popup = controller.dropTreeGridPopup
    const grid = popup.focusRoots()[0] as any
    expect(InputComposer.instance.hasSession).toBe(true)
    expect(popup.focusRoots()).toHaveLength(1)
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp']) {
      pressSearchKey(key)
    }
    expect(FocusManager.instance.current).toBe(grid)
    expect(grid.debugState().focusedItemIndex).toBe(1)
    pressSearchKey('Enter')
    expect(commitVisibleValue).toHaveBeenCalledWith(0, 'exam', 'blood')
    expect(popup.visible).toBe(false)
    controller.dispose()
  })

  it('passes the current outer grid cell to lookup query processors', () => {
    setupPopupContext()
    const row = { orderType: 'drug', itemCode: 'a' }
    const queryProcessor = vi.fn((context: any) => ({
      rows: context.rows.filter((option: Record<string, any>) => option.type === context.cell.row.orderType),
    }))
    const controller = new GridCellPopupEditors<typeof row>({
      owner: anchorTarget(),
      structureEditing: { commitVisibleValue: vi.fn(), canEditCell: () => true } as any,
      getVisibleRows: () => [row],
      onEndEdit: vi.fn(),
      createEmbeddedGrid: () => new RenderDataGrid<Record<string, any>>({ columns: [], rows: [] }),
    })
    const column = { key: 'itemCode', title: 'Item', type: 'text' as const }

    controller.openColumnEditorPopup(0, 0, {
      ...column,
      editor: {
        kind: 'lookup',
        columns: [{ key: 'name', title: 'Name' }],
        rows: [
          { code: 'a', name: 'Drug A', type: 'drug' },
          { code: 'b', name: 'Exam B', type: 'exam' },
        ],
        valueKey: 'code',
        labelKey: 'name',
        queryProcessor,
      },
    })

    expect(queryProcessor).toHaveBeenCalledWith(expect.objectContaining({
      cell: expect.objectContaining({
        row,
        rowIndex: 0,
        column: expect.objectContaining({ key: 'itemCode' }),
        columnIndex: 0,
        value: 'a',
      }),
    }))
    expect(controller.dropdownGridPopup.debugState().filteredRows).toEqual([
      { code: 'a', name: 'Drug A', type: 'drug' },
    ])
    controller.dispose()
  })

  it('does not commit a popup selection after the outer cell becomes readonly', () => {
    setupPopupContext()
    let editable = true
    const commitVisibleValue = vi.fn()
    const rows = [{ status: 'a' }]
    const controller = new GridCellPopupEditors({
      owner: anchorTarget(),
      structureEditing: {
        commitVisibleValue,
        canEditCell: () => editable,
      } as any,
      getVisibleRows: () => rows,
      onEndEdit: vi.fn(),
      createEmbeddedGrid: vi.fn() as any,
    })

    controller.openSelectPopup(0, 0, {
      key: 'status',
      title: 'Status',
      type: 'select',
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
    })
    editable = false
    ;(controller.dropdownPopup as any)._select({ value: 'b', label: 'Beta' })

    expect(commitVisibleValue).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('does not retarget a popup selection after the opened row is removed', () => {
    setupPopupContext()
    let rows = [{ status: 'a' }, { status: 'x' }]
    const commitVisibleValue = vi.fn()
    const canEditCell = vi.fn((rowIndex: number) => rowIndex >= 0)
    const controller = new GridCellPopupEditors({
      owner: anchorTarget(),
      structureEditing: { commitVisibleValue, canEditCell } as any,
      getVisibleRows: () => rows,
      onEndEdit: vi.fn(),
      createEmbeddedGrid: vi.fn() as any,
    })

    controller.openSelectPopup(0, 0, {
      key: 'status',
      title: 'Status',
      type: 'select',
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
    })
    rows = rows.slice(1)
    ;(controller.dropdownPopup as any)._select({ value: 'b', label: 'Beta' })

    expect(canEditCell).toHaveBeenCalledWith(-1, 0)
    expect(commitVisibleValue).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('closes dropdown-grid popups on Tab and Escape with stable debug search state', () => {
    setupPopupContext()
    const popup = new DropdownGridPopup()
    const open = () => popup.open({
      columns: [{ key: 'name', title: 'Name', width: 120 }],
      rows: [{ id: 'a', name: 'Alpha' }],
      valueKey: 'id',
      labelKey: 'name',
      selectedValue: '',
      anchor: anchorTarget(),
      searchable: false,
      maxVisibleItems: 8,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    })

    open()
    expect(popup.debugState()).toMatchObject({
      searchable: false,
      searchBehavior: 'internal',
      searchText: '',
    })
    expect(popup.onKeyDown(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))).toBe(false)
    expect(popup.visible).toBe(false)

    open()
    expect(popup.onKeyDown(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))).toBe(true)
    expect(popup.visible).toBe(false)

    popup.dispose()
  })

  it('refreshes external-search rows against the current query and selected value', () => {
    setupPopupContext()
    const popup = new DropdownGridPopup()

    popup.open({
      columns: [{ key: 'name', title: 'Name', width: 120 }],
      rows: [{ id: 'old', name: 'Old result' }],
      valueKey: 'id',
      labelKey: 'name',
      selectedValue: 'go',
      anchor: anchorTarget(),
      searchable: true,
      searchBehavior: 'external',
      searchText: 'go',
      maxVisibleItems: 8,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    })

    popup.setRows([{ id: 'go', name: 'Go' }])

    expect(popup.debugState()).toMatchObject({
      searchText: 'go',
      searchBehavior: 'external',
      keyboardIndex: 0,
      selectedValue: 'go',
    })
    expect(popup.debugState().filteredRows.map(row => row.id)).toEqual(['go'])

    popup.dispose()
  })
})
