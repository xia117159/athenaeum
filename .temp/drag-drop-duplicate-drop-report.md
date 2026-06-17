# 拖放重复执行与高亮闪烁问题定位报告

## 结论摘要

1. 最可能根因是系统文件 drop listener 生命周期不稳定：`WorkspaceView` 在 `useEffect` 中调用 `listenSystemFileDrops`，依赖包含 `actions`；而 `useWorkspaceController` 的 `actions` 又依赖整个 `state`，状态变化会导致系统 drop listener 反复解绑/重绑。`listenSystemFileDrops` 本身没有单例保护。是否已经泄漏多个 active listener 未确认，但代码具备重复注册竞态风险。
2. 系统 drop 处理缺少全局去重和 reentrancy guard。`createSystemFileDropPayloadHandler` 只在单个 handler 内用 `systemDragActive` 阻止同一 handler 二次 drop；如果存在多个 listener，或 Tauri/wry 对同一原生 drop 产生多个 enter/drop 序列，每个入口都会调用 `actions.dropEntries`。
3. 本地文件 copy/move 会直接走 Windows Shell `perform_system_file_operation`，没有前端 requestId、dropId、in-flight key，也没有 Rust 侧幂等保护。因此重复前端入口会变成多个并发 `IFileOperation.PerformOperations()`，符合重复 README.md 冲突对话框现象。
4. App 内文件拖出再拖回 App 时，`startSystemFileDrag` 发起的 Windows Shell drag 没有 app-origin 标记；Tauri 系统 drop listener 会把本应用发起的 shell data object 当成普通外部 Explorer drop 处理。这个链路本身可以成立，但当前缺少“同一 payload 只消费一次”的保护。
5. 高亮闪烁很可能来自两套机制同时操作同名 CSS class：`systemDragDrop.ts` 直接 `classList.add("is-drop-target")`，`FileListing`/`WorkspacePanelChrome` 又通过 React state 渲染同名 class。React 重渲染会覆盖手工添加的 class，随后 Tauri over 再加回去，形成闪烁。

## 关键调用链

### Explorer -> App 拖入链路

- Tauri 配置：`src-tauri/tauri.conf.json` 保持 `dragDropEnabled: true`，测试在 `workspaceIpc.test.ts:128` 验证。
- 前端监听注册：`src/features/workspace/WorkspaceView.tsx:218` 的 effect 调用 `listenSystemFileDrops`；回调在 `WorkspaceView.tsx:222` 将 `(paths, destination)` 转成 `actions.dropEntries(paths, destination, "copy")`。
- Tauri drop listener：`src/features/workspace/systemDragDrop.ts:183` 的 `listenSystemFileDrops` 每次调用都会创建新的 `createSystemFileDropPayloadHandler`，并在 `systemDragDrop.ts:204` 调用 `webview.onDragDropEvent`。
- hit-test 与高亮：`systemDragDrop.ts:48` 用 `document.elementFromPoint(position.x / devicePixelRatio, position.y / devicePixelRatio)` 找 `[data-entry-drop-kind][data-entry-drop-path]`；`systemDragDrop.ts:95` 直接添加高亮 class。
- drop 执行：`systemDragDrop.ts:149` 在 drop 时再次 hit-test，`systemDragDrop.ts:156` 调用 `onDrop(payload.paths, target.path)`。
- 操作入口：`useWorkspaceController.ts:1414` 的 `dropEntries` 规范化路径后调用 `workspaceGateway.copyEntries` 或 `moveEntries`。
- 本地 Shell 操作：`workspaceOperationsGateway.ts:105` 的 `maybePerformSystemCopyOrMove` 对本地到本地 copy/move 调用 `performSystemFileOperation`；`workspaceOperationsGateway.ts:273` 的 `copyWorkspaceEntries` 命中该路径后直接返回 `undefined`。
- Rust 命令：`workspaceIpc.ts:158` 调用 `perform_system_file_operation`；`src-tauri/src/commands/workspace.rs:222` 转到 `windows_shell::perform_system_file_operation`；`src-tauri/src/services/windows_shell.rs:871` 创建 `IFileOperation` 并在 `windows_shell.rs:925` 执行 `PerformOperations()`。

