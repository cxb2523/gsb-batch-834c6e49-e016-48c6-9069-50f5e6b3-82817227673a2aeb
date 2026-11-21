# DropTreeEdit 树形下拉

> **通用布局能力**：`RenderDropTreeEdit` 实例统一支持 `width`、`height`、min/max、`margin` 和槽位对齐；下拉树的 popup 尺寸和内部 padding 不属于普通盒模型。详见[组件通用布局属性](../common-layout-properties.md)。

DirectSurface UI 的树形单选下拉公共类名是 `RenderDropTreeEdit`。它用于从树形数据中选择一个节点，常见于Team目录、模板分类、组织结构、项目分类、权限菜单等层级字典。

`DropTreeEdit` 默认 `searchable: true`，直接在字段内输入搜索，下面只显示树形候选，不再显示第二个搜索框。真实输入焦点留在字段，树维护独立的逻辑导航Priority亮；设置 `searchable: false` 保留原来的纯树选择方式。popup 内部复用 `RenderTreeView` 的展开折叠、节点选择和滚动。

## API 总览

主类：

- `RenderDropTreeEdit`

相关 public API：

- `TreeNode`
- `defaultDropTreeEditQueryProcessor`
- `DropTreeEditQueryContext`
- `DropTreeEditQueryProcessor`
- `DropTreeEditQueryTextBuilder`
- `DropTreeEditExpandedKeysResolver`
- `DropTreeEditExpandOnOpenContext`
- `DropTreeEditDebugState`
- `FormFieldStatus`

导入：

```ts
import {
  RenderDropTreeEdit,
  defaultDropTreeEditQueryProcessor,
  type DropTreeEditDebugState,
  type DropTreeEditExpandOnOpenContext,
  type DropTreeEditExpandedKeysResolver,
  type DropTreeEditQueryContext,
  type DropTreeEditQueryProcessor,
  type DropTreeEditQueryTextBuilder,
  type FormFieldStatus,
  type TreeNode,
} from 'directsurface'
```

`RenderDropTreeEdit` 的构造参数是公开 options 对象，但当前没有单独导出的 DropTreeEdit options 类型。业务代码直接按本文参数表传入对象。

## 何时使用

- 候选项天然是树形层级。
- 只能选择一个节点。
- 需要保留父子层级和展开状态。
- 查询时需要展示匹配节点及其祖先路径。
- 父节点是否可选需要由业务通过 `selectable` 明确控制。

不适合：

- 扁平单选枚举，使用 [ComboBox](./combo-box.md)。
- 树形多选或父子勾选联动，使用 [DropCheckTreeEdit](./drop-check-tree-edit.md)。
- 树节点需要多列字段，使用 [DropTreeGridEdit](./drop-tree-grid-edit.md)。
- 扁平多列候选，使用 [LookupEdit](./lookup-edit.md)。

## 最小示例

```ts
import { RenderDropTreeEdit, type TreeNode } from 'directsurface'

const departmentRoots: TreeNode<{ py?: string }>[] = [
  {
    key: 'dept-internal',
    label: 'Team group A',
    selectable: false,
    children: [
      { key: 'dept-cardiology', label: 'TeamAlpha', data: { py: 'xnk' } },
      { key: 'dept-respiratory', label: 'TeamDevice', data: { py: 'hxk' } },
    ],
  },
]

const departmentTreeState = {
  departmentId: '',
  departmentName: '',
}

const departmentTree = new RenderDropTreeEdit({
  roots: departmentRoots,
  placeholder: '选择Team',
  searchable: true,
  clearable: true,
  queryTextBuilder: node => [node.key, node.label, node.data?.py ?? ''],
  onChange: (value, node) => {
    departmentTreeState.departmentId = value
    departmentTreeState.departmentName = node?.label ?? ''
  },
})
```

## 组件关系

