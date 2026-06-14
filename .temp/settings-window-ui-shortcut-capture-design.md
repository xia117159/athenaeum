# 设置弹窗 UI 布局与快捷键捕获详细设计方案

状态：最终可编码版，已根据两轮审查结论修订  
范围：本轮只做设计方案，不进行编码实现  
目标代码区域：`src/features/workspace/*`

## 1. 背景与目标

当前项目是 Tauri v2 + Rust + React + TypeScript 的 Windows 文件管理器桌面应用。设置界面已经是独立设置窗口，入口位于工作区菜单，主要实现集中在：

- `src/features/workspace/SettingsWindowView.tsx`
- `src/features/workspace/SettingsSurface.tsx`
- `src/features/workspace/settingsWindow.ts`
- `src/features/workspace/workspace.css`
- `src/features/workspace/workspaceShortcuts.ts`

本次目标是优化设置弹窗的 UI 布局与人机交互：

1. 设置弹窗视觉参考用户给出的设计图，采用 Windows 桌面偏好设置/属性页风格。
2. 保持界面整齐、干净、高密度，适合文件管理器长期使用。
3. 快捷键设置从普通文本输入改为焦点即捕获的快捷键录入方式。
4. 不新增未实现的设置业务能力，只重排和优化现有设置模型的呈现方式，并为未来扩展预留结构。

## 第一轮审查修订记录

第一轮审查结论为“需要修改”。本版已按审查意见补充以下约束：

1. 快捷键捕获状态机从概念状态细化为 `unfocused`、`capturing`、`committedFocused`、`cancelledFocused`，明确确认/取消后的焦点行为，避免 Tab 焦点陷阱。
2. 明确 keydown 处理优先级：先拦截事件，再处理 Escape，再处理 Enter，最后才处理普通候选键。
3. 明确确认逻辑必须幂等，keyup、blur、Enter 不得重复触发 `onUpdateShortcut`。
4. 明确前端冲突检测必须使用即将发送给后端的 `accelerator` 规范化结果。
5. 明确七个设置导航项进入同一个 `SettingsSection` 状态模型，不允许在 `SettingsSurface` 内维护第二套导航状态。
6. 补充窗口最小尺寸、右侧滚动、footer 固定、表格横向滚动和 FTP/SFTP 窄宽折叠策略。
7. 补充 paste、drop、composition、beforeinput 等非键盘输入路径的处理要求。

## 第二轮审查修订记录

第二轮审查结论为“需要修改”。本版已继续补充以下约束：

1. `hasCommittedCurrentCapture` 必须使用同步 guard/ref，不能只依赖 React state，确保 keyup、blur、Enter 同帧触发时仍幂等。
2. 明确通过 Tab 聚焦快捷键控件时进入捕获态，确认或取消后仍聚焦时下一次 Tab 只移动焦点。
3. 明确 Enter 无候选值时恢复原值并迁移到 `committedFocused`，不继续捕获。
4. 明确 DTO 保存边界必须统一规范化所有 shortcuts，包括未编辑的旧数据；`saveWorkspaceShortcuts` 和 `saveWorkspaceSettingsModel` 使用同一规范化函数。
5. 明确实现时同步更新 `SettingsSection` 类型、reducer、controller、测试，并提供旧 `"theme"`、`"rules"` 的单点映射函数。
6. 明确调整当前 `@media (max-width: 960px)` 设置页断点，避免默认 `920px` 窗口把左侧导航折到顶部。
7. 明确 window blur 采用保守系统组合 denylist，不提交 Alt+Tab、Alt+F4、Win/Meta、单 Alt、Ctrl+Alt+Del 等系统级组合。
8. 明确快捷键捕获控件使用真实 `input readOnly`，避免 button/div 模拟控件绕过现有全局快捷键 guard。
9. 明确 FTP/SFTP 表单未暂存时点击“确定”的处理：必须阻止保存并提示，或显式确认丢弃；默认推荐阻止保存。

## 2. 现状与根因分析

### 2.1 当前设置界面现状

当前 `SettingsSurface` 的结构是：

- 顶部标题区。
- 左侧一级导航：快捷键、主题、规则与列、连接。
- 右侧内容区。
- 底部确认/取消按钮。

当前右侧设置项大量使用 `.settings-card`，每个设置项像独立卡片一样排列。快捷键设置使用普通 `<input type="text">`，通过 `onChange` 直接修改绑定字符串。

### 2.2 UI 布局问题根因

1. 信息层级不够接近桌面属性页
   - 参考图是典型桌面软件设置：左侧树状分类，右侧是一个属性页。
   - 当前界面更像 Web 管理后台的卡片列表，视觉层级偏重。

2. 卡片式设置项过多
   - 文件管理器设置需要高密度扫描。
   - 每项卡片会放大边距和视觉分隔，降低信息密度。

3. 分类粒度偏粗
   - `rules` 同时承载右键菜单、颜色规则、列表行高、标签规则、列显示。
   - 用户扫描时很难从左侧直接定位到“菜单”“列表”“颜色”等具体目标。

4. 顶部标题区占用空间偏多
   - 设置窗口本身已有系统标题栏。
   - 内部再放大标题区会压缩有效设置区域。

### 2.3 快捷键交互问题根因

1. 普通文本框不适合快捷键设置
   - 用户可以输入任意字符，容易产生格式不一致、不可用或难以理解的绑定。
   - 直接输入无法自然表达“按下 Ctrl 后自动显示 Ctrl”这种捕获式体验。

2. 快捷键捕获缺少状态机
   - 快捷键录入需要区分：未捕获、捕获中、候选快捷键、已确认、取消。
   - 当前 `onChange` 没有 keydown/keyup 级别的捕获逻辑。

3. 冲突与非法状态反馈不足
   - Rust 后端已有重复快捷键校验，但如果只在保存时失败，用户定位问题成本高。
   - UI 层需要提前标记同一 scope 内的重复绑定。

