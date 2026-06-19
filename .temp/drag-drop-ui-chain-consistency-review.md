# Drag-drop UI Chain Consistency Review

## 1. 结论摘要

- 确认当前剩余问题高度符合“纯 UI 高亮问题”：现有 drop/copy 执行链路仍能通过 `listenSystemFileDrops()` -> `actions.dropEntries()` -> `workspaceGateway.copyEntries()` -> `perform_system_file_operation` 到达系统文件操作；缺失点集中在 App-origin system drag 回到 App 后的 hover/target 高亮。
- 最可能根因：`FileListing.tsx` 在内部 pointer drag 离开 WebView 时主动 `clearEntryDrag()`、`clearDropState()` 并切换到 `startSystemFileDrag()`；回到 App 后内部 pointer 高亮链路已经结束，只能依赖 Tauri native `onDragDropEvent` 的 `enter/over` payload 调用 `updateSystemFileDropHighlight()`。如果同源 `SHDoDragDrop` 回到当前 WebView 时没有稳定发送 `enter/over`，或者 payload position hit-test 失败，就会出现“drop 可用但 hover 高亮缺失”。
- 功能链路风险：未发现需要立即改变 copy/drop 执行逻辑的证据；当前主要风险是 UI 事件职责重复导致后续修复容易误伤现有四条链路，尤其是 HTML5 external `Files` handlers、Tauri native drag-drop listener、内部 pointer drag helper 三层同时存在。
- 不建议在未加日志/测试前改动 `dragDropEnabled`、Tauri IPC、Rust `SHDoDragDrop` 或 `perform_system_file_operation` 行为；这会影响 Explorer -> App 和 App -> Explorer 主路径。

## 2. 四条链路逐条调用链

### 2.1 App A 文件列表 -> 直接移入 App B 文件列表 -> drop

- 起点事件：`FileListing.tsx` 的文件项 `onPointerDown` 调用 `startEntryPointerDrag()`（约 `src/features/workspace/FileListing.tsx:809`）。
- 中间状态/事件转换：`window.pointermove` 超过阈值后进入内部 pointer drag；`getElementFromClientPoint()` + `getPointerEntryDropTarget()` 解析当前命中的 tab/folder/listing（`FileListing.tsx:346`、`FileListing.tsx:916`）。
- 高亮负责方：内部 pointer helper `applyPointerEntryDropHighlight()` 直接给目标 DOM 加 `is-drop-target` 或 `is-entry-drop-target`，并写 `data-drop-operation`（`FileListing.tsx:121`、`FileListing.tsx:132`）。CSS 在 `workspace.css:669`、`workspace.css:899`、`workspace.css:1147` 渲染视觉。
- drop 执行方：`pointerup` 时再次 hit-test，调用 `onDropEntries(activeDrag.paths, dropTarget.path, dropTarget.operation)`（`FileListing.tsx:863`、`FileListing.tsx:870`），随后进入 `useWorkspaceController.dropEntries()`（`useWorkspaceController.ts:1428`）。
- cleanup 负责方：`finishDrag()` 中 `clearEntryDrag()` + `clearDropState()`，`clearDropState()` 会清内部 pointer 高亮和 React HTML5 高亮 state（`FileListing.tsx:873`、`FileListing.tsx:679`）。
- 当前一致性评价：功能与高亮一致性较好，已有 `FileListingShell transfers pointer-drag listing highlight between file lists` 覆盖 A->B listing 高亮转移和一次 drop。但该链路使用 pointer helper，不经过 Tauri native system highlight。

### 2.2 Explorer -> App A 文件列表 -> drop

