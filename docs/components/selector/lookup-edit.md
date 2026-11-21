# LookupEdit 查询选择

> **通用布局能力**：`RenderLookupEdit` 实例统一支持 `width`、`height`、min/max、`margin` 和槽位对齐；查询 popup 的 viewport 尺寸不属于组件外部盒模型。详见[组件通用布局属性](../common-layout-properties.md)。

DirectSurface UI 的查询选择组件公共类名是 `RenderLookupEdit`。它用于从多列候选数据中检索并选择一个值，常见于Catalog、Product、检查项目、人员、Team、物资等复杂字典。

`LookupEdit` 在字段内直接输入关键字，下方 popup 只展示多列候选网格，不再显示第二个搜索框。字段支持光标定位、文本选区、复制粘贴、横向滚动和中文输入；popup 支持键盘导航、鼠标选择、滚动和右下角拖拽调整尺寸。

## API 总览

主类：

- `RenderLookupEdit`

相关 public API：

- `defaultLookupQueryProcessor`
- `LookupEditColumn`
- `LookupEditQueryContext`
- `LookupEditQueryProcessor`
- `LookupEditQueryResult`
- `LookupEditDebugState`
- `LookupEditTextPointerEventType`
- `FormFieldStatus`

导入：

```ts
import {
  RenderLookupEdit,
  defaultLookupQueryProcessor,
  type FormFieldStatus,
  type LookupEditColumn,
  type LookupEditDebugState,
  type LookupEditQueryContext,
  type LookupEditQueryProcessor,
  type LookupEditQueryResult,
} from 'directsurface'
```

`RenderLookupEdit` 的构造参数是公开 options 对象，但当前没有单独导出的 LookupEdit options 类型。业务代码直接按本文参数表传入对象。

## 何时使用

- 候选项需要显示多列信息，例如编码、名称、规格、Team。
- 候选项较多，需要输入关键字过滤。
- 选择结果是一个稳定值，但显示时需要 label 和附加 meta。
- 业务需要自定义查询规则、远程搜索、拼音码搜索或排序。

不适合：

- 只有少量单列枚举，使用 [ComboBox](./combo-box.md)。
- 需要多选，使用 [MultiSelectDropdown](./multi-select-dropdown.md)。
- 候选项是树结构，使用 [DropTreeEdit](./drop-tree-edit.md)。
- 候选项是树表结构，使用 [DropTreeGridEdit](./drop-tree-grid-edit.md)。
- 任意文本输入，使用 [TextBox](../input/text-box.md)。

## 最小示例

```ts
import { RenderLookupEdit, type LookupEditColumn } from 'directsurface'

interface CatalogLookupRow {
  code: string
  name: string
  icd: string
  py: string
}

const catalogColumns: LookupEditColumn[] = [
  { key: 'code', title: '编码', width: 92 },
  { key: 'name', title: 'Item name' },
  { key: 'icd', title: 'CODE', width: 104 },
]

const catalogRows: CatalogLookupRow[] = [
  { code: 'SKU001', name: 'DeviceAlpha', icd: 'CODE06', py: 'shhxdgr' },
  { code: 'SKU002', name: 'PriorityBeta', icd: 'CODE10', py: 'gxy' },
]

const catalogState = {
  catalogCode: '',
  catalogName: '',
}

const catalogLookup = new RenderLookupEdit({
  columns: catalogColumns,
  rows: catalogRows,
  valueKey: 'code',
  labelKey: 'name',
  metaKey: 'icd',
  queryKeys: ['code', 'name', 'icd', 'py'],
  searchable: true,
  clearable: true,
  placeholder: '输入关键字检索Catalog',
  onChange: (value, row) => {
    catalogState.catalogCode = value
    catalogState.catalogName = row?.name ?? ''
  },
})
```

## 组件关系

| 组件 / 类型 | 用途 | 说明 |
| --- | --- | --- |
| `RenderLookupEdit<T>` | 查询选择触发字段。 | 参与布局、焦点、hover、只读禁用、清除和表单状态。 |
| `LookupEditColumn` | popup 表格列定义。 | 描述候选表格列 key、标题和宽度。 |
| `LookupEditQueryProcessor<T>` | 自定义查询函数。 | 接收查询上下文，返回过滤后的 rows。 |
| `defaultLookupQueryProcessor()` | 默认查询函数。 | 按 queryKeys 做精确、前缀、包含匹配并排序。 |
| `LookupEditDebugState` | 调试状态。 | 用于测试和Catalog当前 popup、query、显示文本和过滤数量。 |

