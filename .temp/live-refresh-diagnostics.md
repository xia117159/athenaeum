# Live Refresh Diagnostics - 诊断说明

## 问题分析

文件列表实时刷新失败的可能原因已收敛到以下几个断点：

1. **前端 Tauri 运行时检测失败** - `hasTauriRuntime()` 返回 false，导致：
   - `setWorkspaceWatchRoots` 走 browser fallback，不调用后端命令
   - `listenWorkspaceFsChanges` 返回 noop，永远收不到事件

2. **后端 watch roots 未正确注册** - 前端调用了但后端未收到/未创建 native watch handles

3. **后端 native watcher 未检测到变化** - Win32 API 未报告文件系统事件

4. **后端事件发送失败** - `app.emit()` 失败但被静默忽略

5. **前端事件监听器未订阅** - listener 在事件发出后才设置

6. **前端事件 root 匹配失败** - 后端发出小写 normalized root，前端 tab path 大小写/格式不匹配

7. **前端刷新被丢弃** - `getVisibleDirectoryRefreshTargets` 没找到目标或 `commitNavigation` 被 stale guard 拦截

## 已添加的诊断日志

### 后端 (Rust)

**文件**: `src-tauri/src/services/file_watcher.rs`

#### `update_roots` 函数
```
[FileWatcher] update_roots called: directory_paths=[...], navigation_parent_paths=[...]
[FileWatcher] normalized: directory_roots={...}, navigation_parent_roots={...}
[FileWatcher] has_roots=true/false, will_start=true/false
```

**作用**: 确认前端调用是否到达后端，normalized roots 是否正确。

#### `run_watch_loop` 函数
```
[FileWatcher] Watch loop started on Windows
[FileWatcher] Roots changed: old={...}, new={...}
[FileWatcher] Created N native watch handles
[FileWatcher] Detected changes in roots: [...]
[FileWatcher] Emitting event: sequence=X, directory_roots=[...], navigation_parent_roots=[...]
[FileWatcher] No event generated for changed roots
```

**作用**: 
- 确认 watch loop 是否启动
- 确认 native watch handles 是否创建成功
- 确认文件系统变化是否被检测到
- 确认事件是否生成并发送

#### `emit_workspace_fs_changed` 函数
```
[FileWatcher] Attempting to emit workspace_fs_changed event
[FileWatcher] Event emitted successfully
[FileWatcher] Failed to emit workspace_fs_changed: <error>
```

**作用**: 确认 Tauri event emit 是否成功。

### 前端 (TypeScript)

**文件**: `src/features/workspace/workspaceLiveRefreshGateway.ts`

#### `setWorkspaceWatchRoots`
```
[LiveRefresh] setWorkspaceWatchRoots called: { hasRuntime, directoryPaths, navigationParentPaths }
[LiveRefresh] Using browser fallback (no Tauri runtime)  // 仅当 hasRuntime=false
[LiveRefresh] setWorkspaceWatchRoots completed
```

**作用**: 
- 确认前端是否调用了 setWatchRoots
- 确认 Tauri runtime 是否被正确检测
- 如果走 fallback，说明 `hasTauriRuntime()` 返回了 false

#### `listenWorkspaceFsChanges`
```
[LiveRefresh] listenWorkspaceFsChanges called: { hasRuntime }
[LiveRefresh] No Tauri runtime detected, returning noop  // 仅当 hasRuntime=false
[LiveRefresh] Setting up event listener for workspace_fs_changed
[LiveRefresh] Received workspace_fs_changed event: <payload>
```

**作用**:
- 确认事件监听器是否设置
- 确认是否走了 noop 路径
- 确认是否收到后端事件

**文件**: `src/features/workspace/useWorkspaceController.ts`

#### Watch roots effect (line ~1261)
```
[LiveRefresh] Watch roots effect: state not ready  // state.status !== "ready"
[LiveRefresh] Watch roots unchanged, skipping update
[LiveRefresh] Watch roots changed: { directoryPaths, navigationParentPaths }
```

**作用**: 确认 watch roots effect 是否执行，roots 是否计算正确。

#### `handleWorkspaceFsChanged`
```
[LiveRefresh] handleWorkspaceFsChanged called: <event>
[LiveRefresh] Debounce timeout expired, flushing refresh
```

**作用**: 确认前端是否收到事件并启动 debounce。

#### `flushLiveRefresh`
```
[LiveRefresh] flushLiveRefresh: { directoryRoots, refreshNavigation }
```

**作用**: 确认 debounce 后是否真正刷新。

#### `refreshVisiblePanelsForPaths`
```
[LiveRefresh] refreshVisiblePanelsForPaths: { paths, targets }
```

