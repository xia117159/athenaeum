# 文件操作任务中心、冲突处理 UI、操作历史与撤销方案设计

状态：三轮审查后定稿  
范围：只做方案设计，不做业务代码实现。本文面向当前 `SimpleFileManager` 的 Tauri v2、Rust、React、TypeScript 架构。

## 1. 目标与结论

本方案把“文件操作任务中心”“冲突处理 UI”“操作历史与撤销”设计为同一套文件操作基础设施，而不是三个互相割裂的功能。

核心结论：

- 文件操作应从当前同步 `invoke` 命令升级为后端任务模型：前端发起一个用户意图，后端返回 `taskId`，之后通过事件流推送进度、冲突请求、完成、失败和取消状态。
- 冲突处理应由后端在执行前或执行中发现冲突，并暂停任务等待前端选择；前端提供统一冲突对话框，支持替换、跳过、保留两者、重命名、合并文件夹、应用到全部。
- 撤销不是前端状态回滚，而是新的真实文件操作任务。`Ctrl+Z` 触发后由后端 `journal_store` 原子选择最近一条安全可撤销记录，再根据操作日志执行反向操作。
- 删除撤销需要可控恢复来源。仅依赖 Windows 回收站无法稳定拿到“本次删除对应的可恢复对象”，因此推荐为应用内撤销建立 app-managed trash；本地删除先移动到应用可控暂存区，撤销时从暂存区恢复。
- 远程 FTP/SFTP 删除默认不可撤销，除非后续为远程连接显式启用应用级远程回收目录；远程复制、移动在记录了完整反向动作时可以撤销。

## 2. 当前项目能力与差距

当前实现中已经具备这些基础：

- 前端工作区主路径集中在 `src/features/workspace/*`，文件操作入口集中在 `useWorkspaceController.ts`，调用 `workspaceGateway`。
- `workspaceOperationsGateway.ts` 负责 copy/move/delete/rename/create 的 IPC 调用。
- `remoteUri.ts` 会把一次用户动作拆成多个底层命令，例如本地到远程移动会拆成上传和本地删除。
- Rust 本地文件命令位于 `src-tauri/src/commands/operations.rs`，包括 `copy_entries`、`move_entries`、`delete_entries`、`rename_entry`、`create_directory`、`create_file`。
- Rust 本地文件服务位于 `src-tauri/src/services/fs_service.rs`，冲突目前使用 `available_conflict_path` 自动追加 ` (1)`，删除在 Windows 上使用 `SHFileOperationW + FOF_ALLOWUNDO` 进入系统回收站。
- Rust 远程命令位于 `src-tauri/src/commands/remote.rs`，FTP/SFTP 服务位于 `src-tauri/src/services/remote_service.rs`。
- 搜索已经采用事件流模式：`start_search` 返回搜索 ID，后端通过 `search_result`、`search_progress`、`search_finished` 事件推送结果，`cancel_search` 通过取消标记停止。
- 快捷键系统已有默认绑定和自定义绑定能力，但当前没有 `undo` 默认动作。

主要差距：

- 文件操作仍是同步命令，UI 无法显示长任务进度、取消、失败细节、历史记录。
- 冲突处理目前由后端自动改名，用户无法选择覆盖、跳过、重命名或应用到全部。
- 一次用户动作可能拆成多个底层命令，任务中心和撤销历史如果照底层命令记录，会丢失用户语义。
- 删除进入 Windows 回收站后，应用没有可靠 token 能把“这次删除的文件”恢复回来。
- 没有持久化操作日志，也没有面向真实文件系统的反向操作设计。

## 3. 非目标

- 本方案不实现代码，不调整现有文件。
- 首版不做 redo，也不默认实现 `Ctrl+Y`。
- 首版不承诺远程删除可撤销。
- 首版不追求和 Windows Explorer 复制对话框完全一致；优先保证本应用内本地和远程路径语义一致。
- 首版不把搜索任务并入文件操作任务中心，但任务模型应预留未来统一任务中心的扩展位。

## 4. 统一概念模型

### 4.0 状态权威源

任务、冲突和历史必须只有一个权威来源：

- 后端 `task_service` 是任务生命周期的权威源，负责队列、状态迁移、进度、取消、失败、部分成功和终态。
- 后端 `journal_store` 是操作历史和撤销状态的权威源，负责 `undoable`、`undoing`、`undone`、`expired`、`blocked`、`failed` 的状态迁移。
- 后端 `conflict_service` 是当前等待冲突的权威源，负责冲突 ID、允许决策、apply-to-all 决策缓存和超时/取消。
- 前端 reducer 只保存后端事件的投影，以及纯 UI 状态，例如任务中心打开/关闭、任务行展开、历史列表过滤、当前对话框焦点。
- 前端启动、Tauri 窗口恢复、事件监听重建后，必须先建立任务/历史事件监听，再调用 `list_file_operation_tasks()` 和 `list_operation_history()` 拉取快照重建投影，不能依赖本地 reducer 状态作为事实来源。

这个边界可以避免任务执行中事件丢失、窗口重载或多面板刷新时出现前后端状态分叉。

### 4.1 用户意图

前端不再把一次操作拆成多个底层命令，而是向后端提交一个用户可理解的 `OperationIntent`：

```ts
type PathRef =
  | { kind: "local"; path: string }
  | { kind: "remote"; profileId: string; remotePath: string; protocol: "ftp" | "sftp" };

type RawPathInput =
  | { kind: "local"; path: string }
  | { kind: "remoteUri"; uri: string }
  | { kind: "remote"; profileId: string; remotePath: string; protocol: "ftp" | "sftp" };

type OperationIntentKind =
  | "copy"
  | "move"
  | "delete"
  | "rename"
  | "createDirectory"
  | "createFile"
  | "undo";

type OperationRequestSource = "toolbar" | "contextMenu" | "shortcut" | "dragDrop" | "paste" | "inlineEdit";

type ConflictPolicy = {
  defaultResolution?: "ask" | "skip" | "keepBoth";
  allowApplyToAll: boolean;
};

type BaseOperationIntent = {
  requestId: string;
  source: OperationRequestSource;
  panelId?: PanelId;
  tabId?: string;
  conflictPolicy?: ConflictPolicy;
};

type OperationIntent =
  | (BaseOperationIntent & { kind: "copy"; sources: PathRef[]; destination: PathRef })
  | (BaseOperationIntent & { kind: "move"; sources: PathRef[]; destination: PathRef })
  | (BaseOperationIntent & { kind: "delete"; sources: PathRef[] })
  | (BaseOperationIntent & { kind: "rename"; sourcePath: PathRef; newName: string })
  | (BaseOperationIntent & { kind: "createDirectory"; parent: PathRef; name: string })
  | (BaseOperationIntent & { kind: "createFile"; parent: PathRef; name: string })
  | (BaseOperationIntent & { kind: "undo"; undoRecordId: string });
```

设计要点：

- `requestId` 由前端生成，用于防重复提交和测试断言。
- `requestId` 采用短期幂等语义：同一个 `requestId` 在任务创建窗口内重复提交时返回同一个 `taskId`；若对应任务已被清理，则拒绝并要求前端生成新的 `requestId`。
- `panelId`、`tabId` 只用于 UI 关联和刷新，不作为后端安全依据。
- 路径使用 `PathRef` 表达。本地路径由后端标准化；远程路径在后端规范化为 `profileId + remotePath + protocol`，其中 `remotePath` 必须是 profile root 内的规范路径。
- 后端必须拥有 `PathRef/LocationRef` 解析合约。即使远程 task 执行分阶段实现，也不能长期让前端 `remoteUri.ts` 作为唯一远程规划来源。
- 前端首版可以继续提交现有展示用 `ftp://`、`sftp://` URI，但只能作为入站 `RawPathInput`；后端必须立刻解析为规范 `PathRef`，并拒绝 URI、`profileId`、`remotePath` 互相矛盾的输入。
- 事件、任务快照和 journal 禁止保存带用户名密码、私钥口令或临时认证信息的完整远程 URI；需要展示时由前端用 profile 元数据生成脱敏标签。