### App -> Explorer 拖出链路

- 内部 pointer drag 起点：`FileListing.tsx:809` 的 `startEntryPointerDrag` 在文件行 `onPointerDown` 启动。
- 出 WebView 判定：`FileListing.tsx:75` 的 `shouldStartSystemFileDragFromPointer` 在 pointer 坐标出 viewport 或 `elementFromPoint` 为 null 时返回 true。
- 切到系统拖拽：`FileListing.tsx:891` 命中出界后执行 `cleanup()`、`activeEntryPointerDragRef.current = null`、`clearEntryDrag()`、`clearDropState()`，然后 `FileListing.tsx:909` 调用 `onStartSystemFileDrag(activeDrag.paths)`。
- controller/gateway：`useWorkspaceController.ts:1630` 过滤远程路径后调用 `workspaceGateway.startSystemFileDrag`；`workspaceGateway.ts:430` 转到 IPC。
- IPC/Rust：`workspaceIpc.ts:146` 调用 `start_system_file_drag`；`commands/workspace.rs:212` 转到 `windows_shell::start_system_file_drag`；`windows_shell.rs:1423` 绑定 shell selection，`windows_shell.rs:1443` 调用 `SHDoDragDrop`，`windows_shell.rs:1455` 限制 allowed effect 为 copy。

### App -> 外部 -> App 拖回链路

- 起点同 App -> Explorer：`FileListing.tsx:891` 切换到 `startSystemFileDrag` 后，内部 pointer drag 已清理。
- 鼠标重新进入 App：同一个由本应用发起的 Shell data object 会被 Tauri `webview.onDragDropEvent` 当作系统 file drag 事件送到 `listenSystemFileDrops`。
- 目标命中：`systemDragDrop.ts:48` 通过坐标命中文件列表、文件夹或 tab 的 `data-entry-drop-*`。
- drop 执行：`systemDragDrop.ts:156` 进入 `actions.dropEntries(..., "copy")`，随后本地路径进入 `perform_system_file_operation`。
- 未确认点：代码中没有 app-origin token 或 source 标记，无法区分 Explorer-origin 与 App-origin system drag；也没有证据表明 Tauri 会自动过滤本应用发起的 drag。需要修复 Agent 用 instrumentation 记录 `startSystemFileDrag` 后收到的 Tauri drag-drop payload 数量和 listener id。

## 已确认风险点

### 风险点 1：系统 drop listener 可能重复注册或短时间并存

- 严重程度：高
- 文件和函数位置：
  - `src/features/workspace/WorkspaceView.tsx:218` `useEffect` 注册 `listenSystemFileDrops`
  - `src/features/workspace/WorkspaceView.tsx:243` effect 依赖 `[actions, handleExplorerFileDropsBlocked]`
  - `src/features/workspace/useWorkspaceController.ts:2521` 创建 `actions`
  - `src/features/workspace/useWorkspaceController.ts:2759` `actions` 依赖包含整个 `state`
  - `src/features/workspace/systemDragDrop.ts:183` `listenSystemFileDrops`
- 为什么可能导致重复 drop 或高亮闪烁：
  - `actions` identity 会随 state 变化而变化，导致 `WorkspaceView` 反复执行 listener 注册 effect。
  - `listenSystemFileDrops` 每次调用都创建独立 `handlePayload` 和 `webview.onDragDropEvent` listener，没有模块级单例或“先清旧再注册新”的序列化。
  - cleanup 等异步 `listenSystemFileDrops(...).then(cleanup => ...)` 返回后才保存 `unlisten`；如果 effect 已 disposed，会调用 cleanup，但在异步注册和 cleanup 之间存在竞态窗口。
- 触发条件：
  - React StrictMode 初始双 effect。
  - controller state 更新导致 `actions` 变更。
  - listener 注册尚未完成时组件重渲染或 remount。
- 预期修复方向：
  - 让系统 drop listener 在 App 生命周期内单例注册，drop 回调用 ref/useEffectEvent 更新。
  - 或者让 effect 依赖稳定 callback，不依赖整个 `actions` 对象。
  - 给 `listenSystemFileDrops` 增加 listener id/instrumentation，并保证旧 listener cleanup 完成后再注册新 listener。