内部 popup 基于框架的表格浮层实现，但 `DropdownGridPopup` 不是当前 public API 的直接文档入口。业务优先使用 `RenderLookupEdit`，除非后续框架明确暴露更底层的 popup API。

## 行数据和列定义

`RenderLookupEdit<T>` 的 `T` 必须是普通对象。`valueKey` 和 `labelKey` 指向行对象中的字段：

```ts
interface DrugRow {
  code: string
  name: string
  spec: string
  py: string
}

const drugRows: DrugRow[] = [
  { code: 'MED001', name: '阿莫西林胶囊', spec: '0.25g*24 粒', py: 'amxl' },
  { code: 'MED002', name: '布洛芬缓释胶囊', spec: '0.3g*20 粒', py: 'blf' },
]

const drugColumns: LookupEditColumn[] = [
  { key: 'code', title: 'Product编码', width: 104 },
  { key: 'name', title: 'Product名称' },
  { key: 'spec', title: '规格', width: 132 },
]
```

### LookupEditColumn

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `key` | `string` | 是 | 行对象字段名。 |
| `title` | `string` | 是 | popup 表Alpha标题。 |
| `width` | `number` | 否 | 固定列宽。不传时作为弹性列参与剩余宽度分配。 |

列的 `key` 不要求都参与查询；实际查询字段由 `queryKeys` 或默认查询键决定。

## RenderLookupEdit 构造参数

`new RenderLookupEdit<T>(options)` 的 `options`：

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `columns` | `LookupEditColumn[]` | 必填 | popup 表格列定义。 |
| `rows` | `T[]` | 必填 | 候选行数据。 |
| `valueKey` | `string` | 必填 | 提交值字段。选中后 `value` 来自 `row[valueKey]`。 |
| `labelKey` | `string` | 必填 | 显示文本字段。触发字段显示 `row[labelKey]`。 |
| `value` | `string` | `''` | 当前选中值。 |
| `placeholder` | `string` | `'请选择...'` | 未选中或查询为空时的提示文本。 |
| `onChange` | `(value: string, row: T \| null) => void` | `undefined` | 选中或清除时触发。清除时 `row` 为 `null`。 |
| `searchable` | `boolean` | `true` | 是否允许在字段内编辑查询文本；`false` 时仅选择，不开启文本输入会话。 |
| `maxVisibleItems` | `number` | `8` | popup 表格最多显示的数据行数。 |
| `readonly` | `boolean` | `false` | 只读。不可聚焦、不可打开、不可清除，显示锁图标。 |
| `disabled` | `boolean` | `false` | 禁用。不可聚焦、不可打开、不可清除。 |
| `status` | `FormFieldStatus` | `'default'` | 表单状态。可选 `'default'`、`'success'`、`'warning'`、`'error'`。 |
| `helperText` | `string` | `''` | 字段下方帮助或错误文案。会增加组件Priority度。 |
| `prefixText` | `string` | `''` | 输入区域左侧固定文本。 |
| `suffixText` | `string` | `''` | 输入区域右侧固定文本。 |
| `clearable` | `boolean` | `false` | 有值、非禁用、非只读时显示清除按钮；不可搜索模式下也允许 Backspace/Delete 清除。可搜索模式下删除键只编辑查询词。 |
| `metaKey` | `string` | `undefined` | 已选行附加显示字段，例如 ICD、规格、Team。 |
| `metaFormatter` | `(row: T) => string` | `undefined` | 自定义附加显示文本。优先级Priority于 `metaKey`。 |
| `queryKeys` | `string[]` | 自动推导 | 默认查询字段。未传时使用 `valueKey`、`labelKey`、`metaKey`、所有列 key 去重后的列表。 |
| `queryProcessor` | `LookupEditQueryProcessor<T>` | `defaultLookupQueryProcessor` | 自定义查询函数。可用于远程结果、拼音搜索、业务排序等。 |

