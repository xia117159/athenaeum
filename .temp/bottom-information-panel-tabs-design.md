# 底部信息面板调整详细设计方案

## 1. 目标与范围

本方案只覆盖本轮设计，不包含编码实现。后续编码仍按 TDD 执行：先补测试，再实现，再重构。

目标：

- 底部始终显示“快搜摘要栏”，摘要栏可继续承载当前活动工作区的快速过滤、选中摘要、搜索状态和操作历史入口。
- 将摘要栏最右侧按钮从“关闭”改为“展开/收缩”，信息面板收缩时显示展开图标，展开时显示收缩图标。
- 将当前工具栏右侧的操作历史按钮移动到摘要栏展开/收缩按钮左侧。点击该按钮时展开底部面板并切换到“操作历史”Tab。
- 底部信息面板内容区增加顶层 Tab：`属性`、`查找`、`操作历史`。
- `属性` Tab 在本轮实现设计中作为一等功能纳入前后端契约，显示当前活动工作区的选中项属性，并兼容本地、SFTP、FTP 字段缺失。
- `查找` Tab 承载当前 `WorkspaceInformationPanel` 已实现的搜索条件与搜索历史。
- `操作历史` Tab 承载当前 `OperationTaskCenter` 的任务/历史内容，不再作为独立底部浮层打开。

非目标：

- 不重做搜索引擎、搜索结果 Tab、文件列表选择模型。
- 不重做文件操作任务系统、冲突处理对话框或 undo 语义。
- 不引入全新的并行工作区状态模型。
- 不在本方案中改变 `.temp/design.md` 的总体产品基线。

## 2. 已确认决策

- 多选属性：无选择显示当前目录摘要；单选显示完整属性；多选显示数量、总大小、共同位置、共同类型，无法统一的字段显示“多个值”。
- 属性数据：允许新增一个统一的薄 IPC，例如 `get_item_properties`。本地、FTP、SFTP 后端尽力返回统一 DTO；缺失字段通过结构化 `fieldStates` 显示为“不可用”“服务器未提供”“无法读取”“未计算”等状态。
- 操作历史按钮：点击后自动展开底部面板并切到“操作历史”Tab；如果已经展开，则只切换 Tab。
- 默认 Tab：底部面板默认 `属性`。用户打开搜索或编辑过滤/搜索条件时切换到 `查找`；点击操作历史按钮切换到 `操作历史`。

## 3. 现状诊断

### 3.1 当前前端结构

- `WorkspaceView.tsx` 根据 `state.search.open` 决定是否渲染整个底部信息面板。
- `WorkspaceInformationPanel.tsx` 同时承担两层职责：
  - 顶部摘要栏：过滤输入框、文件夹/选中摘要、状态、关闭按钮。
  - 搜索面板：搜索条件 Tab、搜索输入、扩展名过滤、搜索历史。
- `OperationSummaryButton` 目前位于顶部命令栏右侧 `.workspace-toolbar__history`。
- `OperationTaskCenter` 目前是 `WorkspaceView` 根部的绝对定位底部浮层，通过 `operations.tasksOpen` 控制显示。
- 当前 `EntryViewModel` 只有列表所需字段：名称、路径、扩展名、类型、大小标签、修改时间标签、属性标记、颜色和标签。它不足以支持创建日期、访问日期、占用空间等属性详情。

### 3.2 当前后端能力

- 本地列表在 `fs_service::entry_from_path` 中通过 `std::fs::symlink_metadata` 取得类型、大小、修改时间、隐藏/只读/符号链接等字段。
- SFTP 列表在 `remote_service::parse_sftp_entries` 中通过 `ssh2::FileStat` 取得 size、mtime、perm、symlink 等字段；`FileStat` 也可能提供 atime。
- FTP 列表当前主要通过目录列表解析，字段不稳定，可能无法可靠取得大小、创建时间、访问时间或占用空间。
- `resolve_system_icon` 已有 48px 级别图标解析能力，属性面板可复用 `FileSystemIcon` 并请求 `extra-large` 图标。

### 3.3 根因

当前“底部信息面板”等同于“搜索面板是否打开”，导致：

- 摘要栏无法在面板收缩后保留。
- 操作历史只能以独立浮层打开，不能成为底部面板内容的一部分。
- 属性数据没有独立 DTO，只靠列表项字符串无法正确表达缺失字段、精确字节数、创建/访问时间和占用空间。

## 4. 推荐架构

### 4.1 状态模型

新增独立的底部信息面板状态，避免继续把 `search.open` 当作面板开关。

建议类型：

- `InformationPanelTab = "properties" | "search" | "history"`
- `InformationPanelState`
  - `expanded: boolean`
  - `activeTab: InformationPanelTab`
  - `properties: PropertiesPanelState`
- `PropertiesPanelState`
  - `requestId?: string`
  - `targetKey?: string`
  - `status: "idle" | "loading" | "ready" | "failed"`
  - `item?: ItemProperties`
  - `summary?: MultiSelectionPropertiesSummary`
  - `errorMessage?: string`
- `WorkspaceBootstrap`
  - 新增 `informationPanel: InformationPanelState`
  - `mergeBootstrapWithSession` 负责把 `PersistedWorkspaceSession.informationPanel` 或默认值合并进 bootstrap
  - `createWorkspaceState` 只从 `WorkspaceBootstrap.informationPanel` 初始化 `state.informationPanel`

