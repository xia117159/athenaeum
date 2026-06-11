# 导航 Tab 页实现方案

日期：2026-06-08  
范围：只做方案设计，不做编码实现。

## 0. 确认结论与默认决策

我对当前需求没有必须先向用户追问的阻塞疑问。未明确的实现点按下面的最佳实践默认值推进，并保留可替代选项。

| 决策点 | 推荐默认值 | 可替代选项 | 原因 |
| --- | --- | --- | --- |
| 导航 Tab 唯一性 | 全工作区全局唯一：所有标签页面板合计最多一个导航 Tab | 每个面板一个导航 Tab | 用户明确“多个标签页面板只能有一个导航Tab页”，全局单例最符合语义。 |
| 打开位置 | 工具菜单打开时，若已存在则激活；若在不可见面板中，则移动到当前可见活动面板后激活 | 固定打开到 panel-1 或自动切换布局 | 当前工作区以活动面板为操作上下文；移动到可见面板可避免“已打开但看不见”。 |
| 关闭行为 | 关闭导航 Tab 只隐藏该 Tab，不删除导航项配置；下次启动按会话恢复是否打开 | 每次启动默认关闭 | 配置与 Tab 可见性分离，避免误关 Tab 导致数据丢失。 |
| 导航项目标范围 | 第一阶段以本地绝对路径为主；远程路径显示为“暂不支持系统操作”并作为后续扩展 | 立即支持 FTP/SFTP 文件和文件夹 | 系统默认打开、Windows 原生右键菜单天然面向本地 Shell 对象；远程文件默认打开需要下载/缓存策略。 |
| 缺失路径 | 允许保存，但显示“缺失/不可访问”状态，双击阻止打开并提示 | 保存时强制必须存在 | 可移动盘、网络盘、临时目录可能短暂不可用；保留快捷入口更友好。 |
| 文件双击 | 调用 Windows 系统默认方式打开文件，例如 `.html` 交给默认浏览器 | 应用内预览 | 用户明确要求系统默认方式，且能复用文件关联。 |
| 文件夹双击 | 在导航 Tab 所在面板打开新的普通文件夹 Tab 并激活 | 替换当前导航 Tab | 用户明确“打开一个新的文件夹 tab 选项卡”，不应把导航 Tab 转成目录 Tab。 |
| 右键菜单 | 默认显示应用菜单；其中提供明确标注的 `Windows 文件操作...` 入口来打开系统原生菜单 | 右键直接打开 Windows 原生菜单 | 直接进原生菜单会让“删除导航项”和“删除真实文件”混淆，也会丢失编辑/移除导航项入口。 |

## 1. 目标与非目标

目标：

- 导航 Tab 在普通标签栏内显示、可激活、可移动、可关闭，但全局只能存在一个。
- 用户通过菜单栏“工具”打开或关闭导航 Tab。
- 导航 Tab 显示用户配置的文件或文件夹快捷入口，不在文件系统中创建 `.lnk`。
- 导航项至少包含显示名称、描述、完整路径，并自动识别目标是文件、文件夹、缺失或未知。
- 文件夹双击打开新的普通目录 Tab；文件双击走系统默认打开。
- 右键菜单同时支持导航项管理和 Windows 文件操作，并明确区分“移除导航项”和“操作真实文件”。
- 保持当前主路径可构建、可测试，不绕开 `src/features/workspace/*` 状态模型和 Tauri IPC。

非目标：

- 不创建真实 Windows `.lnk` 文件。
- 第一阶段不承诺远程文件双击系统默认打开，也不承诺远程目标使用 Windows 原生右键菜单。
- 不替代现有书签和目录热表；导航 Tab 是更强的“快捷入口页”。

## 2. 当前架构依据

现有实现边界：

- 前端工作区集中在 `src/features/workspace/*`。
- `TabKind` 当前为 `directory | search-results`，说明非目录内容可以作为 Tab 渲染，但目录专属操作仍大量依赖 `snapshot.location.path`。
- `WorkspaceView` 已有菜单栏、工具栏、面板布局和按 `activeTab.kind` 分流渲染的模式。
- `useWorkspaceController` 是异步导航、打开新 Tab、保存设置、右键菜单和通知的编排层。
- `workspaceReducer` 负责确定性状态变更，已有 Tab 打开、关闭、移动、锁定、会话恢复相关测试。
- 后端 `MetadataStore` 已用 JSON 持久化 bookmarks/hotlist/color rules/shortcuts/remote profiles。
- Windows 原生右键菜单已在 `src-tauri/src/services/windows_shell.rs` 实现，当前限制是本地绝对路径、路径存在、多选同父目录；远程路径和失败场景需要前端回退。