| 组件 / 类型 | 用途 | 说明 |
| --- | --- | --- |
| `RenderDropTreeEdit<T>` | 标准树形单选下拉字段。 | 参与布局、焦点、hover、只读禁用、清除和表单状态。 |
| `TreeNode<T>` | 树节点数据。 | 来自 [TreeView](../data/tree-view.md)，通过 `key`、`label`、`children`、`selectable` 表达层级。 |
| `DropTreeEditQueryProcessor<T>` | 自定义搜索过滤函数。 | 接收 query、roots、selectedValue，返回过滤后的根节点。 |
| `DropTreeEditQueryTextBuilder<T>` | 搜索文本构造函数。 | 决定默认搜索时每个节点参与匹配的字符串。 |
| `DropTreeEditExpandedKeysResolver<T>` | 打开时展开 keys 解析函数。 | 根据 roots 和 selectedValue 动态决定初始展开节点。 |
| `defaultDropTreeEditQueryProcessor()` | 默认搜索过滤器。 | 按 `key`、`label` 或业务提供的 query text 做包含匹配。 |

内部 popup 类不作为正式 public API 使用。业务代码应优先使用 `RenderDropTreeEdit` 和导出的查询/展开类型。

## TreeNode 数据

`DropTreeEdit` 使用 `TreeNode<T>`：

```ts
const templateRoots: TreeNode<{ categoryCode: string }>[] = [
  {
    key: 'template-root',
    label: 'Document模板',
    selectable: false,
    data: { categoryCode: 'ROOT' },
    children: [
      {
        key: 'template-admission',
        label: '入院记录',
        data: { categoryCode: 'ADM' },
      },
    ],
  },
]
```

常用字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `key` | `string` | 节点唯一 key，也是提交值。必须稳定。 |
| `label` | `string` | 显示文本。 |
| `children` | `TreeNode<T>[]` | 子节点。 |
| `selectable` | `boolean` | 设为 `false` 时该节点不能被提交。常用于分类父节点。 |
| `data` | `T` | 业务数据。可用于拼音码、编码、权限类型等。 |

`onChange` 提交的 `value` 就是选中节点的 `key`。

## 表单绑定

`RenderDropTreeEdit<T>` 实现 `ValueEditor<string, ..., TreeNode<T> | null>`，可以直接传给 `FormBindingBag.bindField()`。选择事件的 `detail` 是当前节点，清除时为 `null`；`setValue()` 是静默的模型写入，不触发 `onChange` 或值事件。

字段和自有 popup 属于同一次逻辑焦点会话。可搜索模式中，树导航、展开和滚动不取得真实焦点，也不发布 blur；只有离开字段、显式 `blur()`、隐藏、禁用或只读时退出输入会话。纯选择模式保持树获取焦点的原有行为。

## RenderDropTreeEdit 构造参数

`new RenderDropTreeEdit<T>(options)` 的 `options`：

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `roots` | `TreeNode<T>[]` | 必填 | 根节点数组。 |
| `value` | `string` | `''` | 当前选中节点 key。 |
| `placeholder` | `string` | `'请选择...'` | 未选中时显示的提示文本。 |
| `onChange` | `(value: string, node: TreeNode<T> \| null) => void` | `undefined` | 选中或清除时触发。清除时 `node` 为 `null`。 |
| `searchable` | `boolean` | `true` | 是否在字段内编辑查询文本；默认开启。`false` 时不创建字段输入会话，使用原有纯树选择方式。 |
| `maxVisibleItems` | `number` | `8` | popup 树最多按多少个可见节点计算自然Priority度。 |
| `readonly` | `boolean` | `false` | 只读。不可聚焦、不可打开、不可清除，显示锁图标。 |
| `disabled` | `boolean` | `false` | 禁用。不可聚焦、不可打开、不可清除。 |
| `status` | `FormFieldStatus` | `'default'` | 表单状态。可选 `'default'`、`'success'`、`'warning'`、`'error'`。 |
| `helperText` | `string` | `''` | 字段下方帮助或错误文案。会增加组件Priority度。 |
| `prefixText` | `string` | `''` | 输入区域左侧固定文本。 |
| `suffixText` | `string` | `''` | 输入区域右侧固定文本。 |
| `clearable` | `boolean` | `false` | 有值、非禁用、非只读时显示清除按钮；可搜索模式的删除键只编辑查询词，纯选择模式仍支持键盘清除。 |
| `expandAllOnOpen` | `boolean` | `false` | 打开 popup 时是否展开所有可展开节点。 |
| `expandedKeysOnOpen` | `readonly string[] \| DropTreeEditExpandedKeysResolver<T>` | `undefined` | 打开 popup 时默认展开的节点 key。会自动合并当前选中节点的祖先 key。 |
| `queryTextBuilder` | `DropTreeEditQueryTextBuilder<T>` | `node => [node.key, node.label]` | 默认查询时每个节点参与匹配的文本。 |
| `queryProcessor` | `DropTreeEditQueryProcessor<T>` | `defaultDropTreeEditQueryProcessor(queryTextBuilder)` | 自定义查询函数。 |

