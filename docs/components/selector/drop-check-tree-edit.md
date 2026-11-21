# DropCheckTreeEdit 树形多选下拉

> **通用布局能力**：`RenderDropCheckTreeEdit` 实例统一支持 `width`、`height`、min/max、`margin` 和槽位对齐；下拉 popup 的面板尺寸使用选择器浮层配置。详见[组件通用布局属性](../common-layout-properties.md)。

`RenderDropCheckTreeEdit` 是“触发输入框 + popup check tree”的组合控件。它用于从树形数据中选择多个叶子节点，例如多Team范围、多目录授权、多分类过滤。

控件内部复用 [TreeView](../data/tree-view.md) 的 `selectionMode: 'check'` 行为。字段负责展示摘要、字段内搜索、已选计数和清除按钮；popup 只展示候选树，负责展开折叠、checkbox 勾选和滚动。`searchable: false` 保留纯选择模式。

## API 总览

主类：

- `RenderDropCheckTreeEdit`

相关 public API：

- `TreeNode`
- `defaultDropCheckTreeEditQueryProcessor`
- `DropCheckTreeEditQueryContext`
- `DropCheckTreeEditQueryProcessor`
- `DropCheckTreeEditQueryTextBuilder`
- `DropCheckTreeEditExpandedKeysResolver`
- `DropCheckTreeEditExpandOnOpenContext`
- `DropCheckTreeEditSummaryBuilder`
- `DropCheckTreeEditSummaryContext`
- `DropCheckTreeEditDebugState`
- `FormFieldStatus`

导入：

```ts
import {
  RenderDropCheckTreeEdit,
  defaultDropCheckTreeEditQueryProcessor,
  type DropCheckTreeEditDebugState,
  type DropCheckTreeEditExpandOnOpenContext,
  type DropCheckTreeEditExpandedKeysResolver,
  type DropCheckTreeEditQueryContext,
  type DropCheckTreeEditQueryProcessor,
  type DropCheckTreeEditQueryTextBuilder,
  type DropCheckTreeEditSummaryBuilder,
  type DropCheckTreeEditSummaryContext,
  type FormFieldStatus,
  type TreeNode,
} from 'directsurface'
```

`RenderDropCheckTreeEdit` 的构造参数是公开 options 对象，但当前没有单独导出的 DropCheckTreeEdit options 类型。业务代码直接按本文参数表传入对象。

## 何时使用

使用 DropCheckTreeEdit：

- 需要在树形目录中多选。
- 选项有父子层级，父节点用于分组。
- 需要搜索树节点。
- 表单字段中只需要显示一个简短摘要。

不要使用：

- 单选树，使用 [DropTreeEdit](./drop-tree-edit.md)。
- 平铺多选列表，使用 [MultiSelectDropdown](./multi-select-dropdown.md)。
- 需要多列表格列展示和筛选，使用 [DropTreeGridEdit](./drop-tree-grid-edit.md)。
- 需要长期展示大树，直接使用 [TreeView](../data/tree-view.md)。

## 最小示例

```ts
import { RenderDropCheckTreeEdit, type TreeNode } from 'directsurface'

const departmentCheckRoots: TreeNode[] = [
  {
    key: 'internal',
    label: 'Team group A',
    children: [
      { key: 'cardiology', label: 'TeamAlpha' },
      { key: 'respiratory', label: 'TeamDevice' },
    ],
  },
]

const checkTreeState = {
  keys: [] as string[],
  labels: [] as string[],
}

const field = new RenderDropCheckTreeEdit({
  roots: departmentCheckRoots,
  checkedKeys: checkTreeState.keys,
  placeholder: '选择适用Team范围',
  clearable: true,
  onChange: (checkedKeys, nodes) => {
    checkTreeState.keys = checkedKeys
    checkTreeState.labels = nodes.map(node => node.label)
  },
})
```

`checkedKeys` 表示已勾选的叶子 key。`onChange` 返回当前 leaf checked keys 和对应节点。

## TreeNode 数据结构

DropCheckTreeEdit 使用 TreeView 的 `TreeNode<T>`：

