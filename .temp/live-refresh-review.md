# SimpleFileManager 文件列表实时刷新审查报告

## 范围

本次只做根因定位和代码实现审查，未修改实现代码。审查路径包括：

- 后端 watcher：`src-tauri/src/services/file_watcher.rs`
- Tauri 命令/事件契约：`src-tauri/src/commands/workspace.rs`、`src-tauri/src/lib.rs`、`src-tauri/capabilities/default.json`、`src-tauri/permissions/default.toml`
- 前端事件 gateway / controller：`src/features/workspace/workspaceLiveRefreshGateway.ts`、`src/features/workspace/useWorkspaceController.ts`
- 现有测试：`src-tauri/src/services/file_watcher.rs` 内单测、`src/features/workspace/useWorkspaceController.test.ts`、`src/features/workspace/workspaceLiveRefreshGateway.test.ts`

## 结论

简单的“已注册可见目录下删除一个直接子文件”按当前轮询签名设计应该能被检测到：`directory_signature` 读取 root 的直接子项，删除会改变 `entries`，`poll_changed_roots` 会比较签名并发出 `workspace_fs_changed`。因此用户看到的“经常不刷新”不太像单纯的 `fs::read_dir` 无法看到 Explorer 删除，更像是以下组合问题：

1. watcher 仍然是轮询 + 注册时重建基线模型，root 更新、导航切换、路径格式变化和首次注册窗口都可能吞掉刚发生的外部变化。
2. 后端 root 规范化弱于前端规范化，Rust watcher 内部没有统一 canonical/verbatim/case 形式，容易把同一目录当成不同 root，从而清理旧签名并重新 prime。
3. 事件链和前端刷新链缺少端到端可观测性，`app.emit` 错误被忽略，前端非 Tauri runtime 会静默 noop，测试只覆盖了人工调用 listener，不证明 Rust watcher 到 React 刷新的完整链路。
4. `commitNavigation` 的 latest-request 保护会在用户导航/刷新并发时丢弃实时刷新结果；这是合理防旧请求覆盖，但需要和 live-refresh debounce 配合验证。

## 最可能根因排序

### 1. root 被重新注册并立即 prime，导致变化被当成新基线

证据：

- `FileWatchService::update_roots` 每次收到 `set_workspace_watch_roots` 都会 `replace_roots`，对未保留签名的 active root 执行 `scan_directory_signatures` 并 `insert_primed_signatures`，见 `src-tauri/src/services/file_watcher.rs:63-80`。
- `replace_roots` 只按字符串 key 保留签名，新的 root 字符串不完全相等就会被视为新 root，见 `src-tauri/src/services/file_watcher.rs:125-139`。
- 前端 root 更新由 `useEffect` 驱动，依赖整个 `state`，再用 `watchRootsKeyRef` 防重复，见 `src/features/workspace/useWorkspaceController.ts:1262-1277`。只要 key 发生格式或可见 tab 变化，就会触发后端重新 prime。
- 已有测试只覆盖“注册后、第一次 poll 前删除文件”这一种 prime 修复场景，见 `src-tauri/src/services/file_watcher.rs:303-324`；没有覆盖“同一目录以不同字符串形式重新注册时，外部删除被新基线吞掉”。

为什么会导致高概率失败：

- 如果用户刚打开目录或刚切换 tab/panel 后立刻在 Explorer 删除，后端可能是在删除之后才 prime，该变化不会产生事件。
- 如果同一目录在前后端之间出现 `C:\x`、`c:\x`、`\\?\C:\x`、尾斜杠等字符串差异，watcher 会丢弃旧 signature 并重新 prime。前端会觉得仍是同一目录，后端却把它当成新 root。

验证办法：

- 在 `update_roots`、`replace_roots`、`poll_changed_roots` 临时打日志：输出 raw request roots、normalized roots、roots_to_prime、retained signatures、changed_roots、sequence。
- 构造 Rust 单测：先以 `C:\Temp\A` prime，再以大小写或 verbatim 等价路径注册同一目录，同时删除子文件；断言不应被当作新基线吞掉。
- 人工验证时等待目录打开后至少 2 秒再从 Explorer 删除；如果等待后明显稳定，说明主要是首次注册/重新 prime 窗口。

推荐修复：