```ts
const categoryRoots: TreeNode[] = [
  {
    key: 'template-root',
    label: 'Document模板',
    selectable: false,
    children: [{ key: 'template-admission', label: '入院记录' }],
  },
]
const categoryTree = new RenderDropTreeEdit({
  roots: categoryRoots,
  value: '',
  placeholder: '选择模板分类',
  searchable: true,
  maxVisibleItems: 10,
  clearable: true,
  expandedKeysOnOpen: ['template-root'],
  prefixText: '分类',
  onChange: (value, node) => {
    state.templateCategoryKey = value
    state.templateCategoryName = node?.label ?? ''
  },
})
```

## RenderDropTreeEdit 属性

| 属性 | 类型 | 可写 | 说明 |
| --- | --- | --- | --- |
| `roots` | `TreeNode<T>[]` | 是 | 当前根节点。popup 打开时重新赋值会刷新 popup 树。 |
| `value` | `string` | 是 | 当前选中节点 key。赋值会转成字符串并重绘；popup 打开时会同步 selectedKey。 |
| `placeholder` | `string` | 是 | 提示文本。公开字段。 |
| `onChange` | `(value: string, node: TreeNode<T> \| null) => void \| undefined` | 是 | 值变化回调。 |
| `searchable` | `boolean` | 是 | 是否允许字段内搜索。修改时关闭候选、取消查询并结束旧输入；仍聚焦时重新启用搜索会建立新会话。 |
| `maxVisibleItems` | `number` | 是 | popup 最大可见节点数。公开字段；修改后下一次打开 popup 生效。 |
| `readonly` | `boolean` | 是 | 只读状态。设为 `true` 会关闭 popup、清理 query、失焦并注销焦点。 |
| `disabled` | `boolean` | 是 | 禁用状态。设为 `true` 会关闭 popup、清理 query、失焦并注销焦点。 |
| `status` | `FormFieldStatus` | 是 | 状态色。赋值会重绘。 |
| `helperText` | `string` | 是 | 帮助文案。赋值会重新 layout。 |
| `prefixText` | `string` | 是 | 前缀文本。赋值会重绘。 |
| `suffixText` | `string` | 是 | 后缀文本。赋值会重绘。 |
| `clearable` | `boolean` | 是 | 是否显示清除按钮。赋值会重绘。 |
| `expandAllOnOpen` | `boolean` | 是 | 打开时是否展开所有可展开节点。公开字段。 |
| `expandedKeysOnOpen` | `readonly string[] \| DropTreeEditExpandedKeysResolver<T> \| undefined` | 是 | 打开时展开 key。公开字段。 |
| `queryTextBuilder` | `DropTreeEditQueryTextBuilder<T> \| undefined` | 是 | 默认查询文本构造器。公开字段。 |
| `queryProcessor` | `DropTreeEditQueryProcessor<T> \| undefined` | 是 | 自定义查询函数。公开字段。 |
| `isFocused` | `boolean` | 否 | 触发器或自有树 popup 处于编辑焦点时为 `true`。 |