### 4.2 操作任务

后端创建 `OperationTask`：

```ts
type OperationTaskStatus =
  | "queued"
  | "scanning"
  | "running"
  | "waitingConflict"
  | "cancelling"
  | "cancelled"
  | "succeeded"
  | "failed"
  | "partialSucceeded";

type OperationTask = {
  taskId: string;
  requestId: string;
  kind: OperationIntentKind;
  label: string;
  status: OperationTaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  totalEntries?: number;
  completedEntries: number;
  failedEntries: number;
  totalBytes?: number;
  completedBytes?: number;
  currentPath?: string;
  message?: string;
  cancelable: boolean;
  undoable: boolean;
  affectedRoots: PathRef[];
  retryOfTaskId?: string;
  parentTaskId?: string;
  relatedTaskIds?: string[];
};

type OperationTaskSnapshot = OperationTask & {
  sequence: number;
  updatedAt: string;
};
```

任务生命周期：

1. `queued`：进入队列，前端任务中心立刻可见。
2. `scanning`：递归枚举、计算条目数和可选字节数。
3. `running`：执行复制、移动、删除、恢复等真实操作。
4. `waitingConflict`：遇到冲突，暂停等待用户决策。
5. `cancelling`：收到取消请求，等待安全停止点。
6. 终态：`succeeded`、`failed`、`cancelled`、`partialSucceeded`。

并发策略：

- 本地/远程写操作首版默认串行执行，避免同一目录下的复制、移动、删除互相踩踏。
- 搜索、图标加载、目录刷新不受文件操作队列阻塞。
- 后续可以按根路径做更细粒度并发，但必须先有锁策略和测试。

事件合并规则：

- 后端为每个任务维护递增 `sequence`。任何任务事件都必须带 `taskId`、`sequence`、`updatedAt`。
- 前端只接受比当前投影更新的事件；重复或乱序旧事件直接丢弃。
- `operation_task_snapshot` 表示单个任务的完整快照，不是字段级 patch。
- `list_file_operation_tasks()` 返回当前后端完整 `OperationTaskSnapshot[]` 和 `taskSequence`，用于前端初始化和事件监听恢复。
- 任务终态事件必须带 `affectedRoots`，便于 controller 精准刷新本地或远程父目录；无法计算时才允许回退到当前活动 tab 的刷新。

### 4.3 操作计划与结果

后端把 `OperationIntent` 展开为 `OperationPlan`，内部包含若干 `OperationStep`：

- local copy
- local move
- local trash move
- local restore from trash
- remote copy
- remote move
- remote upload
- remote download
- remote delete
- remote restore if profile trash enabled

计划必须保留用户级动作和底层 step 的稳定映射：

```ts
type OperationPlan = {
  planId: string;
  requestId: string;
  intentKind: OperationIntentKind;
  rootActions: OperationRootAction[];
  steps: OperationStep[];
};

type OperationRootAction = {
  rootActionId: string;
  source?: PathRef;
  destination?: PathRef;
  label: string;
};

type OperationStepKind =
  | "localCopy"
  | "localMove"
  | "localTrash"
  | "localRestore"
  | "localDeleteCreated"
  | "remoteCopy"
  | "remoteMove"
  | "remoteUpload"
  | "remoteDownload"
  | "remoteDelete"
  | "remoteRestore";

type OperationStep = {
  stepId: string;
  rootActionId: string;
  kind: OperationStepKind;
  source?: PathRef;
  destination?: PathRef;
};
```

每个 step 产生结构化结果：

```ts
type EntryMetadataSnapshot = {
  path: PathRef;
  kind: "file" | "directory" | "symlink" | "junction" | "otherReparsePoint" | "unknown";
  sizeBytes?: number;
  modifiedAt?: string;
  createdAt?: string;
  readonly?: boolean;
  isReparsePoint: boolean;
  reparseTag?: string;
  contentHash?: string;
};

type OperationError = {
  code:
    | "notFound"
    | "permissionDenied"
    | "alreadyExists"
    | "invalidPath"
    | "fileInUse"
    | "cancelled"
    | "conflictUnresolved"
    | "remoteCredentialRequired"
    | "remoteUnavailable"
    | "ioError"
    | "unknown";
  message: string;
  path?: PathRef;
  retryable: boolean;
  source: "localFs" | "remoteFs" | "taskService" | "journalStore" | "trashService";
};

type OperationEntryResult = {
  planId: string;
  stepId: string;
  rootActionId: string;
  entryResultId: string;
  source?: PathRef;
  destination?: PathRef;
  kind: "created" | "moved" | "trashed" | "deleted" | "renamed" | "skipped" | "failed";
  error?: OperationError;
  metadataBefore?: EntryMetadataSnapshot;
  metadataAfter?: EntryMetadataSnapshot;
};
```

DTO/serde 规则：

- Rust DTO 使用 `#[serde(rename_all = "camelCase")]`；枚举值使用既有项目风格，跨语言测试必须覆盖每个新增 enum variant。
- TypeScript DTO 不使用裸 `string` 表达后端枚举；新增 enum 或 string union 必须与 Rust serde 测试一一对应。
- 可空字段必须明确是 `undefined` 还是 `null`：Tauri IPC 入站请求使用可选字段，后端出站事件使用 `null` 表达已知为空值。
- 错误不使用裸字符串跨 IPC 传输，统一使用 `OperationError`；UI 可以把 `message` 作为展示文案。
- `OperationTaskEventEnvelope` 的 `taskId/sequence/updatedAt` 只存在于 envelope，payload 内不重复放置同名字段，避免不一致。

这些结果同时服务三件事：

- 任务中心显示完成、失败、跳过明细。
- 目录刷新只刷新受影响的父目录。
- 操作历史生成可撤销记录。

对于组合操作，例如远程移动到本地，`OperationPlan` 可以包含下载和远程删除两个 step，但它们归属于同一个 `rootActionId`。操作历史按 `rootActionId` 聚合生成一条用户级 undo action，避免撤销历史被底层 step 拆碎。

## 5. 文件操作任务中心设计

### 5.1 UI 入口

推荐在工作区顶部工具栏右侧新增任务中心入口：

- 图标按钮：显示当前运行任务数和失败任务红点。
- 状态栏区域：显示最近一个运行任务摘要，例如“正在复制 120/800 项”。
- 点击打开底部抽屉式任务中心，宽度跟随工作区，高度 260-360px，可调整或折叠。

不建议把任务中心塞进当前搜索信息面板。搜索信息面板已经承担搜索条件、历史、结果过滤等职责；任务中心应该是全局工作区层面的工具。

### 5.2 信息结构

任务中心分为四个区：

- 正在运行：显示进度条、当前路径、速度、剩余时间、取消按钮。
- 等待处理：显示冲突任务和“处理冲突”按钮。
- 已完成：显示最近成功任务、可撤销标记、“撤销”快捷按钮、“打开目标位置”。
- 失败/部分完成：显示错误摘要、“重试失败项”、“复制错误详情”、“打开日志”。

每个任务行应包含：

- 操作类型图标：复制、移动、删除、恢复、重命名、新建。
- 任务标题：例如“复制 15 项到 D:\Archive”。
- 状态文本：例如“已完成 8/15 项，当前 report.pdf”。
- 进度条：有字节数时使用字节进度，无字节数时使用条目进度，不确定时使用 indeterminate。
- 操作按钮：取消、重试、撤销、清除、展开详情。

任务详情展开后显示：

- 源路径、目标路径、操作结果。
- 跳过项和失败项。
- 冲突处理决策记录。
- 可撤销状态和不可撤销原因。

任务状态呈现规则：