- 推荐补充测试：
  - `WorkspaceView remount 后 system drop listener 不重复`
  - `StrictMode 双 mount 只保留一个 onDragDropEvent listener`
  - `actions identity 变化不会新增 active system drop listener`

### 风险点 2：同一系统 drop payload 没有跨 listener/跨链路去重

- 严重程度：高
- 文件和函数位置：
  - `src/features/workspace/systemDragDrop.ts:118` `createSystemFileDropPayloadHandler`
  - `src/features/workspace/systemDragDrop.ts:149` drop 时 hit-test
  - `src/features/workspace/systemDragDrop.ts:156` 调用 `onDrop`
  - `src/features/workspace/useWorkspaceController.ts:1414` `dropEntries`
- 为什么可能导致重复 drop：
  - `systemDragActive` 是 handler 局部变量，只能防止单个 handler 在 leave/drop 状态错乱时误处理。
  - 没有基于 paths、destination、position、timestamp、operation 的 dedupe key。
  - `dropEntries` 本身也没有 in-flight guard；重复调用会并发进入 gateway。
- 触发条件：
  - 多个 `webview.onDragDropEvent` listener 同时存在。
  - Tauri/wry 对同一原生 drop 产生多次 enter/drop 序列。
  - App-origin Shell drag 回到 App 时被系统 listener 和旧状态共同消费。
- 预期修复方向：
  - 在 `createSystemFileDropPayloadHandler` 或更靠近 controller 的 `dropEntries` 增加短窗口去重。
  - key 至少包含 normalized paths、destination、operation；本地 shell copy 建议同时传 requestId/dropId。
  - in-flight drop 在完成或超时前拒绝重复请求。
- 推荐补充测试：
  - `同一个 Tauri drop payload 只调用一次 onDropEntries`
  - `重复 enter/drop 序列在 dedupe 窗口内只触发一次 copyEntries`
  - `并发相同 dropEntries 只进入一次 workspaceGateway.copyEntries`

### 风险点 3：本地 copy/move 优先走 Windows Shell，重复入口会直接变成多个原生操作

- 严重程度：高
- 文件和函数位置：
  - `src/features/workspace/workspaceOperationsGateway.ts:105` `maybePerformSystemCopyOrMove`
  - `src/features/workspace/workspaceOperationsGateway.ts:286` copy 命中 Shell 路径后返回
  - `src/features/workspace/workspaceIpc.ts:158` `performSystemFileOperation`
  - `src-tauri/src/services/windows_shell.rs:871` `perform_system_file_operation_inner`
- 为什么可能导致重复 drop：
  - `performSystemFileOperation` request 只有 `sources/destination/operation`，没有 `requestId`。
  - Rust 每次调用都创建新的 `IFileOperation`，逐个 `CopyItem/MoveItem` 后 `PerformOperations()`，没有幂等检查。
  - 这正好解释截图中同一个 README.md 冲突对话框重复出现：不是一次任务内部重复，而是多个 Shell 操作实例同时/连续发起。
- 触发条件：
  - 前端重复调用 `workspaceGateway.copyEntries` 或 `moveEntries`。
  - 目标已存在同名文件，Shell 每个独立操作都弹冲突窗口。
- 预期修复方向：
  - 首选在前端 drop 入口做去重，避免启动多个 Shell 操作。
  - Rust 命令可增加可选 requestId/in-flight map 作为最后防线。
- 推荐补充测试：
  - `copyWorkspaceEntries receives duplicate same request key invokes perform_system_file_operation once`
  - `performSystemFileOperation carries requestId/dropId when source is dragDrop`

### 风险点 4：App-origin system drag 没有来源标记，拖回 App 时和 Explorer-origin 完全等价

- 严重程度：高
- 文件和函数位置：
  - `src/features/workspace/FileListing.tsx:891` 切换到系统 drag
  - `src/features/workspace/FileListing.tsx:900` 清理 internal entry drag
  - `src/features/workspace/FileListing.tsx:909` 调用 `onStartSystemFileDrag`
  - `src/features/workspace/useWorkspaceController.ts:1630` `startSystemFileDrag`
  - `src-tauri/src/services/windows_shell.rs:1423` `start_system_file_drag_inner`
