# WenjianGuanliqi 详细设计

## 1. 产品定位
- 平台：Windows 11
- 技术栈：Tauri v2、Rust、React、TypeScript
- 交互风格：参考 Directory Opus 的高密度效率型布局，同时保留 Windows 用户熟悉的导航方式和视觉节奏
- 核心目标：在保证响应速度的前提下，提供多面板、多标签、强规则驱动和远程文件管理能力

## 2. 架构概览
- 前端负责布局、状态编排、焦点模型、快捷键、规则编辑器和配置界面
- Rust 后端负责本地文件系统操作、搜索、远程协议接入、Windows Shell 集成和数据持久化
- 前后端通过 typed command/event 通信，所有耗时操作都放到后台任务队列，避免阻塞 UI

## 3. 核心领域模型
### 3.1 面板与标签
- `PanelLayoutMode`：`single | dual | triple | quad`
- `PanelState`：每个面板的尺寸、焦点、标签集合、活动标签
- `TabState`：当前位置、历史记录、视图模式、筛选器、选中项、列配置

### 3.2 文件与规则
- `LocationDescriptor`：统一描述本地与远程位置
- `EntryViewModel`：名称、类型、大小、修改时间、属性、扩展名、颜色规则结果、标签集合
- `ColorRule`：按类型、扩展名、隐藏属性、自定义表达式着色
- `EntryTag`：文件/目录与标签的映射
- `ColumnPreset`：详情视图列集合与顺序

### 3.3 配置与元数据
- 用户界面和布局：TOML
- 结构化业务数据：当前实现以 JSON 存储，接口按可替换持久层设计，为后续切换 SQLite 预留边界
- 远程连接配置：连接元数据持久化，凭据优先走 Windows Credential Manager

## 4. 模块拆分
### 4.1 Rust 后端
- `commands.workspace`：工作区初始化、目录列举、目录树、布局保存
- `commands.operations`：复制、移动、删除、重命名、新建文件夹
- `commands.search`：名称搜索、内容搜索、取消与事件流
- `commands.settings`：书签、热表、标签、颜色规则、列配置、快捷键
- `commands.remote`：FTP/SFTP 连接管理与远程目录浏览
- `commands.shell`：Windows 原生右键菜单桥接与图标/关联信息
- `services.fs_service`：本地文件系统抽象
- `services.metadata_store`：元数据持久化与缓存
- `services.settings_store`：布局和 UI 设置
- `services.search_service`：后台搜索任务
- `services.remote_service`：远程协议适配层

### 4.2 React 前端
- `workspace`：应用壳、面板布局、分割条、标签栏
- `navigation`：地址栏、面包屑、目录树、书签热表
- `listing`：详情视图、列显示、着色、标签、上下文菜单
- `search`：搜索面板、搜索历史、结果跳转
- `settings`：快捷键、右键菜单、列模板、规则编辑
- `lib`：typed IPC、平台适配、格式化工具

## 5. 交互设计要点
- 多面板布局支持实时拖拽调整尺寸，采用比例存储，窗口变化时自适应
- 标签与面板焦点分离，键盘导航始终有明确活动面板
- 文件列表使用虚拟滚动，目录树采用懒加载
- 普通右键优先请求系统菜单，`Ctrl + 右键` 强制打开自定义菜单
- 搜索结果双击后定位到对应面板或新开标签

## 6. 性能原则
- 大目录读取按批次返回
- 图标与扩展信息异步加载
- 搜索、复制和移动进入后台任务并支持取消
- 规则匹配结果做短期缓存，路径变化后局部失效

## 7. 测试策略
- 前端：Vitest + Testing Library，覆盖布局 reducer、焦点切换、设置编辑与主要交互
- 后端：Rust 单元测试覆盖路径解析、规则匹配、搜索过滤、元数据存取
- 集成：目录浏览、文件操作、布局恢复、搜索事件流

## 8. 首轮实现范围
- 本地文件管理核心链路全量可用
- 多面板/多标签工作区可用
- 搜索、书签、热表、标签、着色规则、列配置可用
- 远程 FTP/SFTP 和系统右键菜单先交付可替换适配器与 Windows-only 实现骨架