## 3. 设计原则

1. 保留独立设置窗口
   - 当前 `settingsWindow.ts` 创建独立窗口，符合桌面软件设置入口。
   - 本次不退回模态遮罩，也不把设置嵌入主工作区。

2. 左侧分类导航 + 右侧属性页
   - 左侧参考设计图：分组标题 + 紧凑条目 + 当前项蓝色选中。
   - 右侧采用“标题 + 分组 + 表单行/列表行”的属性页结构。

3. 减少卡片感
   - 普通设置项使用行、表格、分隔线，不使用大面积卡片。
   - 只有连接配置这种复杂编辑器允许使用轻量分组框。

4. 优先真实状态模型
   - 不绕开 `WorkspaceState.settings.model`。
   - 不新增平行设置模型。
   - 若需要更细的导航项，只作为前端视图 section 拆分，不新增后端持久化字段。

5. 快捷键只通过键盘事件捕获
   - 输入框获得焦点后进入捕获模式。
   - 不允许直接输入字符来完成快捷键设置。
   - 使用 keydown 实时更新候选值，使用 blur、Enter 或按下的快捷键松开进行确认。

## 4. 设置窗口整体布局设计

### 4.1 窗口尺寸

延续当前窗口尺寸作为基线：

- 默认：`920 x 720`
- 最小：建议调整为 `800 x 560`
- 可调整大小：保留
- 独立窗口标题：`设置`

原因：

- 左侧导航默认约 `248px`，右侧快捷键表格、颜色规则列表和 FTP/SFTP 表单都需要稳定的最小宽度。
- 当前 `settingsWindow.ts` 的 `minWidth: 720` 对七项导航和右侧属性页偏窄，容易导致快捷键列和操作按钮拥挤。
- 实现阶段应同步更新 `settingsWindow.ts` 的 `minWidth/minHeight`，并补测试覆盖窗口配置。

响应式策略：

- 顶层窗口使用三段 grid：内容区占 `minmax(0, 1fr)`，footer 固定在底部，不随内容滚动。
- 左侧导航宽度使用固定或 clamp 策略，建议 `clamp(212px, 27vw, 248px)`。
- 右侧页面必须设置 `min-width: 0`，页面主体使用垂直滚动，滚动范围不包含 footer。
- 快捷键、颜色规则、标签规则这类表格使用内部横向滚动容器，表格建议 `min-width: 560px`，避免整窗横向滚动。
- 当右侧可用宽度不足时，设置行从左右两列折叠为上下结构，输入控件仍保持稳定高度。
- FTP/SFTP 页面在右侧内容宽度低于约 `620px` 时从“左 profile 列表 + 右表单”折叠为“上 profile 列表 + 下表单”。

现有 CSS 断点必须调整：

- 当前 `workspace.css` 存在 `@media (max-width: 960px)`，会在默认 `920px` 设置窗口下把设置导航折到顶部，直接违背本设计的左侧导航基线。
- 实现阶段必须移除该设置页折叠规则，或把设置页相关折叠断点下调到小于最终 `minWidth`，例如 `max-width: 799px`。
- 因设置窗口最小宽度设计为 `800px`，正常窗口宽度下不应出现顶部导航布局。
- 如果浏览器测试容器宽度低于 `800px`，可以允许测试专用窄宽布局，但不能影响 Tauri 设置窗口默认和最小尺寸。

### 4.2 顶层结构

设置窗口内部改为三段式：

```text
settings-window
├─ settings-layout
│  ├─ settings-nav
│  └─ settings-page
└─ settings-footer
```

不再使用占高较大的内部 header。右侧页面顶部直接显示当前页面标题，例如“快捷键”“文件列表”“外观”。

### 4.3 左侧导航

左侧宽度建议 `236px - 260px`。在 920px 默认窗口中建议使用 `248px`。

左侧导航采用参考图风格：

```text
常规
  快捷键
  文件列表
  菜单与鼠标

颜色和风格
  外观
  颜色规则
  标签规则

连接
  FTP/SFTP
```

导航说明：

- 分组标题使用 12px 或 13px、半粗体。
- 普通条目高度 28px - 32px。
- 当前条目使用整行蓝色选中底色，白色文字，类似参考图。
- 鼠标悬停使用浅蓝或浅灰。
- 键盘焦点使用清晰 focus ring，不依赖颜色判断。
- 左侧只负责定位页面，不展示长描述，避免拥挤。

这些导航项均映射现有设置模型：

| 导航项 | 数据来源 | 是否新增业务 |
| --- | --- | --- |
| 快捷键 | `settings.model.shortcuts` | 否 |
| 文件列表 | `settings.model.detailsRowHeight`、`settings.model.columns` | 否 |
| 菜单与鼠标 | `settings.model.contextMenu` | 否 |
| 外观 | `settings.model.theme` | 否 |
| 颜色规则 | `settings.model.colorRules` | 否 |
| 标签规则 | `settings.model.tagRules` | 否 |
| FTP/SFTP | `state.remoteProfiles` | 否 |

实现阶段应扩展同一个 `SettingsSection` 联合类型，而不是在 `SettingsSurface` 内新增局部导航状态：

```ts
export type SettingsSection =
  | "shortcuts"
  | "file-list"
  | "menu-mouse"
  | "appearance"
  | "color-rules"
  | "tag-rules"
  | "connections";
```

落地要求：