```ts
interface TreeNode<T = any> {
  key: string
  label: string
  labelTokens?: readonly TreeLabelToken[]
  tooltip?: string
  icon?: string
  selectable?: boolean
  checkable?: boolean
  data?: T
  children?: TreeNode<T>[]
}
```

常用字段：

| 字段 | 说明 |
| --- | --- |
| `key` | 节点唯一标识。必须稳定。 |
| `label` | 展示文本，也是默认搜索文本之一。 |
| `children` | 子节点。存在子节点时该节点可展开。 |
| `checkable` | 是否显示/响应 checkbox。`false` 时节点本身不可勾选，但子节点仍可勾选。 |
| `selectable` | TreeView 单选语义字段；check 模式下主要由 checkbox 控制。 |
| `data` | 业务数据，可用于搜索、摘要和回调。 |
| `tooltip` | TreeView 节点自身 tooltip。 |
| `labelTokens` | TreeView 支持的分段着色文本。 |

## 表单绑定

`RenderDropCheckTreeEdit<T>` 实现 `ValueEditor<string[], ..., TreeNode<T>[]>`，可以直接绑定 key 数组字段。值事件的 `detail` 是当前勾选节点数组；`getValue()`、`setValue()` 和事件载荷都使用数组副本，页面不能通过修改回调参数绕过控件更新。

可搜索模式的真实输入焦点始终留在字段，候选树使用 owner 导航。字段和勾选树共同组成一次逻辑焦点会话，点击 checkbox、展开和滚动不会提前发布 blur；离开字段、显式调用 `blur()`、隐藏自身或祖先、切换 disabled/readonly 时结束会话。纯选择模式仍由 popup 内的 TreeView 接收键盘焦点。数组字段需要“恢复为相同集合即不再 dirty”时，应按业务顺序或集合语义为 `FormSession` 配置相等函数。

## 构造参数

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `roots` | `TreeNode<T>[]` | 必填 | 树根节点。 |
| `checkedKeys` | `readonly string[]` | `[]` | 初始勾选 key。会去重并过滤空值。 |
| `placeholder` | `string` | `'请选择...'` | 未选择时的提示文本。 |
| `onChange` | `(checkedKeys, nodes) => void` | `undefined` | 勾选变化和清除时触发。 |
| `searchable` | `boolean` | `true` | 是否直接在字段内搜索；popup 不再显示单独搜索框。 |
| `maxVisibleItems` | `number` | `8` | popup 中最多按多少个可见树节点计算Priority度。 |
| `readonly` | `boolean` | `false` | 只读。不能聚焦、不能打开 popup、不能清除。 |
| `disabled` | `boolean` | `false` | 禁用。不能交互。 |
| `status` | `FormFieldStatus` | `'default'` | 表单字段状态。 |
| `helperText` | `string` | `''` | 字段下方辅助/错误文本。影响整体Priority度。 |
| `prefixText` | `string` | `''` | 触发框前缀文本。 |
| `suffixText` | `string` | `''` | 触发框后缀文本。 |
| `clearable` | `boolean` | `false` | 有值且非只读/禁用时显示清除按钮。 |
| `expandAllOnOpen` | `boolean` | `false` | 打开时展开所有可展开节点。 |
| `expandedKeysOnOpen` | `readonly string[] \| resolver` | `undefined` | 打开时使用的展开 key。会自动合并已选节点祖先。 |
| `queryTextBuilder` | `(node) => string[]` | `key + label` | 默认查询处理器使用的节点文本构造器。 |
| `queryProcessor` | `(context) => TreeNode<T>[]` | 默认处理器 | 自定义查询过滤逻辑。 |
| `summaryBuilder` | `(context) => string` | 默认摘要 | 自定义触发框摘要。 |
| `maxSummaryItems` | `number` | `2` | 默认摘要最多展示多少个标签，至少为 1。 |

## 属性和方法

