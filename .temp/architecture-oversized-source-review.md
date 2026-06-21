# 仓库级超大源文件与架构结构审查报告

日期：2026-06-22

## 审查范围
- 覆盖真实源码目录：`src/`、`src-tauri/src/`、`src-tauri/capabilities/`、`scripts/`。
- 排除构建产物与依赖目录：`node_modules/`、`dist/`、`src-tauri/target/`、`.test-build/` 等。
- 本轮只做结构审查与报告，不修改任何源码实现。

## 规模概览

统计口径包括 `.ts`、`.tsx`、`.rs`、`.css`、`.mjs` 等相关源码文件。

| 指标 | 数量 |
| --- | ---: |
| 源码文件数 | 113 |
| 总行数 | 54,847 |
| >= 500 行文件 | 29 |
| >= 1000 行文件 | 14 |
| >= 2000 行文件 | 7 |
| >= 3000 行文件 | 2 |

最长文件清单：

| 行数 | 文件 |
| ---: | --- |
| 4174 | `src/features/workspace/useWorkspaceController.test.ts` |
| 3221 | `src/features/workspace/workspace.css` |
| 2835 | `src/features/workspace/useWorkspaceController.ts` |
| 2813 | `src-tauri/src/services/remote_service.rs` |
| 2423 | `src-tauri/src/services/operation_service.rs` |
| 2277 | `src/features/workspace/workspaceReducer.ts` |
| 2042 | `src/features/workspace/workspaceReducer.test.ts` |
| 1945 | `src-tauri/src/services/windows_shell.rs` |
| 1787 | `src/features/workspace/FileListing.test.tsx` |
| 1669 | `src/features/workspace/FileListing.tsx` |
| 1434 | `src/features/workspace/SettingsSurface.tsx` |
| 1291 | `src/features/workspace/mockData.ts` |
| 1269 | `src-tauri/src/domain/models.rs` |
| 1108 | `src/features/workspace/WorkspaceView.tsx` |

结论：仓库并不是普遍性失控，主要风险集中在 `src/features/workspace/*` 和 `src-tauri/src/services/*`。但这些热点文件已经超过“单个开发者可以快速建立完整上下文”的规模，应当进入架构治理。

## 主要发现

### 严重：`useWorkspaceController.ts` 已承担过多应用编排职责

文件：`src/features/workspace/useWorkspaceController.ts`，2835 行，约 47 个顶层函数/符号。

观察到的职责混合：
- bootstrap、session、settings 持久化。
- 文件监听 roots 计算、目录刷新规划、延迟刷新队列。
- 导航、tab 创建、breadcrumb 历史保留。
- 远程 reconnect、SFTP host key 确认与信任。
- 文件操作、剪贴板、拖拽、系统拖出。
- properties 面板请求、搜索请求、通知。
- 多个 `useRef` 队列和请求去重状态集中在一个 hook 内。

风险：
- 单一职责被破坏。这个 hook 既是应用控制器，又是远程连接协调器、刷新调度器、操作任务协调器、属性请求协调器。
- 新增功能很容易继续向 controller 追加 effect/action，导致“中心化上帝 hook”。
- 测试文件 `useWorkspaceController.test.ts` 已达到 4174 行，是同一结构问题在测试侧的反映。

最佳实践建议：
- 保留 `useWorkspaceController` 作为组合根，只负责组装子控制器并返回统一 facade。
- 提取纯模块优先，再提取 hook，降低行为变更风险。
- 可拆为：
  - `workspaceNavigationController.ts`：导航、tab 创建、breadcrumb 历史。
  - `workspaceRefreshPlanner.ts`：watch roots、refresh targets、operation affected paths。
  - `workspaceRemoteTrust.ts`：SFTP host key 确认流程。
  - `workspaceOperationController.ts`：copy/move/delete/paste/drag-drop 与任务刷新。
  - `workspacePropertiesController.ts`：properties 请求、stale response 防护、多选 summary。
  - `workspaceSearchController.ts`：搜索启动、取消、历史同步。

