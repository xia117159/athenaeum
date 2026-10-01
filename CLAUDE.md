# Athenaeum - Claude Code Project Instructions

> 本文件以 `AGENTS.md` 为基础，面向 Claude Code 适配：两者共有的规则须保持一致，修改时两处同步更新；工具机制（技能调用语法、子 Agent 委派方式）按 Claude Code 改写。“问题修复原则”“架构边界”及设计基线为本文件独有的补充。

## 项目目标
- 基于 `Tauri v2`、`Rust`、`React`、`TypeScript` 实现 Windows 文件管理器桌面应用。
- 设计基线为 `.temp/design.md`（存在时），功能点按该文档持续补齐。

## 交付工作流
- 任何可能修改源码、配置或项目提示词资产的任务，在编写规格或实现之前，先阅读相关代码和约束并与用户对齐目标、范围、结果和风险。发现描述不清、前后矛盾、错误前提或会实质影响结果的疑问时必须提出，不能隐藏为默认假设；存在多个合理方案时，同时说明差异、取舍、风险和推荐理由，等待用户决定实质性方向。清晰任务不制造问题，纯内部、可逆且不改变需求语义的实现细节按项目惯例自主决定。
- 非平凡功能、复杂 BUG、功能或代码重构、跨模块/IPC/架构变化及高风险改动，使用 `/sfm-delivery-workflow` 执行需求对齐、自适应 SDD、独立规格审查、TDD 实现和独立实现审查。规格结构由任务风险自适应，不套固定模板；实现审查初始预算阶段最多 5 轮，5 轮通常只为大型需求、架构变化或重构保留，可提前收敛，未经用户明确扩容不得超过。任务过程中产出的正式规格、设计、审查记录和报告 Markdown 只写入 `.temp/`。
- 根因明确、影响局部且可由一个聚焦失败测试表达的小型 BUG，可在首次代码编辑前直接向用户说明根因与代码证据、修复方案、预期失败测试和回归边界，然后使用 `/sfm-tdd-bugfix` 以 TDD 修复。根因证据必须连接用户已知的复现条件与实际执行路径；只发现能产生相似症状的候选缺陷或 `closest failing invariant`，不能代替用户问题的根因。缺失的环境、入口、协议或状态会改变代码路径时，先向用户澄清，或证明所有合理路径共享同一根因；证据不足、存在实质性方案选择或风险扩大时，升级为正式 SDD。
- 仅解释、诊断、状态、评审或方案讨论的任务，不得擅自进入实现。用户明确要求改动时，再按上述风险分流。
- 所有适用的代码行为变化遵循 `TDD`：先写或补充会因目标行为缺失而失败的测试并确认失败原因，再完成最小实现，最后在测试保持通过时重构。无法形成有意义运行时单元测试的提示词、配置或文档资产，改用结构校验和独立前向场景验证，不伪造 Red-Green。
- 实现审查开始时建立唯一 TODO 账本，记录每项发现的 ID、严重级、来源波次/轮次、状态、处置和验证证据；同一波次批量处理发现，维护当前预算阶段的 `review budget: n/limit`，按阻断级、严重级、一般问题、建议的顺序处理，不得因拆分意见或重复委派突破上限。阻断级和严重级必须以验证通过的 `fixed` 或用户明确的 `accepted-risk` 关闭；一般问题和建议可延期但不能丢失记录。初始阶段达到第 5 轮仍有高等级未解决时停止并报告未完成，不得静默开始第 6 轮；用户若明确扩容，须记录旧/新上限、授权、原因和范围并从新阶段 `0/new_limit` 开始，`accepted-risk` 不增加预算。
- 独立审查由 `.claude/agents/` 下的子 Agent 执行：规格审查用 `sfm-spec-reviewer`，实现审查用 `sfm-impl-reviewer`（按 `behavior`、`safety` 焦点并行，小型修复用单次 `single`）。通过 Agent 工具委派，同一波次的委派放在同一条消息中并行启动。子 Agent 在后台运行，完成时由 harness 主动通知：不要轮询、不要读取其过程记录、不要在通知到达前推断或报告结果；等待期间保持被审查内容冻结，只做互不相关的工作。`AGENTS.md` 中面向其他工具的“每 10 分钟检查一次”规则在 Claude Code 中不适用。