| API | 类型 | 说明 |
| --- | --- | --- |
| `roots` | `TreeNode<T>[]` | 当前根节点。赋值后若 popup 打开会刷新 popup roots。 |
| `checkedKeys` | `string[]` | 当前勾选 key 副本。赋值会同步 popup 并重绘。 |
| `placeholder` | `string` | placeholder 文本。 |
| `onChange` | `(checkedKeys, nodes) => void` | 变化回调。 |
| `searchable` | `boolean` | 是否在字段内搜索；切换时关闭 popup、取消查询和输入法草稿，更新输入会话。 |
| `maxVisibleItems` | `number` | popup 可见行数上限。 |
| `readonly` | `boolean` | 只读状态。设为 `true` 会关闭 popup、清理查询展示并取消焦点。 |
| `disabled` | `boolean` | 禁用状态。设为 `true` 会关闭 popup、清理查询展示并取消焦点。 |
| `status` | `FormFieldStatus` | 字段状态。 |
| `helperText` | `string` | 辅助文本。修改会请求布局。 |
| `prefixText`、`suffixText` | `string` | 触发框前后缀。 |
| `clearable` | `boolean` | 是否显示清除按钮。 |
| `expandAllOnOpen` | `boolean` | 打开时是否展开全部。 |
| `expandedKeysOnOpen` | `readonly string[] \| resolver \| undefined` | 打开时展开策略。 |
| `queryTextBuilder` | `DropCheckTreeEditQueryTextBuilder<T>` | 默认搜索文本构造器。 |
| `queryProcessor` | `DropCheckTreeEditQueryProcessor<T>` | 自定义搜索处理器。 |
| `summaryBuilder` | `DropCheckTreeEditSummaryBuilder<T>` | 自定义摘要。 |
| `maxSummaryItems` | `number` | 默认摘要数量上限。 |
| `isFocused` | `boolean` | 触发器或自有勾选树 popup 处于编辑焦点时为 `true`。 |
| `requestFocus()` / `blur()` | `() => void` | 进入或离开整个逻辑编辑焦点；`blur()` 同时关闭自有 popup。 |
| `refreshTree()` | `() => void` | 原地修改节点、搜索或摘要配置后刷新候选和显示；保留 query、组合输入及仍可见的导航 key。 |
| `getValue()` / `setValue(value)` | `() => string[]` / `(value: string[]) => void` | 读取副本或静默写入正式值。 |
| `debugState()` | `DropCheckTreeEditDebugState` | 返回 popup、查询、展示、勾选、展开等调试状态。 |
| `dispose()` | `void` | 关闭并释放 popup，注销焦点。 |

`checkedKeys` getter 返回副本，不能通过 `field.checkedKeys.push(...)` 修改内部状态；应整体赋值。

## 勾选规则

勾选逻辑由 TreeView check 模式提供：

- `checkedKeys` 存储的是已勾选叶子节点 key。
- 点击叶子 checkbox 会勾选/取消该叶子。
- 点击父节点 checkbox 会切换其下所有可勾选目标叶子。
- 父节点根据当前候选范围的子节点状态自动显示全选或半选；未搜索时使用完整树范围。
- `checkable: false` 的节点本身不作为勾选目标，但其可勾选子孙仍参与父子联动。
- 勾选父节点不会自动展开折叠节点，也不会改变 popup Priority度。

如果父节点只是分组，建议显式设置：

```ts
const roots: TreeNode[] = [
  {
    key: 'support-group',
    label: 'Team group C',
    checkable: false,
    children: [
      { key: 'lab', label: 'TeamInspection' },
      { key: 'imaging', label: '影像Team' },
    ],
  },
]
```

这样用户只能勾选子节点，父节点只承载展开和分组语义。

## 点击区域

