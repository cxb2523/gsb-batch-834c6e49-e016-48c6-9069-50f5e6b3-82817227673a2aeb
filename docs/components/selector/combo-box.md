# ComboBox 单选下拉

> **通用布局能力**：`RenderComboBox` 实例统一支持 `width`、`height`、min/max、`margin` 和槽位对齐；`fieldHeight` 只表示触发字段主体Priority度，popup 使用独立浮层尺寸。详见[组件通用布局属性](../common-layout-properties.md)。

DirectSurface UI 的单选下拉公共类名是 `RenderComboBox`。它用于从一组候选项中选择一个值，内部由字段和独立 `DropdownPopup` 组成。字段参与正常布局、焦点和表单状态；popup 通过 `PopupManager` 绘制在浮层上，不作为触发字段的子节点。

`ComboBox` 适合字典值域、状态字段和查询条件。默认 `searchable: false` 为纯选择模式；设置 `searchable: true` 后，直接在字段内输入搜索，下方只显示候选列表，不再显示第二个搜索框。查询文本仅用于过滤，最终提交的值仍来自 `options`，不允许提交自由文本。

## API 总览

主类：

- `RenderComboBox`
- `DropdownPopup`

相关 public type：

- `DropdownOption`
- `FormFieldStatus`

导入：

```ts
import {
  DropdownPopup,
  RenderComboBox,
  type DropdownOption,
  type FormFieldStatus,
} from 'directsurface'
```

`RenderComboBox` 的构造参数是公开 options 对象，但当前没有单独导出的 ComboBox options 类型。业务代码直接按本文参数表传入对象。

## 何时使用

- 只能从候选项中选择一个值。
- 候选项数量少到中等，但需要键盘导航、搜索过滤或滚动。
- 表单字段需要统一的前缀、后缀、帮助文案、状态边框和清除按钮。
- 数据表格、Document数据元或查询区需要稳定的枚举值录入。

不适合：

- 需要多选，使用 [MultiSelectDropdown](./multi-select-dropdown.md)。
- 候选项来自树结构，使用 [DropTreeEdit](./drop-tree-edit.md)。
- 候选项需要表格列展示，使用 [LookupEdit](./lookup-edit.md) 或 [DropTreeGridEdit](./drop-tree-grid-edit.md)。
- 日期时间输入，使用 [DatePicker](../input/date-picker.md)。
- 任意文本输入，使用 [TextBox](../input/text-box.md)。

## 最小示例

```ts
import { RenderComboBox, type DropdownOption } from 'directsurface'

const statusOptions: DropdownOption[] = [
  { value: 'active', label: '启用' },
  { value: 'disabled', label: '停用' },
]

const statusState = {
  status: 'active',
  statusLabel: '启用',
}

const statusDropdown = new RenderComboBox({
  options: statusOptions,
  value: statusState.status,
  onChange: (value, option) => {
    statusState.status = value
    statusState.statusLabel = option?.label ?? ''
  },
})
```

## 组件关系

| 组件 | 用途 | 说明 |
| --- | --- | --- |
| `RenderComboBox` | 标准单选下拉字段。 | 参与布局、焦点、hover、只读禁用、清除和表单状态。 |
| `DropdownPopup` | 独立下拉浮层。 | 由 `RenderComboBox` 内部持有，也可用于自定义触发器或表格单元格编辑器。 |
| `DropdownOption` | 候选项数据结构。 | `value` 是提交值，`label` 是显示文本。 |

## DropdownOption