公开字段不是 setter 时，修改视觉文案可触发重绘；修改节点内容或查询配置需调用 `refreshTree()`，单纯重绘不会重算过滤快照。打开策略配置在下一次打开时生效。

## RenderDropTreeEdit 方法

| 方法 | 返回值 | 说明 |
| --- | --- | --- |
| `focusIn()` | `void` | 进入焦点。通常由 `FocusManager` 调用。 |
| `focusOut()` | `void` | 退出焦点。通常由 `FocusManager` 调用。 |
| `requestFocus()` / `blur()` | `void` | 进入或离开整个逻辑编辑焦点；`blur()` 同时关闭自有 popup。 |
| `getValue()` / `setValue(value)` | `string` / `void` | 读取或静默写入正式值。 |
| `refreshTree()` | `void` | 显式刷新过滤快照和已选名称；原地修改 roots、节点或查询配置后调用。打开时保留当前 query，关闭时不执行业务查询。 |
| `debugState()` | `DropTreeEditDebugState` | 返回当前 popup、query、显示文本、过滤节点数和展开 keys。 |
| `dispose()` | `void` | 关闭并释放 popup、注销焦点、清理 query 和 hover。 |

`RenderDropTreeEdit` 没有公开 `open()` 方法。聚焦本身不展开。可搜索模式下点击字段、输入或 Enter 可展开；ArrowDown/ArrowUp 展开后进入候选导航。Space 输入空格，仅在纯选择模式下用于展开。

## DropTreeEditDebugState

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
| `value` | `string` | 当前选中 key。 |
| `filteredCount` | `number` | popup 打开时为过滤树节点总数；关闭时为全部节点总数。 |
| `expandedKeys` | `string[]` | popup 当前展开 keys。 |

```ts
const debugTree = new RenderDropTreeEdit({
  roots: [
    {
      key: 'root',
      label: '根节点',
      children: [{ key: 'leaf', label: '叶子节点' }],
    },
  ],
})
const treeState = debugTree.debugState()
if (treeState.popupVisible) {
  notificationManager.show(`展开节点数: ${treeState.expandedKeys.length}`)
}
```

## 查询行为

### 默认查询

默认查询由 `defaultDropTreeEditQueryProcessor(queryTextBuilder)` 创建：

- query 会 trim 后转小写。
- query 为空时返回原始 roots 的浅拷贝。
- 每个节点通过 `queryTextBuilder(node)` 生成多个待匹配文本。
- 任一文本包含 query 即认为该节点匹配。
- 子节点匹配时，会保留祖先节点，并只保留匹配路径下的 children。
- 查询状态下 popup 会展开过滤结果的所有分支，方便看到匹配路径。目录自身命中不会自动带出全部未命中的后代。
- 过滤快照在查询、roots 或显式刷新时更新；布局、绘制、光标闪烁和调试读取不会重新调用 `queryProcessor`。

```ts
const searchableDepartmentRoots: TreeNode<{ py?: string }>[] = [
  {
    key: 'dept-internal',
    label: 'Team group A',
    children: [{ key: 'dept-respiratory', label: 'TeamDevice', data: { py: 'hxk' } }],
  },
]
const queryProcessor = defaultDropTreeEditQueryProcessor<{ py?: string }>(
  node => [node.key, node.label, node.data?.py ?? ''],
)
const filteredRoots = queryProcessor({
  query: 'hxk',
  roots: searchableDepartmentRoots,
  selectedValue: '',
})

state.filteredDepartmentCount = filteredRoots.length
```

### 自定义查询

`queryProcessor` 接收 `DropTreeEditQueryContext<T>`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `query` | `string` | 当前查询文本。 |
| `roots` | `readonly TreeNode<T>[]` | 原始根节点。 |
| `selectedValue` | `string` | 当前已选 key。 |

返回 `TreeNode<T>[]`，即过滤后的根节点。