| 区域 | 行为 |
| --- | --- |
| 字段文本 | 可搜索模式进入搜索并打开 popup；再次点击定位光标，支持拖选和双击选词，不关闭 popup。纯选择模式保留开关行为。 |
| 已选计数 | 搜索时在字段右侧显示“已选 N 项”，不参与文本编辑；悬停显示完整已选名称，无法解析的 key 使用 key 本身。宽度不足时裁剪计数并优先保留输入空间。 |
| 下拉箭Alpha | 切换 popup 开关。关闭时取消搜索并恢复摘要。 |
| 清除按钮 | 清空全部 checked keys，取消 query，触发 `onChange([], [])`；tooltip 为“清空全部选择”。 |
| 节点展开箭Alpha | 只展开或折叠，不勾选。 |
| 节点 checkbox | 即时切换勾选，保留查询、popup 和字段焦点，方便连续选择。 |
| 节点 label | 保持 TreeView 的行交互，不等同于 checkbox 点击。 |
| popup 外部点击 | 结束查询、关闭 popup；已生效的勾选不会撤销。 |

## 摘要与字段内搜索

未搜索时沿用 `summaryBuilder` / `maxSummaryItems` 的摘要，例如“TeamAlpha、TeamDevice +1”。进入搜索时，原生输入值为空，空字段显示“搜索…”；已有摘要不会被复制成查询文本。正在搜索时，左侧只编辑 query，右侧只读计数反映完整已选集合。

```text
普通状态：[ TeamAlpha、TeamDevice +1                 ▾ ]
搜索状态：[ 检验│                 已选 3 项   ▾ ]
```

Escape、Tab、下拉箭Alpha关闭或失焦会取消查询并恢复摘要。字段仍聚焦时，下一次输入会重新进入搜索；删除或粘贴只编辑 query，不取消已选项。清空所有选择应使用清除按钮或显式赋值。

## 搜索

默认搜索处理器：

```ts
const processor = defaultDropCheckTreeEditQueryProcessor()
```

默认搜索规则：

- 查询文本会 trim 并转小写。
- 默认匹配 `node.key` 和 `node.label`。
- 父节点命中时保留该节点。
- 子节点命中时保留祖先路径，并只保留匹配子树。
- 搜索时 popup 会展开过滤结果中的所有可展开节点。

自定义搜索文本：

```ts
const field = new RenderDropCheckTreeEdit({
  roots,
  queryTextBuilder: node => [
    node.key,
    node.label,
    node.data?.py ?? '',
  ],
})
```

自定义搜索处理器：

```ts
const field = new RenderDropCheckTreeEdit({
  roots,
  queryProcessor: ({ query, roots, checkedKeys }) => {
    state.lastQuery = query
    state.checked = [...checkedKeys]
    return roots.filter(node => node.label.includes(query))
  },
})
```

`debugState()` 不会执行 `queryProcessor`，避免调试读取触发昂贵查询。

## 过滤期间的选择范围

完整 `checkedKeys` 独立于过滤树保存。一次勾选仅替换当前结果中合法勾选目标的状态，不覆盖过滤外或暂时无法解析的已选 key。父节点的全选/半选和递归勾选只针对当前过滤结果中的目标；清空查询后恢复完整树的状态。

例如，已选“TeamAlpha”，搜索“Device吸”并勾选“TeamDevice”，最终值仍包含这两项；取消搜索结果里的勾选不会取消被过滤隐藏的“TeamAlpha”。

合法目标按原始完整 roots 的 TreeView 勾选规则计算。过滤裁掉子节点后，原来的父节点不会因此被当成叶子提交；只命中父节点名称而没有可勾选后代的结果保留为分组，不能作为新叶子值提交。自定义 `queryProcessor` 返回的未知 key 也不会作为新的勾选目标；远程结果应先更新完整 `roots`。回调的 `nodes` 从完整当前 roots 解析，而不是返回投影克隆节点。

`roots` 赋值和 `refreshTree()` 保留当前 query、组合输入及仍可见的导航目标；目标被删除或不再可见时清除导航，Enter 不会误勾选其他行。刷新不会静默删除无法解析的已选 key；业务可通过 `checkedKeys` 或 `setValue()` 更新正式值。

赋值 `checkedKeys` 保留当前查询并刷新候选；`setValue()` 在值实际改变时静默关闭 popup、取消查询并同步正式值，组合输入会结束并隔离旧输入载体的迟到事件。传入相同数组值时保持原来的无操作行为。