- 后端 watcher 增加统一 root identity：对本地路径做 Windows 规范化，去掉 verbatim 前缀、统一斜杠/尾斜杠、盘符大小写，存在时尽量 canonicalize 到同一种非 verbatim 展示格式；签名 map 使用这个 identity。
- `WorkspaceFsChangedEvent` 同时携带 normalized identity 和 display path，前端只用 normalized identity 匹配。
- 对 root 变更做差量更新：等价 root 不重建 signature；只有确实新增 root 才 prime。
- 在 prime 后立即安排一次短延迟复扫，避免“注册瞬间后的 Explorer 操作”被新基线吞掉。

### 2. 后端路径规范化不足，和前端/导航路径模型不一致

证据：

- watcher 的 `normalize_local_directory_root` 只 trim、替换 `/` 为 `\`、处理盘符根目录，见 `src-tauri/src/services/file_watcher.rs:107-123`。
- 前端 `normalizeLocationPath` 会额外去掉 `\\?\`、`\\?\UNC\`、`\\.\` 前缀并压缩分隔符，见 `src/features/workspace/mockData.ts:653-681`。
- `fs_service::list_directory` 对存在路径执行 `path.canonicalize()`，再把 canonical path 返回给前端，见 `src-tauri/src/services/fs_service.rs:226-263`。Windows Rust canonicalize 常见会产生 verbatim 形式。
- `windows_shell::normalize_local_path` 采用非 verbatim 展示形式，见 `src-tauri/src/services/windows_shell.rs:135-142`。同一项目内已经有“不要把 verbatim path 暴露给 Windows shell”的处理，说明路径格式问题是真实存在的。

影响：

- directory tab、navigation item、watch root、shell resolved path 可能来自不同规范化策略。
- 前端 `getVisibleDirectoryRefreshTargets` 只把事件 root 和 active tab path 做路径相等匹配，见 `src/features/workspace/useWorkspaceController.ts:413-430`。它能处理大小写和 verbatim 前缀，但无法修复后端签名 map 中已经因为 key 差异而重建基线的问题。

验证办法：

- 在 Windows 上打印 `list_directory` 返回的 `listing.location.path`、前端 `getVisibleWatchRoots` 发送的 root、后端 `normalize_roots` 后的 root。
- 覆盖以下路径：`C:\Users\Name\Dir`、`c:\users\name\dir`、`C:\Users\Name\Dir\`、`\\?\C:\Users\Name\Dir`、盘符根 `C:\`、UNC `\\server\share`。

推荐修复：

- 抽出 Rust 侧 `normalize_local_watch_root_identity`，并让 `file_watcher`、`fs_service` 返回路径、`windows_shell` 导航目标尽量共享同一策略。
- 对外展示路径保持普通 Win32 风格，不把 `\\?\` 作为 UI 主路径；内部可保留 actual path 用于 IO。
- 前端的 `WorkspaceWatchRootsRequest` 可以继续传 display path，但后端必须按 identity 去重和保留签名。

### 3. 当前轮询签名不是可靠文件系统通知，存在天然漏检

证据：

- watcher 每 750ms 扫描 root 的直接子项，见 `WATCH_POLL_INTERVAL` 和后台线程 `src-tauri/src/services/file_watcher.rs:14`、`src-tauri/src/services/file_watcher.rs:84-95`。
- 签名只包含 `name`、`is_dir`、`len`、`modified_millis`，见 `src-tauri/src/services/file_watcher.rs:31-38` 和 `src-tauri/src/services/file_watcher.rs:251-271`。
- `read_dir` 失败返回 `None`，entry metadata 失败时默认为 `is_dir=false`、`len=0`、`modified_millis=None`，见 `src-tauri/src/services/file_watcher.rs:251-271`。

对 Explorer 删除/新增/重命名的可靠性判断：

- 单个直接子项删除：大多数情况下会检测到，因为 entry name 集合变化。
- 新增：大多数情况下会检测到。
- 重命名：大多数情况下会检测到，因为 old name 消失/new name 出现。
- 快速 delete+create 同名文件且长度和 modified 毫秒相同：可能漏检。
- 目录内部深层变化：当前只监听当前可见目录 root 的直接子项，不递归。如果可见列表只显示直接子项，这是符合目标的；如果需要目录 size/状态联动，则不够。
- 短时间内多次变化：会合并成一次事件，能刷新列表但不能表达每个操作。

推荐修复：

- 短期保留轮询时，签名加入更稳定的 Windows metadata，例如 file index / volume serial / creation time（`std::os::windows::fs::MetadataExt` 可提供部分信息，必要时用 Win32 API）。
- 不要用 metadata 失败的默认值静默折叠为普通签名；应把 entry metadata error 纳入签名或触发 changed，避免删除中的文件被表现成稳定的 “len=0/None”。
- 中期改为 Windows 原生通知或 `notify` crate。

### 4. Tauri 事件链本身看起来基本正确，但缺少错误暴露

证据：

- 命令已注册：`set_workspace_watch_roots` 在 `src-tauri/src/lib.rs:54` 的 `generate_handler` 中。
- permission 已加入：`src-tauri/permissions/default.toml:82` 允许 `set_workspace_watch_roots`。
- capability 包含 `core:default` 和 `core:event:allow-listen`，见 `src-tauri/capabilities/default.json:7-9`。schema 显示 `core:event:default` 包含 listen/unlisten/emit/emit-to。
- 前端监听稳定事件名 `workspace_fs_changed`，见 `src/features/workspace/workspaceLiveRefreshGateway.ts:30-39`。
- 后端用 `app.emit("workspace_fs_changed", event)` 广播，见 `src-tauri/src/services/file_watcher.rs:91-94`。

风险：

- `app.emit` 的错误被 `let _ =` 忽略，窗口不存在、事件序列化失败或 runtime 问题无法被看到。
- `listenWorkspaceFsChanges` 在 `hasTauriRuntime` 为 false 时返回 noop，见 `src/features/workspace/workspaceLiveRefreshGateway.ts:30-39`。这对浏览器 fallback 合理，但如果 Tauri runtime 检测在真实环境失效，会静默没有实时刷新。
- 使用 `app.emit` 会广播到所有 webview，包括 `settings`。这不是刷新失败的主因，但更稳妥的是定向到 `main` 窗口，避免非 workspace 窗口参与。

推荐修复：

- 后端 emit 失败至少记录日志；调试阶段记录 sequence 和 roots。
- 可改为 `app.emit_to("main", "workspace_fs_changed", event)`，但前提是确认主窗口 label 固定为 `main`。这能收窄事件目标，不是必须修复项。
- 前端在 Tauri build 中 `listenFileSystemChanges` 初始化失败应明显告警；noop fallback 只允许 browser/test。

### 5. 前端刷新链有合理的丢弃机制，但缺少并发验证

证据：

- `handleWorkspaceFsChanged` 把 `event.directoryRoots` 加入 pending set，350ms 后 `flushLiveRefresh`，见 `src/features/workspace/useWorkspaceController.ts:1231-1259`。
- `refreshVisiblePanelsForPaths` 使用现有 `commitNavigation` 刷新，符合“不另起一套列表更新模型”，见 `src/features/workspace/useWorkspaceController.ts:1218-1229`。
- `commitNavigation` 用 `navigationRequestsRef` 只允许同一 panel/tab 最新请求提交，见 `src/features/workspace/useWorkspaceController.ts:1031-1108`。
- reducer 的 `tabSnapshotCommitted` 会提交同路径 snapshot，不会因为同一路径刷新而拒绝，见 `src/features/workspace/workspaceReducer.ts:1396-1467`。

风险：

- 实时刷新发起后，如果用户地址栏导航、切 tab、刷新按钮或其他操作对同一 tab 发起新 `commitNavigation`，旧实时刷新会被 latest-request 检查丢弃。这是正确的防 stale 逻辑，但可能表现为“这次 Explorer 删除没刷新”，尤其在 350ms debounce + 750ms poll 后用户又操作界面。
- `getVisibleDirectoryRefreshTargets` 只做 root 精确匹配，不刷新子孙路径。当前后端事件 root 是被监听的 visible directory，因此理论上匹配；如果未来后端发 parent root 或 native watcher 发具体 changed path，则前端会漏刷新，需要明确事件语义。

推荐修复：

- 保持使用 `commitNavigation`，但 live refresh 可以按 tab 记录“被 stale request 丢弃的 root”，最新导航完成后若仍在同一可见目录，补一次刷新。
- 给 `WorkspaceFsChangedEvent` 明确契约：`directoryRoots` 必须是当前 visible directory roots，而不是 changed child paths 或 parent paths。
- 在测试中增加“live refresh 与用户导航并发”用例，断言不会刷新错误 tab，同时必要时能补刷新。

## 测试覆盖评价

现有测试证明了部分局部行为，但不足以证明真实 Explorer 删除链路：

- Rust watcher 单测覆盖了 root normalize、注册 prime、第二次 poll 报告变化，见 `src-tauri/src/services/file_watcher.rs:281-347`。
- 前端 gateway 测试只证明命令名和事件名稳定，见 `src/features/workspace/workspaceLiveRefreshGateway.test.ts:19-78`。
- controller 测试人工调用 `fileSystemChangeListeners[0]`，证明收到事件后会刷新当前可见目录、隐藏 panel 不刷新、导航 tab 只刷新存在状态，见 `src/features/workspace/useWorkspaceController.test.ts:1093-1310`。

缺口：

- 没有 Rust 集成测试证明“注册 root 后，真实 `fs::remove_file`/`fs::rename`/`fs::write` 会经轮询生成 event”。
- 没有 Tauri 事件契约测试证明 `app.emit("workspace_fs_changed")` 能被 main window 的 `@tauri-apps/api/event.listen` 收到。
- 没有测试路径格式差异：case、尾斜杠、verbatim、canonical、盘符根、UNC。
- 没有测试 root 更新过程中不吞事件。
- 没有测试 live refresh 与 `commitNavigation` 并发时的 stale request 行为。

最小可复现测试方案：

1. Rust watcher 服务测试：临时目录注册为 root，等待一次 prime 完成后删除子文件，调用或等待 poll，断言 event.directory_roots 包含 root。
2. Rust root identity 测试：同一临时目录用普通路径、尾斜杠、大小写变体、Windows 上的 verbatim 形式反复 `update_roots`，断言 signatures 不被当成不同 root 重建。
3. 前端 hook 测试：模拟 `listenFileSystemChanges` 收到后端 normalized root 和 active tab 的不同显示格式，断言仍刷新 active tab。
4. Tauri smoke 测试或手工诊断开关：在真实 `npx tauri dev` 中显示/记录 watch roots、last event sequence、last refresh path。该测试不应进常规 `npm run dev`。

## 是否建议改为 Windows 原生通知

建议中期从纯轮询改为 `notify` crate 或直接 `ReadDirectoryChangesW`。

优先推荐 `notify` crate：

- 成本：中等。新增一个 watcher service 后台线程/任务，维护 visible roots 到 watcher handles 的 map，把 native event coalesce 后发同一个 `WorkspaceFsChangedEvent`。
- 风险：需要处理 Windows rename 双事件、目录被删除、网络盘/权限错误、watcher overflow、root 替换时 handle 清理。
- 集成方式：保留现有 `set_workspace_watch_roots` 命令和 `workspace_fs_changed` 事件契约；后端实现从 polling signature 改为 native events + debounce。前端无需重写列表模型，仍走 `commitNavigation`。
- 性能：比 750ms 全量扫描好，特别是目录内文件很多时。对当前最多 256 roots 的设计更可靠。

直接使用 `ReadDirectoryChangesW`：

- 成本：较高。需要管理 overlapped I/O 或专用阻塞线程、buffer、取消/关闭 handle、UTF-16 文件名解析和错误码。
- 优点：Windows 行为可控，能针对 Explorer 场景精细处理。
- 风险：实现复杂度和测试成本高于 `notify`，除非项目需要非常细的 Windows 语义，否则不应第一步手写。

短期建议：

- 不必立即抛弃现有轮询；先修 root identity、emit/log 可观测性、测试缺口。
- 如果修完仍无法稳定覆盖 Explorer 删除，则迁移到 `notify`。迁移时不要改变前端刷新入口，仍复用 `set_workspace_watch_roots` 和 `commitNavigation`。

## 推荐执行顺序

1. 加诊断日志或调试状态，确认失败时是“无 watcher event”、“event 到了但未匹配 target”、还是“commitNavigation 被 stale 丢弃”。
2. 修 Rust root identity，统一 normal/canonical/verbatim/case/尾斜杠，避免同一目录重建基线。
3. 补 Rust watcher 测试和前端路径格式 hook 测试。
4. 让 emit/listen 错误可见，必要时 `emit_to("main", ...)`。
5. 评估迁移 `notify` crate，保持现有 IPC 和前端刷新模型不变。