- 起点事件：真实 Windows/Tauri 主路径是 `WorkspaceView.tsx` 挂载 `listenSystemFileDrops()`（`WorkspaceView.tsx:225`），Tauri `getCurrentWebview().onDragDropEvent()` 接收 `enter/over/drop/leave`（`systemDragDrop.ts:218`、`systemDragDrop.ts:239`）。
- 中间状态/事件转换：`createSystemFileDropPayloadHandler()` 维护 `systemDragActive`；`enter` 以 `paths.length > 0` 激活，`over` 在 active 时更新 hover，`drop` 再 hit-test 并执行（`systemDragDrop.ts:149`）。
- 高亮负责方：`updateSystemFileDropHighlight()` -> `findSystemFileDropTargetFromPoint()`，给 tab 加 `is-system-entry-drop-target`，给 folder/listing 加 `is-system-drop-target`，写 `data-system-drop-operation="copy"`（`systemDragDrop.ts:79`、`systemDragDrop.ts:126`）。CSS 与内部高亮共用视觉 selector（`workspace.css:669`、`workspace.css:899`、`workspace.css:1147`）。
- drop 执行方：`WorkspaceView` 的 native drop callback 固定调用 `actions.dropEntries(paths, destination, "copy")`（`WorkspaceView.tsx:225` 到 `WorkspaceView.tsx:227`），再进入 controller/gateway。
- cleanup 负责方：`leave`、`drop` 后、listener unmount 都调用 `clearSystemFileDropHighlight()`（`systemDragDrop.ts:115`、`systemDragDrop.ts:155`、`systemDragDrop.ts:181`、`systemDragDrop.ts:243`）。HTML5 `Files` handlers 在 `FileListing.tsx`/`WorkspacePanelChrome.tsx` 只 preventDefault、设置 copy、清 React state，不执行 drop。
- 当前一致性评价：系统高亮与 drop 执行职责清晰，但与 HTML5 external `Files` hover state 重叠。`dragDropEnabled` 在 `src-tauri/tauri.conf.json:21` 为 true，真实 Windows 文件拖放应以 Tauri native event 为主；HTML5 `Files` handler 更像浏览器/测试兼容层。

### 2.3 App A 文件列表 -> 出窗口 -> 回 App B 文件列表 -> drop

- 起点事件：同 2.1，先由 `startEntryPointerDrag()` 启动内部 pointer drag。
- 中间状态/事件转换：当 `shouldStartSystemFileDragFromPointer()` 判断 pointer 在 viewport 外或 `elementFromPoint()` 为 null（`FileListing.tsx:75`），`handlePointerMove()` 会停止 pointer drag、清状态、释放 pointer capture，然后调用 `onStartSystemFileDrag?.(activeDrag.paths)`（`FileListing.tsx:891` 到 `FileListing.tsx:909`）。controller 过滤远程路径后调用 `workspaceGateway.startSystemFileDrag()`（`useWorkspaceController.ts:1652`、`useWorkspaceController.ts:1658`），最终 Rust `start_system_file_drag` 执行 `SHDoDragDrop`（`src-tauri/src/services/windows_shell.rs:1423`、`windows_shell.rs:1444`）。
- 高亮负责方：出窗口后内部 `is-drop-target` 已清除；回 App 后理论上只能由 `systemDragDrop.ts` 的 `enter/over` -> `updateSystemFileDropHighlight()` 建立 `is-system-drop-target`/`is-system-entry-drop-target`。
- drop 执行方：如果 Tauri 收到 native `drop`，仍由 `createSystemFileDropPayloadHandler()` hit-test 后调用 `onDrop(paths, target.path)`；`WorkspaceView` 固定以 copy 进入 `dropEntries()`。
- cleanup 负责方：出窗口切换时 `FileListing.tsx` 调用 `clearEntryDrag()`/`clearDropState()`；系统事件 `drop/leave/unlisten` 调用 `clearSystemFileDropHighlight()`。两类 cleanup 目前按 `data-drop-operation` 与 `data-system-drop-operation` 分离，理论上不会互删对方 class/data。
- 当前一致性评价：这是当前问题链路。执行链路大概率可用，但 hover 可视反馈完全依赖 native `enter/over` 与 hit-test。现有测试只覆盖“拖出会启动 native system drag”，没有覆盖“同一次 native system drag 回 App 后 over 高亮”。