查询结果按 query、roots、checkedKeys 或显式刷新缓存；勾选改变时也会重新执行 `queryProcessor`，因为上下文包含 checkedKeys。绘制、布局和 `debugState()` 不执行业务查询。查询回调引起的数据重绑、模式切换、关闭或销毁会使旧结果失效；勾选回调可以关闭并重新打开 popup，过期回调不会刷新或关闭新的会话。

## 展开策略

打开 popup 时展开 key 计算规则：

1. `expandAllOnOpen === true`：展开所有可展开节点。
2. `expandedKeysOnOpen` 是函数：使用函数返回值。
3. `expandedKeysOnOpen` 是数组：使用数组。
4. 上述结果都会合并已勾选节点的祖先 key。
5. 搜索中会展开过滤结果的所有可展开节点。
6. 用户手动展开/折叠会在非搜索状态下记忆到 popup 内部；下次打开会沿用。

示例：

```ts
const field = new RenderDropCheckTreeEdit({
  roots,
  checkedKeys: ['lab'],
  expandedKeysOnOpen: ({ checkedKeys }) => {
    return checkedKeys.length > 0 ? ['support-group'] : []
  },
})
```

## 摘要显示

默认摘要使用已勾选节点 label：

- 勾选数量小于等于 `maxSummaryItems`：显示全部，例如 `TeamAlpha、TeamDevice`。
- 勾选数量超出上限：显示前 N 项加数量，例如 `TeamAlpha、TeamDevice +1`。

自定义摘要：

```ts
const field = new RenderDropCheckTreeEdit({
  roots,
  summaryBuilder: ({ checkedNodes }) => {
    return checkedNodes.length === 0
      ? ''
      : `已选择 ${checkedNodes.length} 项`
  },
})
```

当摘要被折叠或触发框宽度不足时，控件会把完整已选 label 列表放入 tooltip。placeholder 和查询文本不生成已选摘要 tooltip；搜索期间可在独立已选计数区域悬停查看完整名称。

## 键盘行为

可搜索模式：

| 操作 | 行为 |
| --- | --- |
| 字符、粘贴、输入法 | 字段内编辑 query，打开并刷新下方树，不改变正式选择。 |
| Enter（popup 未打开） | 进入搜索并打开 popup，不直接勾选。 |
| 首次 ArrowDown / ArrowUp | 打开 popup 并建立导航：优先可见的已勾选目标或其全选/半选祖先，否则首行/末行；后续逐行有界移动。 |
| ArrowLeft / ArrowRight | 有导航时执行父子树导航和展开折叠；文本编辑态交给原生光标。 |
| Enter / Space（已有导航） | 切换可勾选目标，保留 query 和 popup。不可勾选分类只展开关闭的分支，不提交分类。 |
| Enter（popup 已打开但无导航） | 消费事件，不勾选，不触发表单默认提交。 |
| Space（无导航） | 输入普通空格。 |
| Home / End、Backspace / Delete、普通字符、带修饰键的编辑快捷键 | 退出候选导航，交给字段的原生编辑处理。删除查询不会清空已选集合。 |
| Escape | 取消查询并恢复摘要，不撤销勾选。 |
| Tab / Shift+Tab | 取消查询并关闭 popup，继续移动焦点。 |

组合输入期间的方向键和 Enter 留给输入法，不导航、不勾选；外部监听 `preventDefault()` 后不执行默认导航和勾选。

`searchable: false` 保留原来的点击、Enter/Space/ArrowDown 打开、树焦点和键盘规则，以及 clearable 时 Backspace/Delete 清除。没有字段文本输入会话。

## Popup 布局和滚动

popup 宽度：

```text
panelW = clamp(max(280, anchorWidth), viewportWidth - 16)
```

popup Priority度：

- 按 TreeView 可见节点数计算。
- 可见节点数最多为 `maxVisibleItems`。
- 搜索模式也不占用独立搜索框行。
- 位置会限制在 viewport 8px inset 内。

当节点数量超过可见Priority度时，内部 TreeView 自己处理滚动和滚动条。popup 内滚轮会被消费，即使当前树没有溢出，也不会把滚动传递到底层页面。