## 当前实现原则
- 应用内命令菜单复用 `MenuPrimitives.tsx`、`menuInteraction.ts` 与 `workspace.menus.css`，行高统一为 24px；功能 CSS 仅定义布局，覆盖时组合公共类与功能类（如 `.app-menu.open-with-menu`），避免依赖加载顺序。顶部/右键的新建项目和打开方式入口使用 `WorkspaceFeatureMenuTrigger`，共享功能菜单与 controller，以 `MenuParent` 标识跨 portal 的所属菜单。
- 菜单与文件悬停颜色统一由 `workspaceTheme.ts` 定义、规范化，通过 `useMenuTheme.ts` 应用到文档根节点（含 portal）；独立窗口读取并订阅现有设置。Windows 原生菜单保留系统外观。
- 优先保证桌面程序主路径可运行、可构建、可测试。
- 前端工作区优先接真实 Tauri IPC；仅在本地浏览或后端接口缺失时才允许 mock 回退。
- 本地文件操作优先闭环：浏览、复制、移动、删除、重命名、创建目录。
- 远程 FTP/SFTP、系统原生右键菜单、规则系统、设置持久化按设计文档逐步收口，但不能破坏已有可运行路径。

## 开发与验证规则
- `npm run dev` 会先构建，再启动一个常驻静态开发服务器，监听 `127.0.0.1:1420`，不会自动退出。
- 代理执行任务时，不要把 `npm run dev` 当作常规验证命令，否则会占住前台执行通道，并可能在中断后留下后台 `node` 进程。
- 常规验证优先使用：
  - `npm test`
  - `npm run build`
  - `cargo check --manifest-path src-tauri/Cargo.toml --offline`
  - `cargo test --manifest-path src-tauri/Cargo.toml --offline`
- 需要人工联调桌面壳时，优先由用户手动执行 `npx tauri dev`。
- 在启动 `npx tauri dev` 或 `npm run dev` 前，必须先确认 `127.0.0.1:1420` 未被占用；若被占用，先清理残留进程。

## 修改约束
- 修改现有实现时，优先延续当前活跃工作区路径：`src/features/workspace/*`。
- 除非明确废弃，否则不要绕开现有前端状态模型和 Tauri 后端命令，另起一套平行实现。
- 每轮大改后都要重新跑构建和测试，避免出现“能编写但不能启动”的假完成状态。

## 问题修复原则
- 对于问题修复，必须一步一步分析根因，梳理可选的最佳实践方案，再基于最佳实践进行编码修改。
- 根因按具体类别说明：bad state transition, contract drift, unsafe path handling, stale async result, UI layout regression, encoding problem, or missing validation。
- 先写失败测试，再实现修复，最后重构。

## 架构边界
- **React 组件**：渲染和触发 UI 意图
- **`useWorkspaceController`**：编排 effects 和 gateway 调用
- **Reducer**：确定性工作区状态转换
- **Gateway**：IPC、映射、远程 URI 规划、会话持久化
- **Rust commands**：验证 IPC 输入并委托给 services
- **Rust services**：文件系统、远程、搜索、设置、shell 行为

## 项目技能与子 Agent
- 技能源文件在 `.agents/skills/*`（其他 Agent 工具使用），Claude Code 使用的适配副本在 `.claude/skills/*`：`/sfm-delivery-workflow`、`/sfm-tdd-bugfix`、`/sfm-architecture-guard`、`/sfm-react-workspace-ui`、`/sfm-rust-fs-ops`、`/sfm-tauri-ipc-contract`、`/sfm-windows-desktop-visual-design`。
- 适配副本替换工具机制（`CLAUDE.md` 代替 `AGENTS.md`、`/skill` 代替 `$skill`、Agent 工具委派代替定时轮询）、补充当前模块路径，并含少量 Claude Code 专有补充规则，其中最重要的是：小型 BUG 修复（Micro-SDD）完成前也须执行一次 `sfm-impl-reviewer` 的 `single` 审查，而源技能不要求。`.agents/skills` 变更后，把改动合并进 `.claude/skills`，保留这些适配与补充，不要整文件覆盖，也不要只改副本而让源文件落后。
- 审查子 Agent 定义在 `.claude/agents/`。`.claude/hooks/review-write-guard.mjs` 只拦截文件工具（Write、Edit 等）在 `.temp/specs/<task-id>/reviews/` 与 `.temp/reviews/` 之外的写入，并拒绝写 TODO 账本；Bash 写入无法由该 hook 拦截，依赖子 Agent 提示词约束。
- `.claude/` 被 gitignore，上述技能、子 Agent 与 hook 只存在于本机。缺失时先从 `.agents/skills` 重新同步；同步完成前不得宣称独立审查门禁已通过。