## 3. 核心架构设计

### 3.1 Tab 建模

推荐方案：把 Tab 升级为一等 discriminated union，而不是让 `navigation://shortcuts` 伪装成本地目录。

```ts
type TabState = DirectoryTabState | SearchResultsTabState | NavigationTabState;

interface BaseTabState {
  id: string;
  title: string;
  titleOverride?: string;
  locked?: boolean;
  kind: TabKind;
}

interface DirectoryTabState extends BaseTabState {
  kind: "directory";
  snapshot: DirectorySnapshot;
  addressDraft: string;
  history: string[];
  historyIndex: number;
  selectedEntryIds: string[];
  expandedNodePaths: string[];
  viewMode: TabViewMode;
  sort: SortState;
  status: "ready" | "loading" | "reconnect-required";
  inlineEdit?: InlineEditState;
  reconnect?: ReconnectState;
}

interface SearchResultsTabState extends BaseTabState {
  kind: "search-results";
  snapshot: DirectorySnapshot;
  addressDraft: string;
  history: string[];
  historyIndex: number;
  selectedEntryIds: string[];
  expandedNodePaths: string[];
  viewMode: TabViewMode;
  sort: SortState;
  status: "ready";
  search: SearchTabState;
}

interface NavigationTabState extends BaseTabState {
  kind: "navigation";
  title: "导航";
  virtualPath: "navigation://shortcuts";
  status: "ready";
}
```

如果为了分阶段降低改动量，最低要求也不能使用 `location.kind: "local"` 表示导航页；必须增加 `LocationKind = "virtual"` 或 `NavigationTabState.virtualPath`，并保证所有目录专属入口只接受 `tab.kind === "directory"`。

推荐保留这些纯 helper：

- `isDirectoryTab(tab)`
- `isNavigationTab(tab)`
- `createNavigationTab(id)`
- `findNavigationTab(state)`
- `dedupeNavigationTabs(state)`
- `getFallbackDirectoryPath(state)`

`getFallbackDirectoryPath` 的优先级：

1. 当前面板最近的 directory Tab。
2. 任意可见面板的 directory Tab。
3. 任意隐藏面板的 directory Tab。
4. bootstrap initial path 或第一个 drive。

### 3.2 导航项状态

导航项配置是全局应用数据，不属于某个 Tab。关闭导航 Tab 不影响导航项。

```ts
export type NavigationTargetKind = "file" | "folder" | "missing" | "unknown" | "remote-unsupported";
export type NavigationTargetStatus =
  | "ok"
  | "missing"
  | "permissionDenied"
  | "unsupportedRemote"
  | "invalidPath"
  | "unknownError";

export interface NavigationItem {
  id: string;
  displayName: string;
  description: string;
  path: string;
  targetKind: NavigationTargetKind;
  targetStatus: NavigationTargetStatus;
  statusMessage?: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
}

export interface NavigationState {
  items: NavigationItem[];
  selectedItemIds: string[];
  filterText: string;
  status: "idle" | "checking" | "saving";
}
```

`WorkspaceState` 增加：

```ts
navigation: NavigationState;
```

临时 UI 状态策略：

- `items` 持久保留。
- 关闭导航 Tab 后再打开，重置 `selectedItemIds` 和 `filterText`，避免用户看到旧筛选造成“项目丢失”的错觉。
- `lastOpenedAt` 成功打开后更新并持久化。

### 3.3 全局单例规则

Reducer 必须维护全局唯一 invariant：

- `navigationTabOpened`：
  - 已存在且在可见面板：激活它。
  - 已存在但在不可见面板：移动到当前可见活动面板，再激活。
  - 不存在：在当前活动面板创建并激活。
- `tabMoved`：
  - 不允许产生第二个导航 Tab。
  - 如果从只有一个 Tab 的面板拖走导航 Tab，Controller 先补一个后备 directory Tab，再执行移动。
- `bootstrapLoaded` / `mergeBootstrapWithSession`：
  - 执行 `dedupeNavigationTabs`。
  - 多个异常导航 Tab 只保留一个，优先保留上次 active tab，其次保留最靠前的一个。