```ts
const departmentOptions: DropdownOption[] = [
  { value: 'internal', label: '内Team' },
  { value: 'surgery', label: '外Team' },
  { value: 'archive', label: '已停用Team', disabled: true },
]
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `value` | `string` | 是 | 提交值。建议稳定、唯一，不要使用会变更的显示文本。 |
| `label` | `string` | 是 | 显示文本。触发字段、popup 选项、tooltip 都使用它。 |
| `group` | `string` | 否 | 预留分组字段。当前 `RenderComboBox` popup 不绘制分组标题。 |
| `disabled` | `boolean` | 否 | 禁用单个候选项。禁用项可显示，但点击和 Enter 不会选中。 |

`value` 和 `label` 都是字符串。如果业务值是数字或对象，应在业务层做映射，不要把复杂对象塞进 `value`。

## RenderComboBox 构造参数

`new RenderComboBox(options)` 的 `options`：

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `options` | `DropdownOption[]` | 必填 | 候选项数组。 |
| `value` | `string` | `''` | 当前选中值。空字符串表示未选择。 |
| `placeholder` | `string` | `'请选择...'` | 未选择时显示的提示文本。 |
| `onChange` | `(value: string, option: DropdownOption \| null) => void` | `undefined` | 值变化回调。选中候选项时 `option` 为对应项；清除时 `option` 为 `null`。 |
| `searchable` | `boolean` | `false` | 是否在字段内输入搜索。默认 `false` 保留纯选择；`true` 按名称过滤下方候选列表。 |
| `maxVisibleItems` | `number` | `8` | popup 最多显示的行数。超过后显示 popup 内滚动条。 |
| `disabled` | `boolean` | `false` | 禁用。不可聚焦、不可打开、不可清除。 |
| `readonly` | `boolean` | `false` | 只读。不可聚焦、不可打开、不可清除，视觉上按只读状态绘制。 |
| `status` | `FormFieldStatus` | `'default'` | 表单状态。可选 `'default'`、`'success'`、`'warning'`、`'error'`。 |
| `helperText` | `string` | `''` | 字段下方帮助或错误文案。会增加组件Priority度。 |
| `prefixText` | `string` | `''` | 输入区域左侧固定文本。 |
| `suffixText` | `string` | `''` | 输入区域右侧固定文本。 |
| `clearable` | `boolean` | `false` | 有值、非禁用、非只读时显示清除按钮；纯选择模式支持 Backspace/Delete 清除，可搜索模式下删除键只编辑查询词。 |
| `fieldHeight` | `number` | 主题默认Priority度 | 触发字段主体Priority度；组件总Priority度统一使用 `RenderBox.height`。 |

```ts
const selectableDepartments: DropdownOption[] = [
  { value: 'internal', label: '内Team' },
  { value: 'surgery', label: '外Team' },
]
const departmentDropdown = new RenderComboBox({
  options: selectableDepartments,
  value: '',
  placeholder: '选择Team',
  searchable: true,
  maxVisibleItems: 6,
  clearable: true,
  status: 'default',
  helperText: '',
  onChange: (value, option) => {
    state.departmentId = value
    state.departmentName = option?.label ?? ''
  },
})
```

## RenderComboBox 属性

| 属性 | 类型 | 可写 | 说明 |
| --- | --- | --- | --- |
| `options` | `DropdownOption[]` | 是 | 当前候选项。重新赋值仍关闭 popup、取消查询，不自动清空 `value` 或触发 `onChange`；可搜索字段同时同步新名称和原生输入内容。 |
| `value` | `string` | 是 | 当前选中值。赋值会重绘；如果找不到对应 option，会显示 placeholder。 |
| `placeholder` | `string` | 是 | 空值提示文本。公开字段，直接修改后如需立即刷新，应触发重绘。 |
| `onChange` | `(value: string, option: DropdownOption \| null) => void \| undefined` | 是 | 值变化回调。 |
| `searchable` | `boolean` | 是 | 是否开启字段内搜索。修改时关闭候选并恢复已选名称；仍聚焦时，启用搜索会开始输入会话，关闭搜索会结束会话。 |
| `maxVisibleItems` | `number` | 是 | popup 最大可见项数。公开字段；修改后下一次打开 popup 生效。 |
| `disabled` | `boolean` | 是 | 禁用状态。设为 `true` 会清理 hover、失焦并关闭 popup。 |
| `readonly` | `boolean` | 是 | 只读状态。设为 `true` 会清理 hover、失焦并关闭 popup。 |
| `status` | `FormFieldStatus` | 是 | 状态色。赋值会重绘。 |
| `helperText` | `string` | 是 | 帮助文案。赋值会重新 layout。 |
| `prefixText` | `string` | 是 | 前缀文本。赋值会重绘。 |
| `suffixText` | `string` | 是 | 后缀文本。赋值会重绘。 |
| `clearable` | `boolean` | 是 | 是否显示清除按钮。赋值会重绘。 |
| `isFocused` | `boolean` | 否 | 当前是否拥有焦点。 |

`placeholder`、`onChange`、`maxVisibleItems` 是公开字段，不是 setter。运行时修改它们时，框架不会自动知道所有视觉变化；如果已经显示在界面上，业务应触发一次重绘或在下一次打开 popup 前修改。

`fieldHeight` 可在构造后修改并触发重新布局。`height`、`minHeight`、`maxHeight`、`margin` 和对齐属性来自统一的 `RenderBox` 布局契约，不再由 ComboBox 维护第二套尺寸状态。

## RenderComboBox 方法

| 方法 | 返回值 | 说明 |
| --- | --- | --- |
| `focusIn()` | `void` | 进入焦点。通常由 `FocusManager` 调用。 |
| `focusOut()` | `void` | 退出焦点。通常由 `FocusManager` 调用。 |
| `dispose()` | `void` | 释放内部 popup、注销焦点、清理 hover 和 focused 状态。 |

`RenderComboBox` 没有公开 `open()` 方法。点击、Enter 或 ArrowDown 可打开候选；可搜索字段输入时也会展开。Space 在纯选择模式下展开候选，可搜索时输入空格。聚焦本身不自动展开；需要自定义打开策略时可直接使用 `DropdownPopup`。

## 鼠标行为

| 操作 | 行为 |
| --- | --- |
| 点击可搜索字段文本区域 | 获得焦点并展开列表；首次聚焦选中已选名称全文，再次点击定位光标，不关闭列表。 |
| 双击文本 / 拖选 | 可搜索时保留选词、选区和横向滚动；横向拖选参与手势竞争，纵向手势让给滚动容器。 |
| 点击可搜索字段箭Alpha | 展开或收起候选；收起时放弃查询并恢复已选名称。 |
| 点击纯选择字段主体 | 获得焦点并展开候选；已展开时关闭。 |
| 点击清除按钮 | 清空 `value`，触发 `onChange('', null)`，字段保持焦点。 |
| 点击候选项 | 提交该项并关闭候选，触发 `onChange(value, option)`；禁用项不可提交。 |
| 再次选择已选候选项 | 不自动清除；清除使用字段清除按钮或纯选择模式的删除键。 |
| hover 长文本候选项 | 如果文本被截断，显示完整 `label` tooltip。 |
| 滚轮 / 拖动列表滚动条 | 滚动候选，保留字段输入焦点。 |
| 点击外部并失焦 | 可搜索字段关闭候选、取消查询并恢复原值，不自动提交Priority亮项。 |

`DropdownPopup` 独立用法支持“再次点击已选项清除”的 `clearable` 行为；标准 `RenderComboBox` 不启用该行为，其清除入口仍在字段上。

## 键盘行为

### 可搜索模式：`searchable: true`

| 按键 / 操作 | 行为 |
| --- | --- |
| 输入 / 粘贴 / Space | 在字段内编辑查询并展开列表，按 `label` 做不区分大小写的包含匹配，保留候选原顺序。 |
| Enter / ArrowDown（列表关闭时） | 打开候选。 |
| ArrowDown / ArrowUp（列表打开时） | 循环移动Priority亮，跳过禁用项，滚动到可见位置；焦点留在字段。 |
| Enter（列表打开时） | 提交有效Priority亮项；过滤后优先Priority亮仍匹配且可用的已选项，否则Priority亮首个可选项。无匹配项时只消费 Enter，不提交或触发表单导航。 |
| Left / Right、Home / End、文本选择和剪贴板快捷键 | 保留普通单行编辑行为，不导航列表。 |
| Backspace / Delete | 只编辑查询词，不清空已提交的 `value`。 |
| Escape | 关闭列表、取消查询、恢复已选名称，不改变 `value`。 |
| Tab / Shift+Tab | 取消查询并关闭列表，然后正常移动焦点，不提交Priority亮项。 |

查询文本与提交值分开保存。输入、删除、粘贴本身不触发 `onChange`；只有选择或显式清除才通知值变化。查询删空时显示全部候选，保留原值；没有匹配项时保留输入并显示“无匹配项”。需要清空值时使用清除按钮。

中文组合输入期间，方向键、Enter 和 Escape 交给输入法，组合结束后才按最终文本过滤。字段与列表共用当前字段的焦点，popup 不创建第二个输入会话。

### 纯选择模式：`searchable: false`（默认）

| 按键 | 行为 |
| --- | --- |
| Enter / Space / ArrowDown（列表关闭时） | 打开候选。 |
| ArrowDown / ArrowUp（列表打开时） | 循环导航，跳过禁用项。 |
| Home / End（列表打开时） | 跳到首个或最后一个可选项。 |
| 字符（列表打开时） | 跳到下一个以该字符开Alpha的候选项。 |
| Enter（列表打开时） | 选择当前键盘行或 hover 行。 |
| Escape | 关闭列表。 |
| Backspace / Delete（列表关闭时） | `clearable` 且有值时清空，触发 `onChange('', null)`。 |
| Tab / Shift+Tab | 关闭列表并移动焦点。 |

纯选择模式不创建文本输入会话；其原有键盘和字段点击行为保持不变。

## 清除行为

`RenderComboBox` 的清除按钮显示条件：

- `clearable === true`
- `value.length > 0`
- 非 `disabled`
- 非 `readonly`

清除后：

- `value` 变成 `''`
- popup 关闭
- 字段获得焦点
- 触发 `onChange('', null)`

```ts
const yesNoDropdown = new RenderComboBox({
  options: [
    { value: 'yes', label: '是' },
    { value: 'no', label: '否' },
  ],
  value: 'yes',
  clearable: true,
  onChange: (value, option) => {
    state.answer = value
    state.answerLabel = option?.label ?? ''
  },
})
```

## 只读和禁用

| 状态 | 可聚焦 | 可打开 popup | 可清除 | 典型用途 |
| --- | --- | --- | --- | --- |
| 正常 | 是 | 是 | 取决于 `clearable` | 普通枚举选择。 |
| `readonly` | 否 | 否 | 否 | 展示已选值，但当前业务状态不允许修改。 |
| `disabled` | 否 | 否 | 否 | 当前字段不可用，且不参与交互。 |

如果字段需要显示真实值但不能修改，优先使用 `readonly`；如果字段在当前业务流程里完全不可操作，使用 `disabled`。

## 搜索模式

开启 `searchable` 后，popup 顶部会显示搜索输入框：

```ts
const catalogDropdown = new RenderComboBox({
  options: [
    { value: 'J00', label: '急性鼻咽炎' },
    { value: 'J18', label: 'CategoryEta，病原体未特指' },
    { value: 'E11', label: '2型CategoryGamma' },
  ],
  searchable: true,
  maxVisibleItems: 8,
  clearable: true,
  onChange: value => {
    state.catalogCode = value
  },
})
```

过滤规则：

- 搜索内容和候选项 `label` 都转为小写后比较。
- 使用 `label.includes(query)`，不是前缀匹配。
- 搜索为空时恢复全部候选项。
- 搜索后重新计算Priority亮并滚动到可见位置：优先保留仍匹配的可用已选项，否则Priority亮首个可选项。

字段中的查询只是过滤条件，不会变成 `value`。自由文本录入使用 TextBox；需要多列候选时使用 LookupEdit，它同样要求选择后才提交。

## Popup 宽度和长文本

`DropdownPopup` 会根据候选项文本测量结果扩展宽度，同时受下面约束：

- 不小于触发字段宽度。
- 不小于 `minPopupWidth`。
- 不超过 `maxPopupWidth`，默认最大宽度为 560。
- 不超出视口左右 8px 边距。

如果候选项仍然放不下，popup 内显示省略号，hover 该项时 tooltip 显示完整 `label`。

```ts
const longTextOptions: DropdownOption[] = [
  {
    value: 'normal-skin',
    label: '皮肤粘膜未见异常，无肝掌，全身浅表淋巴结无肿大。未见皮下出血点，未见皮疹',
  },
]
```

标准 `RenderComboBox` 当前不暴露 `minPopupWidth` 和 `maxPopupWidth` 构造参数。需要控制 popup 宽度时，应使用自定义触发器和 `DropdownPopup`，或使用支持这些参数的业务组件。

## DropdownPopup 独立用法

`DropdownPopup` 适合表格单元格编辑器、Document数据元编辑器、或需要自定义触发区域的场景。它不参与布局，调用方必须提供 anchor 和回调。

```ts
const popup = new DropdownPopup()
const popupAnchor: PopupAnchorTarget = {
  [GET_POPUP_ANCHOR_RECT]: () => ({
    x: 20,
    y: 20,
    width: 180,
    height: 32,
  }),
}
const popupOptions: DropdownOption[] = [
  { value: 'internal', label: '内Team' },
  { value: 'surgery', label: '外Team' },
]