### 2.4 Explorer -> App A 文件列表 -> 再移出到 Explorer -> drop

- 起点事件：Explorer 文件拖入 App 时由 Tauri native `enter/over` 触发 App 内系统高亮。
- 中间状态/事件转换：在 App 内移动时 `over` 持续更新 `is-system-*`；移出 App 时理论上收到 `leave`，`createSystemFileDropPayloadHandler()` 将 `systemDragActive=false` 并清高亮。
- 高亮负责方：App 内由 `systemDragDrop.ts` 负责，移出后目标是 Explorer，App 不再负责外部目标视觉。
- drop 执行方：最终 drop 到 Explorer 应由系统/Explorer 执行，App 不应调用 `actions.dropEntries()`；只有 App 内 native `drop` 才会执行。
- cleanup 负责方：Tauri `leave` 和 listener cleanup。若没有 `leave`，系统高亮可能残留到下一次 payload；当前 `updateSystemFileDropHighlight()` 有 stale element recovery，但没有“窗口失焦/drag结束但未leave”的兜底。
- 当前一致性评价：策略方向正确，不应拦截或模拟 Explorer drop。残余风险是 native `leave` 丢失时 App 高亮残留，这与当前缺失高亮相反，但属于同一系统事件可靠性边界。

## 3. 当前 UI 高亮缺失问题定位

### 3.1 理论上应显示高亮的代码

- `WorkspaceView.tsx:225` 注册 `listenSystemFileDrops()`。
- `systemDragDrop.ts:239` 将 Tauri `DragDropEvent` payload 交给 `createSystemFileDropPayloadHandler()`。
- `systemDragDrop.ts:160` 处理 `enter`，`systemDragActive = payload.paths.length > 0` 后调用 `updateSystemFileDropHighlight(payload.position)`。
- `systemDragDrop.ts:168` 处理 `over`，在 active 时继续调用 `updateSystemFileDropHighlight(payload.position)`。
- `systemDragDrop.ts:126` 的 `updateSystemFileDropHighlight()` 使用 `document.elementFromPoint(position.x / devicePixelRatio, position.y / devicePixelRatio)` 找目标，并加系统 class。

### 3.2 实际可能没有显示的原因，按可能性排序

1. **同源 `SHDoDragDrop` 回到当前 WebView 时没有稳定发送有用的 `over`，或只在进入边界时发送一次 `enter`。** 这与“实际 drop/copy 基本可用、hover 不显示”最吻合：`enter` 可能只负责激活 `systemDragActive`，但位置在窗口边缘或非 listing 目标；后续如果缺少 `over`，直到 `drop` 瞬间才会重新 hit-test，用户看不到持续 hover。
2. **`enter` 丢失或 `enter.paths.length === 0` 导致 `systemDragActive=false`，后续 `over` 被忽略。** 当前 `over` payload 类型没有 paths，handler 只有在 `enter` 激活后才更新高亮（`systemDragDrop.ts:160`、`systemDragDrop.ts:168`）。如果 App-origin drag 的 `enter` payload 不含 paths 或被 Tauri/Windows 过滤，hover 永远不会调用 `updateSystemFileDropHighlight()`。
3. **坐标 hit-test 失败。** Tauri 类型定义中 `position` 是 `PhysicalPosition`，当前代码除以 `window.devicePixelRatio` 是合理方向；但多显示器 DPI、DevTools 打开、WebView client area 偏移或 position 为窗口/屏幕坐标差异都可能让 `elementFromPoint()` 命中错误元素或 null。Tauri 类型说明也提到 debugger 打开时 drop position 可能不准。
4. **目标 metadata 覆盖不完整。** `findSystemFileDropTargetFromPoint()` 能处理 folder/tab/listing，也能从普通文件行 fallback 到 listing；但如果命中 header、panel chrome 空白、scrollbar、body padding、搜索结果或 navigation tab，则返回 null。当前报告范围是文件列表，主要风险是 header/scrollbar/空白边缘。
5. **React rerender 覆盖系统 class。** 系统高亮是 imperative `classList.add()`，React 渲染 className 时可能重写 DOM class。现有测试验证 `clearSystemFileDropHighlight()` 不会清内部 `is-drop-target`，但没有覆盖“系统高亮加上后组件因 selection/filter/status rerender 是否仍保留”。如果回窗时同时触发 focus/selection/navigation 状态更新，系统 class 可能被 React className 覆盖。
6. **全局 HTML5 `Files` handlers 与 native listener 时序重叠。** `WorkspaceView.tsx:291`、`:474-476` 会对 `Files` drag enter/over/drop preventDefault 并设置 copy；文件列表和 tab 也有 external `Files` handlers。真实 `dragDropEnabled=true` 时主路径应是 native，但如果 HTML5 事件也发生，它们只设置 React state 或清 state，不调用 `updateSystemFileDropHighlight()`，可能造成视觉状态不一致。