## 状态、只读和禁用

| 状态 | 行为 |
| --- | --- |
| `readonly` | 显示锁图标和只读底色，不可聚焦、不可打开、不可清除。 |
| `disabled` | 禁用视觉，不可聚焦、不可打开、不可清除。 |
| `status` | 影响触发框边框/状态色，适合校验状态。 |
| `helperText` | 显示在字段下方，并影响组件布局Priority度。 |

设置 `readonly` 或 `disabled` 为 `true` 时，已打开 popup 会立即关闭，查询展示会清空。

## DebugState

```text
const debug = field.debugState()
```

返回字段：

| 字段 | 说明 |
| --- | --- |
| `popupVisible` | popup 是否打开。 |
| `queryText` | 当前查询文本。 |
| `showQueryInField` | 触发框是否临时展示查询文本。 |
| `displayText` | 当前触发框显示文本。 |
| `focused` | 触发框是否聚焦。 |
| `disabled` | 是否禁用。 |
| `readonly` | 是否只读。 |
| `checkedKeys` | 当前勾选 key。 |
| `checkedLabel` | 当前摘要文本。 |
| `filteredCount` | popup 打开时为过滤树节点数；关闭时为完整树节点数。 |
| `expandedKeys` | popup 当前展开 key。 |

`debugState()` 适合测试和Catalog，不应作为业务数据源。

## 生命周期

`dispose()` 会：

- 关闭 popup。
- 释放 popup 内 TreeView 和字段输入会话，隔离过期回调。
- 注销焦点。
- 清理 hover/focus 状态。

隐藏自身或祖先、detach、readonly/disabled 会关闭候选并结束输入、拖选与捕获；隐藏再显示不会复活旧的按下动作或消耗旧动作上的 once 监听。

当页面卸载、表单销毁或字段不再使用时，应 dispose 该控件。`roots` 中的业务对象仍由业务持有，不由控件释放。

## 性能边界

- popup 内 TreeView 使用固定行虚拟范围绘制可见行。
- 搜索过滤会遍历当前 roots，复杂度和树节点数量相关。
- `debugState()` 不执行查询处理器，避免调试面板触发昂贵过滤。
- 大树应提供轻量 `queryTextBuilder`，避免每个节点构造大字符串。
- 远程查询或懒加载应放在业务层更新 `roots`，不要在 `queryProcessor` 中阻塞主线程。

## 常见问题

### 为什么点击 label 没有勾选？

当前勾选动作绑定在 TreeView check 模式的 checkbox 上。label 点击不是 checkbox 点击。需要改变这个交互应扩展 TreeView 的 check 行为。

### 为什么勾选父节点后没有展开？

这是预期行为。父节点 checkbox 会切换子孙可勾选目标，但不会改变展开状态，也不会改变折叠区域Priority度。

### checkedKeys 为什么只包含叶子？

TreeView check 模式以叶子目标作为真实值。父节点的全选/半选是根据叶子状态推导出来的展示状态。

### 搜索时为什么会展开很多节点？

搜索状态下会展开过滤结果中的所有可展开节点，方便用户看到匹配子节点。清空搜索后恢复非搜索展开策略。

### 如何清空？

设置 `clearable: true` 后，触发框显示清除按钮。点击后会设置 `checkedKeys = []` 并触发 `onChange([], [])`。也可以直接赋值 `field.checkedKeys = []`，但直接赋值不会触发 `onChange`。

### 如何显示完整已选内容？

默认摘要被折叠或宽度不足时会设置 tooltip，内容是完整 label 列表。也可以通过 `summaryBuilder` 自定义摘要。

## 相关文档

- [TreeView 树](../data/tree-view.md)
- [DropTreeEdit 树形单选下拉](./drop-tree-edit.md)
- [DropTreeGridEdit 树表下拉](./drop-tree-grid-edit.md)
- [MultiSelectDropdown 多选下拉](./multi-select-dropdown.md)
- [TextBox 文本输入](../input/text-box.md)