**作用**: 
- 确认哪些 paths 需要刷新
- 确认找到了哪些 visible directory tabs
- 如果 targets 为空，说明路径匹配失败

## 使用方法

### 1. 启动应用并查看控制台

用户手动运行：
```powershell
npx tauri dev
```

前端日志在浏览器 DevTools Console，后端日志在 PowerShell 控制台 stderr。

### 2. 操作步骤

1. 在应用中打开一个本地文件夹（如 `C:\Users\Admin\Documents`）
2. 观察前端控制台，应该看到：
   ```
   [LiveRefresh] Watch roots changed: { directoryPaths: ["c:\\users\\admin\\documents"], ... }
   [LiveRefresh] setWorkspaceWatchRoots called: { hasRuntime: true, ... }
   [LiveRefresh] setWorkspaceWatchRoots completed
   ```
3. 观察后端控制台，应该看到：
   ```
   [FileWatcher] update_roots called: directory_paths=["C:\\Users\\Admin\\Documents"], ...
   [FileWatcher] normalized: directory_roots={"c:\\users\\admin\\documents"}, ...
   [FileWatcher] has_roots=true, will_start=false  // false 表示已启动
   [FileWatcher] Roots changed: old={...}, new={"c:\\users\\admin\\documents"}
   [FileWatcher] Created 1 native watch handles
   ```
4. 从 Windows Explorer 在该文件夹中创建/删除/重命名文件
5. 观察后端控制台，应该看到：
   ```
   [FileWatcher] Detected changes in roots: ["c:\\users\\admin\\documents"]
   [FileWatcher] Emitting event: sequence=1, directory_roots=["c:\\users\\admin\\documents"], ...
   [FileWatcher] Event emitted successfully
   ```
6. 观察前端控制台，应该看到：
   ```
   [LiveRefresh] Received workspace_fs_changed event: { sequence: 1, directoryRoots: ["c:\\users\\admin\\documents"], ... }
   [LiveRefresh] handleWorkspaceFsChanged called: <event>
   [LiveRefresh] Debounce timeout expired, flushing refresh
   [LiveRefresh] flushLiveRefresh: { directoryRoots: ["c:\\users\\admin\\documents"], ... }
   [LiveRefresh] refreshVisiblePanelsForPaths: { paths: [...], targets: [{ panelId, tabId, path, ... }] }
   ```
7. 应用界面应该刷新显示最新文件列表

### 3. 诊断各断点

#### 断点 1: `hasRuntime: false`
**症状**: 前端日志显示 `[LiveRefresh] Using browser fallback (no Tauri runtime)`

**原因**: `isTauri()` 或 `__TAURI_INTERNALS__` 检测失败

**解决**: 检查 Tauri 初始化、窗口加载时机、或 `@tauri-apps/api` 版本

#### 断点 2: 后端未收到 `update_roots`
**症状**: 前端调用了 `setWatchRoots`，但后端控制台没有 `[FileWatcher] update_roots called`

**原因**: Tauri IPC 通道问题或命令未注册

**解决**: 检查 `src-tauri/src/lib.rs` 的 `invoke_handler` 是否包含 `set_workspace_watch_roots`

#### 断点 3: Native watch handles 未创建
**症状**: 后端日志显示 `[FileWatcher] Created 0 native watch handles`

**原因**: `create_native_directory_watches` 失败（路径无效、权限不足、Win32 API 失败）

**解决**: 检查 `normalize_local_directory_root` 返回值，检查 `FindFirstChangeNotificationW` 返回 `INVALID_HANDLE_VALUE`

#### 断点 4: Native watcher 未检测到变化
**症状**: 文件操作后，后端没有 `[FileWatcher] Detected changes in roots`

**原因**: 
- `WaitForMultipleObjects` timeout (50ms) 过短，但这应该会在 250ms reload 后再次检测
- `FindFirstChangeNotificationW` 的 `bWatchSubtree=false` 和 `dwNotifyFilter` 设置不正确
- Win32 handle 已失效

**解决**: 
- 检查 `wait_for_native_directory_changes` 的 `WaitForMultipleObjects` 返回值
- 检查 `FindNextChangeNotification` 是否被调用
- 考虑将 `bWatchSubtree` 改为 `true` (但会增加事件噪声)

#### 断点 5: 事件发送失败
**症状**: 后端显示 `[FileWatcher] Failed to emit workspace_fs_changed: <error>`

**原因**: 
- 主窗口未创建或已关闭
- 事件名拼写错误
- Payload serde 失败

**解决**: 检查窗口 label、事件名、`WorkspaceFsChangedEvent` 的 `#[serde]` 属性

#### 断点 6: 前端未收到事件
**症状**: 后端显示 `Event emitted successfully`，但前端没有 `[LiveRefresh] Received workspace_fs_changed event`