- 将现有 `SettingsSection` 从四个值扩展为七个视图 section。
- `WorkspaceState.settings.section` 仍是唯一选中状态来源。
- 左侧导航点击仍通过 `onSelectSection(section)` 更新 draft state。
- `SettingsWindowView` 在确认时继续把 `draftState.settings.section` 传给 `actions.applySettingsModel(...)`，不新增第二套 section。
- 后端 IPC 不需要新增字段；`section` 只影响前端当前设置页位置。
- 实现阶段必须同步更新 `types.ts`、`workspaceReducer.ts`、`useWorkspaceController.ts`、`state.ts`、`SettingsSurface.test.tsx`、`workspaceReducer.test.ts` 中依赖 `SettingsSection` 的类型、初始值、action 和断言。
- 如果需要兼容旧的 `"theme"` 或 `"rules"` 测试数据/持久化快照，应提供单一映射函数，例如 `normalizeSettingsSection(section)`：
  - `"theme" -> "appearance"`
  - `"rules" -> "file-list"`
  - 其他已知新值原样返回
  - 未知值回退到 `"shortcuts"`
- 兼容映射只允许出现在 state/reducer/mapping 边界，不能散落在 `SettingsSurface` 的渲染分支中。

### 4.4 右侧属性页

右侧页面结构：

```text
页面标题
页面简短说明

分组标题
  设置行
  设置行
  设置行

分组标题
  设置行
  设置行
```

属性页视觉要求：

- 背景保持白色或接近白色。
- 分组之间使用细分隔线或顶部边框。
- 不用大圆角卡片包裹每一项。
- 标签、说明、输入控件对齐。
- 输入控件高度统一为 28px - 32px。
- 字号保持桌面密度：正文 12px - 13px，页面标题 26px - 32px。

设置行推荐布局：

```text
label/description column       control column
```

默认列宽：

- 左列：`minmax(220px, 280px)`
- 右列：`minmax(220px, 1fr)`
- 窄宽时折叠为上下结构。

## 5. 各页面详细设计

### 5.1 快捷键页面

页面标题：`快捷键`  
目标：高效查看、修改和发现冲突。

布局采用表格/列表，不使用每个快捷键一张卡片：

```text
快捷键
管理工作区、面板和文件列表中的键盘操作。

工作区
┌────────────────────┬──────────┬────────────────┬──────────┐
│ 功能               │ 作用范围 │ 快捷键         │ 状态     │
├────────────────────┼──────────┼────────────────┼──────────┤
│ 切换到下一个面板   │ 工作区   │ [ Tab        ] │ 正常     │
│ 打开搜索面板       │ 工作区   │ [ Ctrl+F     ] │ 正常     │
└────────────────────┴──────────┴────────────────┴──────────┘

文件列表
...
```

快捷键输入控件设计：

- 使用真实 `<input type="text" readOnly>`，外观像输入框，但实际行为是快捷键捕获控件。
- 不使用 `button`、`div role="textbox"` 或其他 button-like 模拟输入框，避免绕过现有全局快捷键 guard 对 INPUT/TEXTAREA/SELECT 的判断。
- 获得焦点后立即进入捕获状态。
- 捕获中显示候选值，例如：
  - 按下 Ctrl：显示 `Ctrl`
  - 继续按 Alt：显示 `Ctrl+Alt`
  - 继续按 P：显示 `Ctrl+Alt+P`
- 捕获中可显示轻量状态文本：`正在捕获`。
- 失焦、Enter 或按下的快捷键松开后确认。
- Esc 取消本次捕获，恢复进入焦点前的原值。

冲突反馈：

- 同一 scope 内出现重复 binding 时，在对应行状态列显示 `冲突`。
- 冲突行使用轻量红色文本或边框，不使用大面积红色背景。
- 保存按钮在存在冲突时禁用，或保持可点但在底部错误区明确指出冲突。推荐禁用保存按钮并显示底部错误摘要。
- 冲突判定应与后端 `validate_shortcuts` 一致：`scope + accelerator` 维度去重。
- 冲突判定不能直接比较原始显示字符串，必须比较规范化后的 `accelerator`，详见 6.7。

无效值反馈：

- 后端当前不接受空 accelerator，因此 UI 不提供“清空快捷键”作为默认交互。
- 如果未来需要清空快捷键，应先调整后端校验和快捷键匹配逻辑，本次不纳入。

### 5.2 文件列表页面

承载现有：

- `detailsRowHeight`
- `columns`

页面组织：

```text
文件列表
调整详细信息视图的行高和可见列。

详细信息视图
  行高       [ 24 ] px

显示列
  名称       显示    宽度 ...
  类型       显示    宽度 ...
```

当前列设置是只读展示，则保持只读，不伪装成可编辑控件。只读项应使用文本状态，不显示禁用 checkbox，避免用户误以为可以操作。

### 5.3 菜单与鼠标页面

承载现有：

- `contextMenu.defaultMenu`

页面组织：

```text
菜单与鼠标
控制右键菜单优先打开的软件自定义菜单或 Windows 系统菜单。

右键菜单
  默认右键菜单    [ Windows 系统 | 软件自定义 ]
```

控件建议使用 segmented control 或 select。当前只有两个互斥选项，segmented control 更清晰。

### 5.4 外观页面

承载现有：

- `theme.panelFocusAccent`
- `theme.tabMinWidth`

页面组织：

```text
外观
调整面板焦点强调色和标签页尺寸。

面板
  焦点强调色       [ color swatch ][ #0f6cbd ]

标签页
  最小宽度         [ 96 ] px
```

颜色控件应显示色块和十六进制值，避免只有浏览器默认 color input。

### 5.5 颜色规则页面

承载现有：

- `colorRules`

页面组织：

```text
颜色规则
预览扩展名、属性和标签颜色。

规则列表
  规则名称      匹配条件      颜色       预览
```

当前 color rule 可编辑颜色，则颜色列保留色块控件。规则名称、匹配条件保持文本。

### 5.6 标签规则页面

承载现有：

- `tagRules`

当前 tag rule 是只读展示，则明确使用只读列表：

```text
标签规则
用于快速定位带标签的文件和文件夹。

规则名称      匹配条件      快速筛选
```

### 5.7 FTP/SFTP 页面

承载现有：