`SearchState` 保留搜索查询、过滤文本、搜索历史、进度和结果，但移除或停止使用 `open` 作为 UI 展开状态。实现时需要一次性迁移 `src/features/workspace/types.ts`、`workspaceReducer.ts`、`useWorkspaceController.ts`、`workspaceSessionStore.ts`、`WorkspaceView.tsx` 和相关测试，把旧的 `search.open` 用例改为 `informationPanel.expanded`，避免长期保留两个开关。

新增 reducer action：

- `informationPanelExpandedSet`
- `informationPanelTabChanged`
- `informationPanelHistoryRequested`：展开并切到 `history`
- `searchPanelRequested`：展开并切到 `search`
- `propertiesRequestStarted / propertiesRequestSucceeded / propertiesRequestFailed`：属性异步状态

现有 action 调整：

- `searchToggled` 不再直接控制 `search.open`。实现阶段建议改名为 `searchPanelRequested` 或保留旧 action 名但语义改为“展开底部面板并激活查找”，以降低调用点改动。
- `searchFilterChanged` 同时把 `informationPanel.activeTab` 置为 `search`，但不强制展开，避免用户只做快速过滤时触发布局跳动。
- `searchQueryChanged`、`searchStarted`、`searchHistorySelected` 应激活 `search`；`searchStarted` 应展开面板。
- `operationConflictRequested` 保持冲突对话框独立显示，同时可把底部面板切到 `history` 并展开，让任务上下文可见。

默认值与持久化：

- `PersistedWorkspaceSession` 新增 `informationPanel?: { expanded: boolean; activeTab: InformationPanelTab }`。
- 旧 session 缺少 `informationPanel` 时使用确定默认值：`expanded=false`，`activeTab="properties"`。不从旧 `search.open` 推导，因为当前 session 实际没有保存该字段。
- `informationPanel.activeTab` 默认为 `properties`。
- `layoutRatios.search` 继续表示底部面板展开时的内容高度比例，避免破坏已有布局持久化。
- `workspaceSessionStore` 负责读写 `informationPanel`。保存新 session 时写入该字段；读取旧 session 时补默认值。
- 完整恢复链路必须闭环：`readPersistedSession()` 读出 session，`mergeBootstrapWithSession(base, session, profiles)` 归一化并合并 `informationPanel`，`createWorkspaceState(bootstrap)` 从 bootstrap 初始化 reducer state。只改 `workspaceSessionStore` 读写不够。
- `SearchState.open` 在同一实现 slice 中删除，或仅作为一次性迁移输入读取后立即归一到 `informationPanel.expanded`，不得继续参与渲染判断。
- `workspaceBackendDtos.ts` 中的 `UiLayout.showSearch` 视为旧布局兼容字段。本轮不建议用它承载 `informationPanel.expanded`，除非同时修改 `toBackendLayout`、`mapWorkspaceBootstrap` 和后端 settings 读写，让它真实往返该状态。优先方案是：展开状态存在 workspace session，`showSearch` 后续另起兼容迁移改名。
- `layoutRatios.search` 作为兼容命名继续存在，但语义改为“底部信息面板展开内容区高度比例”。后续可迁移命名为 `informationPanel` 或 `bottomPanel`。

### 4.2 组件拆分

建议把 `WorkspaceInformationPanel.tsx` 拆为一个 shell 和三个内容组件：

- `WorkspaceInformationPanel`
  - 负责底部面板容器、展开/收缩、顶层 Tab、摘要栏。
  - 摘要栏始终渲染。
- `InformationSummaryBar`
  - 左侧：快速过滤输入框。
  - 中间：文件夹摘要、选中摘要、选中名称、搜索/任务状态。
  - 右侧：操作历史按钮、展开/收缩按钮。
  - 响应式优先级：右侧两个图标按钮固定宽度且永不换行；过滤框保留最小可用宽度；摘要文本按优先级 ellipsis 或隐藏到 tooltip，禁止把摘要栏撑成多行。
- `PropertiesPanel`
  - 显示无选择、单选、多选三种属性视图。
- `SearchPanelContent`
  - 迁移现有搜索条件区和搜索历史区。
- `OperationHistoryPanelContent`
  - 复用并改造现有 `OperationTaskCenter` 内容。

`OperationTaskCenter` 的建议处理：

- 保留 `OperationConflictDialog` 独立，因为它是模态冲突流程，不应塞入 Tab。
- 把 `OperationTaskCenter` 中的任务分区、最近完成、操作历史行抽成可复用内容组件。
- 移除或废弃底部绝对定位的 `OperationTaskCenter` 浮层入口。
- `OperationSummaryButton` 移动到摘要栏右侧，并保持任务数量、等待、失败状态提示。

### 4.3 布局与动画

底部摘要栏应作为整个工作区右侧区域的底部锚点：

- 收缩状态：主工作区占据可用空间，底部只显示 28-32px 高的摘要栏。
- 展开状态：内容区在摘要栏上方向上滑入；摘要栏仍固定在最底部。
- 收缩时：内容区向下滑出并释放空间，主工作区恢复高度。

建议 DOM 结构：