| 状态 | 用户呈现 | 可用操作 |
| --- | --- | --- |
| `queued` | 灰色排队标识，显示等待执行 | 取消、展开详情 |
| `scanning` | 显示“正在扫描”，进度条使用 indeterminate 或条目数 | 取消、展开详情 |
| `running` | 显示当前路径、条目/字节进度、速度和剩余时间 | 取消、展开详情 |
| `waitingConflict` | 置顶到“等待处理”，任务中心入口显示提示点 | 处理冲突、取消任务、展开详情 |
| `cancelling` | 显示“正在取消，等待安全停止点”，禁用重复取消 | 展开详情 |
| `cancelled` | 显示已取消和已完成条目数 | 清除、撤销已成功项、展开详情 |
| `succeeded` | 显示完成摘要，若有目标目录则提供打开位置 | 撤销、打开目标位置、清除、展开详情 |
| `partialSucceeded` | 显示成功/失败/跳过数量，失败用警告色 | 重试失败项、撤销成功项、复制错误详情、清除 |
| `failed` | 显示首个错误摘要和错误来源 | 重试、复制错误详情、打开日志、清除 |

历史状态呈现规则：

| 状态 | 用户呈现 | 可用操作 |
| --- | --- | --- |
| `undoable` | 显示“可撤销”和到期时间 | 撤销、清除记录 |
| `pendingConfirmation` | 显示等待确认，说明将恢复、删除或替换的条目 | 继续撤销、取消撤销、查看详情 |
| `undoing` | 显示正在撤销并关联 undo task | 打开任务中心、展开详情 |
| `undone` | 显示已撤销和撤销完成时间 | 清除记录 |
| `expired` | 显示暂存已清理或恢复来源过期 | 清除记录、查看详情 |
| `blocked` | 显示不可撤销原因，例如目标被修改、payload 缺失、远程凭据不可用 | 重新连接、跳过、查看详情 |
| `failed` | 显示撤销失败原因 | 重试撤销、复制错误详情、查看详情 |

清理历史和 payload 前必须明确提示：清理删除暂存或替换备份后，对应记录将无法通过 `Ctrl+Z` 恢复。默认“清除任务记录”只隐藏记录，不删除 payload；只有用户选择“清理暂存”或自动过期清理时才删除 payload。

### 5.3 取消与重试

取消规则：

- 复制：当前文件块安全停止后取消；已经完整复制的条目保留，并记录为部分完成。若当前文件是未完成临时文件，应清理临时文件。
- 移动：已移动条目保留；未移动条目不处理；任务标记为部分完成，并可为已移动条目生成撤销记录。
- 删除：已进入应用暂存区的条目可恢复；未处理条目保持原样。
- 远程操作：只能在连接库和循环安全点取消；无法中断的底层调用在返回后再进入取消终态。

重试规则：

- 只重试失败项和用户明确选择重试的跳过项。
- 重试创建新 task，但保留原 task 的关联 ID，方便任务中心折叠展示。
- 重试必须重新做 preflight 和冲突判断，不能复用旧冲突结果盲目覆盖。

### 5.4 持久化策略

任务本身不要求跨进程恢复继续执行，首版只持久化最近任务摘要和操作历史：

- 运行中任务：应用退出后视为中断；重启后显示“上次任务未完成”的只读记录。
- 成功任务：若可撤销，写入操作历史。
- 失败任务：保留最近 100 条或 7 天，便于排查。

### 5.5 通知与状态栏策略

任务反馈分三层，避免通知噪音：

- 状态栏：显示当前前台任务的短摘要和最近完成任务，适合快速复制、重命名、新建等短操作。
- Toast：后台长任务完成、撤销完成、无可撤销项时使用可自动消失 toast；toast 内可提供“打开任务中心”。
- Sticky notification：失败、部分完成、等待冲突、远程凭据失效、撤销被阻止等需要用户处理的状态使用粘性提示，并在任务中心入口显示红点或待处理数量。

前台短任务成功不弹 toast，只更新状态栏和文件列表；用户正在其他 tab 或任务中心折叠时，长任务完成才显示 toast。

## 6. 冲突处理 UI 设计

### 6.1 冲突类型

首版必须覆盖：

- 目标已存在：复制、移动、恢复、重命名、新建时目标路径存在。
- 文件夹合并：源和目标都是文件夹。
- 名称非法：新建或重命名包含空名、路径分隔符、`.`、`..` 等。
- 目标在源目录内部：移动/复制文件夹到自身或子目录。
- 权限不足或文件占用：不可自动修复，但应作为任务错误展示。

目标已存在是交互式冲突；名称非法和自身嵌套应尽量在执行前直接阻止。

### 6.2 冲突决策

统一决策类型：

```ts
type ConflictResolution =
  | { kind: "replace" }
  | { kind: "skip" }
  | { kind: "keepBoth"; suggestedName?: string }
  | { kind: "rename"; newName: string }
  | { kind: "mergeDirectory" }
  | { kind: "cancelTask" };
```

支持“应用到全部”：

- 仅对同类型冲突生效。
- 文件覆盖、文件保留两者、文件跳过可以应用到全部文件冲突。
- 文件夹合并、文件夹跳过可以应用到全部文件夹冲突。
- 用户输入的单个重命名不能应用到全部；可以改用“自动保留两者”。

可撤销要求：

- `replace` 是破坏性决策。后端执行替换前必须把既有目标移动到 `trash_service` 管理的 conflict backup payload，并把该 payload 写入 undo record。
- 如果既有目标无法备份，后端不得静默替换；首版应让任务失败并提示“无法创建替换备份”，而不是产生不可撤销覆盖。
- `mergeDirectory` 不是一个单独的“覆盖文件夹”动作。它必须展开为子项级 plan：新增子项记录为 created，替换子项记录 old target backup，跳过子项记录 skipped。
- 远程 `replace`/`mergeDirectory` 只有在后端能够创建远程备份或 profile 启用远程 trash 时才可标记为 undoable；否则该 root action 必须标记为 `undoUnavailableReason`。

### 6.3 UI 形态

冲突 UI 使用模态对话框或任务中心内的高优先级面板。推荐首版使用模态对话框，原因是冲突会暂停任务且需要明确决策。

对话框内容：

- 标题：`复制时发现同名文件`
- 源项：名称、路径、类型、大小、修改时间。
- 目标项：名称、路径、类型、大小、修改时间。
- 决策按钮：替换、跳过、保留两者、重命名、取消任务。
- 文件夹冲突时显示：合并文件夹、跳过、保留两者、取消任务。
- 底部复选框：`对剩余同类冲突执行相同操作`。
- 多冲突任务可显示 `第 3 / 28 个冲突`，并允许展开冲突列表。

易用性补充：

- 默认高亮“保留两者”，避免误覆盖。
- 替换按钮必须使用危险色，并显示目标会被替换。
- 重命名输入框实时校验名称合法性。
- 冲突列表支持按文件/文件夹、源目录、目标目录过滤。
- 对于相同大小和相同修改时间的文件，可提示“疑似相同文件”，但不自动跳过，除非后续增加 hash 比对设置。

键盘可达性和焦点规则：

- 打开冲突对话框时保存来源焦点，通常是任务中心“处理冲突”按钮、当前 panel 文件列表或触发操作的 toolbar 按钮。
- Tab 焦点限制在对话框内循环，关闭后恢复到来源焦点；来源元素已不存在时恢复到当前 panel 文件列表。
- 默认焦点落在“保留两者”或文件夹冲突的“合并文件夹”，避免 Enter 误触发破坏性替换。
- 进入重命名模式时焦点进入名称输入框，Enter 只在名称合法时提交重命名，Esc 退出重命名模式并回到默认决策按钮。
- 对话框顶层按 Esc 不执行破坏性操作。首版建议 Esc 只关闭当前对话框视觉层并让任务保持 `waitingConflict`，或聚焦“取消任务”；如果要取消任务，必须二次确认。
- 冲突响应提交后按钮进入 pending 禁用态，防止重复提交；后端返回“冲突已过期/已处理”时，前端关闭旧对话框并根据最新 task snapshot 重新展示。

### 6.4 后端事件流

后端遇到冲突时发事件：

