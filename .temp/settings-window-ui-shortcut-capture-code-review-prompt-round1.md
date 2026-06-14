# 设置弹窗 UI 与快捷键捕获实现代码审查提示词 - 第 1 轮

请你作为代码审查 Agent，对本轮设置弹窗 UI 与快捷键捕获实现进行严格审查。审查目标是判断实现是否忠实落地设计文档、是否符合 SimpleFileManager 现有架构边界、是否存在行为缺陷、交互缺陷、响应式布局缺陷、测试缺口或代码质量问题。

## 背景与基线

- 设计基线：`.temp/settings-window-ui-shortcut-capture-design.md`
- 本轮是编码完成后的第 1 轮审查，后续还会继续执行第 2、3 轮审查与修改。
- 项目约束：Tauri v2 + Rust + React + TypeScript，设置页必须继续使用现有 `src/features/workspace/*` 状态、reducer、controller、gateway 边界，禁止另起平行状态模型。

## 重点审查范围

请重点审查以下文件和相关调用链：

- `src/features/workspace/SettingsSurface.tsx`
- `src/features/workspace/workspace.css`
- `src/features/workspace/workspaceShortcuts.ts`
- `src/features/workspace/workspaceBackendDtos.ts`
- `src/features/workspace/workspaceMappers.ts`
- `src/features/workspace/workspaceReducer.ts`
- `src/features/workspace/types.ts`
- `src/features/workspace/settingsWindow.ts`
- 对应测试：
  - `src/features/workspace/SettingsSurface.test.tsx`
  - `src/features/workspace/workspaceShortcuts.test.ts`
  - `src/features/workspace/workspaceBackendDtos.test.ts`
  - `src/features/workspace/workspaceSettingsGateway.test.ts`
  - `src/features/workspace/workspaceReducer.test.ts`
  - `src/features/workspace/settingsWindow.test.ts`
  - `src/features/workspace/OperationTaskCenter.test.tsx`
  - `src/features/workspace/useWorkspaceController.test.ts`

## 必须验证的问题

1. 快捷键捕获状态机是否可实现且无焦点陷阱：
   - 状态应覆盖 `unfocused / capturing / committedFocused / cancelledFocused`。
   - `keyup / blur / Enter / window blur` 确认必须幂等，不能重复触发 `onUpdateShortcut`。
   - 确认或取消后，后续 `Tab` 应用于焦点导航，不能继续被捕获。

2. 快捷键输入路径是否彻底禁用文本编辑：
   - 真实 `input readOnly` 是否保留。
   - `beforeinput / input / change / paste / dragover / drop / composition*` 是否不会更新 binding。
   - disabled/applying 状态下 focus、keydown、paste、drop 是否不会更新。

3. 快捷键规范化与冲突检测是否与后端一致：
   - UI 确认前是否使用 `normalizeShortcutBindingForStorage`。
   - `toBackendShortcut` 是否对所有 shortcuts 调用同一规范化函数，包括未编辑旧数据。
   - 前端冲突检测是否使用将要发给后端的 `accelerator.trim().toLowerCase()` 语义。
   - 是否覆盖大小写、前后空格、修饰键顺序、modifier-only 组合。

4. 系统保留组合是否处理保守：
   - `Alt+Tab`、`Alt+F4`、`Meta/Win`、单 `Alt`、`Ctrl+Alt+Delete`、`Unidentified`、IME/dead key 是否不会误提交。
   - window blur 提交逻辑是否只在安全候选值下生效。

5. 七个设置页面是否只使用同一状态源：
   - `SettingsSection` 是否统一扩展为七个 section。
   - 旧值 `"theme"`、`"rules"` 是否通过单一映射函数迁移。
   - reducer、controller、测试是否没有新增第二套 section 状态。

6. 设置窗口 UI 与响应式布局是否符合设计：
   - 默认窗口宽度 920px 下左侧导航不应折叠到顶部。
   - 当前 Tauri settings window 最小尺寸是否更新到设计要求。
   - 右侧内容区、footer、快捷键表格、连接编辑器是否有可用的滚动/折叠策略。
   - 是否避免大面积卡片堆叠、嵌套卡片、营销式布局和不必要装饰。

7. FTP/SFTP 连接页草稿语义是否正确：
   - “暂存配置”前的表单修改不能被窗口“确定”静默保存或丢弃。
   - 存在未暂存修改时，切换 profile、切换 section、点击确定是否被阻断并给出提示。
   - 暂存后再确认是否能正常走统一保存路径。

8. 全局快捷键与设置窗口是否互不干扰：
   - 快捷键控件在非捕获态、确认态、取消态下是否不会触发工作区快捷键。
   - 如果依赖真实 input readOnly，是否足以被现有全局 keydown guard 识别为输入控件。

9. 测试质量是否足够：
   - 新增测试是否覆盖设计文档中的关键边界。
   - 是否有遗漏用例、脆弱测试、只测 CSS 字符串但不测行为的问题。
   - `OperationTaskCenter.test.tsx`、`useWorkspaceController.test.ts` 中新增 JSDOM `attachEvent/detachEvent` 兼容补丁是否合理、是否应抽成共享测试 helper。

## 已执行验证

本轮实现后已执行：

- `npm.cmd test`
- `npm.cmd run build`
- `cargo check --manifest-path src-tauri/Cargo.toml --offline`

其中 `npm.cmd run build` 仍会输出 lucide-react 的既有 `"use client"` bundle warning，请不要把该既有 warning 当作本轮失败，除非你发现它与本轮代码有关。

## 输出格式要求

请按以下格式输出审查结论：

1. 结论：`通过` 或 `需要修改`
2. 主要问题：
   - 每条问题包含严重级别（高/中/低）、文件和行号、影响、建议修改方式。
3. 遗漏用例：
   - 列出仍建议补充的测试或手工验证场景。
4. 与现有架构/设计的冲突：
   - 如有，请指出具体状态流、DTO 边界、CSS 断点、快捷键事件流或持久化路径冲突。
5. 建议保留的实现点：
   - 列出无需改动且方向正确的实现。
6. 最终建议：
   - 明确下一步是可以进入第 2 轮审查，还是必须先修复问题再审查。

请优先给出可落地的问题，不要只给泛泛的代码风格建议。若认为需要修改，请尽量提供能直接转化为 TODO 的修改项。