```ts
interface DrugLookupRow {
  code: string
  name: string
  spec: string
  py: string
}

const drugLookupRows: DrugLookupRow[] = [
  { code: 'MED001', name: '阿莫西林胶囊', spec: '0.25g*24 粒', py: 'amxl' },
  { code: 'MED002', name: '布洛芬缓释胶囊', spec: '0.3g*20 粒', py: 'blf' },
]
const drugLookupColumns: LookupEditColumn[] = [
  { key: 'code', title: 'Product编码', width: 104 },
  { key: 'name', title: 'Product名称' },
  { key: 'spec', title: '规格', width: 132 },
]

const drugLookup = new RenderLookupEdit<DrugLookupRow>({
  columns: drugLookupColumns,
  rows: drugLookupRows,
  valueKey: 'code',
  labelKey: 'name',
  metaKey: 'spec',
  queryKeys: ['code', 'name', 'spec', 'py'],
  clearable: true,
  prefixText: 'Product',
  onChange: (value, row) => {
    state.drugCode = value
    state.drugSpec = row?.spec ?? ''
  },
})
```

## RenderLookupEdit 属性

| 属性 | 类型 | 可写 | 说明 |
| --- | --- | --- | --- |
| `columns` | `LookupEditColumn[]` | 是 | popup 表格列。popup 打开时重新赋值会同步列和当前查询结果。 |
| `rows` | `T[]` | 是 | 候选行。popup 打开时重新赋值会按当前 query 重新过滤并同步。 |
| `valueKey` | `string` | 是 | 提交值字段。公开字段；修改后需业务确保 `value` 与 rows 仍匹配。 |
| `labelKey` | `string` | 是 | 显示字段。公开字段；修改后如需立即刷新，应触发重绘。 |
| `value` | `string` | 是 | 当前选中值。赋值会转成字符串并重绘。 |
| `placeholder` | `string` | 是 | 提示文本。公开字段。 |
| `onChange` | `(value: string, row: T \| null) => void \| undefined` | 是 | 值变化回调。 |
| `searchable` | `boolean` | 是 | 是否允许在字段内输入查询。修改时关闭候选并恢复已选 label；关闭搜索会结束输入会话，重新启用会在字段仍聚焦时恢复输入。 |
| `maxVisibleItems` | `number` | 是 | popup 最大可见行数。公开字段；修改后下一次打开 popup 生效。 |
| `readonly` | `boolean` | 是 | 只读状态。设为 `true` 会关闭 popup、清理 query、失焦并注销焦点。 |
| `disabled` | `boolean` | 是 | 禁用状态。设为 `true` 会关闭 popup、清理 query、失焦并注销焦点。 |
| `status` | `FormFieldStatus` | 是 | 状态色。赋值会重绘。 |
| `helperText` | `string` | 是 | 帮助文案。赋值会重新 layout。 |
| `prefixText` | `string` | 是 | 前缀文本。赋值会重绘。 |
| `suffixText` | `string` | 是 | 后缀文本。赋值会重绘。 |
| `clearable` | `boolean` | 是 | 是否显示清除按钮。赋值会重绘。 |
| `metaKey` | `string \| undefined` | 是 | 附加显示字段。公开字段。 |
| `metaFormatter` | `(row: T) => string \| undefined` | 是 | 自定义附加显示文本。公开字段。 |
| `queryKeys` | `string[] \| undefined` | 是 | 查询字段。公开字段。 |
| `queryProcessor` | `LookupEditQueryProcessor<T> \| undefined` | 是 | 查询函数。公开字段。 |
| `isFocused` | `boolean` | 否 | 当前是否拥有焦点。 |

公开字段不是 setter 时，运行时修改后框架不会自动知道所有视觉变化。如果影响当前画面，应由业务触发重绘或在下一次打开 popup 前修改。

## RenderLookupEdit 方法

| 方法 | 返回值 | 说明 |
| --- | --- | --- |
| `focusIn()` | `void` | 进入焦点。通常由 `FocusManager` 调用。 |
| `focusOut()` | `void` | 退出焦点。通常由 `FocusManager` 调用。 |
| `refreshLookup()` | `void` | 重建当前实例的值索引并重绘；同一 `rows` 数组保持相同长度但原地替换候选内容后调用。popup 已打开时会沿用当前 query 重新计算结果。 |
| `debugState()` | `LookupEditDebugState` | 返回当前 popup、query、显示文本、过滤数等Catalog信息。 |
| `dispose()` | `void` | 清理 query 展示、释放 popup、注销焦点、清理 hover 和文本区域监听器。 |
| `addTextPointerEventListener(type, listener, options?)` | `() => void` | 注册文本区域独立的单击或双击监听，返回取消函数。详见下文。 |
| `removeTextPointerEventListener(type, listener, options?)` | `void` | 按事件类型、监听函数和 capture 移除文本区域监听。 |