- `.workspace-main__right`
  - `.workspace-main__panels`
  - `.information-panel`
    - `.information-panel__content-shell`
      - 顶层 Tab
      - 当前 Tab 内容
    - `.information-panel__summary`

展开状态可以继续使用 `ResizableSplit` 管理“主面板区”和“底部内容区”的高度，但摘要栏必须位于 split 外层最底部，避免拖动 split 时摘要栏从底部移走。推荐结构是：右侧区域使用三段布局，第一段为主面板区，第二段为可展开内容区，第三段为常驻摘要栏；展开时第一段和第二段之间出现 split handle，收缩时第二段高度为 0 且不显示 handle。这样收缩状态只有摘要栏占高，展开状态内容向上进入，摘要栏位置稳定。

动画建议：

- 内容区高度由展开状态控制，CSS 使用 `grid-template-rows` 或 `max-height` 过渡。
- 内容区内部使用 `transform: translateY(...)` 和 `opacity` 做滑入/滑出。
- 动画时长 120-160ms，使用 `ease-out` 展开、`ease-in` 收缩。
- 尊重 `prefers-reduced-motion: reduce`，禁用 transform 过渡。

视觉规范：

- 摘要栏高度保持桌面密度，推荐 30px。
- 顶层 Tab 高度 26px 左右，采用 Windows 桌面式方形 Tab，不使用大圆角胶囊。
- 内容区背景使用白色或极浅灰，边线使用 1px hairline，不使用卡片嵌套。
- 按钮使用 lucide 图标：
  - 操作历史：`History`，保留状态计数。
  - 展开：`ChevronUp` 或 `PanelBottomOpen`。
  - 收缩：`ChevronDown` 或 `PanelBottomClose`。
- 所有图标按钮必须有 `title` 和 `aria-label`。
- 摘要栏在窄宽度下仍保持单行。推荐优先保留过滤框、操作历史按钮、展开/收缩按钮；文件夹摘要、选中名称、状态文本可按优先级隐藏为 title/tooltip。
- 顶层 Tab 使用 `role="tablist"` / `role="tab"` / `aria-controls`，支持左右方向键切换。查找 Tab 内部的“名称/内容”子 Tab 必须有独立 aria-label，避免与顶层 Tab 混淆。

## 5. 属性 Tab 设计

### 5.1 数据来源选择

属性面板的目标由当前活动面板和活动 Tab 决定：

- 活动 Tab 是目录 Tab：
  - 无选择：当前目录本身，可请求单个目录属性。
  - 单选：选中的文件或文件夹，请求单个项目属性。
  - 多选：本轮仅基于当前 `EntryViewModel[]` 做有限汇总，不循环触发 N 次 `get_item_properties` IPC。
- 活动 Tab 是导航 Tab：
  - 显示“导航页”摘要，不请求文件属性。
- 活动 Tab 是搜索结果 Tab：
  - 当前搜索结果列表暂未实现选择模型，本轮显示搜索结果 Tab 摘要；后续若搜索结果支持选择，再接入相同属性目标选择逻辑。

属性请求只在以下情况触发：

- `informationPanel.activeTab === "properties"`。
- 活动面板、活动 Tab、单选目标或无选择时当前目录路径变化。
- 面板从收缩变为展开且当前 Tab 是 `properties`。

请求必须携带 `requestId` 或 `selectionKey`。响应回来时如果目标已变化，reducer 忽略过期结果，避免快速切换目录或选择时显示错属性。

多选属性本轮不请求后端详情，原因是远程多选逐项 stat 会引入连接压力、陈旧响应和 UI 卡顿风险。多选摘要使用列表已知字段：数量、共同父目录、共同类型、共同后缀、已知大小汇总、未知/目录未计算计数。后续若需要精确多选属性，应新增 `get_item_properties_summary` 或 batch IPC，明确 requestId、并发限制、非递归目录策略、取消和字段缺失规则。

多选大小汇总不得从 `sizeLabel` 反解析。本方案明确选择在前端 `EntryViewModel` 增加 `sizeBytes?: number | null`，由 `workspaceMappers.mapEntryViewModel` 从后端 `EntryViewModel.size` 原始数值映射。多选 `knownSizeBytes` 只汇总该字段；没有 `sizeBytes` 的项计入 `unknownSizeCount`。这是进入属性 UI Slice 前的必做契约变更。

### 5.2 属性显示规则

单选视图显示：

- 48x48 图标。
- 名称。
- 后缀名。
- 类型：文件、文件夹、符号链接、远程文件等。
- 位置。
- 大小。
- 占用空间。
- 创建日期。
- 修改日期。
- 访问日期。
- 属性标记：只读、隐藏、符号链接、目录、远程等。

无选择视图：

- 显示当前目录图标、名称、位置。
- 显示当前列表项数量、过滤后项数量、已知大小摘要。
- 若当前目录可取得元数据，则显示目录本身的创建/修改/访问日期。

多选视图：

- 图标使用多选/文件夹组合图标或通用文件夹图标。
- 名称显示 `已选择 N 项`。
- 位置：全部相同父目录时显示该目录，否则显示 `多个位置`。
- 类型：全部同类型时显示该类型，否则显示 `多个类型`。
- 后缀名：全部相同时显示，否则显示 `多个值`。
- 大小：汇总已知文件大小；如果含目录且目录大小未计算，显示 `已知 X，另有目录未计算`。
- 占用空间、创建/修改/访问日期：只有所有选中项可统一或可汇总时显示，否则显示 `多个值` 或 `不可用`。