- 为什么可能导致重复 drop：
  - 内部 pointer 状态大体被清理，但系统 drag 没有 app-origin 标记。
  - 当同一个 Shell drag 回到 App 时，系统 drop listener 会按外部文件拖入处理。
  - 如果此时存在 listener 重复或 Tauri 多 payload，缺少 app-origin/dropId 会使修复 Agent 很难判断同一用户动作是否已处理。
- 触发条件：
  - 从软件文件列表开始拖动，移出软件，再移入另一个文件列表松开。
- 预期修复方向：
  - 在 `startSystemFileDrag` 前记录 app-origin drag token、paths、startedAt。
  - Tauri system drop payload 进入时携带/匹配该上下文，保证只执行一次；不要简单禁止 app-origin drop，因为 App -> 外部 -> App 可能是用户期望的复制动作。
  - `SHDoDragDrop` 返回或超时后清理 app-origin 上下文。
- 推荐补充测试：
  - `App drag-out 再 drag-in 只触发一次 copyEntries`
  - `startSystemFileDrag 后 internal pointer drag cleanup 不会再触发 pointer drop`
  - `app-origin system drop 和 explorer-origin external drop 都能复制一次`

### 风险点 5：系统高亮与 React/HTML5 高亮共用同名 class，存在 class 覆盖和互相清理

- 严重程度：中到高
- 文件和函数位置：
  - `src/features/workspace/systemDragDrop.ts:95` `updateSystemFileDropHighlight`
  - `src/features/workspace/systemDragDrop.ts:84` `clearSystemFileDropHighlight`
  - `src/features/workspace/FileListing.tsx:1041` folder 外部 Files `dragover`
  - `src/features/workspace/FileListing.tsx:1322` listing 外部 Files `dragover`
  - `src/features/workspace/FileListing.tsx:1668` listing className 使用 `is-drop-target`
  - `src/features/workspace/WorkspacePanelChrome.tsx:384` tab 外部 Files `dragover`
  - `src/features/workspace/WorkspacePanelChrome.tsx:500` tab className 使用 `is-entry-drop-target`
  - `src/features/workspace/workspace.css:669`, `workspace.css:898`, `workspace.css:1145`
- 为什么可能导致高亮闪烁：
  - 系统链路直接操作 DOM class；React 链路通过 state 重新渲染 className。
  - 两者使用同名 `is-drop-target` / `is-entry-drop-target` 和 `data-drop-operation`。
  - React render 会把 DOM className 重写为 JSX 计算值，可能移除系统链路刚添加的 class；下一次 Tauri over 又重新添加。
  - `clearSystemFileDropHighlight` 和 `clearPointerEntryDropHighlight` 都会删除 `dataset.dropOperation`，也可能互相覆盖视觉状态。
- 触发条件：
  - Explorer -> App 时浏览器 HTML5 Files dragover/drop 与 Tauri drag-drop event 同时存在。
  - dragover/leave 在文件行、空白 listing、tab、panel chrome 间快速切换。
  - 目录刷新或重渲染替换了已高亮 DOM。
- 预期修复方向：
  - 统一拖放高亮状态机，避免系统链路直接改 React 管理的 className。
  - 或至少使用不同 class，例如 `is-system-drop-target`，并避免两个清理函数删除对方的状态。
  - 对 `elementFromPoint` null/普通文件行/卸载 DOM 做稳定处理。
- 推荐补充测试：
  - `enter/over/leave 抖动不会造成高亮闪烁`
  - `系统 drop 高亮不被 FileListing 外部 dragover 重渲染清掉`
  - `system clear 不会移除 pointer/internal drop 高亮`

### 风险点 6：WorkspaceView 顶层也消费外部 Files drag/drop

- 严重程度：中
- 文件和函数位置：
  - `src/features/workspace/WorkspaceView.tsx:288` `handleExternalFileDrag`
  - `src/features/workspace/WorkspaceView.tsx:471` `onDragEnter`
  - `src/features/workspace/WorkspaceView.tsx:472` `onDragOver`
  - `src/features/workspace/WorkspaceView.tsx:473` `onDrop`