### 3.3 需要加日志或测试验证的关键点

- 在 `systemDragDrop.ts` 的 native handler 临时记录 App-origin 回窗时是否收到 `enter`、`over`、`drop`、`leave`，以及每个 payload 的 `paths.length`、`position`、`systemDragActive`。
- 在 `updateSystemFileDropHighlight()` 临时记录 `position`、缩放后的 client point、`document.elementFromPoint()` 命中的 selector、最终 `target.kind/path`。
- 在 `FileListing.tsx` 拖出分支临时记录 `clearEntryDrag()`、`clearDropState()`、`onStartSystemFileDrag()` 顺序是否只发生一次。
- 补 `systemDragDrop.test.ts`：重复 drop 去重后，再次 `enter/over` 仍应高亮；`over` 在没有 active enter 时当前不会高亮，若实测 App-origin 只有 over/drop，需要调整策略并加测试。
- 人工验证必须在 Tauri shell 内执行，不能只依赖 jsdom，因为问题核心是 WebView/OLE native event 时序。

## 4. 代码一致性审查

### 4.1 Target hit-test 是否重复或不一致

- 重复点 1：`FileListing.tsx:getPointerEntryDropTarget()` 与 `systemDragDrop.ts:findSystemFileDropTargetFromPoint()` 都实现了“普通文件行 fallback 到 listing、folder/tab/listing 读取 `data-entry-drop-kind/path`”逻辑。区别是 pointer 版本计算 copy/move、解析 panelId；system 版本固定 copy 且接收 physical position。
- 重复点 2：`WorkspacePanelChrome.tsx:getEntryDropTabFromEvent()` 另有 tab strip hit-test，用 `document.elementFromPoint(event.clientX, event.clientY)` 兜底；这和系统 `findSystemFileDropTargetFromPoint()` 对 tab 的 `closest("[data-entry-drop-kind]")` 是两套。
- 风险：后续新增可 drop 区域时容易只改其中一处，导致内部 pointer、HTML5 entry drag、native system drag 命中结果不一致。

### 4.2 Highlight class/data 职责是否清晰

- 内部 pointer/system 两套 class 名称清晰：`is-drop-target`/`is-entry-drop-target` 对应 `data-drop-operation`；`is-system-drop-target`/`is-system-entry-drop-target` 对应 `data-system-drop-operation`。
- CSS 视觉 selector 合并良好：tab、listing、entry item 都同时覆盖内部和系统 class（`workspace.css:669`、`:899`、`:1147`）。
- 缺口：`data-system-drop-operation` 当前没有 CSS 或 UI 使用，只是测试/语义字段；如果未来显示 copy/move badge，需要补系统路径专属视觉。

### 4.3 Cleanup 是否互相误清理