缺失字段显示：

- 后端返回 `null` 时不能直接等同为普通空值，必须结合字段状态渲染。
- 字段状态为 `notAvailable` 时显示 `不可用`。
- 字段状态为 `unsupported` 时显示 `服务器未提供`。
- 字段状态为 `permissionDenied` 或 `readFailed` 时显示 `无法读取`，并在详情区显示短错误。
- 字段状态为 `notComputed` 时显示 `未计算`。
- 字段状态为 `computing` 时显示 `正在计算...`。
- 多选摘要中无法统一的字段显示 `多个值`；未知字段按未知计数显示，例如 `已知 4 项，2 项不可用`。

### 5.3 属性 DTO

新增统一 DTO，TypeScript 与 Rust 保持 camelCase。

建议后端类型：

- `ItemPropertiesRequest`
  - `requestId: String`
  - `target: ItemPropertiesTarget`
  - `includeDirectorySize: bool`
- `ItemPropertiesTarget`
  - 本地：`{ kind: "local", path: String }`
  - 远程：`{ kind: "remote", protocol: "ftp" | "sftp", profileId: String, remotePath: String, displayPath: String }`
- `ItemProperties`
  - `requestId`
  - `target`
  - `displayPath`
  - `actualPath`
  - `parentPath`
  - `name`
  - `extension`
  - `kind`
  - `sizeBytes`
  - `allocatedBytes`
  - `createdAt`
  - `modifiedAt`
  - `accessedAt`
  - `isHidden`
  - `isReadOnly`
  - `isSymlink`
  - `directorySizeState`
  - `fieldStates`
  - `errorMessage`
- `ItemPropertyField`
  - `"name" | "extension" | "kind" | "parentPath" | "sizeBytes" | "allocatedBytes" | "createdAt" | "modifiedAt" | "accessedAt" | "attributes" | "directorySize"`
- `ItemPropertyFieldState`
  - `field: ItemPropertyField`
  - `state: "available" | "notAvailable" | "unsupported" | "permissionDenied" | "readFailed" | "notComputed" | "computing"`
  - `message?: String`
- `DirectorySizeState`
  - `state: "notApplicable" | "notComputed" | "computing" | "available" | "failed"`
  - `sizeBytes?: u64`
  - `message?: String`
- `MultiSelectionPropertiesSummary`
  - `selectionKey`
  - `count`
  - `knownSizeBytes`
  - `unknownSizeCount`
  - `directoryCount`
  - `commonParentPath?: string`
  - `commonKind?: "file" | "folder"`
  - `commonExtension?: string`
  - `fieldStates`

说明：

- `sizeBytes` 和 `allocatedBytes` 使用数字字节，不使用格式化字符串。
- 日期使用 ISO 字符串或 `DateTime<Utc>` 序列化，前端统一格式化。
- 对本地请求：`target.kind="local"`，`target.path` 为规范化本地路径。
- 对远程请求：`target.kind="remote"`，`profileId` 为连接配置 id，`remotePath` 为服务端路径，`displayPath` 为前端展示 URI。后端只用 `profileId + remotePath` 操作服务器，不得反解析 `displayPath`。
- `ItemPropertiesTarget.remote` 不携带密码是刻意设计。command 通过 `profileId` 从 `AppState.metadata` 查找已保存 profile，并按现有远程服务规则读取 `credential_target` 对应凭据。前端不在属性请求中传密码，避免属性 DTO 与现有远程 profile/credential 模型分裂。
- 后端 `EntryKind::Directory` 到前端 `EntryKind="folder"` 的转换仍发生在前端 mapper 边界，属性 DTO 不引入第二套类型含义。
- `fieldStates` 用于表达 FTP/SFTP 缺失字段、权限失败、读取失败和未计算状态，不把缺失伪装成 0 或普通空字符串。
- nullable 字段必须由对应 `fieldStates` 或 `directorySizeState` 解释：例如 `sizeBytes=null` 对目录可对应 `directorySizeState.notComputed`，对 FTP 文件可对应 `fieldStates[{ field: "sizeBytes", state: "unsupported" }]`。
- 本地文件的 `allocatedBytes` 可在 Windows 上通过系统 API 获取；不可用时返回 `null`。
- `includeDirectorySize` 默认应为 `false`。本轮属性 Tab 先显示目录元数据和“目录大小未计算”，避免选中大目录或远程目录时阻塞 UI。后续如果增加“计算大小”按钮或自动后台计算，应单独设计取消、进度和陈旧响应处理。

### 5.4 IPC 与服务边界

新增 Tauri command：

- `get_item_properties(request: ItemPropertiesRequest) -> Result<ItemProperties, String>`

挂载位置：