- 为什么可能导致问题：
  - 该 handler 对所有 HTML5 `Files` 事件 `preventDefault` 并设置 `dropEffect = "copy"`，但不执行复制。
  - 它不是重复复制的直接入口，但可能改变浏览器/Tauri 对原生 drop 的事件行为，且会和 FileListing/PanelChrome 局部 HTML5 handlers 一起参与高亮状态变化。
- 触发条件：
  - 外部 Files drag/drop 冒泡到 workspace shell。
- 预期修复方向：
  - 明确 HTML5 Files handler 的职责：只允许浏览器 fallback，还是只阻止默认行为。
  - 如果 Tauri native drop 是唯一执行入口，HTML5 层不要维护与系统层冲突的高亮。
- 推荐补充测试：
  - `WorkspaceView 顶层 external Files drop 不调用 dropEntries`
  - `FileListing/PanelChrome 外部 drop 与 WorkspaceView 顶层 handler 不造成双高亮`

## 最可能的根因假设

1. 优先验证：`WorkspaceView` 的 `listenSystemFileDrops` 在 StrictMode、state 更新或快速 remount 后出现多个 active `webview.onDragDropEvent` listener。代码证据是 effect 依赖不稳定 `actions`，而 listener 注册没有单例和跨调用去重；未确认的是运行时是否真的泄漏或短时间并存到足以接收同一次 drop。
2. 同一 drop 即使只进入一次 listener，也可能被 Tauri/wry 对 app-origin Shell drag 产生多个 enter/drop payload 序列。代码证据是 handler 没有跨序列 dedupe，且 App-origin drag 没有 source token；未确认的是 Tauri 实际 payload 序列。
3. 高亮闪烁最可能由系统 DOM class 直接操作与 React HTML5 drag state 共用 class 造成。代码证据明确，修复 Agent 可通过记录 className 变化和 React render 次数快速验证。

建议修复 Agent 第一优先级加 instrumentation：给每个 `listenSystemFileDrops` 注册生成 listenerId，记录 register/unlisten、payload type、paths hash、position、target path、onDrop 调用次数、`dropEntries` request key、`perform_system_file_operation` 调用次数。复现一次 App -> 外部 -> App，如果同一 dropId 出现多个 listenerId 调用，即可确认根因 1；如果只有一个 listenerId 但多次 enter/drop，则确认根因 2。

## 建议修复策略

- 在 `WorkspaceView` 或 `systemDragDrop.ts` 保证系统 drop listener 单例。推荐 `WorkspaceView` 只注册一次 listener，内部 drop callback 通过 ref/useEffectEvent 读取最新 `actions.dropEntries`，不要把整个 `actions` 放进 effect 依赖。
- 在 `createSystemFileDropPayloadHandler` 和 `useWorkspaceController.dropEntries` 至少一处增加 drop 去重 guard。更稳妥做两层：UI payload 层防同一 Tauri drop 反复触发，controller 层防任何调用方重复提交同一 operation。
- 为 dragDrop copy/move 生成 `dropId/requestId`，传到 gateway；本地 Shell 路径也应带 requestId，方便日志和可选后端 in-flight 去重。
- 对 App-origin `startSystemFileDrag` 建立短生命周期上下文：paths hash、startedAt、source panel/tab、nativeDragActive。拖回 App 时可以标记为 app-origin，但仍允许复制一次。
- 清理内部 drag-out 状态时保持当前顺序的优点：`FileListing.tsx:891` 已经先 cleanup pointer listener、清 active ref、清 internal drag，再启动 system drag。修复时不要引入新的 pointer/html5 双路径。
- 统一高亮状态：不要让 Tauri system drop 直接改 React 管理的 `is-drop-target`；可以引入 `is-system-drop-target` 或把 system highlight 也纳入 React state。两个清理函数不要删除对方的 class/data attribute。
- Rust `perform_system_file_operation` 可作为最后防线接受 requestId 并在短时间内拒绝重复 request，但主要问题应在前端 drop 入口阻断。

