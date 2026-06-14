# 设置弹窗 UI 与快捷键捕获实现代码审查提示词 - 第 3 轮

请你作为代码审查 Agent，对设置弹窗 UI 与快捷键捕获实现进行第 3 轮最终审查。前两轮已完成修复，本轮目标是确认所有阻塞问题是否关闭，并找出仍会影响发布质量的残留问题。

## 背景

- 设计基线：`.temp/settings-window-ui-shortcut-capture-design.md`
- 第 1 轮代码审查提示词：`.temp/settings-window-ui-shortcut-capture-code-review-prompt-round1.md`
- 第 2 轮代码审查提示词：`.temp/settings-window-ui-shortcut-capture-code-review-prompt-round2.md`

## 前两轮主要问题与修复概况

1. 快捷键保留组合提交问题
   - 已修复：`ShortcutCaptureInput.commitCapture` 在 `keyup / Enter / blur / window-blur` 所有路径统一拒绝 `Alt`、`Alt+Tab`、`Alt+F4`、`Ctrl+Alt+Delete` 等系统保留组合。
   - 已补测试：`SettingsSurface.test.tsx` 覆盖 keyup、Enter、blur、window blur 相关拒绝路径。

2. 全局快捷键 editable guard
   - 已修复：`useWorkspaceController.ts` 硬编码 `Alt+ArrowLeft` 已加 `!editable`。
   - 已补测试：readOnly input 作为 event target 时不会触发工作区后退导航。

3. NavigationTabView 自有快捷键 editable guard
   - 第 2 轮发现：`NavigationTabView.tsx` 根节点 `onKeyDown` 会消费子输入框中的 `Ctrl+A / Delete / Enter / F2` 等按键。
   - 本轮已修复：新增 `isEditableKeyboardTarget`，`input / textarea / select / contenteditable` 目标直接 return。
   - 已补测试：`NavigationTabView.test.tsx` 覆盖筛选输入框和编辑输入框内 `Ctrl+A / Delete / Enter / F2` 不触发导航动作且不阻止默认文本编辑。

4. FTP/SFTP 响应式布局
   - 已修复：连接页折叠改为 `.settings-window__content` container query。
   - 本轮补充调整：container query 阈值从 620px 收紧到 600px，避免 920px 默认窗口下连接编辑器默认折叠。

5. JSDOM legacy input patch 去重
   - 已修复：新增 `src/features/workspace/testDom.ts`，集中安装 `attachEvent/detachEvent` 兼容补丁，相关测试已迁移。

## 重点审查文件

请重点审查：

- `src/features/workspace/SettingsSurface.tsx`
- `src/features/workspace/SettingsSurface.test.tsx`
- `src/features/workspace/workspaceShortcuts.ts`
- `src/features/workspace/workspaceShortcuts.test.ts`
- `src/features/workspace/useWorkspaceController.ts`
- `src/features/workspace/useWorkspaceController.test.ts`
- `src/features/workspace/NavigationTabView.tsx`
- `src/features/workspace/NavigationTabView.test.tsx`
- `src/features/workspace/workspace.css`
- `src/features/workspace/testDom.ts`
- 设置 section / DTO / reducer / window 尺寸相关文件：
  - `src/features/workspace/types.ts`
  - `src/features/workspace/workspaceMappers.ts`
  - `src/features/workspace/workspaceReducer.ts`
  - `src/features/workspace/workspaceBackendDtos.ts`
  - `src/features/workspace/settingsWindow.ts`

## 必须复核的问题

1. 前两轮问题关闭情况
   - 快捷键保留组合是否真正无法通过任何提交路径保存。
   - `useWorkspaceController` 与 `NavigationTabView` 的所有键盘分支是否都尊重 editable target。
   - FTP/SFTP 响应式是否在 920px 默认窗口和 800px 最小窗口下都合理。
   - JSDOM patch helper 是否没有生产运行时副作用。

2. 快捷键捕获最终行为
   - `unfocused / capturing / committedFocused / cancelledFocused` 状态迁移是否仍一致。
   - `hasCommittedCurrentCaptureRef` 是否仍能防止 `keyup + blur` 或 `Enter + blur` 重复提交。
   - `Tab` 在提交/取消/拒绝后是否用于焦点导航。
   - disabled/applying 状态下 focus、keydown、paste、drop、composition 是否不会更新 binding。
   - `Meta/Win`、`Dead`、`Unidentified`、`Process`、IME composing 是否不会保存且不会形成焦点陷阱。

3. 保存边界与冲突检测
   - `normalizeShortcutBindingForStorage` 是否仍和后端 `validate_shortcuts` 的 `scope + accelerator.trim().to_ascii_lowercase()` 去重语义一致。
   - `toBackendShortcut` 是否对所有 shortcuts 规范化，包括未编辑旧数据。
   - `saveWorkspaceShortcuts` 和 `saveWorkspaceSettingsModel` 是否仍复用同一 DTO 边界。

4. 设置 section 状态模型
   - 七个设置页面是否仍统一使用 `WorkspaceState.settings.section`。
   - 旧 `"theme"`、`"rules"` 是否仍通过单点映射迁移。
   - 是否有组件局部第二套 section 状态。

5. UI 和响应式布局
   - 是否符合 Windows 桌面偏好设置面板的高密度风格。
   - 是否存在文字溢出、卡片嵌套、默认 920px 折叠异常、800px 最小窗口不可用等问题。
   - footer 固定、右侧滚动、快捷键表格横向滚动、FTP/SFTP 窄宽折叠是否合理。
   - 当前 CSS 字符串测试是否不足以覆盖某些布局风险，如有请明确指出应补的截图或集成测试。

6. FTP/SFTP 草稿语义
   - 未暂存 dirty 时：切 profile、切 section、窗口确定是否阻断。
   - 暂存后：窗口确定是否走统一保存。
   - 测试连接是否不会清 dirty、不会等同暂存。
   - 若测试仍不足，请列出最小补测建议。

## 已执行验证

本轮修复后已执行：

- `npm.cmd test`
- `npm.cmd run build`
- `cargo check --manifest-path src-tauri/Cargo.toml --offline`

`npm.cmd run build` 仍有 lucide-react 既有 `"use client"` bundle warning；除非能证明与本轮改动有关，否则不要作为本轮问题。

## 输出格式要求

请按以下格式输出：

1. 结论：`通过` 或 `需要修改`
2. 第一轮问题关闭情况：
   - 对第 1 轮问题逐项标注 `已关闭 / 部分关闭 / 未关闭`。
3. 第二轮问题关闭情况：
   - 对第 2 轮问题逐项标注 `已关闭 / 部分关闭 / 未关闭`。
4. 主要问题：
   - 每条包含严重级别（高/中/低）、文件和行号、影响、建议修改方式。
5. 遗漏用例：
   - 只列仍值得补的测试或手工验证。
6. 建议保留的实现点：
   - 列出方向正确、无需修改的部分。
7. 最终建议：
   - 明确是否可以结束三轮审查流程，还是必须继续修复。

请聚焦真实发布风险，避免重复已经关闭且无新证据的问题。