- Rust command 放在 `src-tauri/src/commands/workspace.rs`，因为属性是工作区通用能力；实现为 `async fn`。
- 本地实现放在 `src-tauri/src/services/fs_service.rs`。
- 远程实现放在 `src-tauri/src/services/remote_service.rs`，由 command 根据 `request.target.kind` 分发。
- 远程分支必须复用现有远程命令的阻塞隔离模式：在 Tauri async command 中使用 `tauri::async_runtime::spawn_blocking` 或提取现有 `commands/remote.rs` 的 `run_remote_blocking` 为共享 helper，避免 SFTP `lstat`、FTP/curl 查询阻塞 async runtime。
- 远程分支必须复用现有 profile lookup、credential 读取、host key/连接策略和 `remotePath` root 范围校验，行为与 `list_remote_directory`、远程文件操作一致。
- 新 command 需要注册到 `src-tauri/src/lib.rs` 的 `generate_handler!`。
- 新 command 需要加入 Tauri v2 权限：`src-tauri/permissions/default.toml` 的默认 permission 列表增加 `allow-get-item-properties`，并新增对应 `[[permission]]` 条目，commands 列表包含 `"get_item_properties"`。`src-tauri/capabilities/default.json` 继续通过 `"default"` permission 引用该 allow-list。
- 前端 gateway 放在新文件 `workspacePropertiesGateway.ts` 或合并进 `workspaceDirectoryGateway.ts`。建议新文件，避免目录浏览 gateway 继续膨胀。

前端调用：

- `WorkspaceGateway` 增加 `getItemProperties(target)`。
- 对本地路径：传 `target: { kind: "local", path }`。
- 对远程 URI：先用现有 `resolveRemotePath` 得到 `profileId` 和 `remotePath`，再传 `target: { kind: "remote", protocol, profileId, remotePath, displayPath }`；Rust 不应解析前端展示用的 `ftp://user@host/root` 字符串。
- 浏览器 fallback：基于当前 `EntryViewModel` 生成有限属性，字段缺失显示 `不可用`，只用于非 Tauri 环境和测试。

后端兼容性：

- 本地：读取 `symlink_metadata`，尽力读取 created/modified/accessed。Windows 可额外读取 attributes 和 allocated size。
- SFTP：使用 `lstat`，映射 size、mtime、atime、perm、file_type；created 和 allocated 通常不可用。
- FTP：优先使用目录列表或可用命令返回的 size/modified；无法取得时返回对应 `fieldStates`，不报错。

## 6. 查找 Tab 设计

`查找` Tab 迁移现有搜索面板内容，保留当前行为：

- 名称/内容两个搜索子 Tab 可继续存在于查找 Tab 内部。
- 扩展名过滤、大小写、递归、包含文件夹、搜索历史逻辑不变。
- 摘要栏过滤输入框仍控制 `search.filterText`，用于过滤当前活动列表和搜索结果。
- 点击顶部命令栏搜索按钮或快捷键 `Ctrl+F` 时：
  - 展开底部面板。
  - 激活 `查找` Tab。
  - 焦点进入查找内容输入或摘要栏过滤输入，具体实现可按现有焦点习惯决定。
- 用户在摘要栏过滤框输入时：
  - 更新 `search.filterText`。
  - 激活 `查找` Tab。
  - 不强制展开面板。

## 7. 操作历史 Tab 设计

操作历史 Tab 应承载当前操作中心内容，但不再作为独立浮层出现。

内容结构：

- 顶部紧凑工具行：任务数、历史数、撤销最近操作按钮。
- 下方分区：
  - 进行中。
  - 等待处理。
  - 问题。
  - 最近完成。
  - 操作历史。

在宽屏下沿用当前 5 列高密度网格；窄宽度下改为横向可滚动或 2 列/1列响应式，避免文本挤压重叠。

交互：

- 摘要栏操作历史按钮点击：展开并切到该 Tab。
- 有等待冲突或失败任务时，按钮保留醒目但克制的计数状态。
- 撤销单条记录仍在历史行内执行。
- 冲突对话框仍使用现有 `OperationConflictDialog`，保持模态和焦点陷阱。

状态迁移：

- `operations.tasksOpen` 不再用于控制独立浮层显示。
- 可将其迁移为 `informationPanel.activeTab === "history" && informationPanel.expanded`，或保留短期兼容 action `operationTasksOpenSet(true)`，内部转发为“打开历史 Tab”。
- `operationTasksOpenSet(false)` 不应无条件收缩底部面板，因为用户可能已经切到属性或查找。兼容期建议只在当前 Tab 仍为 `history` 且调用来源是旧操作中心关闭按钮时才收缩；更推荐删除旧关闭按钮调用点，并显式使用 `informationPanelExpandedSet(false)`。

## 8. WorkspaceView 装配方案

`WorkspaceView` 应继续从现有 controller 接收 `state` 和 `actions`，组件不直接调用 Tauri。

主要装配变化：

- 顶部 `.workspace-toolbar__history` 删除或清空，不再渲染 `OperationSummaryButton`。
- `WorkspaceRightContent` 不再只在 `state.search.open` 时渲染底部信息面板。
- `WorkspaceInformationPanel` 始终渲染摘要栏。
- 展开时在主面板与底部内容之间渲染可拖拽 split handle，并使用 `layoutRatios.search`。
- 收缩时仅显示摘要栏，不显示 split handle，也不保留内容区占位高度。

`WorkspaceInformationPanel` props 应从“搜索专用”扩展为：