popup.open({
  options: popupOptions,
  selectedValue: state.departmentId,
  anchor: popupAnchor,
  searchable: true,
  maxVisibleItems: 6,
  maxPopupWidth: 420,
  clearable: true,
  onSelect: (value, option) => {
    state.departmentId = value
    state.departmentName = option.label
  },
  onClear: () => {
    state.departmentId = ''
    state.departmentName = ''
  },
  onClose: () => {
    state.departmentPopupOpen = false
  },
})
```

`DropdownPopup.open(options)` 的参数：

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `options` | `DropdownOption[]` | 必填 | 候选项。 |
| `selectedValue` | `string` | 必填 | 当前选中值。 |
| `anchor` | `PopupAnchor` | 必填 | popup 定位锚点。 |
| `searchable` | `boolean` | 必填 | 独立 popup 是否显示搜索框。标准可搜索 ComboBox 传 `false`，由字段管理输入。 |
| `ownerInput` | `boolean` | `false` | 是否由宿主管理文本输入。默认等待方向键激活候选后才允许 Enter，详见正文宿主说明。 |
| `emptyText` | `string` | `undefined` | 可选空结果提示。不传时保持原有布局；标准可搜索 ComboBox 传“无匹配项”。 |
| `maxVisibleItems` | `number` | 必填 | 最大可见行数。 |
| `minPopupWidth` | `number` | `undefined` | popup 最小宽度。 |
| `maxPopupWidth` | `number` | `560` | popup 最大宽度。 |
| `clearable` | `boolean` | `false` | 选中项可否通过再次点击当前项清除。 |
| `onSelect` | `(value: string, option: DropdownOption) => boolean \| void` | 必填 | 选择候选项时触发；返回 false 保持 popup 打开。 |
| `onClear` | `() => boolean \| void` | `undefined` | `clearable` 模式下再次点击当前已选项时触发；返回 false 保持 popup 打开。 |
| `onTab` | `(direction: 1 \| -1) => void` | `undefined` | 可选宿主导航钩子；配置后 Tab 关闭 popup 并通知方向。 |
| `onClose` | `() => void` | 必填 | popup 关闭后触发。 |

`DropdownPopup` 的公开方法：

| 方法 | 返回值 | 说明 |
| --- | --- | --- |
| `open(options)` | `void` | 打开 popup。已打开时会先关闭旧 popup。 |
| `close()` | `void` | 关闭当前 popup。 |
| `updateOptions(options, selectedValue?, activation?)` | `void` | 刷新候选。`activation` 可选 `{ activate?: boolean }`；显式传 `true` 允许宿主直接用 Enter 提交当前Priority亮，否则保留已有正文宿主的显式导航规则。 |
| `debugState()` | `{ filteredOptions; keyboardIndex; scrollOffset; searchText; searchable; clearable }` | 返回调试状态，供测试和Catalog使用。 |
| `dispose()` | `void` | 关闭 popup、释放搜索输入和回调引用。 |

`DropdownPopup` 的 `clearable` 行为和 `RenderComboBox` 不同：popup 的 `clearable` 表示“再次点击当前已选项清除”；字段的 `clearable` 表示“触发字段显示清除按钮”。

## Popup 定位和生命周期

`RenderComboBox` 实现了 `GET_POPUP_ANCHOR_RECT`，popup 会使用字段主体作为定位锚点。字段下方空间不足时，popup 会尝试显示到字段上方；如果视口Priority度不足，则减少可见行数并启用内部滚动。

生命周期规则：

- `RenderComboBox.dispose()` 会释放内部 popup。
- `RenderComboBox.detach()` 会结束字段输入、关闭候选并释放拖选捕获。
- 可搜索字段失焦、自身或祖先隐藏、禁用、只读、销毁时也结束输入并取消查询；按下后隐藏再显示，旧抬起不会触发文本激活。
- 组合输入期间重绑 `options`，或通过 `setValue()` 变更提交值时，会安全结束旧组合输入并隔离其延迟事件。字段仍聚焦且可搜索时重新建立输入会话，选中当前名称；旧事件不会重新展开候选或覆盖输入，也不会触发 `onChange`。
- 可搜索模式选择时先关闭旧候选，再执行业务回调。回调重新打开的候选不会被旧选择流程关闭，回调抛错时亦如此。
- `options` 重新赋值会关闭已打开的 popup，但不会触发 `onChange`。
- `disabled` 或 `readonly` 变为 `true` 会关闭 popup 并从焦点管理中注销。
- `DropdownPopup.dispose()` 会结束搜索输入 session，避免隐藏 textarea 或计时器泄漏。

## 表单组合建议

ComboBox 使用共享的表单壳绘制输入框、清除按钮、前缀、后缀和 helper 文案，适合直接放入表单布局中。

```ts
const requiredStatusDropdown = new RenderComboBox({
  options: [
    { value: 'draft', label: '草稿' },
    { value: 'submitted', label: '已提交' },
  ],
  value: state.status,
  prefixText: '状态',
  clearable: true,
  status: state.status ? 'default' : 'error',
  helperText: state.status ? '' : '请选择状态',
  onChange: value => {
    state.status = value
  },
})
```

布局注意：

- 组件宽度由父布局约束决定；`performLayout` 在无限宽度下默认使用 200。
- `helperText` 会增加组件总Priority度，父容器要按实际Priority度布局。
- 触发字段里的选中长文本会被裁剪；如果裁剪，组件 tooltip 会显示完整选中项 `label`。
- popup 宽度可大于触发字段，长文本优先在 popup 中展示完整内容。

## 和 DataGrid 的关系

`DataGrid` 的 dropdown 单元格编辑器直接复用 `DropdownPopup`，继续管理自己的 anchor、提交和关闭时机，其搜索框仍按独立 popup 的原有配置显示。标准 ComboBox 的字段内搜索不会自动改变表格编辑器或Document正文宿主；列表绘制、禁用项、tooltip 和滚动仍复用同一弹层能力。

## 主题和视觉

ComboBox 的视觉来自主题派生 token：

- `deriveTextInputStyle()`：触发字段背景、边框、placeholder、helper、清除按钮。
- `deriveDropdownStyle()`：popup 行Priority、选项文本、hover/selected 背景、箭Alpha和分割线。
- `derivePopupStyle()`：popup 外壳 padding、边框、阴影。
- `deriveScrollbarStyle()`：popup 内滚动条轨道和滑块。
- `deriveTreeStyle().panelBg`：popup 面板背景。

不要在业务组件里手绘另一套 hover、selected 或滚动条样式。需要全局调整时，应从主题 token 入手，保证 ComboBox、TreeView、DataGrid 的交互状态一致。

## 常见问题

### 为什么设置了 `value` 但显示 placeholder？

`value` 必须能在 `options` 中找到相同 `value` 的候选项。找不到时组件认为当前没有可显示的选中项，会显示 placeholder。

### 为什么重新设置 `options` 后 `value` 没有清空？

这是刻意行为。重新绑定候选项只关闭 popup，不替业务决定当前值是否仍然有效。需要清空时由业务显式设置：

```ts
const resetOptions: DropdownOption[] = [
  { value: 'surgery', label: '外Team' },
]
const resetDropdown = new RenderComboBox({
  options: [{ value: 'internal', label: '内Team' }],
  value: 'internal',
})