- `state.remoteProfiles`
- 新建、暂存、删除、测试连接

该页面内容复杂，可以使用左右结构：

```text
FTP/SFTP
管理远程连接配置。

┌ profile list ┐ ┌ editor form ┐
│ profile A    │ │ 名称        │
│ profile B    │ │ 主机/端口   │
│ 新建配置     │ │ 认证方式    │
└──────────────┘ └─────────────┘
```

要求：

- profile 列表不要做成大 chip 横向滚动，改为左侧竖向列表，更符合设置页。
- 编辑器表单字段两列对齐。
- 测试连接、暂存配置、移除配置放在编辑器底部右侧。
- 不改变保存语义：仍由设置窗口“确定”统一落地，连接编辑器内部的“暂存配置”只更新 draft。
- 切换 profile 前，如果当前表单存在未暂存修改，应使用轻量确认或内联提示处理，不能静默丢失 draft。
- 点击设置窗口“确定”时，只保存已经进入 `draftState.remoteProfiles` 的配置；未点击“暂存配置”的表单编辑不应被误认为已保存。
- 默认策略：如果当前 FTP/SFTP 表单存在未暂存修改，设置窗口“确定”应被阻止，并在表单底部或 footer 错误区提示“请先暂存当前连接配置或放弃修改”。
- 可选策略：弹出确认丢弃未暂存修改后继续保存已暂存数据；若实现该策略，必须补测试。本设计推荐默认阻止保存，避免静默丢失。
- 本轮不采用“确定自动暂存当前表单”，因为这会改变当前“暂存配置”按钮的语义。
- 窄宽时 profile 列表折叠到表单上方，列表项高度保持紧凑，避免横向 chip 滚动。

## 6. 快捷键捕获交互详细设计

### 6.1 状态机

每个快捷键控件维护局部捕获状态，但该状态只属于单个控件，不进入 workspace reducer。

```text
unfocused
  └─ focus -> capturing

capturing
  ├─ keydown Escape -> cancelledFocused
  ├─ keydown Enter  -> committedFocused
  ├─ keydown normal -> capturing with candidate
  ├─ keyup          -> committedFocused when candidate exists
  ├─ element blur   -> unfocused after commit/restore
  └─ window blur    -> unfocused with OS-reserved fallback rules

committedFocused
  ├─ Tab            -> normal focus navigation, not captured
  ├─ click/pointer  -> capturing
  └─ blur           -> unfocused

cancelledFocused
  ├─ Tab            -> normal focus navigation, not captured
  ├─ click/pointer  -> capturing
  └─ blur           -> unfocused
```

状态字段建议：

- `captureState: "unfocused" | "capturing" | "committedFocused" | "cancelledFocused"`
- `candidateBinding: string | null`
- `originalBinding: string`
- `pressedCodes: Set<string>` 或等价结构
- `hasCommittedCurrentCaptureRef: React.MutableRefObject<boolean>` 或等价同步 guard
- `lastSupportedKeyWasPrimary: boolean`

核心约束：

- 输入框第一次获得焦点时进入 `capturing`。
- 通过键盘 Tab 聚焦快捷键控件时也进入 `capturing`，此时用户下一次 keydown 会被捕获为候选快捷键。
- 一次捕获确认或取消后，如果元素仍然聚焦，状态进入 `committedFocused` 或 `cancelledFocused`，不继续捕获。
- 在 `committedFocused`/`cancelledFocused` 状态下，Tab 必须按浏览器默认行为移动焦点，不得被捕获为快捷键。
- 已聚焦状态下用户再次点击控件，或控件 blur 后再次 focus，才重新进入 `capturing`。
- 确认逻辑必须幂等：同一次捕获中 `onUpdateShortcut` 最多调用一次。
- keyup 确认后触发的 blur、后续修饰键 keyup 或 Enter 不得再次调用 `onUpdateShortcut`。
- 幂等 guard 必须是同步可读写的 ref/实例字段，不能只依赖 React state；React state 更新可能被批处理，无法阻止同一事件循环中的 keyup + blur 双提交。

通过 Tab 聚焦的事件序列：

```text
previous control --Tab--> shortcut input focus
shortcut input state: capturing
keydown Ctrl -> candidate Ctrl
keyup Ctrl -> commit Ctrl, state committedFocused
next keydown Tab -> browser focus navigation, not captured
```

如果用户只是 Tab 到控件后不想修改，应先按 Escape 取消进入 `cancelledFocused`，再按 Tab 离开；在 `capturing` 且还没有候选值时，Tab 是捕获键，这是用户要求“获得焦点即可捕获”的结果。确认或取消后，下一次 Tab 才恢复为焦点导航。

### 6.2 keydown 规则

当控件处于捕获状态：

1. 调用 `event.preventDefault()`。
2. 调用 `event.stopPropagation()`，避免触发工作区快捷键。
3. 按优先级处理按键：
   - `Escape`：取消本次捕获，恢复原值，进入 `cancelledFocused`，永远不调用 `onUpdateShortcut`。
   - `Enter`：确认当前候选值；如果没有候选值，则恢复原值并进入 `committedFocused`，不调用 `onUpdateShortcut`。
   - 其他按键：进入候选值更新逻辑。
4. 忽略 `event.repeat`，防止长按重复更新。
5. 根据当前按键和 modifier 状态生成候选快捷键。
6. 立即调用 UI 更新，使输入框显示候选值。

当控件处于 `committedFocused` 或 `cancelledFocused`：

- 不拦截 Tab，允许焦点移动。
- 不用普通 keydown 更新候选值。
- 只允许 click/pointer 或重新 focus 进入下一次捕获。

示例：