```ts
type OperationConflictRequested = {
  conflictId: string;
  planId: string;
  stepId: string;
  rootActionId: string;
  entryResultId?: string;
  affectedEntryKey: string;
  operationKind: OperationIntentKind;
  conflictKind: "destinationExists" | "directoryMerge" | "restoreDestinationExists";
  source?: EntryMetadataSnapshot;
  destination?: EntryMetadataSnapshot;
  affectedRoots: PathRef[];
  suggestedName?: string;
  allowedResolutions: ConflictResolution["kind"][];
  canApplyToAll: boolean;
};
```

前端调用命令返回决策：

```ts
resolve_file_operation_conflict({
  taskId,
  conflictId,
  resolution,
  applyToAll
})
```

后端规则：

- 等待冲突期间 task 状态为 `waitingConflict`。
- 用户取消任务时，后端从当前安全点停止，并按任务取消规则处理已完成项。
- 如果前端窗口关闭或事件监听断开，任务保持等待；应用重启后首版可标记为失败并提示“冲突未处理”。
- `affectedEntryKey` 必须由后端生成，建议格式为 `taskId/rootActionId/stepId/source-or-destination-normalized-path`，用于防止批量操作中多个同名文件把冲突响应投递给错误条目。
- 前端提交 `resolve_file_operation_conflict` 时必须同时带 `taskId` 和 `conflictId`；后端只接受当前等待中的冲突 ID，已过期或已处理的冲突响应必须拒绝。

## 7. 操作历史与撤销设计

### 7.1 原则

- 撤销必须执行真实文件操作，不允许只还原 React 状态。
- 只有后端确认完整记录了反向动作的任务才标记 `undoable`。
- 撤销本身也是任务，进入任务中心，有进度、冲突、取消、失败状态。
- 操作历史记录的是用户动作，不是底层 step。例如“剪切 3 项到 D:\Work”是一条历史，即使底层包含复制、删除、远程上传等多个 step。
- 撤销前必须做 preflight，检查目标是否仍存在、源位置是否被占用、暂存区是否完整。

### 7.2 操作日志

新增 `OperationJournalStore`，建议首版放在应用数据目录下的 JSON 文件，后续可迁移 SQLite：

```ts
type UndoRecordStatus =
  | "undoable"
  | "pendingConfirmation"
  | "undoing"
  | "undone"
  | "expired"
  | "blocked"
  | "failed";

type UndoAction =
  | { kind: "deleteCreated"; target: PathRef; metadataAfter?: EntryMetadataSnapshot }
  | { kind: "moveBack"; from: PathRef; to: PathRef; metadataBefore?: EntryMetadataSnapshot }
  | { kind: "restoreTrash"; payloadId: string; originalPath: PathRef }
  | { kind: "restoreReplacement"; backupPayloadId: string; targetPath: PathRef }
  | { kind: "renameBack"; from: PathRef; to: PathRef };

type UndoPrecondition = {
  kind: "exists" | "notExists" | "metadataUnchanged" | "payloadAvailable" | "remoteCredentialAvailable";
  path?: PathRef;
  payloadId?: string;
  expected?: EntryMetadataSnapshot;
};

type TrashPayloadRef = {
  payloadId: string;
  manifestPath: string;
  payloadRoot: string;
  originalPath: PathRef;
  purpose: "delete" | "replacementBackup";
};

type UndoRecord = {
  id: string;
  taskId: string;
  createdAt: string;
  label: string;
  operationKind: OperationIntentKind;
  requestSource: OperationRequestSource;
  affectedRoots: PathRef[];
  status: UndoRecordStatus;
  actions: UndoAction[];
  preconditions: UndoPrecondition[];
  trashPayloads?: TrashPayloadRef[];
  expiresAt?: string;
  blockedReason?: string;
  undoUnavailableReason?: string;
  destructiveUndoReason?: string;
};

type UndoScope =
  | { kind: "window" }
  | { kind: "panel"; panelId: string };

type UndoConfirmationSummary = {
  confirmationId: string;
  recordId: string;
  label: string;
  affectedRoots: PathRef[];
  actions: UndoAction[];
  preconditions: UndoPrecondition[];
  destructiveUndoReason?: string;
  blockedReason?: string;
};

type UndoStartResult =
  | { kind: "started"; taskId: string; recordId: string }
  | { kind: "needsConfirmation"; summary: UndoConfirmationSummary }
  | { kind: "noUndoableOperation" }
  | { kind: "blocked"; recordId?: string; reason: string; retryable: boolean };
```

保留策略：

- 默认最多保留 100 条可见历史。
- 应用托管删除暂存默认保留 7 天，或在“清理任务历史/清空暂存”时删除。
- 超过保留期的删除暂存清理后，对应记录变成 `expired`。
- 不存远程密码、私钥口令或临时认证信息。

覆盖与合并的撤销：

- 对 `replace` 产生的 `restoreReplacement`，撤销时先删除或移走新目标，再把 backup payload 恢复到原目标路径。
- 对 `mergeDirectory`，撤销按子项级 action 反向执行：删除本次新增子项，恢复被替换子项，保留原本未触碰的目标子项。
- 如果 backup payload 已过期、丢失或无法读取，相关 undo action 进入 `blocked`，不得继续执行会破坏现状的“半撤销”。
- 如果用户确认执行带破坏性的撤销，必须在 `destructiveUndoReason` 中记录原因，并在任务中心详情展示。

### 7.3 Ctrl+Z 行为

快捷键：

- 新增默认快捷键 `undo = Ctrl+Z`，scope 为 `workspace`。
- 当焦点在 input、textarea、contenteditable、文件名内联编辑框时，不拦截 `Ctrl+Z`，保留文本编辑撤销。
- 当冲突对话框打开时，`Ctrl+Z` 不触发操作撤销。

触发规则：

1. `Ctrl+Z` 不由前端最终决定撤销哪条记录。前端可以基于投影做轻量提示，但真正选择最近可撤销记录必须由后端 `journal_store` 原子完成。
2. 前端调用 `undo_latest_operation({ requestId, scope })`，`scope` 首版为 `{ kind: "window" }`。
3. 后端在同一临界区内查找最近 `undoable` 记录并执行 preflight。如果可以直接撤销，把记录置为 `undoing` 并创建 undo task；如果没有可撤销记录，返回 `noUndoableOperation`。
4. 若记录属于删除恢复、替换恢复、目标被修改等需要用户确认的场景，后端把记录置为 `pendingConfirmation`，返回 `needsConfirmation` 和确认摘要。前端展示将恢复、删除、替换或跳过的条目后，调用 `confirm_undo_operation({ confirmationId, decision, requestId })`。
5. 用户确认后，后端再次校验 confirmation 仍有效，再把记录置为 `undoing` 并创建 undo task；用户取消时，记录恢复为 `undoable`，不创建任务。
6. 后端创建的 `undo` task 执行反向操作，并通过任务中心显示进度。
7. 任务中心内单条历史的“撤销”按钮仍可调用 `undo_operation({ recordId, requestId })`，但后端必须重新校验记录仍是 `undoable`，避免连续点击或多窗口状态滞后导致重复撤销。

无可撤销项时，显示轻量 toast“没有可撤销的文件操作”，不打开任务中心、不打断当前文件列表焦点。连续按两次 `Ctrl+Z` 时，每次都由后端重新选择当前最近的 `undoable` 记录。

历史作用域：

- 首版使用当前窗口的全局文件操作历史，不按 panel 分栈。
- 历史项记录 `panelId`、`tabId` 和 `affectedRoots`，撤销完成后刷新相关面板。
- 后续可在任务中心历史页提供“只看当前面板相关操作”的过滤。

### 7.4 各操作撤销语义

#### 复制撤销

适用场景：

- `Ctrl+C` + `Ctrl+V`
- 拖动复制
- 本地到本地复制
- 本地到远程上传复制
- 远程到本地下载复制
- 同 profile 远程复制
- 跨 profile 远程复制

记录：

- 每个源路径对应实际创建的目标路径。
- 创建目标的类型、大小、修改时间、可选 hash。
- 目标父目录。

撤销：