适用设计模式：
- 观察者模式：文件系统变化、operation task event、settings changed event 应明确通过 watcher/event subscription 层进入控制器，而不是让主 hook 直接承载全部订阅与刷新策略。
- 命令模式：用户操作已经接近 command 语义，应让操作控制器将 UI intent 转为 operation command/request，主 hook 不应知道每种操作的刷新细节。

### 严重：`remote_service.rs` 是远程协议、适配器、凭据、路径和传输的大杂烩

文件：`src-tauri/src/services/remote_service.rs`，2813 行，约 94 个顶层符号。

当前文件同时包含：
- profile 校验与规范化。
- Windows Credential Manager 读写入口。
- FTP/curl 适配器。
- SFTP/ssh2 适配器。
- host key 查询、信任、known_hosts 写入。
- 远程路径校验、URL 构造、percent encoding。
- 上传、下载、复制、移动、删除、冲突路径生成。
- listing 解析、SFTP stat 映射、属性读取。
- 大量单元测试。

风险：
- 远程服务的领域边界不清，FTP 和 SFTP 的变化互相影响。
- adapter trait 已经存在，但具体实现和工厂仍挤在同一文件，无法体现可替换适配器设计。
- host key 信任与文件传输属于不同安全边界，放在同一文件会增加审查成本。

最佳实践建议：
- 保留 `RemoteAdapter` trait，但按模块拆分实现：
  - `services/remote_service/mod.rs`：公开 API 与 orchestration。
  - `services/remote_service/profile.rs`：profile 校验、normalize、credential target。
  - `services/remote_service/path.rs`：remote path、URL、encoding、conflict path。
  - `services/remote_service/host_key.rs`：known_hosts、fingerprint、trust。
  - `services/remote_service/adapters/mod.rs`：trait 与 factory。
  - `services/remote_service/adapters/curl_ftp.rs`。
  - `services/remote_service/adapters/sftp.rs`。
  - `services/remote_service/transfer.rs`：跨本地/远程 transfer 编排。

适用设计模式：
- 工厂模式：`select_adapter(profile)` 应成为清晰的 `RemoteAdapterFactory`，根据 profile protocol/auth/环境生成具体 adapter。
- 策略模式：FTP curl、SFTP ssh2、unsupported adapter 是同一远程操作策略的不同实现。
- 适配器模式：curl/ssh2 是外部协议实现细节，应隔离在 adapter 内。

### 严重：`workspaceReducer.ts` action 聚合过大，状态边界需要分区

文件：`src/features/workspace/workspaceReducer.ts`，2277 行，约 86 个 action 变体、95 个 reducer case。

当前 reducer 同时处理：
- layout、panel focus、tab lifecycle。
- tree expansion、remote reconnect。
- selection、sort、view mode、inline edit。
- information panel、properties、search、search result tabs。
- navigation items、remote profiles、settings model。
- clipboard、operation tasks/history、notifications、context menu。

风险：
- reducer 的确定性状态管理方向是正确的，但 action 空间已经过宽。
- 新 action 经常需要理解多个 helper：tab、tree、search、properties、settings、operation 互相穿插。
- 大量 helper 函数与 reducer case 放在一个文件，降低局部修改信心。

最佳实践建议：
- 先保持单一 `workspaceReducer(state, action)` 入口不变，内部按领域委托：
  - `workspaceReducer/tabs.ts`
  - `workspaceReducer/tree.ts`
  - `workspaceReducer/search.ts`
  - `workspaceReducer/properties.ts`
  - `workspaceReducer/settings.ts`
  - `workspaceReducer/operations.ts`
  - `workspaceReducer/navigation.ts`
- 把 `WorkspaceAction` union 拆成领域 action 后再组合导出。
- 每次只迁移一组 action，保证现有 reducer 测试继续覆盖。