`RenderLookupEdit` 没有公开 `open()` 方法。聚焦本身不展开候选；点击字段、Enter、ArrowDown 或字段内输入会展开候选。Space 在可搜索模式下输入空格，仅在不可搜索模式下用于展开候选。

每个 `RenderLookupEdit` 实例独立维护 `valueKey → row` 索引。已选 label 和 meta 的绘制不会重复扫描完整 `rows`；该索引不参与 `queryProcessor`，因此不会改变 popup 的查询结果、顺序或数量。替换 `rows` 或改变数组长度时索引会自动更新。

## LookupEditDebugState

`debugState()` 返回：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `popupVisible` | `boolean` | popup 是否打开。 |
| `queryText` | `string` | 当前查询文本。 |
| `showQueryInField` | `boolean` | 触发字段当前是否显示 query，而不是已选 label。 |
| `displayText` | `string` | 当前触发字段主文本。 |
| `focused` | `boolean` | 是否聚焦。 |
| `disabled` | `boolean` | 是否禁用。 |
| `readonly` | `boolean` | 是否只读。 |
| `value` | `string` | 当前提交值。 |
| `selectedLabel` | `string` | 当前 value 对应行的 label。找不到时为空。 |
| `filteredCount` | `number` | popup 打开时为过滤结果数；关闭时为全部 rows 数。 |

```ts
const debugLookup = new RenderLookupEdit({
  columns: [
    { key: 'code', title: '编码' },
    { key: 'name', title: '名称' },
  ],
  rows: [
    { code: 'SKU001', name: 'DeviceAlpha' },
  ],
  valueKey: 'code',
  labelKey: 'name',
})
const stateSnapshot = debugLookup.debugState()
if (stateSnapshot.popupVisible) {
  notificationManager.show(`当前过滤结果: ${stateSnapshot.filteredCount}`)
}
```

## 查询行为

### 默认查询

默认查询函数是 `defaultLookupQueryProcessor()`。它会：

- 将 query trim 后转小写。
- query 为空时返回全部 rows。
- 在 `queryKeys` 指定的字段中查找。
- 匹配优先级为：完全匹配、前缀匹配、包含匹配。
- 字段优先级为：`valueKey`、`labelKey`、`metaKey`、其他 queryKeys。
- 同等条件下按匹配位置、长度差、原始行顺序排序。

```ts
const localResult = defaultLookupQueryProcessor({
  query: 'dx',
  rows: [
    { code: 'SKU001', name: 'DeviceAlpha', icd: 'CODE06' },
  ],
  columns: [
    { key: 'code', title: '编码' },
    { key: 'name', title: '名称' },
  ],
  valueKey: 'code',
  labelKey: 'name',
  queryKeys: ['code', 'name'],
  selectedValue: '',
})

state.filteredRows = localResult.rows
```

### 自定义查询

`queryProcessor` 接收 `LookupEditQueryContext<T>`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `query` | `string` | 当前查询文本。 |
| `rows` | `readonly T[]` | 当前候选行。 |
| `columns` | `readonly LookupEditColumn[]` | 当前列。 |
| `valueKey` | `string` | 提交值字段。 |
| `labelKey` | `string` | 显示字段。 |
| `metaKey` | `string \| undefined` | 附加显示字段。 |
| `queryKeys` | `readonly string[]` | 实际查询字段。 |
| `selectedValue` | `string` | 当前已选值。 |

返回 `LookupEditQueryResult<T>`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `rows` | `T[]` | 过滤和排序后的候选行。 |

```ts
interface EmployeeRow {
  id: string
  name: string
  dept: string
  py: string
}

const employeeRows: EmployeeRow[] = [
  { id: 'E001', name: '李安然', dept: 'TeamAlpha', py: 'lar' },
  { id: 'E002', name: '王明', dept: 'TeamDevice', py: 'wm' },
]

const employeeLookup = new RenderLookupEdit<EmployeeRow>({
  columns: [
    { key: 'id', title: '工号', width: 80 },
    { key: 'name', title: '姓名' },
    { key: 'dept', title: 'Team', width: 120 },
  ],
  rows: employeeRows,
  valueKey: 'id',
  labelKey: 'name',
  queryKeys: ['id', 'name', 'dept', 'py'],
  queryProcessor: context => {
    const query = context.query.trim().toLowerCase()
    return {
      rows: query
        ? context.rows.filter(row =>
            row.name.includes(context.query) ||
            row.py.includes(query) ||
            row.dept.includes(context.query),
          )
        : [...context.rows],
    }
  },
  onChange: (value, row) => {
    state.employeeId = value
    state.employeeName = row?.name ?? ''
  },
})
```