| 用户操作 | 显示 |
| --- | --- |
| keydown Ctrl | `Ctrl` |
| keydown Ctrl, keydown Alt | `Ctrl+Alt` |
| keydown Ctrl, keydown Alt, keydown P | `Ctrl+Alt+P` |
| keydown F2 | `F2` |
| keydown Alt, keydown ArrowUp | `Alt+Up` |
| keydown Tab | `Tab` |
| keydown Ctrl, keydown Alt, keyup Ctrl | 确认 `Ctrl+Alt` |

不支持或不可靠的键：

- `Unidentified`、`Dead`、IME composition key 不生成候选值。
- Windows/Meta 键不作为可配置快捷键；WebView 对 Win 组合和系统级组合交付不稳定。
- `Alt+Tab`、`Alt+F4`、`Ctrl+Alt+Del` 等 OS 保留组合不承诺可捕获。
- 如果窗口因 OS 级组合失焦，采用保守 denylist，不提交候选值，避免用户切换窗口或关闭窗口时误改快捷键。
- denylist 至少包括：单 `Alt`、`Alt+Tab`、`Alt+F4`、`Ctrl+Alt+Delete`、任何包含 `Meta`/Win 的组合、`Unidentified`、`Dead`、IME 组合键。
- window blur 时只有明确不是系统级组合、且已形成可支持候选值的情况才允许提交；实现上如果无法可靠判断，优先取消，不要误提交。

### 6.3 keyup 规则

当控件处于捕获状态且已有候选值：

- 如果 keyup 发生，确认当前候选值。
- 确认后退出捕获状态，并调用 `onUpdateShortcut(id, binding)`。
- 若 keyup 发生在 Ctrl-only、Alt-only、Shift-only 这类单修饰键候选上，也允许确认，因为现有系统已支持 modifier-only 绑定，例如拖放移动和右键菜单切换。
- Ctrl+Alt+P 的释放顺序不影响结果：无论先松 P、Ctrl 还是 Alt，只要当前候选值已经是 `Ctrl+Alt+P`，第一次 keyup 就确认该值。
- 确认后状态进入 `committedFocused`；后续修饰键 keyup 必须被忽略。

### 6.4 blur 与 Enter 规则

- element blur：如果处于 `capturing` 且已有候选值，则确认；没有候选值则恢复原值且不更新。然后状态进入 `unfocused`。
- window blur 或 WebView 失活：遵循保守 OS 保留组合保护规则。denylist 命中或无法判断时取消，不提交。
- Enter：在 keydown 优先级中处理。已有候选值时确认；没有候选值时恢复原值且不更新。
- Escape：取消本次捕获，恢复原值，不调用 `onUpdateShortcut`。

确认函数建议设计为：

```ts
function commitCapture(reason: "keyup" | "enter" | "blur" | "window-blur") {
  if (captureStateRef.current !== "capturing" || hasCommittedCurrentCaptureRef.current) {
    return;
  }
  hasCommittedCurrentCaptureRef.current = true;

  if (reason === "window-blur" && isReservedSystemCandidate(candidateBinding)) {
    restoreOriginalBinding();
    captureStateRef.current = "unfocused";
    return;
  }

  const nextBinding = normalizeShortcutBindingForStorage(candidateBinding ?? "");
  if (!nextBinding) {
    restoreOriginalBinding();
    captureStateRef.current = reason === "blur" || reason === "window-blur" ? "unfocused" : "committedFocused";
    return;
  }
  onUpdateShortcut(id, nextBinding);
  captureStateRef.current = reason === "blur" || reason === "window-blur" ? "unfocused" : "committedFocused";
}
```

实现可以不同，但必须满足同等幂等语义。

### 6.5 不允许直接输入字符

快捷键控件必须禁止文本输入：

- 输入控件应设置 `readOnly`。
- 不依赖 `onChange` 获取用户输入。
- `beforeinput` 或 `input` 事件不应改变快捷键。
- 粘贴文本不应改变快捷键。
- 拖放文本不应改变快捷键。
- IME 组合输入不应改变快捷键。

事件处理原则：

- `onBeforeInput`：阻止默认行为，不更新绑定。
- `onInput`：忽略，不更新绑定。
- `onChange`：忽略，不更新绑定；快捷键只能由确认函数触发 `onUpdateShortcut`。
- `onPaste`：阻止默认行为，不更新绑定。
- `onDragOver`：阻止默认行为或明确禁用 drop target，不更新绑定。
- `onDrop`：阻止默认行为，不更新绑定。
- `onCompositionStart`/`onCompositionUpdate`/`onCompositionEnd`：阻止或忽略，不更新绑定。
- disabled/applying 状态下，focus、keydown、keyup、paste、drop、composition 都不能触发更新。

### 6.6 快捷键格式规范

显示和保存使用统一格式：

```text
Ctrl+Alt+Shift+Key
```

规则：

- 修饰键顺序固定：`Ctrl`、`Alt`、`Shift`。
- Windows 平台优先显示 `Ctrl`，不显示 `Meta` 或 `Cmd`。
- 字母统一大写显示，例如 `P`。
- 方向键显示为 `Up`、`Down`、`Left`、`Right`。
- 功能键显示为 `F1` - `F24`。
- 空格显示为 `Space`。
- Delete、Backspace、Tab、Enter 等按键按标准名称显示。

注意：

- Enter 在捕获控件中用于确认，不作为本次设计的可绑定快捷键。
- Escape 用于取消，不作为本次设计的可绑定快捷键。
- 如果未来需要绑定 Enter/Escape，应提供额外编辑模式或显式按钮，本次不纳入。
- Backspace/Delete 本轮作为可绑定快捷键处理，不作为清空操作，因为后端当前不接受空 accelerator。

### 6.7 规范化与后端一致性

前端模型字段是 `binding`，保存到后端时 `toBackendShortcut` 会映射为 `accelerator`。因此确认前必须统一规范化，避免 UI 与后端冲突检测不一致。

规范化要求：