- `otherTabsClosed`：
  - 导航 Tab 与普通 Tab 一样会被“关闭其他”影响，除非被锁定。
  - 如果操作会让某面板只剩待关闭的导航 Tab，Controller 先补后备 directory Tab。

### 3.4 关闭入口统一 guard

所有关闭入口必须走 Controller 的统一关闭函数：

- Tab 关闭按钮。
- Ctrl+W。
- Tab 右键菜单关闭。
- 工具菜单隐藏导航页。
- 关闭其他 Tab。

规则：

1. 如果关闭目标不是导航 Tab，沿用现有逻辑。
2. 如果关闭目标是导航 Tab 且该面板还有其他 Tab，直接关闭。
3. 如果关闭目标是该面板唯一 Tab，先用 `getFallbackDirectoryPath` 打开一个普通 directory Tab，再关闭导航 Tab。
4. 如果后备目录无法打开，拒绝关闭并显示错误通知，避免面板无 Tab。

### 3.5 目录专属动作 guard

这些行为必须集中在 Controller/action 层判断 `tab.kind === "directory"`，组件只发 intent，reducer 只做确定性状态变更：

- 地址栏提交。
- 刷新目录。
- 后退/前进/上一级。
- 创建文件/文件夹。
- 粘贴到当前目录。
- 普通文件列表拖放到当前目录。
- 目录树 hydrate。
- 普通 selection 操作。
- 普通 Tab “复制路径”。
- 普通 native context menu。
- `tabSnapshotCommitted`。

导航 Tab 激活时：

- 地址栏显示 `导航`，不显示或不提交 `navigation://shortcuts`。
- 后退/前进/上一级、创建、粘贴等目录命令禁用。
- F5 映射为“刷新导航项目标状态”。

## 4. 产品交互设计

### 4.1 工具菜单

菜单栏“工具”增加可勾选项：

- 未打开：`显示导航页`
- 已打开：`隐藏导航页`

如果导航 Tab 已存在但在当前布局不可见的面板中，菜单点击“显示导航页”时不切布局，直接把导航 Tab 移动到当前可见活动面板并激活。

### 4.2 导航 Tab 外观

- 标题固定为 `导航`，不建议允许普通 Tab 的“重命名”改掉它。
- 可显示 `Compass` 或 `Star` 图标，使用 lucide-react。
- Tab 右键菜单保留锁定、关闭；禁用“复制路径”或显示为“复制内部标识”，默认推荐禁用。
- 面包屑显示单段 `导航`。
- 地址栏不展示内部 URI，或者展示只读 `导航`。

### 4.3 内容布局

使用高密度桌面列表，不做卡片式主页。

顶部工具行按组显示：

- 添加：添加、添加当前文件夹、从选中项添加。
- 打开：打开、打开所在文件夹。
- 管理：编辑、从导航页移除、上移/下移。
- 状态：刷新状态、过滤框。

按钮按选择状态动态启用，常用操作使用图标按钮和 tooltip，避免拥挤。

主体列：

- 图标。
- 名称。
- 类型：文件夹、文件、缺失、未知、远程暂不支持。
- 路径。
- 描述。
- 状态。
- 最近打开时间。

空状态提供：

- 添加导航项。
- 添加当前文件夹。
- 从当前选中项添加。

### 4.4 添加与编辑

入口：

- 导航 Tab 顶部添加按钮。
- 空白处应用右键菜单。
- 普通文件列表选中项右键：`添加到导航页`。
- 当前目录菜单：`添加当前文件夹到导航页`。
- 将文件列表项拖入导航 Tab。
- 可选增强：接入 `@tauri-apps/plugin-dialog` 后提供选择文件/选择文件夹；若不新增插件，第一阶段使用路径输入框、当前文件夹、当前选中项和拖放。

字段：

- 显示名称：默认从路径 basename 推导，根目录用驱动器标签或路径。
- 描述：可选。
- 完整路径：必填，保存前 trim 和规范化。
- 类型：由后端检测得出，不建议用户手填。

校验：

- 路径不能为空。
- 本地路径第一阶段要求绝对路径。
- 缺失路径允许保存，但 warning 说明“稍后磁盘重新连接后可恢复使用”。
- 重复路径默认不创建重复项，提示用户选择激活已有项或更新已有项。

编辑：