- `informationPanel`
- `search`
- `operations`
- `activeEntries`
- `selectedEntries`
- `workspaceActiveTab`，用于区分工作区当前 Tab，避免与信息面板顶层 Tab、查找内部子 Tab 混淆。
- `propertiesState`
- 搜索 actions。
- 操作 actions。
- 属性刷新/请求 actions。
- 展开、收缩、切换顶层 Tab actions。

属性请求不应由展示组件直接触发 Tauri。`WorkspaceView` 或 `WorkspaceInformationPanel` 只提交“目标变化/刷新”意图；`useWorkspaceController` 负责监听状态和调用 `workspaceGateway.getItemProperties`。

## 9. TDD 验证计划

### 9.1 Reducer 测试

新增或更新 `workspaceReducer.test.ts`：

- 初始状态包含 `informationPanel.expanded` 和默认 `activeTab = "properties"`。
- 旧 bootstrap/session 缺少 `informationPanel` 时得到确定默认值：`expanded=false`，`activeTab="properties"`。
- 新 session 保存并恢复 `informationPanel.expanded` 和 `informationPanel.activeTab`。
- `mergeBootstrapWithSession` 将 session 中的 `informationPanel` 合并进 `WorkspaceBootstrap`，`createWorkspaceState` 从 bootstrap 初始化 state，覆盖 `readPersistedSession -> mergeBootstrapWithSession -> createWorkspaceState` 完整链路。
- `SearchState.open` 不再参与渲染状态；相关旧 action 只转发到 `informationPanel`。
- 展开按钮 action 只改变 expanded，不破坏搜索状态。
- 收缩按钮 action 只收缩内容区，摘要栏仍由组件常驻渲染。
- 打开搜索 action 展开并激活 `search`。
- `searchFilterChanged` 激活 `search` 但不强制展开。
- 操作历史按钮 action 展开并激活 `history`。
- 属性 requestId 不匹配时忽略旧响应。
- 切换活动面板或选中项后重置属性加载状态。
- 多选只生成 `MultiSelectionPropertiesSummary`，不触发逐项属性 IPC。
- 多选 size 汇总只使用 `EntryViewModel.sizeBytes`，不会反解析 `sizeLabel`。

### 9.2 组件测试

新增或更新 `WorkspaceInformationPanel.test.tsx`：

- 收缩状态只渲染摘要栏，不渲染内容 Tab。
- 展开状态渲染 `属性 / 查找 / 操作历史` 顶层 Tab。
- 展开/收缩按钮 aria-label 和图标状态正确。
- 操作历史按钮位于展开/收缩按钮左侧，点击触发打开历史 Tab。
- 查找内容从旧搜索面板迁移后，原搜索输入、历史选择、删除历史、运行/停止搜索行为保持。
- 属性 Tab 正确渲染无选择、单选、多选和字段缺失状态。
- 48x48 图标容器尺寸稳定。
- 摘要栏在窄宽度下仍为单行：图标按钮固定，过滤框可收缩，低优先级摘要 ellipsis 或隐藏到 title/tooltip，不因换行撑高。
- 顶层 Tab 有完整 `role=tablist`、`aria-controls` 和方向键切换测试；查找内部子 Tab 与顶层 Tab 的 aria-label 不冲突。

更新 `OperationTaskCenter.test.tsx`：

- 抽出的操作历史内容组件在 Tab 容器内可渲染所有分区。
- 独立浮层不再由 `tasksOpen` 渲染，冲突对话框仍独立。

更新 `WorkspaceVisualDensity.test.ts`：

- 顶部工具栏不再包含 `.workspace-toolbar__history` 的操作历史按钮。
- `WorkspaceView` 始终包含 `WorkspaceInformationPanel`。
- 摘要栏高度、Tab 高度、按钮尺寸符合桌面密度。
- 不出现 nested card、圆角卡片式布局、营销式面板。

### 9.3 Gateway/IPC 测试

新增 `workspacePropertiesGateway.test.ts`：

- 本地路径调用 `get_item_properties` 时参数为 `{ requestId, target: { kind: "local", path }, includeDirectorySize: false }`。
- 远程 URI 通过 `resolveRemotePath` 转换为 `{ kind: "remote", protocol, profileId, remotePath, displayPath }`，请求不携带 password。
- 远程属性 gateway 在连接配置不存在时失败，不把展示 URI 当作真实服务器路径。
- 浏览器 fallback 只生成有限属性，不吞掉 Tauri 真实错误。
- 后端 nullable 字段结合 `fieldStates` 映射为 `不可用`、`服务器未提供`、`无法读取`、`未计算` 或 `正在计算`。

更新 `workspaceBackendDtos.test.ts` 或新增类型契约测试：

- `ItemPropertiesRequest` 和 `ItemProperties` 字段命名为 camelCase。
- `sizeBytes/allocatedBytes` 为 number/null，不是格式化字符串。
- 远程请求不会把展示 URI 传给 Rust 作为实际远程路径。
- `PersistedWorkspaceSession.informationPanel` 读写测试覆盖新 session 与旧 session 缺省值。
- `workspaceMappers.test.ts` 覆盖后端 `EntryViewModel.size` 映射为前端 `EntryViewModel.sizeBytes`，目录或未知大小保持 `null`。
- `workspaceIpc.test.ts` 的 required commands 增加 `get_item_properties`，并断言 `src-tauri/permissions/default.toml` 暴露 `"get_item_properties"`。
- `ItemPropertyField`、`ItemPropertyFieldState` 和 `DirectorySizeState` 的 contract 测试覆盖字段名和值域，避免三套状态含义分裂。