- `normalizeShortcutBindingForStorage(binding)` 输出固定顺序和大小写：`Ctrl+Alt+Shift+Key`。
- 输出前 trim 每个片段，去除空片段。
- 修饰键顺序固定，不允许保存 `Alt+Ctrl+P` 这种顺序。
- 字母主键保存为大写，例如 `Ctrl+Alt+P`。
- 方向键保存为 `Up/Down/Left/Right`，不是 `ArrowUp`。
- 前端冲突检测使用即将发送给后端的 `accelerator`：`normalizeShortcutBindingForStorage(binding).trim().toLowerCase()`。
- scope 参与冲突检测时同样使用 `scope.trim().toLowerCase()`。
- DTO 保存边界也必须规范化。`toBackendShortcut(shortcut)` 不能原样透传 `shortcut.binding`，必须输出 `accelerator: normalizeShortcutBindingForStorage(shortcut.binding)`。
- 规范化必须覆盖所有 shortcuts，包括本次未编辑但来自旧设置、测试夹具或后端快照的历史值。
- `saveWorkspaceShortcuts(shortcuts)` 和 `saveWorkspaceSettingsModel(model)` 必须使用同一个 `toBackendShortcut`/同一个规范化函数，避免两条保存路径行为分叉。
- 浏览器 fallback `createBrowserSettingsSnapshot` 若回显 shortcuts，也应回显规范化后的 accelerator，方便测试和 UI 一致。

冲突 key 等价于：

```ts
const conflictKey = `${scope.trim().toLowerCase()}:${normalizeShortcutBindingForStorage(binding).trim().toLowerCase()}`;
```

必须补测试覆盖：

- `Alt+Ctrl+P` 与 `Ctrl+Alt+P` 判定为同一个冲突。
- ` ctrl + alt + p ` 与 `Ctrl+Alt+P` 判定为同一个冲突。
- `ctrl+alt+p` 保存后显示/存储为 `Ctrl+Alt+P`。
- 不同 scope 中相同 binding 不冲突。

### 6.8 与现有快捷键工具的关系

当前 `workspaceShortcuts.ts` 已有：

- `normalizeShortcutBinding`
- `eventToShortcutBinding`
- `getShortcutBindingMap`
- `shortcutMatches`
- `modifiersMatchShortcutBinding`

实现阶段建议：

1. 保留现有匹配能力，避免影响工作区快捷键处理。
2. 增加或扩展用于捕获 UI 的格式化函数，例如：
   - `eventToShortcutCaptureCandidate(event)`
   - `formatShortcutBindingForDisplay(binding)`
   - `normalizeShortcutBindingForStorage(binding)`
3. 不把捕获控件的临时状态塞入全局 workspace reducer。
4. 最终确认后仍通过 `onUpdateShortcut(id, binding)` 更新 draft settings model。
5. 若保留现有 `normalizeShortcutBinding` 的小写输出用于匹配，则新增 storage/display 规范化函数，不强行改变现有匹配函数语义，避免工作区快捷键回归。

## 7. 保存与错误处理设计

### 7.1 保存语义

保留当前语义：

- 用户在设置窗口内修改 draft。
- 点击“确定”后统一调用 `actions.applySettingsModel(...)` 和远程连接保存/删除。
- 成功后关闭设置窗口。
- “取消”丢弃 draft 并关闭窗口。

### 7.2 错误展示

底部 footer 左侧保留错误摘要区域：

```text
发现 1 个快捷键冲突：文件列表 / Shift
```

右侧保留按钮：

```text
取消    确定
```

当存在前端可判定错误时：

- `确定` 按钮禁用。
- 错误摘要可见。
- 对应设置行显示 inline 状态。

当后端保存失败时：

- 保留当前窗口不关闭。
- 底部显示后端错误信息。
- 不丢失用户 draft。

## 8. 可访问性与键盘操作

1. 左侧导航
   - 使用 `nav` + `button` 或 `role="tree"`/`treeitem`。
   - 如果只是分组导航，不需要复杂 tree 键盘模型，普通 button 更稳妥。
   - 当前选中项使用 `aria-current="page"`。

2. 快捷键捕获控件
   - 有明确 `aria-label`，例如 `复制 的快捷键`。
   - 捕获中使用 `aria-live` 或旁边状态文本提示当前状态。
   - `readOnly` 表明不可直接编辑文本。
   - focus ring 清晰。

3. 表格/列表
   - 快捷键列表可使用语义 table。
   - 如果使用 div grid，则需要清晰的 header 和 aria label。

4. 错误
   - 错误摘要区域使用 `role="alert"` 或 `aria-live="polite"`。

## 9. 视觉细节

### 9.1 色彩

建议使用现有 accent 基线：

- 主 accent：`#0f6cbd`
- 选中导航背景：`#0078d4` 或现有 accent
- 主背景：`#ffffff`
- 左侧导航背景：`#f3f3f3`
- 分隔线：`#e5e5e5`
- 错误：`#b00020`

避免大面积渐变、装饰图形和一整套单色主题。

### 9.2 间距

- 左侧导航内边距：8px - 10px。
- 导航项高度：28px - 32px。
- 右侧页面内边距：24px - 28px。
- 分组标题上边距：18px - 24px。
- 设置行高度：32px - 40px。

### 9.3 控件

- 输入框、select、segmented control 高度统一。
- 边框半径不超过 4px。
- focus ring 使用 2px 外轮廓或 box-shadow。
- 不使用浏览器默认裸控件外观。

## 10. 未来实现计划

实现阶段必须按 TDD：

1. 先补测试
   - 快捷键捕获行为测试。
   - 设置导航拆分与内容渲染测试。
   - 冲突检测与保存禁用测试。
   - CSS/结构契约测试。

