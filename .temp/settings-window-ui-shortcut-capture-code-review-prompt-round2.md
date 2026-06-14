# 设置弹窗 UI 与快捷键捕获实现代码审查提示词 - 第 2 轮

请你作为代码审查 Agent，对第 1 轮审查后的修复结果进行第 2 轮严格审查。请优先验证第 1 轮指出的问题是否真正关闭，同时继续审查编码最佳实践、设计原则、设计完成度和正确性。

## 背景

- 设计基线：`.temp/settings-window-ui-shortcut-capture-design.md`
- 第 1 轮代码审查提示词：`.temp/settings-window-ui-shortcut-capture-code-review-prompt-round1.md`
- 第 1 轮审查结论：需要修改，主要问题包括：
  - 系统保留快捷键组合只在 `window blur` 拒绝，`keyup / Enter / blur` 仍可能提交。
  - `useWorkspaceController` 中硬编码 `Alt+ArrowLeft` 绕过 editable guard。
  - FTP/SFTP 连接编辑器折叠断点绑定 viewport，800px 最小窗口下右侧内容可能过挤。
  - JSDOM `attachEvent/detachEvent` 兼容补丁重复复制。

## 本轮已修复内容

请重点确认以下修复是否完整、正确、没有引入新问题：

1. 快捷键保留组合统一拒绝
   - `ShortcutCaptureInput.commitCapture` 现在应在所有提交原因下统一调用 `isReservedSystemShortcutCandidate(nextBinding)`。
   - `Alt`、`Alt+Tab`、`Alt+F4`、`Ctrl+Alt+Delete` 应在 `keyup / Enter / blur / window-blur` 路径均不触发 `onUpdateShortcut`。
   - 拒绝后应恢复原值，并进入非捕获状态；不能留下焦点陷阱或重复提交。
   - `eventToShortcutCaptureCandidate` 已增加 `isComposing`、`Meta/Win`、`Unidentified`、`Dead`、`Process` 过滤。

2. 全局快捷键 editable guard
   - `useWorkspaceController.ts` 中硬编码 `Alt+ArrowLeft` 现在应带 `!editable` 条件。
   - readOnly shortcut input 作为 `keydown` event target 时，不应触发工作区后退导航，也不应 `preventDefault`。
   - 请确认其它硬编码快捷键或特殊分支没有类似绕过 editable guard 的问题。

3. FTP/SFTP 连接页响应式
   - `.settings-window__content` 已声明 `container-name: settings-content` / `container-type: inline-size`。
   - 连接页在 `@container settings-content (max-width: 620px)` 下折叠 `.connections-editor`、`.settings-form-grid`、`.settings-toggle-grid`。
   - 请确认该策略不影响 920px 默认窗口下左侧导航保留，也不会误伤其它设置页面布局。

4. 测试 helper 去重
   - 新增 `src/features/workspace/testDom.ts`，集中安装 JSDOM legacy input event patch。
   - 已将相关测试中的重复 `attachEvent/detachEvent` 补丁迁移到共享 helper。
   - 请确认 helper 命名、位置和生产构建影响合理；若认为应放到专用 test utils 路径，请指出。

## 重点审查文件

- `src/features/workspace/SettingsSurface.tsx`
- `src/features/workspace/SettingsSurface.test.tsx`
- `src/features/workspace/workspaceShortcuts.ts`
- `src/features/workspace/workspaceShortcuts.test.ts`
- `src/features/workspace/useWorkspaceController.ts`
- `src/features/workspace/useWorkspaceController.test.ts`
- `src/features/workspace/workspace.css`
- `src/features/workspace/testDom.ts`
- 以及第 1 轮已涉及的设置 section、DTO、reducer、settings window 尺寸相关文件。

## 必须复核的问题

1. 快捷键捕获状态机
   - `hasCommittedCurrentCaptureRef` 是否仍是同步幂等 guard。
   - `blur` 和 `window-blur` 后进入 `unfocused` 是否合理；`keyup` / `Enter` 拒绝保留组合后进入 `cancelledFocused` 是否合理。
   - 确认/取消/拒绝后，下一次 `Tab` 是否用于焦点导航而不是继续捕获。

2. 快捷键候选与保存边界
   - `normalizeShortcutBindingForStorage` 是否仍保证 `Ctrl+Alt+Shift+Key` 顺序。
   - 前端冲突检测与 `toBackendShortcut` 是否仍和 Rust `validate_shortcuts` 的 `scope + accelerator.trim().to_ascii_lowercase()` 一致。
   - modifier-only 组合是否按设计允许，保留组合是否按 denylist 拒绝。

3. 全局快捷键互斥
   - readOnly input、普通 input、textarea、select、contenteditable 是否都会阻止工作区快捷键。
   - 硬编码分支、配置型快捷键分支、导航 tab 分支是否都遵守 editable guard。

4. 响应式布局
   - 920px 默认窗口、800px 最小窗口下设置页是否可用。
   - 左侧导航是否只在 viewport <799px 时折到顶部。
   - FTP/SFTP 连接编辑器是否在右侧内容宽度不足时折叠，footer 是否仍固定，表格是否可横向滚动。
   - container query 是否有兼容性风险，是否符合当前 Tauri WebView 目标。

5. FTP/SFTP 草稿语义
   - 未暂存 dirty 时：切 profile、切 section、窗口确定均应阻断。
   - 暂存后：窗口确定应走统一保存路径。
   - 测试连接不应等同于暂存。
   - 请指出当前测试是否仍不足。

6. 测试质量
   - 新增测试是否真正覆盖行为，而不是只验证字符串。
   - 是否存在 JSDOM 与真实 WebView 事件序列差异导致的漏测。
   - 共享 `testDom.ts` 是否会被生产构建误用或造成维护风险。

## 已执行验证

本轮修复后已执行：

- `npm.cmd test`
- `npm.cmd run build`
- `cargo check --manifest-path src-tauri/Cargo.toml --offline`

`npm.cmd run build` 仍有 lucide-react 既有 `"use client"` bundle warning；除非你能证明它与本轮改动有关，否则不要作为本轮问题。

## 输出格式要求

请按以下格式输出：

1. 结论：`通过` 或 `需要修改`
2. 主要问题：
   - 每条包含严重级别（高/中/低）、文件和行号、影响、建议修改方式。
3. 第一轮问题关闭情况：
   - 对第 1 轮四个主要问题逐项标注 `已关闭 / 部分关闭 / 未关闭`。
4. 新增问题：
   - 如发现新的设计、实现、测试或架构问题，请列出。
5. 遗漏用例：
   - 列出仍建议补充的测试或手工验证。
6. 建议保留的实现点：
   - 列出方向正确、无需修改的部分。
7. 最终建议：
   - 明确是否可以进入第 3 轮审查，还是必须先修复问题。

请优先输出能直接转成 TODO 的问题，不要只给泛泛的风格建议。