### 9.4 Rust 测试

新增或更新 Rust 单元测试：

- `fs_service` 本地文件属性：名称、扩展名、size、modifiedAt、readonly/hidden/symlink 映射正确。
- 本地目录属性不会把未知目录大小伪装为 0。
- Windows allocated size 不可得时返回 None，不失败。
- `remote_service` SFTP FileStat 映射 size、mtime、atime、perm、symlink。
- FTP 缺字段时返回对应 `fieldStates`，不把缺失视为命令失败。
- `get_item_properties` command 校验本地/远程 request 并分发到正确服务。
- 远程 `get_item_properties` 在 `spawn_blocking` 边界内执行 SFTP `lstat` 或 FTP/curl 查询。
- 远程 request 必须校验 profile 存在、协议匹配、`remotePath` 位于 profile root 内，且不解析 `displayPath` 作为真实路径。
- 远程属性请求不携带 password；command 从已保存 profile 的 `credential_target` 读取凭据，行为与现有远程目录/操作一致。
- `DirectorySizeState` 对文件、本地目录、远程目录、失败状态的映射明确可测。

### 9.5 常规验证

实现完成后按项目规则运行：

- `npm test`
- `npm run build`
- `cargo check --manifest-path src-tauri/Cargo.toml --offline`
- `cargo test --manifest-path src-tauri/Cargo.toml --offline`

不使用 `npm run dev` 作为常规验证。

## 10. 分步实施建议

### Slice 1：状态与组件骨架

- 增加 `InformationPanelState`、`PersistedWorkspaceSession.informationPanel`、reducer action 和测试。
- 同一 slice 删除或迁移 `SearchState.open` 渲染语义，避免双开关。
- 扩展 `WorkspaceBootstrap`，让 `mergeBootstrapWithSession` 合并 `informationPanel`，`createWorkspaceState` 从 bootstrap 初始化 state。
- `WorkspaceInformationPanel` 始终渲染摘要栏。
- 顶层 Tab 先接空内容占位。
- 移动操作历史按钮到摘要栏。

验收：收缩/展开/Tab 切换行为可测，工具栏按钮已移除，session 可保存/恢复底部面板状态。

### Slice 2：查找 Tab 迁移

- 将现有搜索内容迁入 `SearchPanelContent`。
- 保持搜索查询、运行、停止、历史选择和删除行为不变。
- 搜索入口和过滤输入激活 `查找` Tab。

验收：旧 `WorkspaceInformationPanel` 搜索测试迁移后仍覆盖原行为。

### Slice 3：操作历史 Tab 迁移

- 抽出 `OperationHistoryPanelContent`。
- `operationTasksOpenSet(true)` 转发为打开历史 Tab，或更新所有调用点直接使用新 action。
- 保留 `OperationConflictDialog`。

验收：操作任务和历史分区在 Tab 内显示，冲突对话框不回归。

### Slice 4：属性 DTO 与 gateway

- 新增 TypeScript DTO、gateway 和 browser fallback。
- 新增 Rust DTO、command、service 方法。
- command 为 async，远程 I/O 进入阻塞隔离边界。
- 更新 `src-tauri/permissions/default.toml`，加入 `allow-get-item-properties`。
- 完成本地和 SFTP 属性基础映射；FTP 字段缺失可显示不可用。

验收：本地文件/目录、SFTP 文件、FTP 缺失字段都有测试。

### Slice 5：属性 Tab UI

- 在前端 `EntryViewModel` 和 mapper 中加入 `sizeBytes?: number | null`，供多选大小汇总使用；禁止从 `sizeLabel` 反解析。
- 完成 `PropertiesPanel` 三种状态。
- 接入属性请求生命周期和 requestId 防陈旧。
- controller 负责生成 `requestId`/`targetKey` 并调用 gateway；reducer 只接收 started/succeeded/failed 并做陈旧响应过滤。
- 接入 48x48 系统图标。

验收：无选择、单选、多选、加载、错误、缺失字段状态均有组件测试。

### Slice 6：视觉收口与构建

- 调整 CSS 动画、密度、响应式布局。
- 更新视觉密度测试。
- 跑完整验证命令。

## 11. 风险与缓解

- 风险：把 `search.open` 和新 `informationPanel.expanded` 并存会产生双开关。
  - 缓解：实现时一次性把渲染逻辑迁到 `informationPanel.expanded`，`SearchState.open` 同 slice 删除或只作为迁移输入，不长期保留双状态。
- 风险：旧 session 和后端 `UiLayout.showSearch` 无法真实表达新面板状态。
  - 缓解：新增 `PersistedWorkspaceSession.informationPanel`；旧 session 使用确定默认值；`UiLayout.showSearch` 本轮作为旧兼容字段，不承载新状态。
- 风险：session 保存后不能恢复到 reducer state。
  - 缓解：新增 `WorkspaceBootstrap.informationPanel`，并测试 `readPersistedSession -> mergeBootstrapWithSession -> createWorkspaceState` 链路。