- 删除本次复制创建的目标根路径。
- 如果目标已不存在，该项标记为已跳过。
- 如果目标被用户修改，默认阻止自动删除，并在撤销冲突 UI 中要求确认“仍然删除该目标”或“跳过”。

#### 移动/剪切粘贴撤销

适用场景：

- `Ctrl+X` + `Ctrl+V`
- 拖动移动
- 本地到本地移动
- 本地与远程之间的移动
- 远程同 profile 或跨 profile 移动

记录：

- 原始路径和实际目标路径的成对映射。
- 移动前元数据。
- 对于组合移动，记录底层 copy/upload/download/delete 的完成结果，但对用户只显示一条移动历史。

撤销：

- 将实际目标路径移回原始路径。
- 如果原始路径已被占用，进入冲突 UI：替换、保留两者、重命名恢复、跳过。
- 如果目标路径已不存在，则该项无法自动撤销，标记为 blocked。
- 对跨边界移动，撤销就是反向移动：例如远程下载后删除源端，撤销时上传回原远程路径，再删除本地目标。

跨卷/跨远程 move 执行要求：

- 目标写入必须先落到目标目录内的临时文件或临时目录，完成校验后再原子 rename 到最终路径。
- 删除源之前必须确认源在复制期间没有被修改；本地至少比较 size、modified time、file id 或可选 hash，远程至少比较 size/modified time，无法确认时标记为需要用户确认或 blocked。
- 删除源失败时，本次实际效果是 copy，不应生成 `moveBack` undo action；应生成 `deleteCreated` undo action，让撤销删除目标副本而不是试图恢复源。
- 跨远程移动如果反向上传/删除需要凭据但凭据不可用，undo record 进入 `blocked`，任务中心提示需要重新连接。

用户要求映射：

- “拖动所造成的复制粘贴时，撤销则删除粘贴过来的文件”：对应复制撤销。
- “剪切+粘贴时，撤销则恢复到之前的位置”：对应移动撤销。

#### 删除撤销

本地删除推荐采用 app-managed trash：

1. 删除任务不是直接调用当前 `delete_entry_recycle`。
2. 后端把每个删除项移动到应用托管暂存区。
3. 操作日志记录原始路径、暂存路径、元数据。
4. 前端显示为“已删除，可撤销”。
5. 撤销时从暂存区移回原始路径。

暂存区建议：

- 首版：`AppLocalData/SimpleFileManager/trash/<recordId>/payload/...`
- 元数据：`AppLocalData/SimpleFileManager/trash/<recordId>/manifest.json`
- 后续优化：按卷建立 per-volume trash，减少跨卷移动退化为复制的成本。

manifest 结构：

```ts
type TrashManifestStatus = "pending" | "committed" | "restoring" | "restored" | "expired" | "orphaned" | "failed";

type TrashManifestItem = {
  payloadId: string;
  originalPath: PathRef;
  normalizedOriginalPath: string;
  payloadPath: string;
  purpose: "delete" | "replacementBackup";
  metadataBefore: EntryMetadataSnapshot;
  movedAt?: string;
  restoredAt?: string;
  status: TrashManifestStatus;
};

type TrashManifest = {
  recordId: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
  status: TrashManifestStatus;
  items: TrashManifestItem[];
};
```

manifest 规则：

- `payloadId` 由后端生成，不能来自用户路径；payload 路径必须位于 `trash_root` 下，恢复和清理前都要做 canonical path 校验，防止路径穿越。
- `normalizedOriginalPath` 用于匹配和展示，不作为恢复写入的唯一依据；恢复写入必须使用结构化 `PathRef`。
- `metadataBefore` 必须记录 reparse 信息，至少包含 `isReparsePoint` 和 `reparseTag`。
- 应用启动时 `trash_service` 需要 reconcile：`pending` 且 payload 不存在的记录标记 failed；`committed` 但 journal 缺失的记录标记 orphaned 并显示为“可清理暂存”；journal 指向缺失 payload 的记录标记 blocked/expired。

失败边界：

- 移入暂存区前必须先写入 pending manifest，记录原路径、计划暂存路径和任务 ID；移动成功后再把 manifest 标记为 committed。
- 跨卷移动退化为复制时，必须先完整复制到暂存区并校验，再删除原路径；删除原路径失败时任务标记为部分失败，暂存副本不得作为成功删除记录。
- 磁盘空间不足、权限不足、暂存区不可创建时，删除任务失败，不降级为不可撤销的永久删除。
- 不建议自动降级到 Windows 回收站；除非后续能拿到可靠恢复 token，否则降级会破坏 `Ctrl+Z` 的可预测性。
- 清理过期暂存时必须先把 journal 记录置为 `expired` 或写入清理事务，再删除 payload，避免 payload 已删但历史仍显示可撤销。

为什么不只用 Windows 回收站：

- 当前 `SHFileOperationW + FOF_ALLOWUNDO` 可以把文件送入系统回收站，但应用不能稳定知道本次删除对应回收站对象的内部 ID。
- 如果用户或其他程序也在操作回收站，按名称和原路径枚举恢复会有歧义。
- 应用内 `Ctrl+Z` 需要可预测、可测试、可跨任务中心展示的恢复 token。

远程删除：

- 首版默认不可撤销，并在确认删除时明确提示“远程删除无法通过 Ctrl+Z 恢复”。
- 后续可为每个远程 profile 增加“远程回收目录”设置，例如 `/root/.simple-file-manager-trash`；启用后删除改为远程 move 到该目录，再支持撤销恢复。

#### 重命名撤销

记录：

- 原始路径、重命名后路径。

撤销：

- 把新路径重命名回原路径。
- 如果原路径已占用，进入冲突 UI。

#### 新建文件/文件夹撤销

记录：

- 新建路径和新建后的初始元数据。

撤销：

- 删除新建项。
- 如果新建文件/文件夹被用户修改，默认要求确认。
- 新建文件夹中已经产生内容时，不能静默删除，应提示“该文件夹已包含新内容”。

### 7.5 部分成功与历史可用性

如果任务部分成功：

- 为成功产生实际影响的条目生成 undo action。
- 历史项状态为 `undoable`，但标题显示“部分完成，可撤销已完成的 N 项”。
- 失败项不会进入撤销动作。
- 用户撤销时只处理成功项。

如果写入操作日志失败：

- 任务应显示 `succeeded` 但 `undoable = false`，并明确提示“操作完成，但无法记录撤销信息”。
- 对删除任务，日志写入失败时不能清理暂存 manifest；否则会导致无法恢复。

## 8. 后端架构设计

### 8.1 模块划分

新增或扩展 Rust 服务模块：

- `task_service.rs`：任务队列、状态机、事件发送、取消标记。
- `operation_service.rs`：把 `OperationIntent` 规划和执行为 step。
- `conflict_service.rs`：冲突检测、建议名称、apply-to-all 决策缓存。
- `journal_store.rs`：操作历史持久化、查询、状态更新。
- `trash_service.rs`：应用托管删除暂存、恢复、过期清理。
- `remote_path_service.rs`：后端解析 `ftp://`、`sftp://` URI 到 remote profile 和远程路径，避免长期依赖前端 `remoteUri.ts` 做唯一规划。

`AppState` 增加：

- `operation_tasks`
- `operation_cancellations`
- `operation_conflict_waiters`
- `operation_journal`
- `trash_root`

### 8.2 IPC 命令

新增命令草案：

```ts
start_file_operation_task({ intent }): Promise<{ taskId: string }>
cancel_file_operation_task({ taskId }): Promise<void>
resolve_file_operation_conflict({ taskId, conflictId, resolution, applyToAll }): Promise<void>
list_file_operation_tasks(): Promise<{ taskSequence: number; tasks: OperationTaskSnapshot[] }>
clear_file_operation_tasks({ mode }): Promise<void>
list_operation_history(): Promise<{ historySequence: number; records: UndoRecord[] }>
undo_latest_operation({ requestId, scope }): Promise<UndoStartResult>
undo_operation({ recordId, requestId }): Promise<UndoStartResult>
confirm_undo_operation({ confirmationId, decision, requestId }): Promise<UndoStartResult>
dismiss_operation_history({ recordId, deletePayloads: false }): Promise<void>
purge_operation_payloads({ recordIds }): Promise<void>
```