```ts
const customDepartmentRoots: TreeNode<{ py: string }>[] = [
  {
    key: 'dept-internal',
    label: 'Team group A',
    data: { py: 'nkxt' },
    children: [{ key: 'dept-respiratory', label: 'TeamDevice', data: { py: 'hxk' } }],
  },
]
const customTree = new RenderDropTreeEdit<{ py: string }>({
  roots: customDepartmentRoots,
  queryProcessor: context => {
    const query = context.query.trim().toLowerCase()
    if (!query) return [...context.roots]
    return context.roots
      .map(root => ({
        ...root,
        children: root.children?.filter(child =>
          child.label.includes(context.query) ||
          child.data?.py.includes(query),
        ),
      }))
      .filter(root => root.label.includes(context.query) || (root.children?.length ?? 0) > 0)
  },
  onChange: value => {
    state.departmentKey = value
  },
})
```

`queryProcessor` 是同步函数。远程查询由业务层更新 `roots`，组件保留当前查询并刷新候选；过期响应仍需业务用请求编号或取消机制控制。查询回调期间关闭、禁用、销毁、程序设值或切换搜索模式使本轮结果失效时，组件不发布旧结果，也不继续旧打开流程。即使在同一回调里关闭再重新启用搜索，旧查询仍失效。roots 重绑仍保留当前查询，并通过刷新代次防止旧结果覆盖新结果。刷新异常会清空旧候选导航目标并继续保留提交值。

## 展开策略

打开 popup 时的展开 keys 按下面顺序处理：

1. 如果 `expandAllOnOpen === true`，展开所有有 children 的节点。
2. 否则如果 `expandedKeysOnOpen` 是函数，调用它取得展开 keys。
3. 否则如果 `expandedKeysOnOpen` 是数组，使用该数组。
4. 没有显式配置时恢复普通浏览的记忆展开状态。
5. 合并已选节点祖先路径，忽略不存在或不可展开的 key。

```ts
const resolverRoots: TreeNode[] = [
  {
    key: 'template-root',
    label: 'Document模板',
    children: [{ key: 'template-admission', label: '入院记录' }],
  },
]
const resolverTree = new RenderDropTreeEdit({
  roots: resolverRoots,
  value: 'template-admission',
  expandedKeysOnOpen: context => {
    return context.selectedValue ? ['template-root'] : []
  },
})
```

普通浏览的展开操作会被记录；没有显式展开配置时，下次打开恢复记忆状态。显式配置在每次打开时优先于记忆。规范化 query 非空时，展开和折叠属于本轮临时搜索视图，不写回普通状态；查询或 roots 更新后重新展开过滤路径。清空查询（纯空格也按空查询处理）恢复普通状态，并合并已选节点祖先。

## 鼠标行为

| 操作 | 行为 |
| --- | --- |
| 点击可搜索字段文本区域 | 获得输入焦点并展开候选；首次聚焦全选已选名称，再次点击定位光标、返回文本编辑态。 |
| 双击文本 / 横向拖选 | 保留选词和选区；横向拖选参与手势竞争，纵向手势让给滚动容器。 |
| 点击字段箭Alpha | 展开或收起候选；收起时取消查询并恢复已选名称。 |
| 点击纯选择字段主体 | 按原方式展开或收起树 popup。 |
| 点击可选节点 | 提交节点 key，关闭旧候选后执行回调。 |
| 点击不可选分类或展开图标 | 只展开或折叠，不提交；可搜索模式下输入焦点留在字段。 |
| 滚轮 / 拖动树滚动条 | 滚动候选，不切换字段输入会话。 |
| 点击清除按钮 | 清空提交值、取消查询并保持字段焦点。 |
| 外部失焦 | 取消查询、关闭自有候选，恢复已选名称，不自动提交Priority亮节点。 |

## 键盘行为

### 可搜索模式（默认）

真实输入焦点始终在字段。文本编辑态与树候选导航态通过是否存在逻辑导航 key 区分；导航Priority亮不是已提交值。已有选中节点可能保持选中色，但搜索本身不创建 Enter 提交目标。