当前 `queryProcessor` 是同步函数。远程检索通常应由业务层异步更新 `rows`：输入变化可以先返回已有缓存结果，业务异步请求完成后给 `lookup.rows` 重新赋值；如果 popup 仍打开，组件会按当前 query 自动同步候选行。

## 鼠标行为

| 操作 | 行为 |
| --- | --- |
| 点击可搜索字段主体 | 获得焦点并展开候选；首次聚焦选中已选名称全文，再次点击定位光标，不关闭候选。 |
| 拖动文本 / 双击单词 | 选择查询文本。横向拖选参与手势竞争，纵向手势让给滚动容器。 |
| 点击右侧箭Alpha | 展开或收起候选；收起时放弃未提交的查询。 |
| 点击不可搜索字段主体 | 展开或收起候选。 |
| 点击清除按钮 | 清空 `value`，触发 `onChange('', null)`，字段保持焦点。 |
| 点击 popup 行 | 提交该行，`value = row[valueKey]`，关闭 popup 后触发 `onChange(value, row)`。 |
| 点击外部并失焦 | 关闭候选，放弃本次查询并恢复已选 label，不自动提交Priority亮行。 |
| 滚动 popup 表格 | 只滚动候选表格，字段保留输入焦点。 |
| 拖动右下角 resize grip | 调整 popup 面板宽度和Priority度。 |

popup 中的表格是只读候选表格，不支持在 lookup popup 内编辑单元格。候选为空时保持查询文本并显示网格空状态。候选跟随字段所属窗口与焦点作用域；模态表单内的字段也可以直接点击自己的候选，其他模态作用域之外的浮层仍被阻挡。

## 文本区域单击和双击监听

`addTextPointerEventListener()` 只监听可搜索且非只读、非禁用字段的文本编辑区域，包括其中的空白。下拉箭Alpha、清除按钮、前后缀、已选值的 meta 和 helper 文本不触发这些监听。它不创建独立的 TextBox 子组件，事件的 `target` / `currentTarget` 仍是当前 `RenderLookupEdit`。

```ts
import { RenderLookupEdit, type LookupEditTextPointerEventType } from 'directsurface'

const lookup = new RenderLookupEdit({
  columns: [{ key: 'name', title: '名称' }],
  rows: [{ code: 'A', name: '项目 A' }],
  valueKey: 'code',
  labelKey: 'name',
  clearable: true,
})

const clickType: LookupEditTextPointerEventType = 'pointeractivate'
const stopClick = lookup.addTextPointerEventListener(clickType, event => {
  console.log('文本单击', event.position)
})
const doubleClick = () => console.log('文本双击')
lookup.addTextPointerEventListener('dblclick', doubleClick)

stopClick()
lookup.removeTextPointerEventListener('dblclick', doubleClick)
```

- `type` 为 `'pointeractivate' | 'dblclick'`，与框架指针事件系统一致；单击不使用 DOM 的 `'click'` 名称。
- `listener` 类型为 `PointerEventListener`，接收 `RoutedPointerEvent`；`options` 支持 `capture` 和 `once`。相同类型、函数及 capture 的重复注册只保留一份。
- `once` 仅由匹配的文本事件消耗，箭Alpha或清除按钮点击不会消耗它；取消函数可重复调用，组件销毁时自动清理。
- 单击在有效按下、抬起后触发；拖选、手势竞争失败、取消或抬起到其他区域不触发。按下后字段自身或祖先隐藏、失焦或 detach 会使旧按下失效；即使抬起前重新显示或恢复焦点，也不会触发旧点击或消耗 `once`。新的点击从单击重新计数。双击按文本区域的逻辑命中身份计数，第二次单击后触发一次 `dblclick`，所以一次双击通常也产生两次 `pointeractivate`。
- 监听不会替换默认编辑行为：单击仍定位光标，双击仍选词。`dblclick` 监听先于默认选词，调用 `preventDefault()` 可取消选词；`stopPropagation()` 只停止该事件传播。单击通知发生在按下阶段的光标定位之后，不能撤销已经完成的定位；需要控制按下行为时使用组件原有的 `addPointerEventListener('pointerdown', ...)`。
- 组件级 `addPointerEventListener()` 继续用于监听整个字段；文本区域监听不包含候选网格的行点击。