resetDropdown.options = resetOptions
if (!resetOptions.some(option => option.value === resetDropdown.value)) {
  resetDropdown.value = ''
}
```

### 为什么搜索文本不会作为值提交？

ComboBox 是枚举选择组件，不是输入组件。搜索文本只用于过滤候选项。需要“输入即值”的交互应使用 TextBox。LookupEdit 允许在字段内输入以过滤网格候选，仍须选择候选后才提交值。

### 为什么标准 `RenderComboBox` 不能配置 `maxPopupWidth`？

标准组件保持简单的表单字段 API，并使用默认 560 的 popup 最大宽度。需要针对Document数据元或表格编辑器控制 popup 宽度时，应使用 `DropdownPopup` 或封装业务组件。

## 相关组件

- [MultiSelectDropdown](./multi-select-dropdown.md)
- [LookupEdit](./lookup-edit.md)
- [DropTreeEdit](./drop-tree-edit.md)
- [DropTreeGridEdit](./drop-tree-grid-edit.md)
- [TextBox](../input/text-box.md)
- [DatePicker](../input/date-picker.md)


## 正文编辑宿主的候选联动

`DropdownPopup.open()` 可选 `ownerInput: true`，适用于正文自身处理输入、弹层仅提供候选的场景。此模式以非模态方式登记；字符、删除、左右、Home／End、Tab及文字剪贴快捷键不由候选弹层消费。上下键明确激活候选后，Enter才选择；Escape关闭，IME组合键始终交还宿主。默认false保持独立popup原有键盘行为。`searchable`应设为false，自由文字由宿主管理。标准可搜索ComboBox会显式调用`updateOptions(options, value, { activate: true })`激活当前可选项；正文宿主不传此参数，其规则保持不变。

已有框架窗口通常直接使用无参构造。独立Canvas宿主可传入 `new DropdownPopup({ context: () => popupContext, repaint: () => requestPaint() })`，提供自己的viewport／主题及重绘调度；宿主负责调用paint和指针／键盘接口、验证来源目标、恢复输入焦点，以及销毁弹层。它不安装或覆盖全局PopupManager的context provider。宿主传给候选组件的坐标必须与该viewport同一坐标系，避免重复应用正文zoom或DPR。

`debugState()`另外提供`layout`、`itemHeight`与`contentY`，供Catalog实际候选几何，不作为候选值或文档数据保存。