| 按键 / 操作 | 行为 |
| --- | --- |
| 输入 / 粘贴 | 更新 query 并展开结果，回到文本态，清除旧导航目标。 |
| Enter（候选关闭时） | 打开候选，不直接提交。 |
| Enter（文本态、空结果或无导航目标） | 只消费按键，不提交祖先或触发表单导航。 |
| 首次 ArrowDown / ArrowUp | 进入候选导航，优先定位仍可见的已选节点，否则定位首个/最后一个可见节点。 |
| 后续 ArrowDown / ArrowUp | 在可见节点之间移动，到边界停止；分类节点可导航但不可提交。 |
| 导航态 ArrowRight / ArrowLeft | 展开、折叠或移到父子节点，沿用 TreeView 的方向键规则。 |
| 文本态 ArrowLeft / ArrowRight | 正常移动文本光标。 |
| Enter（可选导航节点） | 提交该节点并关闭候选。 |
| Enter（不可选分类） | 仅展开尚未展开的分类；无可展开 children 时不操作。 |
| Space / 删除 / Home / End / 带修饰键的文本操作 | 返回文本编辑态并交给单行输入；Space 不选择树节点，删除查询词不清空正式值。 |
| Escape | 取消查询、关闭候选并恢复已选名称。 |
| Tab / Shift+Tab | 取消查询、关闭候选并正常移焦，不提交导航目标。 |

中文组合输入期间，方向键、Enter 和 Escape 留给输入法，组合结束后再过滤。关闭候选、显式 `setValue()` 变更值等取消路径会安全结束旧组合输入并隔离旧节点的延迟事件。

### 纯选择模式：`searchable: false`

保留原有字段 Enter、Space、ArrowDown 打开候选的行为。内部树取得真实焦点后按原来的方向键、Space 和 Enter 操作；Escape 关闭，Tab 关闭并移焦。禁用和只读仍不可打开或清除。

键盘监听继续沿字段所属窗口及焦点作用域分发：`preventDefault()` 取消默认导航或选择，`stopPropagation()` 本身不取消默认行为。

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
const clearableDepartmentRoots: TreeNode[] = [
  {
    key: 'dept-internal',
    label: 'Team group A',
    children: [{ key: 'dept-cardiology', label: 'TeamAlpha' }],
  },
]
const clearableTree = new RenderDropTreeEdit({
  roots: clearableDepartmentRoots,
  value: 'dept-cardiology',
  clearable: true,
  onChange: (value, node) => {
    state.departmentId = value
    state.departmentName = node?.label ?? ''
  },
})
```

## 只读和禁用

| 状态 | 可聚焦 | 可打开 popup | 可清除 | 视觉 |
| --- | --- | --- | --- | --- |
| 正常 | 是 | 是 | 取决于 `clearable` | 箭Alpha图标。 |
| `readonly` | 否 | 否 | 否 | 只读底色和锁图标。 |
| `disabled` | 否 | 否 | 否 | 禁用文本和禁用边框。 |

`readonly` 适合展示已选节点但当前流程不允许修改；`disabled` 适合字段完全不可交互的状态。

## roots / value 动态更新

- `roots` 重新赋值时，如果 popup 打开，会调用内部刷新并保留当前 query。
- `roots` 变化不会自动清空 `value`，也不会触发 `onChange`。
- 未编辑查询时同步已选名称与原生输入，保留并约束选区；组合输入中保留预编辑基底，继续按最后确认的 query 刷新。
- 活动导航节点按稳定 key 恢复；节点消失或不再可见时清除提交目标，不使用旧行号导航到其他节点。普通展开记录按新 roots 裁剪。
- 原地修改数组、节点或 `queryTextBuilder` / `queryProcessor` 后，可调用 `refreshTree()` 显式刷新。
- `value` 重新赋值时，如果 popup 打开，会同步 popup 的 selectedValue 和树选中态。
- 如果新 roots 不包含当前 value，触发字段会显示 placeholder。

```ts
const dynamicTree = new RenderDropTreeEdit({
  roots: [
    { key: 'old', label: '旧节点' },
  ],
  value: 'old',
})