- 系统清理 `clearSystemFileDropHighlight()` 只删 `highlightedSystemDropClass` 和 `dataset.systemDropOperation`，不会删内部 `is-drop-target`/`data-drop-operation`；已有 `systemDragDrop.test.ts` 覆盖。
- 内部清理 `clearPointerEntryDropHighlight()` 只删内部 class/data，不会删 `is-system-*`；但没有直接测试“system clear 不清 pointer”和“pointer clear 不清 system”的双向覆盖。
- React HTML5 external handler 的 `clearDropState()` 会清内部 pointer/React HTML5 state，不会直接清系统 class；但如果触发 rerender，可能间接覆盖 imperative 系统 class。

### 4.4 Drop 去重是否只影响执行，不影响 hover 视觉

- `systemDragDrop.ts:wasSystemDropRecentlyHandled()` 只在 `drop` 分支、`updateSystemFileDropHighlight()` 和 `clearSystemFileDropHighlight()` 之后执行（`systemDragDrop.ts:180` 到 `systemDragDrop.ts:187`）。因此当前代码结构上不会阻止 `enter/over` hover。
- 测试缺口：现有测试名为“ignores duplicate enter/drop payloads”，实际只验证第二次 drop 不执行；没有断言第二次 `enter` 后仍显示高亮，也没有断言 duplicate drop 的去重不会影响下一轮 hover。

### 4.5 Gateway/controller 边界是否清晰

- `WorkspaceView` 只把 drop 转成 `actions.dropEntries()`，不直接调用 Tauri IPC，符合边界。
- `useWorkspaceController.dropEntries()` 做路径 normalize、自身/子目录保护、same-parent move no-op、in-flight request 去重，然后调用 `workspaceGateway.copyEntries/moveEntries()`（`useWorkspaceController.ts:1428`）。
- `workspaceOperationsGateway.ts:108` 附近对 local->local copy/move 优先调用 `performSystemFileOperation()`，远程路径走 operation planner，没有隐藏真实 Tauri IPC 错误。
- `startSystemFileDrag()` 只过滤 remote path 后调用 gateway（`useWorkspaceController.ts:1652`、`useWorkspaceController.ts:1658`），IPC wrapper 在非 Tauri runtime 返回 null；真实 runtime 错误不会被 mock fallback 掩盖。

### 4.6 CSS 视觉状态是否统一、是否遗漏 selector

- 已覆盖 tab、listing scroll、details row、icon card、list item、tile/content item。
- 可能遗漏：文件列表 header、scrollbar/空白边缘、panel listing 外层 `.panel-listing` 不显示系统 drop target。若 `elementFromPoint()` 命中 header 或 panel 空白，系统 helper 返回 null，不会高亮当前目录。
- 视觉优化点：内部和系统高亮目前都是浅蓝背景/细内描边，copy/move operation 没有可见差异。App-origin system drag 固定 copy，所以问题不大，但内部 move/copy 可视反馈也较弱。

## 5. 冗余/垃圾代码/最佳实践问题

### 必须修复

- `src/features/workspace/systemDragDrop.ts:createSystemFileDropPayloadHandler()`：当前 `over` 依赖之前的 active `enter`。如果日志确认 App-origin system drag 回窗缺失 `enter` 或 `enter.paths`，必须调整系统 hover 激活策略，否则高亮无法可靠出现。修复需保持 drop 去重只作用于 drop。
- `src/features/workspace/systemDragDrop.test.ts`：必须补“duplicate drop 不阻止后续 enter/over 高亮”和“App-origin style 回窗 payload 序列显示系统高亮”的测试，否则下一轮容易再次回归成 drop 可用但 hover 缺失。

### 建议优化