撤销确认规则：

- `decision = "proceed"` 时，后端必须重新校验 `confirmationId`、record 状态、payload 和目标路径，再启动 undo task。
- `decision = "cancel"` 时，后端把 `pendingConfirmation` 恢复为 `undoable`，不创建任务。
- `confirmationId` 只能使用一次，窗口重载后必须重新发起 preflight，不能复用旧确认。

兼容策略：

- 首版实现时，现有 `copy_entries` 等命令可以保留给测试和过渡。
- 前端 `workspaceOperationsGateway.ts` 新增 task 模式后，普通 UI 操作逐步切换到 `start_file_operation_task`。
- 不应长期让前端把一次用户操作拆成多个底层命令再分别提交，否则任务中心和撤销语义会继续破碎。

### 8.3 IPC 事件

新增事件草案：

```ts
type OperationTaskEventEnvelope<T> = {
  taskId: string;
  sequence: number;
  updatedAt: string;
  payload: T;
};

type OperationTaskCompletion = {
  status: "succeeded" | "partialSucceeded";
  affectedRoots: PathRef[];
  entryResults: OperationEntryResult[];
  undoRecordId?: string;
};

type OperationTaskFailure = {
  status: "failed";
  affectedRoots: PathRef[];
  entryResults: OperationEntryResult[];
  error: OperationError;
  undoRecordId?: string;
};

type OperationTaskCancellation = {
  status: "cancelled";
  affectedRoots: PathRef[];
  entryResults: OperationEntryResult[];
  undoRecordId?: string;
};

operation_task_snapshot: OperationTaskEventEnvelope<Omit<OperationTask, "taskId">>
operation_task_completed: OperationTaskEventEnvelope<OperationTaskCompletion>
operation_task_failed: OperationTaskEventEnvelope<OperationTaskFailure>
operation_task_cancelled: OperationTaskEventEnvelope<OperationTaskCancellation>
operation_conflict_requested: OperationTaskEventEnvelope<OperationConflictRequested>
operation_history_changed: { sequence: number; updatedAt: string; records: UndoRecord[] }
```

事件规则：

- 事件 envelope 必须包含 `taskId`、`sequence`、`updatedAt`。前端根据 `taskId + sequence` 合并状态，避免多任务串线、乱序覆盖和重复处理。
- `operation_task_snapshot` 是单个任务完整快照，可覆盖前端该任务的投影。
- `operation_task_completed`、`operation_task_failed`、`operation_task_cancelled` 必须包含 `affectedRoots`、`entryResults` 摘要和 `undoRecordId?`。
- `operation_history_changed` 由 `journal_store` 发送完整历史投影；前端不自行推断历史状态。
- 如果未来搜索也进入统一任务中心，应新增 `taskCategory: "fileOperation" | "search" | "icon" | ...`，首版文件操作事件不要阻塞这个扩展。
- 前端初始化时必须先注册所有 operation event listener，再调用 `list_file_operation_tasks()` 和 `list_operation_history()` 拉快照；如果快照 sequence 小于已收到事件 sequence，保留更新的事件投影。

### 8.4 执行安全规则

- 执行前校验路径非空、名称合法、目标不在源目录内部。
- 递归复制/移动必须使用 reparse-aware metadata；Windows symlink、junction、mount point、其他 reparse point 都不能被当作普通目录递归进入。
- 复制 reparse point 时首版只复制链接项本身；如果当前权限或 API 不支持创建同类链接，则该项标记为 skipped/blocked，不得退化为复制链接目标。
- 删除、移动到 trash、trash cleanup 和撤销恢复都只能操作 reparse point 本身，不得跟随到目标目录执行递归删除。
- 覆盖前必须有用户明确冲突决策。
- 文件写入采用临时文件策略，完成后原子 rename 到目标，避免取消或崩溃留下半文件。
- 移动跨卷或跨远程边界时，先复制到目标临时路径，校验完成并原子落位，再删除源；如果删除源失败，任务结果必须降级为 copy 语义并生成 `deleteCreated` 撤销动作。
- 删除进入 app-managed trash 后才算删除成功。
- 撤销时复用同一套冲突检测和任务事件，不做特殊捷径。

## 9. 前端架构设计

### 9.1 状态模型

在 `types.ts` 中增加：

- `OperationTaskViewModel`
- `OperationTaskCenterState`
- `OperationConflictState`
- `UndoHistoryItem`

`WorkspaceState` 增加：

```ts
operationTasks: OperationTaskCenterState;
operationHistory: UndoHistoryItem[];
activeConflict?: OperationConflictState;
```

状态投影规则：

- `operationTasks` 只保存后端任务快照和 UI 展开/筛选状态，不在 reducer 内自行推进任务生命周期。
- `operationHistory` 只保存 `journal_store` 返回的历史投影，不由前端根据 completed 事件拼装可撤销记录。
- `activeConflict` 只保存当前后端等待处理的冲突请求；冲突被解决、取消或任务结束后由后端事件关闭。
- 初始化或事件监听重建时，controller 必须先注册 operation event listener，再调用 `list_file_operation_tasks()` 和 `list_operation_history()` 拉取快照；如快照 sequence 落后于已收到事件，保留更新事件投影。

Reducer 新增动作：

- `operationTaskSnapshotReceived`
- `operationTaskProgressReceived`
- `operationTaskCompleted`
- `operationTaskFailed`
- `operationTaskCancelled`
- `operationConflictRequested`
- `operationConflictResolved`
- `operationHistoryLoaded`
- `operationHistoryChanged`
- `taskCenterToggled`
- `taskCenterTaskExpanded`

### 9.2 Controller 与 Gateway

`useWorkspaceController.ts` 保持编排职责：

- `copySelection`、`pasteIntoPanel`、`dropEntries`、`deleteSelection`、`commitInlineEdit` 不再直接 await 底层同步操作完成。
- 它们调用 `workspaceGateway.startFileOperation(intent)`。
- 任务完成事件到达后，根据 `affectedRoots` 刷新相关面板。
- 操作失败通过任务中心展示，重要失败同时发 notification。
- `undoLatestOperation` 由快捷键和任务中心按钮共同调用。

`workspaceOperationsGateway.ts` 新增：

- DTO mapper
- 事件监听封装
- `startWorkspaceFileOperation`
- `cancelWorkspaceFileOperation`
- `resolveWorkspaceOperationConflict`
- `undoLatestWorkspaceOperation`
- `undoWorkspaceOperation`
- `confirmWorkspaceUndoOperation`
- `listWorkspaceOperationTasks`
- `listWorkspaceOperationHistory`

### 9.3 UI 组件

新增组件建议：

- `OperationTaskCenter.tsx`
- `OperationTaskRow.tsx`
- `OperationTaskDetail.tsx`
- `OperationConflictDialog.tsx`
- `OperationHistoryList.tsx`

组件边界：

- 所有 Operation UI 组件只接收 view model 和 callback props，不直接调用 `invoke`、gateway 或注册 Tauri event listener。
- `OperationTaskCenter` 只负责渲染任务列表、筛选、展开状态和触发 `onCancelTask`、`onRetryTask`、`onUndoRecord`、`onClearTask` 等回调。
- `OperationConflictDialog` 只负责展示冲突和收集用户决策，提交由 controller 调用 `resolveWorkspaceOperationConflict`。
- `OperationHistoryList` 只负责展示历史投影和筛选，撤销、清除、清理 payload 都通过 controller 回调进入 gateway。
- operation 事件监听、命令调用、快捷键处理统一由 `useWorkspaceController` 编排；reducer 只接收 controller 分发的 action。

视觉要求：

- 高密度 Windows 桌面风格。
- 不使用营销式卡片堆叠。
- 任务行高度稳定，进度文本不挤压按钮。
- 常用动作使用 icon button，并提供 tooltip。
- 错误详情可复制，长路径使用省略和 tooltip。

历史列表信息：