2. 实现快捷键捕获工具函数
   - 不破坏现有 `shortcutMatches`。
   - 添加 display/storage normalization。
   - 修改 `workspaceBackendDtos.ts` 的 `toBackendShortcut`，对所有 shortcuts 输出规范化 accelerator。
   - 确保 `saveWorkspaceShortcuts` 和 `saveWorkspaceSettingsModel` 通过同一 DTO 规范化路径保存。

3. 重构 `SettingsSurface`
   - 拆分导航定义。
   - 拆分右侧页面组件。
   - 新增 `ShortcutCaptureInput` 内部组件。
   - 扩展 `SettingsSection` 到七个视图 section，保持 `WorkspaceState.settings.section` 为唯一导航状态。
   - 快捷键捕获控件使用真实 `input readOnly`，不使用 button/div 模拟控件。
   - `hasCommittedCurrentCapture` 使用同步 ref guard。

4. 调整 `workspace.css`
   - 移除设置页过重卡片视觉。
   - 增加属性页、设置行、快捷键表格、导航分组样式。
   - 增加右侧页面滚动、表格内部横向滚动、FTP/SFTP 窄宽折叠样式。
   - 移除或调整当前 `@media (max-width: 960px)` 设置页导航折叠规则，保证默认 `920px` 窗口仍是左侧导航。

5. 更新设置窗口配置和状态迁移
   - 更新 `settingsWindow.ts` 默认/最小尺寸与对应测试，最小尺寸改为 `800 x 560`。
   - 同步更新 `SettingsSection` 相关 reducer/controller/state/tests。
   - 增加 `normalizeSettingsSection` 单点映射旧 `"theme"`、`"rules"`。

6. 验证
   - `npm test`
   - `npm run build`
   - 如未改 Rust，不需要跑 Rust 检查；若改 IPC 或 Rust 校验则补跑 cargo check/test。

## 11. 测试设计

### 11.1 快捷键捕获测试

建议新增或更新 `SettingsSurface.test.tsx`：

1. 输入框获得焦点后进入捕获模式。
2. `keydown Ctrl` 后显示 `Ctrl`。
3. `keydown Ctrl` + `keydown Alt` + `keydown P` 后显示 `Ctrl+Alt+P`。
4. keyup 后确认并调用 `onUpdateShortcut(id, "Ctrl+Alt+P")`。
5. Ctrl+Alt+P 在不同释放顺序下都只确认一次。
6. Ctrl+Alt 这种多修饰键、无主键组合可以确认。
7. 普通 `input/change/paste/drop/composition` 不会修改快捷键。
8. Escape 取消并不调用更新。
9. Escape 在无候选值时恢复原值且不调用更新。
10. Enter 确认当前候选值。
11. Enter 在无候选值时恢复原值且不调用更新。
12. keyup 确认后再触发 blur，不会重复调用 `onUpdateShortcut`。
13. 确认后焦点仍在控件上，再按 Tab 应移动焦点，不应生成 `Tab` 候选。
14. 重新点击已聚焦控件后可以开始下一次捕获。
15. disabled/applying 状态下 focus、keydown、keyup、paste、drop、composition 都不能触发更新。
16. OS/WebView 不可靠键值 `Unidentified`、`Dead`、Meta/Win 不生成可保存候选。
17. window blur 对 OS 保留组合不误提交单 `Alt`、`Alt+Tab`、`Alt+F4`、Win/Meta 组合。
18. Tab 可以在捕获状态下被捕获为 `Tab`。
19. Alt+ArrowUp 格式化为 `Alt+Up`。
20. modifier-only 快捷键可以确认，例如 `Shift`。
21. Ctrl 单修饰键 keyup 提交为 `Ctrl`。
22. Alt 单修饰键 keyup 提交为 `Alt`。
23. 通过键盘 Tab 聚焦快捷键控件后，首次 Tab 可作为捕获候选；确认后下一次 Tab 移动焦点。
24. 捕获中点击设置窗口“确定”导致 blur 提交时，保存使用最新 binding 且只提交一次。
25. `change` 事件不会触发 `onUpdateShortcut`。
26. `dragover/drop` 不会把拖入文本写入快捷键。
27. 通过 Tab 聚焦后按 Escape 取消，再按 Tab 应移动焦点。

### 11.2 冲突测试

1. 同一 scope 内相同 binding 显示冲突。
2. 不同 scope 内相同 binding 不显示冲突。
3. 有冲突时确认按钮禁用或显示明确错误摘要。
4. `Alt+Ctrl+P` 与 `Ctrl+Alt+P` 显示为同一冲突。
5. ` ctrl + alt + p ` 与 `Ctrl+Alt+P` 显示为同一冲突。
6. 已有设置中大小写、空格、顺序不规范时，进入页面后冲突展示仍与后端一致。
7. 保存前传给 `onUpdateShortcut` 的 binding 已经是规范化存储格式。
8. `toBackendShortcut` 对 `Alt+Ctrl+P`、`ctrl + alt + p` 等未编辑旧值也输出规范化 accelerator。
9. `saveWorkspaceShortcuts` 和 `saveWorkspaceSettingsModel` 两条保存路径使用同一规范化函数。

### 11.3 布局结构测试

1. 设置窗口不再依赖 `.settings-modal` 或 `.settings-dialog`。
2. 左侧导航存在分组标题和当前选中项。
3. 右侧页面存在属性页标题和设置分组。
4. 快捷键页面使用列表/表格结构，不再为每个快捷键生成 `.settings-card`。
5. 七个导航项都通过 `WorkspaceState.settings.section` 驱动，不存在组件内第二套 section 状态。
6. 窄宽下右侧内容区滚动而 footer 固定可见。
7. 快捷键表格在窄宽下使用内部横向滚动，不撑开窗口。
8. FTP/SFTP 页面在窄宽下从左右结构折叠为上下结构。
9. 默认 `920px` 设置窗口宽度下仍使用左侧导航，不触发顶部导航折叠。
10. 当前 `@media (max-width: 960px)` 设置页折叠规则已移除或下调到小于 `800px`。
11. `settingsWindow.ts` 最小尺寸更新为 `800 x 560`，对应测试同步更新。