## 建议新增测试

- `systemDragDrop.test.ts`：`createSystemFileDropPayloadHandler ignores duplicate drop payload within dedupe window`
  - 模拟 enter/drop/drop 或 enter/drop/enter/drop，paths/destination 相同。
  - 断言 `onDrop` 只调用一次。

- `systemDragDrop.test.ts`：`listenSystemFileDrops unlistens stale async registrations`
  - stub `getCurrentWebview().onDragDropEvent`，让 promise 延迟 resolve。
  - 模拟 effect disposed 后 resolve。
  - 断言 stale cleanup 被调用，active listener 数量为 0 或 1。

- `WorkspaceView.test.tsx`：`WorkspaceView remount 后 system drop listener 不重复`
  - 在 StrictMode 下 render/unmount/remount。
  - stub `listenSystemFileDrops` 或 Tauri webview listener registry。
  - 触发一次 drop payload。
  - 断言 `actions.dropEntries`/gateway copy 只调用一次。

- `WorkspaceView.test.tsx`：`actions identity 变化不会重复注册 system drop listener`
  - 触发会改变 controller state 的 action。
  - 断言 active system listener 数量仍为 1。

- `FileListing.test.tsx`：`App drag-out 再 drag-in 只触发一次 copyEntries`
  - 模拟 pointerdown、pointermove 到 viewport 外，断言 `onStartSystemFileDrag` 调用且 pointer active 状态清理。
  - 随后向系统 drop handler 注入 app-origin 同 paths payload。
  - 断言 drop/copy 只执行一次。

- `FileListing.test.tsx`：`external Files HTML5 drop does not race system drop highlight`
  - 同时模拟 HTML5 dragover/leave 和 system enter/over。
  - 断言最终 class 不被 React render 清掉，或使用新系统 class 后两者互不影响。

- `WorkspacePanelChrome.test.tsx`：`tab external Files highlight does not clear system highlight`
  - tab 上同时触发 HTML5 Files dragover 和 system highlight。
  - 断言 tab 高亮稳定，drop 不调用 HTML5 `onDropEntries`，系统 drop 只调用一次。

- `useWorkspaceController.test.ts`：`duplicate dragDrop copy request is deduped while in flight`
  - 让 gateway copy promise 延迟。
  - 连续两次调用同 paths/destination/operation 的 `actions.dropEntries`。
  - 断言 `copyEntries` 只调用一次，并验证完成后可处理新的不同 drop。

- `workspaceOperationsGateway.test.ts`：`dragDrop shell copy carries requestId`
  - 调用 copyWorkspaceEntries 时传入 requestId/source dragDrop。
  - 断言 `perform_system_file_operation` request 包含 requestId/dropId，或至少 instrumentation 能关联。

- `workspaceIpc.test.ts`：`performSystemFileOperation forwards request id for drag-drop dedupe`
  - 如果扩展 IPC contract，覆盖 requestId 透传。

## 修复 Agent 需要注意

- 不要破坏 Explorer -> App 正常拖入复制；外部 Explorer 文件拖入 listing、folder row、tab 都应复制一次。
- 不要破坏 App -> Explorer 正常拖出复制；`start_system_file_drag` 当前只允许 copy，修复时不要改成 move。
- 不要破坏 App 内部 A 列表 -> B 列表 pointer drag/drop；`FileListing.tsx:870` 的内部 pointer drop 应继续直接调用 `onDropEntries` 一次。
- 不要破坏 tab 选项卡和文件列表内容区高亮；tab 用 `is-entry-drop-target`，listing/folder 用 `is-drop-target`，若改 class 需要同步 CSS 和测试。
- 不要破坏复制/移动/删除后的文件列表刷新；`dropEntries` 当前 copy 刷新 destination，move 刷新 source parents + destination。
- 不要移除 Windows 权限提升导致 Explorer 拖入被阻止时的诊断提示；`warnIfExplorerFileDropsAreBlocked` 和 `get_windows_drag_drop_environment` 仍需保留。
- 不要把真实 Tauri IPC 错误隐藏成 mock fallback；浏览器 fallback 只能在 Tauri runtime 不存在时使用。