- 历史行显示操作图标、动作标题、条目数/大小、源到目标摘要、时间、状态标签、撤销按钮和清除按钮。
- 支持“全部 / 可撤销 / 失败 / 已过期 / 被阻止”过滤。
- 详情展开显示 `affectedRoots`、成功/失败项摘要、payload 到期时间、不可撤销原因、撤销失败原因和错误详情复制入口。
- 对 `blocked` 历史项，行内显示下一步动作，例如“重新连接远程 profile”“查看冲突”“跳过该项”。

### 9.4 快捷键

`workspaceShortcuts.ts` 增加默认：

```ts
["undo", "Ctrl+Z"]
```

`useWorkspaceController.ts` 的 keydown 顺序：

1. editable target 直接返回，保留文本编辑。
2. 冲突对话框打开时，由对话框处理键盘，不触发文件撤销。
3. 匹配 `undo` 时 `preventDefault()` 并调用 `undoLatestOperation()`。
4. 其他现有快捷键保持不变。

### 9.5 拖放语义

`dropEntries` 只生成用户级 `OperationIntent`，最终合法性仍由后端 preflight 校验：

- 同一本地卷内拖放默认 `move`，跨本地卷默认 `copy`。
- `Ctrl` 强制 `copy`，`Shift` 强制 `move`；modifier 与目标能力冲突时，以后端能力校验为准并提示用户。
- 本地与远程、跨 remote profile、凭据状态不确定的拖放默认 `copy`；用户按 `Shift` 强制 move 时，需要后端确认可以在复制完成后删除源端。
- 拖动悬停时显示“复制到”或“移动到”徽标，徽标必须跟随当前 modifier 和目标能力更新。
- drop 生成的 intent 必须保留 `requestSource: "dragDrop"`，撤销历史标题使用“拖放复制”或“拖放移动”，方便用户理解 `Ctrl+Z` 的反向效果。

### 9.6 完成后的刷新、选中与 reveal

任务完成后的 UI 刷新由 controller 根据后端 `affectedRoots` 和 `entryResults` 决定：

- copy、create、restore 成功后，如果目标父目录已在某个 tab 打开，则刷新该 tab 并选中/reveal 新建或恢复的项。
- move 成功后刷新源父目录和目标父目录；源面板中移除已移动项，并尽量保持相邻项选中；目标面板可见时选中/reveal 移动后的项。
- delete 成功后从当前列表移除删除项，保持相邻选择和滚动位置；删除撤销完成后 reveal 恢复项。
- undo 完成后按 undo task 的 `entryResults` 刷新受影响目录；恢复原路径被占用并进入冲突处理时，不提前刷新为成功状态。
- 如果目标目录没有打开的 tab，只更新任务中心和历史列表，不强制切换用户当前视图。
- 远程目录刷新同样使用规范 `PathRef` 匹配已打开 panel/tab，不能用脱敏显示标签做路径匹配。

## 10. 分阶段落地建议

### 阶段 1：任务中心骨架与本地任务化

- 新增 task IPC 合约、前端状态投影和后端 `PathRef/LocationRef` 解析合约。
- 建立 `OperationIntent -> OperationPlan -> OperationStep -> OperationEntryResult` 骨架，先覆盖本地 copy/move/delete/rename/create。
- 本地 copy/move/delete/rename/create 通过任务启动，完成事件必须携带 `affectedRoots`、`entryResults` 和 `sequence`。
- 冲突策略暂时保持当前自动保留两者，但必须通过 plan/result 记录实际目标路径，为阶段 2 冲突 UI 和阶段 3 撤销复用。
- 远程路径首版可以返回“task 模式暂不支持该远程操作”或继续走旧路径，但不得把旧前端拆分命令伪装成新 task。
- 验收重点：长目录操作 UI 不阻塞，可取消，完成后刷新正确，任务事件乱序不会污染前端状态。

### 阶段 2：冲突 UI

- 后端停止自动 `available_conflict_path` 作为唯一行为，改为检测冲突并请求前端决策。
- 前端实现冲突对话框和 apply-to-all。
- 本地 copy/move/restore/rename/create 全部接入。
- 验收重点：覆盖、跳过、保留两者、重命名、合并文件夹行为可预测。

### 阶段 3：操作历史与撤销

- 新增 journal store 和 `Ctrl+Z`。
- 支持 copy、move、rename、create 的撤销。
- 本地 delete 改为 app-managed trash，支持恢复。
- 验收重点：用户要求的三类撤销行为全部成立。

### 阶段 4：远程与组合操作收口

- 完成后端远程 URI 和 profile 解析实现，替换阶段 1 已定义的 `PathRef/LocationRef` 占位能力。
- 远程 copy/move/upload/download 生成一条用户级 task 和一条用户级 undo record。
- 远程 delete 保持不可撤销提示，或在 profile 启用远程 trash 后支持撤销。

### 阶段 5：体验增强

- 任务失败重试、错误详情导出。
- 历史过滤、清理策略设置。
- 可选 `Ctrl+Y` redo。
- 可选 hash 比对和“相同文件自动跳过”策略。

## 11. TDD 与验证矩阵

Rust 测试：

- `operation_service`：本地 copy/move/delete/rename/create 生成正确 entry result。
- `conflict_service`：目标存在时生成正确冲突和建议名称。
- `trash_service`：删除暂存、恢复、原路径占用冲突、过期清理。
- `journal_store`：原子写入、坏文件容错、状态迁移。
- `undo`：复制撤销删除目标，移动撤销恢复源路径，删除撤销从 trash 恢复。
- `remote_path_service`：远程 URI 到 profile/root 的解析和越界拒绝。

TypeScript 测试：

- `workspaceOperationsGateway.test.ts`：start/cancel/resolve/undo/confirm undo 的 invoke 参数、`UndoStartResult` mapper 和事件 mapper。
- `workspaceReducer.test.ts`：任务状态合并、冲突打开/关闭、历史更新。
- `workspaceShortcuts.test.ts`：`Ctrl+Z` 默认绑定，editable target 不拦截，冲突对话框打开时不触发文件撤销。
- `useWorkspaceController.test.ts`：复制、粘贴、拖放、删除发起高层 intent；完成事件触发刷新、选中和 reveal；`Ctrl+Z` 调用 `undo_latest_operation` 而不是前端自行选择 record。
- `OperationConflictDialog.test.tsx`：决策按钮、重命名校验、apply-to-all、Tab 焦点循环、Enter/Esc 行为和焦点恢复。
- `OperationTaskCenter.test.tsx`：运行中、等待冲突、失败、部分成功、pending confirmation、可撤销/不可撤销、payload 清理提示状态展示。
- `OperationHistoryList.test.tsx`：历史过滤、状态标签、撤销确认、blocked/expired 原因和清除记录行为。

常规验证命令：

- `npm test`
- `npm run build`
- `cargo check --manifest-path src-tauri/Cargo.toml --offline`
- `cargo test --manifest-path src-tauri/Cargo.toml --offline`

## 12. 风险与缓解

- 删除撤销可靠性：不用 Windows 回收站作为唯一恢复来源，改用 app-managed trash。
- 跨卷删除性能：首版由任务中心显示进度；后续做 per-volume trash。
- 冲突竞态：执行前和真正写入前都检查目标状态；用户决策过期后重新确认。
- 部分成功：每个条目记录独立结果，只撤销已成功条目。
- 远程不可逆删除：默认标记不可撤销，并在 UI 明确提示。
- 用户修改已复制目标后撤销：preflight 检测变化，要求用户确认或跳过。
- 日志损坏：journal store 读取失败时备份坏文件并从空历史恢复，不影响文件浏览主路径。
- 并发写冲突：首版文件写操作串行，降低复杂度。
- Windows reparse point：symlink、junction、mount point 和其他 reparse point 都按链接项处理；递归复制、移动、删除、trash cleanup 和撤销恢复默认不跟随目标，必须测试覆盖。
- 隐私：操作历史默认只存路径和元数据，不存远程密码；提供清空历史入口。