- `src/features/workspace/FileListing.tsx:getPointerEntryDropTarget()` 与 `src/features/workspace/systemDragDrop.ts:findSystemFileDropTargetFromPoint()`：建议后续抽共享 target resolver，输入 client point/element、输出 `{kind,path,element,panelId?}`，pointer 再补 operation。先小步抽，不要一次重构所有拖放。
- `src/features/workspace/WorkspacePanelChrome.tsx:getEntryDropTabFromEvent()`：tab drop hit-test 可逐步复用共享 resolver 或至少统一 data attribute 规则，减少 tab strip 特判。
- `src/features/workspace/FileListing.tsx:applyPointerDropTarget()`：当前内部 pointer hover 使用 imperative DOM class，但函数内部仍调用 `clearDropState()` 并把 `dropTargetPath`/`isListingDropTarget` 置空。这是为了避免和 React HTML5 state 混用，但命名上容易误解为 React state 也参与 pointer hover；后续建议把 HTML5 state 与 pointer imperative highlighter 的 helper 命名拆清楚。
- `src/features/workspace/FileListing.tsx:handleListingDragOver()`、entry folder `onDragOver`、`WorkspacePanelChrome.tsx:handleEntryDragOverTab()`：HTML5 external `Files` handlers 只负责 allow/visual state，不执行 drop。建议在注释或 helper 命名上明确“external HTML5 fallback/advertise only”，避免误以为 Explorer drop 在这里执行。
- `src/features/workspace/workspace.css`：可以增加对 `[data-system-drop-operation="copy"]` 的细微视觉 cue 或统一 copy badge，但不要改变主高亮 selector。
- `src/features/workspace/systemDragDrop.ts:clearSystemFileDropHighlight()`：可考虑增加 window blur/drop-cancel 兜底清理，但需要人工验证，避免正常拖入期间误清。

### 暂不建议动

- `src-tauri/src/services/windows_shell.rs:start_system_file_drag_inner()`：`SHDoDragDrop`、`IDropSource`、`DROPEFFECT_COPY` 当前是 App -> Explorer/系统链路核心。UI 高亮问题未证明源自 Rust data object，不应先改 allowed effects 或 COM 拖放实现。
- `src-tauri/tauri.conf.json:dragDropEnabled=true`：这是 Tauri native file drop 事件的前提。改为 false 会把 Explorer -> App 主路径切到 HTML5 drag/drop，风险高且违反当前真实 IPC/Tauri native 结构。
- `workspaceOperationsGateway.ts:maybePerformSystemCopyOrMove()` 与 `perform_system_file_operation`：当前重复 Shell copy/move 已修过，不应为 UI hover 问题改动执行层。
- `entryDrag.ts:startEntryDrag()`：目前没有生产调用，但测试和 HTML5 legacy/internal payload 仍依赖 `readEntryDragPayload()` 兼容层。不要在本轮删除；后续如清理，必须先证明没有浏览器 fallback 和 tab drop 测试依赖。

## 6. 推荐后续修复方案

### 6.1 保守方案：最小改动修复高亮

- 做法：先加测试与临时日志验证 App-origin 回窗 payload。若确认 `enter` 缺失但 `over` 到达，可让 `over` 在可命中 drop target 时也允许建立视觉高亮，但 drop 执行仍要求 drop payload 有 paths；去重仍只在 drop 分支执行。
- 功能风险：低。只改 hover 激活，不改 copy/move 执行、不改 IPC、不改 Rust。
- UI 风险：低到中。若 `over` 对非文件系统拖放也触发，可能误显示高亮；需用 payload 来源或 Tauri file drop listener语义约束，并加测试。

### 6.2 中等方案：整理系统拖放与内部拖放高亮职责

- 做法：抽一个共享 target resolver，统一 folder/listing/plain file/tab 的命中规则；系统高亮继续用 `is-system-*`，内部 pointer 继续用 `is-*`，仅复用 target resolution 和 cleanup 测试矩阵。
- 功能风险：中。触及三条 UI 链路，需要覆盖 A->B、Explorer->App、App->out->App、Explorer->App->out。
- UI 风险：中。若 resolver 对 tab strip、plain file row、blank listing 的优先级和现状不同，会改变 hover 位置。

### 6.3 不推荐方案