## 键盘行为

| 按键 / 操作 | 行为 |
| --- | --- |
| Enter / ArrowDown（候选关闭时） | 打开候选。 |
| 字段内输入 / 粘贴 | `searchable: true` 时更新 query 并展开候选；沿用 `queryProcessor` 过滤、排序。 |
| Space | 可搜索时输入空格，不可搜索时打开候选。 |
| ArrowDown / ArrowUp（候选打开时） | 移动候选Priority亮并滚动到可见位置，输入焦点保留在字段。 |
| Enter（候选打开时） | 提交当前有效候选；输入过滤后默认Priority亮首个匹配项（已选行仍匹配时优先保留）；没有有效候选时不提交。 |
| Escape | 关闭候选，恢复已选 label，不更改 `value`。 |
| Tab / Shift+Tab | 关闭候选、不提交，并正常移动焦点。 |
| Left / Right、Home / End、选择及剪贴板快捷键 | 保留单行文本编辑行为。 |
| Backspace / Delete | 可搜索时只编辑查询词；不可搜索且 `clearable` 有值时清空已选值。 |

查询文本与提交值独立：删除全部查询词会显示全部候选，但不会清空 `value` 或触发 `onChange`。需要清空已选值时使用清除按钮。关闭候选或失焦时，未选择的 query 会被放弃，不作为自由文本值提交。

中文组合输入期间保留输入法的方向键、Enter 和 Escape，不导航或提交候选；组合输入结束后再按最终文本查询。组件树键盘监听仍先于默认行为执行，`preventDefault()` 可取消选择，`stopPropagation()` 本身不取消选择。

## 清除行为

清除按钮显示条件：

- `clearable === true`
- `value.length > 0`
- 非 `disabled`
- 非 `readonly`

清除后：

- 关闭 popup。
- 清空 query 展示。
- 字段获得焦点。
- `value` 变成 `''`。
- 触发 `onChange('', null)`。

```ts
const clearableLookup = new RenderLookupEdit({
  columns: [
    { key: 'code', title: '编码', width: 92 },
    { key: 'name', title: '名称' },
  ],
  rows: [
    { code: 'A001', name: '项目 A' },
  ],
  valueKey: 'code',
  labelKey: 'name',
  value: 'A001',
  clearable: true,
  onChange: (value, row) => {
    state.lookupValue = value
    state.lookupRow = row
  },
})
```

## 只读和禁用

| 状态 | 可聚焦 | 可打开 popup | 可清除 | 视觉 |
| --- | --- | --- | --- | --- |
| 正常 | 是 | 是 | 取决于 `clearable` | 箭Alpha图标。 |
| `readonly` | 否 | 否 | 否 | 只读底色和锁图标。 |
| `disabled` | 否 | 否 | 否 | 禁用文本和禁用边框。 |

`readonly` 适合展示已选值但当前流程不允许改；`disabled` 适合字段完全不可交互的状态。

## meta 显示

`metaKey` 或 `metaFormatter` 用于在触发字段右侧显示附加信息：

```ts
const examLookup = new RenderLookupEdit({
  columns: [
    { key: 'code', title: '项目编码', width: 104 },
    { key: 'name', title: '检查项目' },
    { key: 'dept', title: '执行Team', width: 120 },
  ],
  rows: [
    { code: 'LAB001', name: 'Standard item', dept: 'TeamInspection' },
    { code: 'SKU301', name: 'Alpha product', dept: 'TeamImaging' },
  ],
  valueKey: 'code',
  labelKey: 'name',
  metaFormatter: row => `执行: ${row.dept}`,
  onChange: value => {
    state.examCode = value
  },
})
```

显示规则：

- popup 关闭时，主文本显示 `labelKey`，右侧显示 meta。
- 用户输入 query 时，触发字段显示 query，并临时隐藏 meta。
- 选择或关闭 popup 后恢复已提交值展示。

## Popup 布局和尺寸

Lookup popup 的宽度和Priority度由内部表格浮层计算：

- 最小宽度不小于触发字段宽度。
- 最小宽度不小于 200。
- 固定列使用 `width`。
- 未设置 `width` 的列按剩余宽度弹性分配，最小 60。
- 如果候选行超过可见行数，会保留垂直滚动条宽度。
- 下方空间不足时会尝试显示到触发字段上方。
- 右下角 resize grip 可调整 popup 宽Priority。