适用设计模式：
- Reducer/状态机分片比引入复杂 OO 模式更合适。这里的目标是按状态子域拆分高内聚 handler，不建议强行套观察者或工厂。

### 高：`workspace.css` 是全局样式单体，且存在重复 settings 样式段

文件：`src/features/workspace/workspace.css`，3221 行。

当前同一 CSS 文件覆盖：
- workspace shell、menubar、commandbar、addressbar。
- tree pane。
- panel chrome、tab strip、breadcrumbs。
- file listing 多视图。
- settings window 与 settings pages。
- context menu。
- status/loading/notifications。
- operation center/history。

风险：
- 样式职责按页面/组件边界混杂，新增样式容易产生选择器覆盖和回归。
- settings 相关样式在文件中出现多段定义，说明样式已经不再按组件稳定聚合。
- 全局 class 文件过大，不利于前端视觉治理和局部重构。

最佳实践建议：
- 不必立即引入 CSS Modules，先按当前 class 命名和 import 方式拆文件：
  - `workspace.shell.css`
  - `workspace.panel.css`
  - `workspace.tree.css`
  - `workspace.listing.css`
  - `workspace.settings.css`
  - `workspace.context-menu.css`
  - `workspace.operations.css`
- 由 `workspace.css` 只保留变量和 `@import`，或者在组件入口显式 import 对应 CSS。
- 这是较低行为风险的第一批重构对象，适合作为架构治理切入点。

### 高：Rust `operation_service.rs` 同时包含任务仓储、执行器、冲突处理、undo 和文件操作细节

文件：`src-tauri/src/services/operation_service.rs`，2423 行。

当前文件包含：
- `OperationStore` 状态和 journal 持久化。
- task queue、cancel、history、undo。
- copy/move/delete/rename/create 执行。
- conflict request/resolve。
- trash destination、undo payload、结果映射。
- 本地路径安全校验和递归复制/移动细节。

风险：
- 服务既保存任务状态，又直接实现所有本地文件执行细节。
- conflict/undo 是独立复杂领域，继续增长会让操作服务难以验证。

最佳实践建议：
- 以 `OperationStore` 为 facade，拆执行细节：
  - `operation_service/store.rs`
  - `operation_service/journal.rs`
  - `operation_service/executor.rs`
  - `operation_service/conflict.rs`
  - `operation_service/undo.rs`
  - `operation_service/local_fs_ops.rs`
- 优先提取纯函数和数据结构，保留公开 API 不变。

适用设计模式：
- 命令模式：`OperationIntent` 已是命令对象，应让 executor 只消费 intent 并产出 result。
- 策略模式：conflict resolution、copy/move destination decision 可以作为策略对象/函数族，不要散落在执行流程中。

### 高：`windows_shell.rs` 平台实现隔离不足

文件：`src-tauri/src/services/windows_shell.rs`，1945 行。

当前 `#[cfg(windows)] mod imp` 内含：
- shell context menu。
- background custom menu。
- clipboard HDROP。
- drag/drop source。
- IFileOperation。
- navigation target resolve。
- elevation/integrity diagnostics。
- Win32 helper 和大量 tests。

风险：
- Windows FFI 本身复杂，单文件过大使 unsafe/COM 边界审查困难。
- 非 Windows fallback 和 Windows implementation 放在一个文件，公开 API 易读性受影响。

最佳实践建议：
- 以平台 module 保持外部 API 不变：
  - `windows_shell/mod.rs`
  - `windows_shell/context_menu.rs`
  - `windows_shell/background_menu.rs`
  - `windows_shell/clipboard.rs`
  - `windows_shell/drag_drop.rs`
  - `windows_shell/file_operation.rs`
  - `windows_shell/navigation.rs`
  - `windows_shell/integrity.rs`
- unsafe/COM 相关 helper 放入最小模块，降低审查范围。

