  # Tauri v2 Windows 文件管理器实施方案

  ## Summary

  从零搭建一个仅面向 Windows 11 的 Tauri v2 桌面文件管理器，整体交互风格参考 Directory Opus，但保留 Windows 原生习惯。
  架构采用 Rust 负责文件系统/远程协议/Windows 原生集成/任务调度，React + TypeScript 负责工作区 UI/状态编排/设置界面。
  数据层采用 SQLite + JSON/TOML 混合存储：结构化元数据进 SQLite，轻量 UI 配置进 JSON/TOML，远程凭据存入 Windows
  Credential Manager。搜索首版采用 按需实时扫描，不做后台全量索引。

  ## Key Changes

  ### 1. 工程与模块边界

  - 初始化 Tauri v2 + React + TypeScript + Vite 工程，前端使用组件分层 + 状态切片，后端按领域拆分 crate/module。
  - Rust 后端拆为这些子系统：
      - fs_core：本地文件枚举、复制/移动/删除/重命名、冲突策略、批量任务。
      - nav_core：地址栏导航、历史记录、目录树数据、驱动器/快捷位置枚举。
      - search_core：名称搜索、内容搜索、过滤与中断、结果流式返回。
      - remote_core：FTP/SFTP 连接池、远程目录列举、上传下载、远程重命名/删除/移动。
      - rules_core：着色规则、标签规则、列配置、书签/热表。
      - shell_core：Windows Shell 集成、系统右键菜单、图标/关联信息。
      - settings_core：快捷键、自定义右键菜单、布局持久化、用户偏好。
      - task_core：后台任务队列、取消/重试/进度事件、错误聚合。
  - 前端拆为这些子系统：
      - workspace shell：窗口框架、标题区、命令栏、状态栏。
      - panel system：1/2/3/4 面板布局、分割拖拽、焦点管理、Tab 顺序切换。
      - tab workspace：每面板多标签、独立导航状态、恢复上次会话。
      - listing view：详情视图、可定制列、排序、选择模型、虚拟滚动。
      - tree + address bar：目录树、面包屑、地址栏、历史前进后退。
      - menu systems：系统右键桥接、自定义右键菜单、快捷动作入口。
      - settings app：快捷键编辑器、右键菜单配置、着色/标签规则编辑器。
  - 采用事件驱动 IPC：前端通过 typed commands 调用后端，通过 typed events 接收进度、搜索流、任务状态。

  ### 2. 核心交互与数据设计

  - 布局系统支持 single / dual / triple / quad 四种模式；每个面板由 PanelState 表示，包含当前标签集合、活动标签、尺寸
    比例、焦点状态。
  - 标签页由 TabState 表示，包含当前位置、本地或远程 location、浏览历史、视图模式、列配置、筛选条件、选中项缓存。
  - 统一资源定位：
      - 本地路径使用 file:// 语义包装。
      - 远程路径使用 remote://connection-id/path 语义包装。
      - 前端不区分展示层操作入口；由后端根据 location type 路由到本地或远程适配器。
  - 文件列表统一视图模型 EntryViewModel，字段至少包含：名称、类型、大小、修改时间、扩展名、属性、颜色规则结果、标签集
    合、图标句柄、所在位置。
  - SQLite 结构化数据表：
      - bookmarks
      - directory_hotlist
      - tag_definitions
      - entry_tags
      - color_rules
      - saved_columns
      - search_history
      - remote_connections
      - custom_context_actions
  - JSON/TOML 仅保存：
      - 窗口尺寸与恢复状态
      - 当前布局和各面板比例
      - UI 外观、密度、默认列模板
      - 快捷键绑定导出快照
  - 远程连接元数据进 SQLite；密码/私钥口令仅存 Windows Credential Manager。
  - 文件内容搜索首版策略：
      - 名称搜索即时遍历。
      - 内容搜索按需扫描文本类文件，支持扩展名白名单、大小上限、编码探测、取消信号。
      - 搜索过程流式回传结果，不阻塞 UI。
  - 右键菜单策略：
      - 普通右键优先走 IContextMenu/Shell 桥接，尽量展示系统原生菜单。
      - Ctrl + 右键 强制显示应用自定义菜单。
      - 原生菜单不可用时安全回退到自定义菜单，并明确区分来源。
  - 快捷键系统支持作用域：
      - global window
      - workspace
      - active panel
      - listing view
        冲突检测在设置界面完成，保存前阻止重复绑定。
  - UI 风格基线：
      - Win11 桌面应用观感、专业高密度信息布局、清晰层级、可键盘优先操作。
      - 使用虚拟列表、懒加载树节点、异步图标解析和批量状态提交，避免大目录卡顿。

  ### 3. 需要明确实现的公共接口/类型

  - Tauri commands：
      - layout_get, layout_set, panel_resize
      - tab_open, tab_close, tab_activate, tab_restore_session
      - location_list_entries, location_change_dir, location_get_tree_children
      - file_copy, file_move, file_delete, file_rename, file_create_folder
      - bookmark_list/save/delete, hotlist_list/save/delete
      - search_start, search_cancel
      - remote_connection_test/create/update/delete/connect/disconnect
      - rule_list/save/delete for colors/tags/columns/context actions
      - shortcut_list/save/reset
      - shell_show_system_context_menu, shell_execute_custom_context_action
  - Tauri events：
      - task_progress
      - task_completed
      - task_failed
      - search_result
      - search_finished
      - panel_focus_changed
      - native_context_fallback
  - TypeScript 关键类型：
      - PanelLayoutMode
      - PanelState
      - TabState
      - LocationDescriptor
      - EntryViewModel
      - FileOperationRequest
      - SearchQuery
      - ColorRule, TagRule, ColumnPreset
      - ShortcutBinding
      - RemoteConnectionProfile

  ### 4. 编码实施顺序与子 Agent 分工

  所有编码按 TDD: 红灯 -> 绿灯 -> 重构 执行，每个子 Agent 对应一个清晰写入边界，主 Agent 负责集成、跨模块契约校验和回
  归测试。

  1. Agent A - Scaffold & Contracts

  - 建立 Tauri/React 基线工程、目录结构、typed IPC、测试框架、CI 脚本骨架。
  - 先写契约测试与类型测试，再落空实现。

  2. Agent B - Panel/Tab Workspace

  - 实现 1/2/3/4 面板布局、拖拽分割、焦点切换、Tab 容器、会话恢复。
  - 负责前端工作区状态机和布局持久化。

  3. Agent C - Local FS Operations

  - 实现本地文件浏览与基础操作、冲突策略、后台任务、历史导航。
  - 负责 Rust fs_core/nav_core/task_core。

  4. Agent D - Tree/Address/Bookmarks

  - 实现目录树、地址栏、面包屑、书签和目录热表。
  - 负责前端导航控件与后端导航查询接口。

  - 实现详情视图、列定制、排序、虚拟滚动、颜色规则、标签展示与筛选。

  6. Agent F - Search

  - 实现名称与内容搜索、流式结果、取消、过滤条件、结果定位跳转。
  - 负责后端扫描器和前端搜索面板。

  7. Agent G - Windows Shell / Context Menu

  8. Agent H - FTP/SFTP

  - 实现连接管理、浏览、上传下载、远程基础文件操作、凭据管理。
  - 负责 remote_core 与连接设置界面。

  9. Agent I - Shortcuts & Settings

  - 实现快捷键绑定、冲突校验、设置界面、自定义右键动作配置。
  - 负责 JSON/TOML UI 配置与全局设置读写。

  10. 主 Agent - 集成与重构

  - 统一视觉与交互规范。
  - 解决跨 Agent 契约冲突。
  - 执行端到端回归、性能优化和最终文档整理。

  ### 5. TDD 与验收测试

  - 单元测试：
      - 路径标准化、本地/远程 location 解析、规则匹配、标签映射、列配置持久化。
      - 文件操作冲突处理、搜索过滤、快捷键冲突检测、任务队列状态机。
  - 组件测试：
      - 面板切换、Tab 激活、分割条拖拽、目录树展开、列显示切换、搜索面板交互。
  - 集成测试：
      - 本地目录浏览到复制/删除/重命名全链路。
      - 书签、热表、标签定位、着色规则生效。
      - 自定义右键菜单与 Ctrl + 右键 分流。
      - FTP/SFTP 连接、浏览、上传下载、远程重命名与删除。
  - 端到端测试：
      - 启动恢复上次布局和标签页。
      - Tab 顺序切换面板。
      - 前进/后退/上一级/下一级导航。
      - 大目录滚动与快速切换时 UI 不冻结。
  - 性能验收：
      - 10k+ 文件目录列表仍可流畅滚动。
      - 搜索和文件操作在后台任务中可取消且 UI 保持响应。
      - 图标提取、目录树展开、远程目录切换均采用异步批处理。
  - 交付文档：
      - 一份产品/技术详细设计文档。
      - 一份 IPC 契约文档。
      - 一份测试矩阵与 TDD 进度文档。

  - 从空仓库开始，不复用现有业务代码。
  - 目标平台固定为 Windows 11，不承诺 Windows 10 行为一致性。
  - 搜索首版不做后台索引器；如后续要全文高性能搜索，再追加索引服务。
  - 远程功能首版为“基础远程文件管理”，不做同步中心、断点续传编排、远程协同编辑。
  - 原生系统右键菜单以“尽量原生、失败回退”为准，不要求完全复制 Explorer 的全部边缘行为。
  - 所有实现阶段均由多个子 Agent 并行开发，但每个 Agent 只能在明确边界内改动，最终由主 Agent 集成。