`maxVisibleItems` 控制自然Priority度，但用户调整过 popup 尺寸后，浮层会使用当前 override 尺寸。

## rows / columns 动态更新

`rows` 和 `columns` 可以在运行时替换：

- popup 关闭时，只更新下一次打开使用的数据。
- popup 打开时，`rows` 替换会按当前 query 重新过滤并同步表格。
- popup 打开时，`columns` 替换会同步表格列，并重新设置当前查询结果。
- 替换 `rows` 或 `columns` 不会自动清空 `value`，也不会触发 `onChange`。
- 字段聚焦且未编辑查询时，替换 `rows` 或调用 `refreshLookup()` 会同步已选名称与输入内容，并将选区约束到新文本范围；原先全选时继续全选新名称。正在编辑的 query 和选区不被数据刷新覆盖。

```ts
const dynamicLookup = new RenderLookupEdit({
  columns: [
    { key: 'code', title: '编码' },
    { key: 'name', title: '名称' },
  ],
  rows: [
    { code: 'OLD', name: '旧项目' },
  ],
  valueKey: 'code',
  labelKey: 'name',
  value: 'OLD',
})

dynamicLookup.rows = [
  { code: 'NEW', name: '新项目' },
]
if (!dynamicLookup.rows.some(row => row.code === dynamicLookup.value)) {
  dynamicLookup.value = ''
}
```

## 生命周期

- `RenderLookupEdit.dispose()` 会关闭并释放 popup、注销焦点、清理 query 和 hover。
- `readonly` / `disabled` 变为 `true` 会关闭 popup、清理 query、失焦并从焦点顺序中移除。
- popup 不持有文本输入 session。候选关闭时，仍聚焦的可搜索字段保留输入能力并恢复已选 label；失焦、自身或祖先容器隐藏、detach 或 dispose 时结束输入会话，并释放文本拖选捕获。
- 选择时先关闭旧 popup 再调用业务回调；回调可以销毁组件或打开新候选，旧选择流程不会再次关闭新 popup。
- `debugState()` 在 popup 关闭时不会执行 `queryProcessor`，避免调试面板触发额外业务查询。

## 表单组合建议

```ts
const requiredCatalogLookup = new RenderLookupEdit({
  columns: [
    { key: 'code', title: '编码', width: 92 },
    { key: 'name', title: 'Item name' },
  ],
  rows: [
    { code: 'SKU001', name: 'DeviceAlpha' },
  ],
  valueKey: 'code',
  labelKey: 'name',
  value: state.catalogCode,
  prefixText: 'Catalog',
  clearable: true,
  status: state.catalogCode ? 'default' : 'error',
  helperText: state.catalogCode ? '' : '请选择Catalog',
  onChange: value => {
    state.catalogCode = value
  },
})
```

布局注意：

- 组件宽度由父布局约束决定；无限宽度下默认使用 220。
- `helperText` 会增加组件总Priority度。
- 主文本和 meta 共享触发字段的 value 区域，meta 会占用右侧空间。
- 长 label 会被裁剪，不会自动换行。

## 常见问题

### 为什么输入 query 后没有选中值？

LookupEdit 的输入只用于查询，只有选择 popup 行才会提交 `value`。关闭 popup 会恢复已提交 label，不会把 query 当作 value。

### 为什么设置了 `value` 但显示为空？

`value` 必须能在 `rows` 中找到 `String(row[valueKey]) === value` 的行。找不到时 `selectedLabel` 为空，触发字段会显示 placeholder。

### 为什么更新 rows 后 value 没有自动清空？

组件不替业务决定旧值是否仍有效。需要清空时由业务显式判断并设置 `value = ''`。

### 远程搜索怎么做？

当前 `queryProcessor` 是同步函数。推荐方式是业务层维护缓存 rows：用户查询时先返回当前缓存，业务异步请求完成后更新 `lookup.rows`。如果 popup 仍打开，组件会按当前 query 同步候选结果。

## 相关组件

- [ComboBox](./combo-box.md)
- [MultiSelectDropdown](./multi-select-dropdown.md)
- [DropTreeEdit](./drop-tree-edit.md)
- [DropTreeGridEdit](./drop-tree-grid-edit.md)
- [DataGrid](../data/data-grid.md)
- [TextBox](../input/text-box.md)