适用设计模式：
- 适配器模式：Win32 Shell API 应作为平台适配层，Rust commands/services 不应依赖具体 COM 操作细节。

### 高：领域/DTO 类型出现多处“单体类型文件”

文件：
- `src-tauri/src/domain/models.rs`，1269 行，约 121 个领域/DTO 类型。
- `src/app/types.ts`，528 行。
- `src/features/workspace/types.ts`，506 行。

风险：
- Rust DTO、全局前端 DTO、workspace view model 三套类型边界存在重复但不完全一致，例如 `EntryKind`、`LocationKind`、operation/search/settings 等。
- 大型类型文件会鼓励跨领域随手 import，削弱模块边界。
- 后续改 IPC contract 时，影响范围不容易评估。

最佳实践建议：
- Rust 按领域拆：
  - `domain/fs.rs`
  - `domain/navigation.rs`
  - `domain/settings.rs`
  - `domain/remote.rs`
  - `domain/search.rs`
  - `domain/operation.rs`
  - `domain/shell.rs`
  - `domain/workspace.rs`
- TypeScript 按 backend contract 和 frontend state 拆，不要混在一个全局文件：
  - `src/app/contracts/fs.ts`
  - `src/app/contracts/operation.ts`
  - `src/app/contracts/remote.ts`
  - `src/features/workspace/stateTypes.ts`
  - `src/features/workspace/viewTypes.ts`
- 重要 IPC DTO 应保持 contract tests，避免拆分时只改 TypeScript 或只改 Rust。

适用设计模式：
- DTO 分包不是设计模式，但属于边界治理。这里优先保证 contract 显式、低耦合，而不是引入继承体系。

### 中：大型 React 组件仍承担多个子组件职责

文件：
- `src/features/workspace/FileListing.tsx`，1669 行。
- `src/features/workspace/SettingsSurface.tsx`，1434 行。
- `src/features/workspace/WorkspaceView.tsx`，1108 行。

风险：
- `FileListing.tsx` 同时处理排序、列宽、视图渲染、拖拽、上下文菜单、inline edit、DOM hit test。
- `SettingsSurface.tsx` 同时处理导航、快捷键捕获、文件列表配置、鼠标菜单、主题颜色、规则、远程连接编辑。
- `WorkspaceView.tsx` 同时组合应用壳、工具栏、树、panel layout、search results listing。

最佳实践建议：
- 先提取纯 helper，再提取 presentational 子组件：
  - `FileListing`: `listingSort.ts`、`listingColumns.ts`、`listingDragController.ts`、`ListingDetailsView.tsx`、`ListingIconView.tsx`。
  - `SettingsSurface`: `SettingsNavigation.tsx`、`ShortcutsPage.tsx`、`AppearancePage.tsx`、`ConnectionsEditor.tsx`。
  - `WorkspaceView`: `WorkspaceTopChrome.tsx`、`WorkspacePanelLayout.tsx`、`WorkspaceSearchResultsListing.tsx`。
- 不建议在这些组件中引入复杂类层次。React 组件拆分和自定义 hook 足够。

### 中：测试文件按大实现文件聚合，降低定位效率

文件：
- `useWorkspaceController.test.ts`，4174 行。
- `workspaceReducer.test.ts`，2042 行。
- `FileListing.test.tsx`，1787 行。

风险：
- 测试本身成为维护瓶颈。
- 当实现拆分后，如果测试仍按旧大文件聚合，会继续阻碍定位。

最佳实践建议：
- 按行为域拆测试，而不是按原文件名：
  - `workspaceController.navigation.test.ts`
  - `workspaceController.operations.test.ts`
  - `workspaceController.search.test.ts`
  - `workspaceReducer.tabs.test.ts`
  - `workspaceReducer.settings.test.ts`
  - `fileListing.dragDrop.test.tsx`
  - `fileListing.contextMenu.test.tsx`