- 风险：属性 DTO 契约分裂。
  - 缓解：只使用 `ItemPropertiesRequest.target` union 作为 canonical request；gateway、Rust command 和测试都围绕该 union。
- 风险：多选属性逐项请求造成远程压力和陈旧响应。
  - 缓解：本轮多选只基于 `EntryViewModel` 做有限汇总；精确多选属性必须另设 batch/summary IPC。
- 风险：多选汇总反解析 `sizeLabel` 导致精度和单位错误。
  - 缓解：前端 `EntryViewModel` 增加原始 `sizeBytes?: number | null`，多选只汇总该字段。
- 风险：字段缺失被渲染成普通空值或 0。
  - 缓解：所有缺失、未计算、协议不支持、权限失败和读取失败都通过 `fieldStates` 表达。
- 风险：`directorySizeState` 与 `fieldStates` 含义分裂。
  - 缓解：定义 `ItemPropertyField` union、`ItemPropertyFieldState` 和 `DirectorySizeState`，nullable 字段必须由对应状态解释。
- 风险：远程属性查询阻塞 Tauri async runtime。
  - 缓解：`get_item_properties` 为 async command，远程分支使用 `spawn_blocking` 或共享远程阻塞 helper，并复用 profile/credential/root 校验。
- 风险：新增 command 只注册 handler，未进入 Tauri v2 权限 allow-list。
  - 缓解：更新 `src-tauri/permissions/default.toml` 并扩展 `workspaceIpc.test.ts` 的 required command 检查。
- 风险：远程属性请求凭据契约分裂。
  - 缓解：remote target 不携带 password；command 从已保存 profile 的 `credential_target` 读取凭据。
- 风险：目录大小递归计算阻塞 UI 或远程服务器。
  - 缓解：`includeDirectorySize=false` 为默认；目录大小使用 `directorySizeState` 表达未计算，不用 0 伪装；远程目录默认不深度扫描。
- 风险：操作历史浮层和 Tab 内容重复。
  - 缓解：抽出内容组件，删除独立浮层入口，只保留冲突对话框。
- 风险：快速切换选择导致属性显示陈旧。
  - 缓解：属性请求携带 `selectionKey/requestId`，reducer 校验后再提交。
- 风险：底部动画影响 split 布局。
  - 缓解：展开时才渲染 split handle；收缩时只保留摘要栏；动画只作用内容壳，不改变摘要栏尺寸。
- 风险：摘要栏窄宽度换行撑高。
  - 缓解：摘要栏单行固定高度；右侧图标固定，文本按优先级 ellipsis 或隐藏到 tooltip。

## 12. 第一轮审查修订记录

根据第一轮审查，本文档已修订以下阻塞和高风险点：

- 明确 `PersistedWorkspaceSession.informationPanel` 是唯一持久化来源，旧 session 缺失时使用确定默认值，不再从不存在的 `search.open` 或旧 `showSearch` 推导。
- 将属性请求改为唯一 canonical `target` union，消除 `locationKind`、`request.location.kind` 和测试示例之间的不一致。
- 明确多选属性本轮只做前端有限汇总，不循环触发 N 次属性 IPC。
- 用结构化 `fieldStates` 替代单纯 `unavailableFields`，支持 `不可用 / 服务器未提供 / 无法读取 / 未计算 / 正在计算` 等字段级状态。
- 明确远程属性 command 是 async，并在远程 SFTP/FTP 查询时使用阻塞隔离边界和现有远程 profile/credential/root 校验。
- 补充摘要栏窄宽度响应式优先级，避免单行底栏被撑高。

## 13. 修订版结论

最佳实践方案是将“底部信息面板”从“搜索面板开关”提升为独立的工作区底部 shell：摘要栏常驻底部，内容区通过展开状态显示，并用顶层 Tab 管理属性、查找和操作历史。属性功能通过统一 DTO 和薄 IPC 接入本地/远程后端，所有不可得字段显式表达为不可用，避免前端猜测或用列表字符串拼接属性。

第一轮审查指出的阻塞点已在本文档中收敛。第二轮审查指出的 session 恢复链路、多选大小来源、Tauri 权限、远程凭据策略、字段状态类型定义也已补齐。方案可以进入 Slice 1 的 TDD 实现；进入 Slice 4/5 前应再次对属性 DTO 与 Rust/TS 契约测试做逐项核对。

## 14. 第二轮审查修订记录

根据第二轮审查，本文档继续补齐：

- `WorkspaceBootstrap.informationPanel` 与 `mergeBootstrapWithSession -> createWorkspaceState` 恢复链路。
- 多选大小汇总依赖新增 `EntryViewModel.sizeBytes`，禁止从 `sizeLabel` 反解析。
- `get_item_properties` 需要加入 `src-tauri/permissions/default.toml` 的 `allow-get-item-properties`，并更新 `workspaceIpc.test.ts`。
- 远程属性请求不携带 password，由后端通过 profile `credential_target` 读取凭据。
- `ItemPropertyField`、`ItemPropertyFieldState` 和 `DirectorySizeState` 的具体类型和值域。
- controller 负责生成 `requestId`/`targetKey`，reducer 负责陈旧响应过滤。