## 13. 验收标准

- 用户可以在任务中心看到复制、移动、删除、重命名、新建的进度、结果和失败详情。
- 长文件操作不会阻塞 React UI。
- 用户遇到目标冲突时，可以选择替换、跳过、保留两者、重命名，并可对剩余同类冲突应用相同策略。
- `Ctrl+Z` 能撤销最近一次复制：删除本次粘贴/拖拽复制产生的目标项。
- `Ctrl+Z` 能撤销最近一次剪切粘贴或拖拽移动：把目标项恢复到原位置。
- `Ctrl+Z` 能撤销最近一次本地删除：从应用暂存区恢复到原路径。
- `Ctrl+Z` 的最近记录选择由后端原子完成；连续触发不会重复撤销同一条历史。
- 需要破坏性确认的撤销会先展示确认摘要，用户取消后不创建 undo task。
- 撤销过程中如果原路径被占用，会进入冲突处理 UI，而不是静默覆盖。
- 任务中心和历史列表能展示 `pendingConfirmation`、`blocked`、`expired`、`partialSucceeded` 和 payload 清理后的不可撤销原因。
- 拖放时能按同卷/跨卷/远程边界和 Ctrl/Shift modifier 正确生成 copy/move intent，并显示“复制到/移动到”徽标。
- 远程删除在未启用远程 trash 时明确显示不可撤销。
- 所有新增 IPC DTO 都有前后端契约测试覆盖。

## 14. 子 Agent 审查记录

### 第 1 轮：架构与状态模型审查

审查方式：委派 1 个子 Agent 只审查方案文档，不修改文件。

主要发现：

- 需要明确前端/后端状态权威源，避免 reducer、task service、journal store 各自维护事实状态。
- 任务事件只靠 `taskId` 不足以处理乱序、重复和漏事件，需要 `sequence`、`updatedAt` 和快照恢复规则。
- `affectedRoots` 被 controller 刷新逻辑使用，但初稿没有进入任务/事件合约。
- 用户级操作与底层 step/result 的映射需要更硬，避免远程组合操作和部分成功时撤销历史被拆碎。
- 阶段 1 需要提前建立 plan/result 骨架和远程 `PathRef/LocationRef` 合约，降低后续返工。

处理结果：

- 已补充“状态权威源”，明确后端 task service、journal store、conflict service 是事实来源，前端 reducer 只保存事件投影和 UI 状态。
- 已把 `OperationIntent` 改为 discriminated union，并新增 `PathRef`、`requestId` 幂等规则。
- 已为 `OperationTask` 和任务事件补充 `sequence`、`updatedAt`、`affectedRoots`、任务关联字段。
- 已新增 `OperationPlan`、`OperationRootAction`、`OperationStep`、`OperationEntryResult` 的稳定映射。
- 已补充冲突事件中的 `planId`、`stepId`、`rootActionId`、`affectedEntryKey`。
- 已调整阶段 1，把 task IPC、plan/result 骨架、本地任务化和远程路径合约前置。

### 第 2 轮：Rust 文件操作、远程路径与 IPC 合约审查

审查方式：委派 1 个子 Agent 只审查方案文档，不修改文件；根据反馈完成本轮修订后再进入下一轮。

主要发现：

- `replace` 和 `mergeDirectory` 的撤销语义需要显式备份规则，否则覆盖后无法可靠恢复。
- symlink、junction、mount point 等 Windows reparse point 不能按普通目录递归处理。
- app-managed trash 需要 manifest、事务状态、启动 reconcile 和 payload 清理规则，否则删除撤销会在崩溃或过期清理时失真。
- 跨卷、跨远程边界的 move 需要定义“复制成功但删除源失败”的降级语义，此时撤销应按 copy undo 删除已创建目标，而不是按 move undo 还原。
- IPC DTO 需要收紧：避免 loose string、重复 envelope 字段、命令命名不一致和前端先 list 后 listen 造成事件竞态。
- 远程路径不能在任务、事件、journal 中保存敏感完整 URI，应规范为 `profileId + remotePath + protocol`。

处理结果：

- 已新增 `ConflictPolicy`、`OperationStepKind`、`EntryMetadataSnapshot`、`OperationError`、`UndoAction`、`UndoPrecondition`、`TrashPayloadRef` 等关键 DTO。
- 已把远程 `PathRef` 收紧为 `{ kind: "remote"; profileId; remotePath; protocol }`，并把原始 URI 限定为入站 `RawPathInput`。
- 已补充 `replace`、`mergeDirectory` 的备份和撤销要求，无法备份时不得静默执行破坏性覆盖。
- 已补充 app-managed trash manifest、状态迁移、启动 reconcile、过期清理事务和 payload 校验规则。
- 已补充跨卷/跨远程 move 的降级语义：源删除失败时任务按 copy 结果生成 `deleteCreated` 撤销动作。
- 已统一冲突命令为 `resolve_file_operation_conflict`，并补充 task/history 列表快照的 sequence 合并规则。
- 已明确前端必须先注册 operation event listener，再调用 `list_file_operation_tasks()` 和 `list_operation_history()` 拉取快照。
- 已补充 Windows reparse point 安全规则：复制/移动/删除/清理/恢复均默认只处理链接项本身，不跟随到目标递归操作。

### 第 3 轮：React UI、任务中心、冲突交互与快捷键审查

审查方式：委派 1 个子 Agent 只审查方案文档，不修改文件；本轮重点审查前端边界、任务中心状态呈现、冲突弹窗、`Ctrl+Z` 和文件管理器易用性。

主要发现：

- 前端组件边界需要更硬，避免 `OperationTaskCenter`、`OperationConflictDialog`、`OperationHistoryList` 直接调用 gateway、Tauri invoke 或注册事件监听。
- 任务中心和历史列表需要明确各状态的用户呈现，尤其是 `waitingConflict`、`partialSucceeded`、`blocked`、`expired`、`pendingConfirmation` 和 payload 清理后的不可撤销状态。
- `Ctrl+Z` 不能由前端根据可能滞后的历史投影选择记录，应由后端 `journal_store` 原子选择最近可撤销记录。
- 冲突对话框缺少 Tab 焦点循环、Enter/Esc 行为、重命名输入焦点、决策过期处理和焦点恢复规则。
- 拖放 copy/move 语义需要贴近 Windows 文件管理器习惯，明确同卷、跨卷、远程边界和 Ctrl/Shift modifier。
- 完成后的刷新、选中和 reveal 规则需要更具体，避免完成任务后打断用户当前视图或刷新错误面板。
- toast、状态栏、sticky notification 的使用边界需要区分，避免通知噪音。
- 历史列表需要补充信息密度、过滤、blocked/expired 原因和 payload 到期信息。

处理结果：

- 已补充 Operation UI 组件边界：组件只接收 view model 和 callback props，命令调用、事件监听、快捷键处理统一由 `useWorkspaceController` 编排。
- 已新增任务状态和历史状态呈现表，覆盖运行、等待冲突、取消、完成、部分成功、失败、撤销确认、被阻止、已过期等状态。
- 已把 `Ctrl+Z` 改为调用 `undo_latest_operation({ requestId, scope })`，由后端原子选择记录；单条历史撤销仍走 `undo_operation({ recordId, requestId })` 并由后端重新校验。
- 已新增 `UndoStartResult`、`pendingConfirmation`、`confirm_undo_operation` 和一次性 `confirmationId` 规则，覆盖需要确认的破坏性撤销。
- 已补充冲突对话框键盘可达性、焦点保存/恢复、Esc 不执行破坏性动作、提交 pending 禁用态和过期冲突处理。
- 已补充拖放语义：同卷默认 move、跨卷默认 copy、Ctrl 强制 copy、Shift 强制 move、远程边界默认 copy 并显示“复制到/移动到”徽标。
- 已补充完成后的刷新、选中与 reveal 规则，按 `affectedRoots` 和 `entryResults` 精准刷新，不强制切换未打开的目标 tab。
- 已补充通知策略和历史列表信息结构，并同步测试矩阵与验收标准。