- 测试 helper 移入 `testDom.ts` 或专门 `workspaceTestHarness.ts`，减少重复 harness。

## 设计模式使用建议

设计模式应服务于边界，不应为了“显得架构化”而增加间接层。当前最值得采用或强化的模式如下：

| 场景 | 推荐模式 | 理由 |
| --- | --- | --- |
| 远程 FTP/SFTP/unsupported 实现选择 | 工厂 + 策略 + 适配器 | 已有 `RemoteAdapter` 雏形，应模块化为清晰 adapter factory |
| 文件操作 copy/move/delete/rename/create/undo | 命令模式 | `OperationIntent` 已是命令对象，应让 executor 消费 intent |
| 冲突处理 replace/skip/keepBoth/rename/merge | 策略模式 | 冲突决策应独立于复制/移动主流程 |
| 文件监听、operation event、settings changed | 观察者模式 | 事件订阅与刷新响应应从主 controller 中拆出 |
| Windows Shell/Clipboard/DragDrop/IFileOperation | 适配器模式 | 隔离 Win32/COM 复杂度，降低 unsafe 审查范围 |
| Settings 页面渲染 | 组件组合，不优先 OO 模式 | React 子组件和 page registry 已足够 |
| Reducer 状态管理 | 子 reducer / 状态机分区 | 比工厂/观察者更贴合当前函数式状态模型 |

## 建议治理顺序

### 第 1 阶段：低行为风险拆分
1. 拆 `workspace.css`，保持 class 名不变。
2. 拆大型测试文件，先不改生产逻辑。
3. 提取 `useWorkspaceController.ts` 中的纯路径/刷新/host-key helper，并迁移对应测试。

### 第 2 阶段：前端状态和控制器分区
1. 拆 `workspaceReducer.ts` 的 action 类型和领域 handler。
2. 拆 `useWorkspaceController.ts` 为多个子 controller/hook，主 hook 保持 facade。
3. 拆 `FileListing.tsx` 的排序、列、拖拽、视图渲染。
4. 拆 `SettingsSurface.tsx` 为 page 级组件。

### 第 3 阶段：Rust 服务模块化
1. 拆 `remote_service.rs`，先抽 adapter factory、path、host_key。
2. 拆 `operation_service.rs`，先抽 journal/conflict/undo/local_fs_ops。
3. 拆 `windows_shell.rs`，按 Win32 能力模块化。
4. 拆 `domain/models.rs`，按 IPC contract 领域分组。

### 第 4 阶段：边界与预算固化
1. 为源码增加行数预算检查脚本，建议阈值：
   - React component：目标 <= 500 行，警戒 800 行。
   - hook/controller：目标 <= 600 行，警戒 1000 行。
   - reducer/纯逻辑模块：目标 <= 800 行，警戒 1200 行。
   - Rust service module：目标 <= 1000 行，警戒 1500 行。
   - CSS 单文件：目标 <= 800 行，警戒 1200 行。
2. 超过阈值允许例外，但需要在 `.temp/` 架构说明中记录原因和拆分计划。

## 总体结论

当前代码库主路径可构建、测试覆盖较强，这是重构的有利条件。但结构上已经出现明显的大文件和职责聚合风险，尤其是 `workspace` 前端控制器/reducer/CSS，以及 Rust remote/operation/windows shell 服务。最合理的改造方式不是大规模重写，而是以“公开 API 不变、纯函数先行、测试先分区、模块逐步迁移”为原则进行治理。

优先级最高的三个切片：
1. `workspace.css` 拆分：低行为风险，立即改善可维护性。
2. `useWorkspaceController.ts` 提取刷新/远程信任/操作编排 helper：降低最大前端风险。
3. `remote_service.rs` 拆出 adapter factory/path/host_key：让已有设计模式真正落到模块边界。

本轮未运行测试或构建，因为只生成审查报告，未修改源码实现。