- F2 只编辑显示名称。
- 完整编辑使用工具栏 `编辑`、右键 `编辑导航项` 或 Alt+Enter。
- 编辑路径后重新检测目标状态。

### 4.5 移除与排序

删除文案统一使用 `从导航页移除` 或 `删除导航项`，不使用容易误解为删除真实文件的裸 `删除`。

行为：

- Delete：从导航页移除选中项。
- 确认框必须写明“只删除导航项配置，不会删除磁盘上的文件或文件夹”。
- 排序支持上移/下移和拖拽排序，持久化 `sortOrder`。
- 过滤只影响显示，不改变持久化顺序。

### 4.6 打开导航项

单击：

- 只选择，不打开。

双击或 Enter：

- 文件夹：在导航 Tab 所在面板打开新的普通 directory Tab 并激活。
- 文件：调用 `open_path_with_system_default(path)`，由 Windows 默认程序打开。
- 缺失/无权限：阻止打开，显示通知，并刷新状态。
- 远程目标：第一阶段显示“远程目标暂不支持系统方式打开”。

快捷键：

- Enter：打开。
- Ctrl+Enter：文件夹在后台新 Tab 打开；文件仍系统打开。
- F2：编辑显示名称。
- Alt+Enter：打开完整编辑对话框。
- Delete：从导航页移除。
- Ctrl+C：复制完整路径。
- Ctrl+A：全选导航项。
- F5：刷新目标状态。
- Shift+F10 或菜单键：打开应用右键菜单。
- Esc：清空过滤或取消编辑。
- 方向键、Space、Ctrl/Shift 多选按文件列表习惯处理。

### 4.7 Tab 行为对照

| 行为 | 普通文件夹 Tab | 搜索结果 Tab | 导航 Tab |
| --- | --- | --- | --- |
| 地址栏 | 可编辑路径并跳转 | 显示来源路径，通常不作为目录提交 | 显示 `导航`，不提交内部 URI |
| 后退/前进/上一级 | 可用 | 通常禁用或返回来源上下文 | 禁用 |
| 刷新 | 重新列目录 | 刷新/重跑搜索结果，按现有语义 | 刷新导航项目标状态 |
| 创建/粘贴 | 对当前目录执行真实文件操作 | 禁用 | 禁用 |
| 双击文件夹 | 进入目录或按现有逻辑导航 | 打开结果位置 | 新开普通文件夹 Tab |
| 双击文件 | 当前实现可后续扩展 | 打开结果位置或系统打开，按现有语义 | 系统默认方式打开 |
| 右键菜单 | 优先 Windows 原生菜单，失败回退应用菜单 | 应用菜单为主 | 默认应用菜单，另有 `Windows 文件操作...` |
| 关闭/恢复 | 会话恢复 | 通常不持久恢复 | 会话恢复打开状态，但配置始终保留 |

## 5. 右键菜单设计

### 5.1 默认策略

导航项右键默认显示应用菜单，而不是直接显示 Windows 原生菜单。

原因：

- 导航项是软件层面的快捷入口，右键必须优先提供 `编辑导航项`、`从导航页移除`。
- Windows 原生菜单里的删除、重命名、剪切会作用于真实文件，必须明确标注。
- 如果直接进入原生菜单，用户在最常见场景下反而看不到导航项管理操作。

应用菜单建议：

- 打开。
- 文件夹：在新 Tab 打开。
- 文件：系统方式打开。
- 打开所在文件夹。
- 复制路径。
- 编辑导航项。
- 从导航页移除。
- 刷新状态。
- `Windows 文件操作...`：明确标注“作用于真实目标文件/文件夹”。

增强入口：

- Shift+右键可直接尝试 Windows 原生菜单，但仍建议首次使用时提示“这些操作会作用于真实文件”。

### 5.2 Windows 文件操作入口

点击 `Windows 文件操作...` 后才调用现有 `show_native_context_menu(paths, x, y)`。

尝试条件：

- 全部是本地路径。
- 路径存在。
- 不是 remote URI。
- 多选时全部来自同一父目录。

否则直接提示不可用并保留应用菜单。

### 5.3 原生菜单后的同步

Windows 原生菜单可以执行删除、重命名、剪切等真实文件操作，但不会可靠返回具体变化。

处理策略：