- 不推荐关闭 `dragDropEnabled` 改走 HTML5 Files drop：会绕开 Tauri native file drop，Explorer -> App 与权限/高完整性诊断、native payload 坐标、系统 drop 行为都会改变。
- 不推荐在 `FileListing.tsx` 拖出后继续保留内部 pointer drag 状态并尝试跨窗口追踪：pointer capture/WebView 边界不可靠，且会和 `SHDoDragDrop` 形成双执行风险。
- 不推荐在 Rust `SHDoDragDrop` 完成后由返回值反推 App 内 drop：drop 目标和路径必须由前端当前 DOM hit-test 决定，Rust 层无法安全知道文件列表目标。

## 7. 建议新增或补充测试

- `systemDragDrop.test.ts`：模拟 App A -> 出窗口 -> 回 App B 的 native payload 序列，断言目标 listing 获得 `is-system-drop-target` 和 `data-system-drop-operation="copy"`。
- `systemDragDrop.test.ts`：模拟重复 drop 去重窗口内第二次 `enter/over`，断言 hover 高亮仍显示，但第二次 `drop` 不调用 `onDrop`。
- `systemDragDrop.test.ts`：补双向 cleanup 隔离测试，断言 `clearSystemFileDropHighlight()` 不清内部 pointer class/data，`clearPointerEntryDropHighlight()` 或可通过组件行为断言不清系统 class/data。
- `FileListing.test.tsx` 或 `WorkspaceView` 级测试：Explorer -> App 文件列表正常 `Files/native` 高亮并 drop 一次；如果无法在 jsdom 覆盖 Tauri native listener，则至少覆盖 `createSystemFileDropPayloadHandler()` + DOM metadata。
- `FileListing.test.tsx`：App A -> B 内部 pointer drag 高亮和 drop 一次继续不受系统 highlighter 改动影响。
- `WorkspacePanelChrome.test.tsx`：系统高亮命中 ready directory tab 使用 `is-system-entry-drop-target`，navigation tab 不暴露 drop metadata。
- 人工验证：Tauri shell 中记录 App-origin system drag 回窗 `enter/over/drop/leave` 序列；DevTools 关闭、100%/150% DPI 各测一次。

## 8. 最终 TODO List

- [ ] 在 `systemDragDrop.ts` 增加可移除的调试日志或测试注入点，记录 App-origin 回窗的 native payload 序列；人工验证后移除或改成受 dev flag 控制。
- [ ] 补 `systemDragDrop.test.ts`：App A -> 出窗口 -> 回 App B 时目标 listing/tab/folder 显示 `is-system-drop-target`/`is-system-entry-drop-target`。
- [ ] 补 `systemDragDrop.test.ts`：重复 drop 去重不阻止后续 `enter/over` hover 高亮。
- [ ] 补 cleanup 隔离测试：system clear 不清 pointer/internal drop 高亮，pointer/internal clear 不清 system 高亮。
- [ ] 若验证 `over` 缺少 active enter，最小修改 `createSystemFileDropPayloadHandler()` 的 hover 激活策略，并保证 drop 执行仍只由 `drop.paths` 驱动。
- [ ] 人工验证 Explorer -> App：folder/listing/tab 高亮正常，drop 只执行一次。
- [ ] 人工验证 App A -> B 直接拖放：内部 pointer 高亮和 copy/move operation 不变，drop 只执行一次。
- [ ] 人工验证 App A -> 出窗口 -> 回 App B：回窗 hover 有系统高亮，drop copy 一次。
- [ ] 人工验证 Explorer -> App -> 出到 Explorer：App 内 leave 清理高亮，App 不执行 drop。
- [ ] 后续小步抽取共享 target resolver，先覆盖 folder/listing/plain file fallback，再考虑 tab strip，避免一次性重构全部拖放系统。

## 验证说明

- 本轮没有修改实现代码，也没有加入 instrumentation；只新增本报告。
- 未运行完整 `npm test`/`npm run build`/`cargo test`，原因是本轮任务要求以分析、定位、审查为主，且未改动生产代码。后续编码修复前应先补失败测试，再运行至少 `npm test`，如触及 Rust/Tauri IPC 再运行 `cargo test --manifest-path src-tauri/Cargo.toml --offline`。