**原因**: 
- 前端监听器未设置（`hasRuntime: false` 或 effect 未执行）
- 事件监听在事件发出后才设置（时序问题）
- Tauri 事件系统 IPC 断开

**解决**: 
- 检查 `listenWorkspaceFsChanges` 是否走了 noop
- 检查 capabilities/permissions 是否允许 `core:event:allow-listen`
- 在 `listenWorkspaceFsChanges` 返回的 promise resolve 后，手动触发一次后端事件测试

#### 断点 7: 路径匹配失败
**症状**: 前端收到事件，但 `refreshVisiblePanelsForPaths` 显示 `targets: []`

**原因**: 
- 后端 emit 的 root 是小写 normalized (`c:\users\...`)
- 前端 tab `snapshot.location.path` 是原始大小写 (`C:\Users\...`)
- `pathsEqual` / `getPathComparisonKey` 匹配逻辑有 bug

**解决**: 
- 检查 `getVisibleDirectoryRefreshTargets` 的 `normalizedRoots` 和 `tabPath`
- 确认 `pathsEqual` 正确 lower-case 比较
- 前端添加测试：后端 emit lowercase root，验证能匹配 mixed-case tab path

#### 断点 8: `commitNavigation` 被拦截
**症状**: `targets` 不为空，但文件列表未刷新

**原因**: 
- `commitNavigation` 的 stale request guard 丢弃了刷新结果
- `resolveDirectory` 失败
- `tabSnapshotCommitted` 未写入当前 active tab

**解决**: 
- 在 `commitNavigation` 添加诊断日志
- 检查 `historyIndex` 是否匹配
- 检查 `tabId` 是否仍然存在

## 预期输出示例

### 正常工作的完整日志链

#### 前端控制台
```
[LiveRefresh] listenWorkspaceFsChanges called: { hasRuntime: true }
[LiveRefresh] Setting up event listener for workspace_fs_changed
[LiveRefresh] Watch roots changed: { directoryPaths: ["c:\\users\\admin\\documents"], navigationParentPaths: [] }
[LiveRefresh] setWorkspaceWatchRoots called: { hasRuntime: true, directoryPaths: ["C:\\Users\\Admin\\Documents"], navigationParentPaths: [] }
[LiveRefresh] setWorkspaceWatchRoots completed
[LiveRefresh] Received workspace_fs_changed event: { sequence: 1, directoryRoots: ["c:\\users\\admin\\documents"], navigationParentRoots: [] }
[LiveRefresh] handleWorkspaceFsChanged called: { sequence: 1, directoryRoots: ["c:\\users\\admin\\documents"], navigationParentRoots: [] }
[LiveRefresh] Debounce timeout expired, flushing refresh
[LiveRefresh] flushLiveRefresh: { directoryRoots: ["c:\\users\\admin\\documents"], refreshNavigation: false }
[LiveRefresh] refreshVisiblePanelsForPaths: { paths: ["c:\\users\\admin\\documents"], targets: [{ panelId: "left", tabId: "...", path: "C:\\Users\\Admin\\Documents", historyIndex: 0 }] }
```

#### 后端控制台
```
[FileWatcher] update_roots called: directory_paths=["C:\\Users\\Admin\\Documents"], navigation_parent_paths=[]
[FileWatcher] normalized: directory_roots={"c:\\users\\admin\\documents"}, navigation_parent_roots={}
[FileWatcher] has_roots=true, will_start=true
[FileWatcher] Watch loop started on Windows
[FileWatcher] Roots changed: old={}, new={"c:\\users\\admin\\documents"}
[FileWatcher] Created 1 native watch handles
[FileWatcher] Detected changes in roots: ["c:\\users\\admin\\documents"]
[FileWatcher] Emitting event: sequence=1, directory_roots=["c:\\users\\admin\\documents"], navigation_parent_roots=[]
[FileWatcher] Attempting to emit workspace_fs_changed event
[FileWatcher] Event emitted successfully
```

## 下一步

1. 用户运行 `npx tauri dev`
2. 按照"操作步骤"执行，收集完整日志
3. 根据日志定位真实断点
4. 针对性修复

## 已添加的测试

**文件**: `src/features/workspace/workspaceLiveRefreshIntegration.test.ts`

覆盖：
- `hasTauriRuntime` 在有/无 `__TAURI_INTERNALS__` 时的返回值
- `setWorkspaceWatchRoots` 在有/无 runtime 时是否调用后端
- `listenWorkspaceFsChanges` 在有/无 runtime 时是否返回 noop
- `invokeRequired` 在有/无 runtime 时是否走 fallback

这些测试确保基础 IPC 逻辑正确，但不能覆盖真实 Tauri 环境的运行时检测和事件分发。
