# 第二轮审查提示词：设置弹窗 UI 布局与快捷键捕获设计方案

请审查修订后的设计文档：

`F:\project\athenaeum\.temp\settings-window-ui-shortcut-capture-design.md`

## 审查背景

这是第二轮审查。本轮只审查设计方案，不进行编码实现。

第一轮审查结论为“需要修改”，主要问题包括：

1. 快捷键捕获状态机不可直接实现，可能重复确认或造成 Tab 焦点陷阱。
2. Enter/Escape 与普通 keydown 候选更新优先级不明确。
3. 前端 binding 与后端 accelerator 的规范化关系不清晰。
4. 七个左侧导航项与现有四值 `SettingsSection` 存在状态分叉风险。
5. 窗口最小尺寸、表格响应式、FTP/SFTP 窄宽布局不够具体。
6. 禁止直接输入字符没有覆盖 paste、drop、composition 等路径。

修订版已补充：

- `unfocused / capturing / committedFocused / cancelledFocused` 状态机。
- keydown 优先级：拦截事件 -> Escape -> Enter -> 普通候选键。
- 幂等确认规则，确保 keyup、blur、Enter 不重复调用更新。
- 确认/取消后 Tab 移动焦点，不继续捕获。
- `normalizeShortcutBindingForStorage` 与后端 accelerator 冲突检测一致性。
- 七个设置导航项进入同一个 `WorkspaceState.settings.section` 状态。
- `800 x 560` 最小窗口、右侧滚动、footer 固定、表格内部横向滚动、FTP/SFTP 折叠策略。
- paste、drop、beforeinput、input、composition 的禁止/忽略规则。

## 请重点审查

1. 第一轮提出的高/中风险问题是否已经被完整关闭。
2. 快捷键状态机是否仍存在重复提交、焦点陷阱或无法重新捕获的问题。
3. keydown/keyup/blur/window blur 的事件顺序是否足够明确，可直接转化为测试。
4. Ctrl、Ctrl+Alt、Ctrl+Alt+P、Ctrl+Alt、Shift、Tab、Alt+Up 等捕获用例是否都有一致行为。
5. Enter/Escape 在有候选值和无候选值时是否都不会误写入空值或候选键。
6. 前端规范化与后端 `validate_shortcuts` 的 `scope + accelerator.trim().to_ascii_lowercase()` 去重逻辑是否完全对齐。
7. 七个 settings section 的状态归属是否仍有与现有 reducer/controller 冲突的地方。
8. 响应式布局策略是否足够可实现，尤其是默认 920px、最小 800px、右侧表格和 FTP/SFTP 页面。
9. 禁止直接文本输入是否覆盖所有合理输入路径。
10. FTP/SFTP 页面重排是否会改变现有“暂存配置”和窗口“确定”统一保存的语义。
11. 测试计划是否足够覆盖第二轮前的所有已知风险。

## 输出格式要求

请按以下结构输出审查结论：

```text
结论：通过 / 需要修改

第一轮问题关闭情况：
1. [已关闭/未关闭/部分关闭] 问题描述
   - 说明：
   - 仍需修改：

新增问题：
1. [严重级别：高/中/低] 问题描述
   - 影响：
   - 建议修改：

遗漏用例：
1. ...

与现有代码/架构的冲突：
1. ...

最终建议：
...
```

请给出具体、可执行的修改建议。不要直接改代码。