dynamicTree.roots = [
  { key: 'new', label: '新节点' },
]
if (!dynamicTree.debugState().displayText) {
  dynamicTree.value = ''
}
```

## Popup 布局

popup 宽Priority规则：

- 宽度不小于 260，也不小于触发字段宽度。
- 宽度不会超出视口左右 8px 内边距。
- 可搜索字段的 popup 不含搜索框；Priority度按树可见节点数和主题 padding 计算。独立旧 popup 调用方继续使用原有搜索框配置。
- `maxVisibleItems` 参与自然Priority度计算。
- 下方空间不足时，当前实现会把 popup 限制在视口内，而不是强制翻到上方。

大树滚动和可见行处理由内部 `RenderTreeView` 承担。树数据非常大时，应配合业务查询或懒加载，避免一次性把全量深树放进 popup。

## 生命周期

- `RenderDropTreeEdit.dispose()` 会关闭并释放 popup、注销焦点、清理 query 和 hover。
- `readonly` / `disabled` 变为 `true` 会关闭 popup、清理 query、失焦并从焦点顺序中移除。
- 可搜索模式关闭候选时销毁内部树、清除导航目标；字段仍聚焦时保留输入能力并恢复已选名称。纯选择或独立 popup 的搜索 session 按原方式结束。
- 自身或祖先隐藏、失焦、detach、销毁会结束字段输入并释放捕获；隐藏再显示不能恢复旧按下、触发旧点击或消耗 `once`。
- 选择先关闭旧候选，再调用业务回调；回调新开的候选不被旧流程关闭，抛错也不会遗留旧候选。
- DataGrid 的 DropTreePopup 调用不启用字段宿主模式，继续保持原有搜索和树焦点规则。
- `debugState()`、布局和绘制只读过滤快照，不执行 `queryProcessor`。

## 表单组合建议

```ts
const requiredDepartmentRoots: TreeNode<{ py?: string }>[] = [
  {
    key: 'dept-internal',
    label: 'Team group A',
    children: [{ key: 'dept-cardiology', label: 'TeamAlpha', data: { py: 'xnk' } }],
  },
]
const requiredDepartmentTree = new RenderDropTreeEdit({
  roots: requiredDepartmentRoots,
  value: state.departmentId,
  placeholder: '选择Team',
  prefixText: 'Team',
  clearable: true,
  status: state.departmentId ? 'default' : 'error',
  helperText: state.departmentId ? '' : '请选择Team',
  expandedKeysOnOpen: ['dept-internal'],
  queryTextBuilder: node => [node.key, node.label, node.data?.py ?? ''],
  onChange: value => {
    state.departmentId = value
  },
})
```

布局注意：

- 组件宽度由父布局约束决定；无限宽度下默认使用 220。
- `helperText` 会增加组件总Priority度。
- 已选 label 只在单行内裁剪，不会自动换行。
- 分类父节点建议设置 `selectable: false`，避免用户误选分类容器。

## 常见问题

### 为什么点击父节点没有提交？

检查节点是否设置了 `selectable: false`。这种节点只作为分类容器，不会触发 `onChange`。

### 为什么搜索后树会全部展开？

搜索状态下组件会展开过滤后的所有可展开节点，目的是让匹配节点立即可见。搜索时的展开状态不会保存为正常展开状态。

### 为什么设置了 `value` 但显示 placeholder？

`value` 必须能在 `roots` 中找到相同 key 的节点。找不到时组件没有可显示 label，会显示 placeholder。

### 远程树查询怎么做？

当前 `queryProcessor` 是同步函数。推荐业务层维护缓存 roots：用户输入 query 时先返回当前缓存，请求完成后更新 `field.roots`。如果 popup 仍打开，组件会刷新过滤树。

## 相关组件

- [TreeView](../data/tree-view.md)
- [ComboBox](./combo-box.md)
- [DropCheckTreeEdit](./drop-check-tree-edit.md)
- [DropTreeGridEdit](./drop-tree-grid-edit.md)
- [LookupEdit](./lookup-edit.md)