### 11.4 回归测试

1. 确认/取消按钮仍可触发对应回调。
2. disabled/applying 状态下控件不可编辑。
3. 远程连接 draft 保存/删除/测试行为不改变。
4. 主题、行高、右键菜单、颜色规则更新回调不改变。
5. FTP/SFTP 表单未点“暂存配置”时切换 profile 或确认窗口，不会静默改变已暂存数据。
6. 已暂存 profile 在点击设置窗口“确定”后仍按当前 `SettingsWindowView` 统一保存流程落地。
7. FTP/SFTP 表单存在未暂存修改时，点击“确定”会被阻止并显示提示，或经过显式确认丢弃；默认实现按阻止保存测试。
8. `normalizeSettingsSection` 将旧 `"theme"`、`"rules"` 单点映射到新 section，未知值回退到 `"shortcuts"`。

## 12. 风险与约束

1. 编码字符集风险
   - 当前部分文件在终端输出中存在中文错显，需要实现阶段谨慎检查实际文件编码。
   - 不应在本次 UI 重构中扩大无关中文文案改动。

2. 快捷键匹配格式风险
   - UI 显示格式和内部匹配格式必须保持一致。
   - 若只改显示不改 normalize，可能导致保存成功但快捷键不生效。
   - 前端冲突检测必须使用即将发送给后端的 normalized accelerator，否则会与 Rust `validate_shortcuts` 不一致。
   - DTO 边界如果仍原样透传旧 `binding`，未编辑旧值会绕过 UI 规范化，仍可能与后端校验分叉。

3. Tab 捕获与键盘导航冲突
   - 用户要求输入框获得焦点即捕获，因此 Tab 在捕获状态下应作为候选快捷键。
   - 需要提供 Enter/Escape/鼠标点击等方式退出捕获。
   - 确认或取消后必须进入非捕获的 focused 状态，保证后续 Tab 移动焦点。

4. Enter/Escape 绑定限制
   - 本设计把 Enter 作为确认、Escape 作为取消。
   - 这两个键本轮不作为可绑定快捷键，避免交互歧义。

5. 后端校验约束
   - 后端当前不接受空快捷键。
   - 本轮不设计“清空快捷键”。

6. OS 保留快捷键风险
   - Alt+Tab、Alt+F4、Ctrl+Alt+Del、Win 组合不保证 WebView 可拦截。
   - window blur 必须采用保守 denylist；实现只能避免误提交，不能承诺捕获这些系统级组合。

7. 导航 section 迁移风险
   - 现有 `SettingsSection` 只有四个值，扩展到七个值需要同步更新类型、reducer、测试和所有 switch 分支。
   - 不允许以组件局部状态临时代替，否则会出现保存后 section 不同步。

8. 响应式布局风险
   - 最小宽度提高到 800 后需要同步更新 `settingsWindow.ts` 和测试。
   - 表格内部横向滚动必须限制在右侧页面内，不能让整个窗口出现横向滚动。
   - 现有 `@media (max-width: 960px)` 会影响默认 920px 设置窗口，必须移除或下调设置页折叠断点。

9. 全局快捷键 guard 风险
   - 如果快捷键捕获控件使用 button/div 模拟输入框，现有全局 keydown 可能把它当作普通界面并触发工作区快捷键。
   - 本设计要求使用真实 `input readOnly`，或额外在设置窗口根节点阻断全局快捷键；推荐前者。

10. 远程连接未暂存风险
   - “确定”统一保存容易让用户以为当前表单也会自动暂存。
   - 默认必须阻止保存并提示未暂存修改，避免静默丢失。

## 13. 验收标准

方案实现后应满足：

1. 设置窗口视觉接近参考图的信息组织方式：左侧分组导航，右侧属性页。
2. 界面不再呈现 Web 卡片堆叠感。
3. 快捷键输入不能直接输入文本。
4. 输入框聚焦后可实时捕获 `Ctrl`、`Ctrl+Alt`、`Ctrl+Alt+P`。
5. blur、Enter 或 keyup 可以确认候选快捷键，且同一次捕获最多提交一次。
6. 确认或取消后焦点仍在控件上时，Tab 可以移动焦点，不会继续捕获。
7. Enter/Escape 在无候选值时不写入空快捷键。
8. 同 scope 冲突能在保存前发现并提示，且冲突判断与后端 accelerator 规范化一致。
9. DTO 保存边界对所有 shortcuts 输出规范化 accelerator，包括未编辑旧数据。
10. 七个导航项使用同一个 `WorkspaceState.settings.section` 状态，不存在第二套导航状态。
11. 默认 `920px` 设置窗口下仍是左侧导航，不被 960px 断点折叠为顶部导航。
12. 窄宽下 footer 保持可见，表格和 FTP/SFTP 页面有明确折叠/滚动策略。
13. FTP/SFTP 未暂存表单修改不会被“确定”静默丢弃，默认阻止保存并提示。
14. 不破坏现有设置保存、取消、远程连接 draft 行为。
15. `npm test` 与 `npm run build` 通过。

## 14. 审查流程

本设计需要经过两轮审查与修订：

1. 第一轮：已完成，结论为“需要修改”。
2. 第一轮修订：已补充快捷键状态机、焦点规则、规范化、导航状态归属、响应式布局和输入路径处理。
3. 第二轮：已完成，结论为“需要修改”。
4. 第二轮修订：已补充同步幂等 guard、Tab 聚焦序列、DTO 保存边界规范化、CSS 960px 断点调整、window blur denylist、真实 readOnly input 和 FTP/SFTP 未暂存确认语义。
5. 当前文档为可编码基线。进入实现阶段前不再新增设计审查轮次，除非用户提出新的范围或交互要求。