- 原生菜单关闭后，对参与菜单的路径做轻量状态检测。
- 如果路径消失，标记导航项为“缺失”。
- 如果用户通过原生菜单重命名目标，应用无法自动知道新路径；导航项会显示缺失，并提供编辑入口。
- 不拦截或重写 Shell 菜单命令。

## 6. IPC 与 Rust 后端设计

### 6.1 DTO

Rust `domain/models.rs` 建议新增：

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NavigationTargetKind {
  File,
  Folder,
  Missing,
  Unknown,
  RemoteUnsupported
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NavigationTargetStatus {
  Ok,
  Missing,
  PermissionDenied,
  UnsupportedRemote,
  InvalidPath,
  UnknownError
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NavigationItemUpsertRequest {
  pub id: Option<String>,
  pub display_name: Option<String>,
  pub description: String,
  pub path: String
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NavigationItem {
  pub id: String,
  pub display_name: String,
  pub description: String,
  pub path: String,
  pub target_kind: NavigationTargetKind,
  pub target_status: NavigationTargetStatus,
  pub status_message: Option<String>,
  pub sort_order: u32,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  pub last_opened_at: Option<DateTime<Utc>>
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NavigationTargetInfo {
  pub path: String,
  pub normalized_path: Option<String>,
  pub canonical_path: Option<String>,
  pub display_name: String,
  pub target_kind: NavigationTargetKind,
  pub target_status: NavigationTargetStatus,
  pub message: Option<String>,
  pub exists: bool,
  pub is_local: bool,
  pub parent_path: Option<String>
}
```

`SettingsSnapshot` 增加：

```rust
#[serde(default)]
pub navigation_items: Vec<NavigationItem>
```

旧数据兼容的关键点：

- `MetadataStore.navigation_items` 必须加 `#[serde(default)]`。当前 `MetadataStore` 是从 `metadata.json` 反序列化的结构，新增非 default 字段会导致旧文件启动失败。
- `SettingsSnapshot.navigation_items` 也加 `#[serde(default)]`，保证 IPC snapshot 和测试 fixture 缺字段时能默认空数组。
- TypeScript `SettingsSnapshot`、`createBrowserSettingsSnapshot`、mapper 均默认 `navigationItems: []`。

前端不提交完整 `NavigationItem` 持久化对象。保存时只提交 `NavigationItemUpsertRequest`：

- `id?`：有值表示更新，无值表示创建。
- `displayName?`：为空时后端从路径推导。
- `description`：后端 trim。
- `path`：后端 trim、规范化、检测状态。

后端负责生成 id、时间戳、`sortOrder`、`targetKind`、`targetStatus` 和状态消息，避免前端与后端对目标状态产生两套事实来源。

### 6.2 Commands

建议新增：

- `save_navigation_item(request: NavigationItemUpsertRequest) -> SettingsSnapshot`
- `delete_navigation_item(id: String) -> SettingsSnapshot`
- `reorder_navigation_items(ids: Vec<String>) -> SettingsSnapshot`
- `resolve_navigation_targets(paths: Vec<String>) -> Vec<NavigationTargetInfo>`
- `open_path_with_system_default(path: String) -> Result<(), String>`

命名和返回值：

- settings 类 command 沿用 `save_bookmark`、`delete_bookmark` 返回 `SettingsSnapshot` 的模式。
- 前端 gateway 只从 snapshot 中映射 `navigationItems` 并 dispatch `navigationItemsUpdated`，不要让 `SettingsSnapshot`、`SettingsModel`、`WorkspaceState.navigation` 形成多处状态来源。
- `resolve_navigation_targets` 用批量接口，避免刷新大量导航项时多次 IPC。

命令注册位置：

- `save_navigation_item`、`delete_navigation_item`、`reorder_navigation_items` 放在 `src-tauri/src/commands/settings.rs`。
- `resolve_navigation_targets` 可放在 `commands/workspace.rs`，也可以后续拆 `commands/navigation.rs`；第一阶段推荐放 `workspace.rs`，减少模块扩散。
- `open_path_with_system_default` 放在 `commands/workspace.rs` 或独立 shell command 模块，底层委托 `services/windows_shell.rs`。
- 所有新增 command 必须在 `src-tauri/src/lib.rs` 的 `tauri::generate_handler![...]` 中注册。

权限同步：

- 更新 `src-tauri/permissions/default.toml`。
- `src-tauri/capabilities/default.json` 当前通过 `"default"` 引入 default permission；通常只需更新 `permissions/default.toml`。如果引入 `@tauri-apps/plugin-dialog`，才需要额外补插件权限。
- 更新 `workspaceIpc.test.ts` required command 列表。

### 6.3 MetadataStore

新增：

- `navigation_items: Vec<NavigationItem>`
- `upsert_navigation_item`
- `delete_navigation_item`
- `reorder_navigation_items`

规则：

- 保存时 trim 名称、描述、路径。
- displayName 为空时从路径推导。
- 新项由后端使用当前最大 `sortOrder + 1`。
- reorder 时按传入 id 列表重写 `sortOrder`；缺失项追加到末尾。
- reorder 输入中的重复 id 忽略后续重复项。
- 删除导航项只删除 metadata，不触碰真实文件系统。

### 6.4 路径规范化

导航目标解析、Windows 文件操作入口、系统默认打开必须复用同一套本地路径校验 helper，避免三处规则漂移。

规范化规则：

- 拒绝空路径。
- 拒绝相对路径。
- 拒绝 remote URI：`ftp://`、`sftp://`。
- 拒绝普通 URL scheme，例如 `http://`、`https://`、`mailto:`，导航项第一阶段只做本地文件系统路径。
- Windows 下重复判断大小写不敏感，并去掉非根路径尾部分隔符。
- 存在路径可使用 `canonicalize` 得到 `canonicalPath`。
- 缺失路径只能做词法级规范化，不能强行 canonicalize。
- 支持 UNC 路径作为本地路径，例如 `\\server\share\path`，但状态检测可能返回 permissionDenied 或 unknownError。
- 支持驱动器根目录，例如 `C:\`。
- `\\?\` 长路径作为后续兼容项；第一阶段可保留但不主动生成。

### 6.5 Windows 默认打开

`windows_shell.rs` 增加 `open_path_with_system_default`：

- Windows：
  - 使用上面的本地路径校验 helper，拒绝空路径、相对路径、remote URI、URL scheme、缺失路径。
  - 使用 `ShellExecuteW` 或 `ShellExecuteExW` 的 `open` verb，不使用 `cmd /c start`。
  - `lpDirectory` 设置为目标父目录，便于关联程序获得合理工作目录。
  - 返回值 `<= 32` 时映射为用户可理解的错误，例如无关联程序、访问被拒绝、文件未找到。
  - `.exe`、`.bat`、`.cmd`、`.msi` 等可执行目标只允许由明确用户手势触发：双击导航项、Enter、应用菜单点击。后台刷新、会话恢复、状态检测绝不能自动执行。
- 非 Windows：
  - 返回明确错误：该能力仅支持 Windows。

测试：

- 单测路径校验函数：拒绝空路径、相对路径、remote URI、缺失路径。
- ShellExecute 本身隔离在很薄的函数中，Windows 手工联调验证即可。

### 6.6 Windows 原生右键菜单边界

现有 `windows_shell.rs` 使用经典 `IContextMenu` popup，可覆盖多数 Shell verbs，但不等同于 Windows 11 Explorer 的现代右键菜单。

边界：

- 不承诺完全复刻 Explorer 所有扩展菜单。
- 当前未处理 `IContextMenu2/3` 消息，复杂 Shell 扩展可能表现不完整。
- 现有实现只能可靠判断“菜单是否打开”；如果用户点击某个 Shell 命令但 `InvokeCommand` 失败，fallback 不一定能接管。
- 因此导航 Tab 默认应用菜单，`Windows 文件操作...` 是高级入口，失败只提示用户，不承诺自动转成等价应用操作。

## 7. 与书签/热表的关系

书签和热表主要用于目录跳转，导航 Tab 是文件和文件夹的统一快捷入口。

第一阶段保持独立集合：

- 不删除、不替代书签/热表。
- 可从书签/热表导入导航项。
- 目标是文件夹的导航项可另存为书签/热表。
- 长期可考虑统一底层 metadata，但不能影响已有可运行路径。

## 8. TDD 实施顺序

### Slice 1：契约和持久化

先写测试：

- Rust `metadata_store`：upsert/delete/reorder navigation items。
- Rust DTO serde：`NavigationItem`、`NavigationItemUpsertRequest`、`NavigationTargetInfo` 使用 camelCase。
- 旧 `metadata.json` 缺少 `navigationItems` 时能加载，并默认空数组。
- reorder 处理缺失 id、重复 id 和未出现在输入列表中的旧项。
- TS mapper：settings snapshot 映射出 navigation items。
- IPC permissions：新增 commands 在 default permission 中可用。

再实现 DTO、MetadataStore、settings snapshot、commands、permissions、gateway 方法。

验证：

- `npm test`
- `cargo test --manifest-path src-tauri/Cargo.toml --offline`

### Slice 2：Tab 类型、单例和会话恢复

先写测试：

- reducer 打开导航 Tab 时全局只产生一个。
- 已存在导航 Tab 时再次打开只激活。
- 导航 Tab 在不可见面板时，工具菜单打开会移动到当前可见活动面板。
- session restore 能恢复 navigation Tab，且不调用 `resolveDirectory("navigation://shortcuts")`。
- 异常 session 中多个 navigation Tab 会去重。
- 所有关闭入口关闭唯一导航 Tab 前会先创建后备 directory Tab。

再实现 Tab union/helper、reducer actions、session store/reviveTab 支持。

验证：

- `npm test`
- `npm run build`

### Slice 3：导航 Tab UI

先写测试：

- 工具菜单 checked 状态和打开/关闭行为。
- 导航 Tab 渲染空状态。
- 添加/编辑/从导航页移除表单行为。
- 过滤、选择、键盘打开。
- 文件夹双击调用 open new tab；文件双击调用系统打开 gateway。
- 导航 Tab 激活时目录专属命令禁用。

再实现 `NavigationTabView.tsx`、CSS、`WorkspaceView` 分流、菜单和 controller actions。

验证：

- `npm test`
- `npm run build`

### Slice 4：Windows Shell 集成

先写测试：

- `resolve_navigation_targets` 批量状态检测。
- `resolve_navigation_targets` 覆盖文件、目录、缺失、相对路径、remote URI、无权限或无法读取的路径。
- `open_path_with_system_default` path validation。
- ShellExecute 返回码映射通过可注入封装测试，不直接在单测中启动外部程序。
- 导航项应用菜单默认出现，`Windows 文件操作...` 才调用 native context menu。

再实现 shell service、Tauri command、gateway 方法、导航项右键菜单分流。

验证：

- `cargo check --manifest-path src-tauri/Cargo.toml --offline`
- `cargo test --manifest-path src-tauri/Cargo.toml --offline`
- `npm test`
- `npm run build`

### Slice 5：体验增强

先写测试：

- 拖放添加导航项。
- 批量移除只删除配置不删除文件。
- 原生菜单关闭后状态刷新。
- 导入书签/热表。

再实现拖放、批量、导入、状态刷新。

## 9. 测试矩阵补充

| 层级 | 重点用例 |
| --- | --- |
| Rust DTO | camelCase 序列化；`NavigationItemUpsertRequest` 反序列化；`NavigationTargetStatus` 枚举值稳定。 |
| MetadataStore | 旧 JSON 缺 `navigationItems` 可加载；upsert 创建/更新；delete 不触碰真实文件；reorder 缺失/重复 id。 |
| Rust 路径 helper | 空路径、相对路径、remote URI、URL scheme、本地文件、本地目录、缺失路径、UNC、驱动器根目录。 |
| Windows Shell | ShellExecute 返回码映射；可执行文件只允许用户手势触发；非 Windows 返回明确错误。 |
| TS mapper/gateway | settings snapshot 默认空数组；upsert request 参数形状；批量 resolve 参数形状；新增 command 名称。 |
| Reducer/session | 全局单例；不可见面板移动；session revive 不 resolve virtual path；异常多个导航 Tab 去重。 |
| Controller/UI | 目录专属命令在导航 Tab 禁用；右键默认应用菜单；`Windows 文件操作...` 才调用 native menu；Delete 文案为移除导航项。 |

## 10. 风险与处理

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 把导航 Tab 当成本地目录 | 误触发 list_directory、复制/粘贴、路径提交等 | 使用一等 `NavigationTabState`；最低限度也要 `virtual` kind，并在 controller 集中 guard。 |
| 右键菜单删除语义混淆 | 用户误删真实文件或找不到移除入口 | 默认应用菜单；`Windows 文件操作...` 明确标注作用于真实目标。 |
| 原生菜单重命名后无法回写路径 | 导航项变缺失 | 原生菜单关闭后刷新状态，提示用户编辑路径。 |
| 远程路径与系统默认打开冲突 | 远程文件不能直接 ShellExecute | 第一阶段标为 remote unsupported，后续设计下载/缓存策略。 |
| 导航 Tab 位于隐藏面板 | 用户看到菜单已勾选但找不到 Tab | 打开时移动到当前可见活动面板。 |
| 关闭导航 Tab 后面板为空 | reducer 拒绝关闭或状态异常 | 所有关闭入口走 controller guard，先补后备 directory Tab。 |
| 旧 metadata JSON 缺字段 | 启动解析失败 | Rust 字段加 `#[serde(default)]`，TS mapper 默认空数组。 |

## 11. 验收标准

功能验收：

- 工具菜单可打开/关闭导航 Tab。
- 任意时刻全工作区最多一个导航 Tab。
- 导航 Tab 可在标签栏中激活、移动、关闭；不可见面板中的导航 Tab 可被菜单带回当前可见面板。
- 添加导航项时可填写名称、描述、完整路径；名称可从路径自动生成。
- 关闭导航 Tab 后导航项配置仍保留。
- 文件夹双击打开新的普通目录 Tab。
- 文件双击调用系统默认程序。
- 导航项右键默认显示应用菜单，提供编辑和从导航页移除。
- `Windows 文件操作...` 对本地存在路径调用 Windows 原生菜单，并明确作用于真实文件。
- 缺失路径显示状态，不导致应用崩溃。

技术验收：

- 不新增平行工作区状态模型。
- 组件不直接调用 Tauri IPC。
- IPC DTO 使用 camelCase，权限文件和 IPC 测试同步。
- 后端路径校验集中在 Rust service/command 层。
- 常规验证通过：
  - `npm test`
  - `npm run build`
  - `cargo check --manifest-path src-tauri/Cargo.toml --offline`
  - `cargo test --manifest-path src-tauri/Cargo.toml --offline`

## 12. 子 Agent 审查记录

### 第一轮：架构审查

采纳的必须修改项：

- 不再把 `navigation://shortcuts` 伪装为 `location.kind: "local"`，推荐一等 `NavigationTabState`，最低也要 `virtual` 类型。
- 细化 session restore：`PersistedTab` 保存 `kind`，navigation revive 不调用目录 resolver，恢复时全局去重。
- 处理导航 Tab 在不可见面板中的情况：菜单打开时移动到当前可见活动面板。
- 所有关闭入口统一走 Controller guard，避免唯一导航 Tab 无法关闭或面板为空。
- 目录专属动作集中 guard。

### 第二轮：交互审查

采纳的必须修改项：

- 右键默认策略改为应用菜单，`Windows 文件操作...` 作为明确标注的入口。
- 应用菜单始终提供 `编辑导航项`、`从导航页移除` 等管理操作。
- 增加普通文件夹 Tab、搜索结果 Tab、导航 Tab 行为对照表。
- 删除文案统一为 `从导航页移除` 或 `删除导航项`，明确不删除真实文件。

### 第三轮：IPC/Rust/Windows Shell 审查

采纳的必须修改项：

- 旧数据兼容明确落到 `MetadataStore.navigation_items #[serde(default)]`，同时 `SettingsSnapshot` 和 TS mapper 默认空数组。
- 保存接口由 `save_navigation_item(item: NavigationItem)` 改为 `save_navigation_item(request: NavigationItemUpsertRequest)`，后端生成 id、时间、排序和目标状态。
- `NavigationTargetInfo` 增加 `NavigationTargetStatus`、`message`、`normalizedPath`、`canonicalPath`，可表达无权限、远程不支持、非法路径和未知错误。
- `open_path_with_system_default` 补充安全边界：拒绝 URL/remote/相对路径，不用 `cmd /c start`，ShellExecute 返回码映射，可执行文件仅允许用户手势触发。
- 新 command 必须注册到 `src-tauri/src/lib.rs` 的 `generate_handler!`。
- Windows 原生右键菜单边界写实：当前是经典 `IContextMenu`，不承诺等同 Windows 11 Explorer 现代菜单，也不能可靠 fallback Shell 命令执行失败。

采纳的建议修改项：

- 增加路径规范化专节。
- 要求目标解析、默认打开、Windows 文件操作复用同一套路径校验 helper。
- 明确 default capability 通常不需额外修改，除非引入 dialog 插件。
- 补充测试矩阵。
