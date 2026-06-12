# 文件列表多选和框选功能实现总结

## 功能概述

为文件管理器的 Tab 文件列表实现了完整的鼠标框选和多选功能，提供了类似 Windows 资源管理器的交互体验。

## 实现的功能

### 1. 鼠标框选（Marquee Selection）
- ✅ 鼠标按下并拖动出现矩形框选区域
- ✅ 框选区域与列表项相交即选中（intersection-based）
- ✅ 实时更新框选区域和选中状态
- ✅ 框选独立模式：只有按住鼠标拖动才触发框选，不影响普通点击

### 2. 多选功能
- ✅ **Ctrl+A** 全选当前目录所有文件/文件夹
- ✅ **Shift+点击** 范围多选：从上次点击到当前点击之间的所有项
- ✅ **Ctrl+点击** 切换单个项的选中状态
- ✅ **鼠标左键点击** 任何位置取消多选（包括空白区域）

### 3. 视图兼容性
- ✅ 支持所有视图模式：
  - 详细信息列表（details）
  - 列表（list）
  - 小图标（small-icons）
  - 中等图标（medium-icons）
  - 大图标（large-icons）
  - 超大图标（extra-large-icons）
  - 平铺（tiles）
  - 内容（content）

### 4. 统一判定逻辑
- ✅ 基于列表项的实际渲染边界进行框选判定
- ✅ 自动适配不同视图模式的布局

## 技术实现

### 1. 状态管理（workspaceReducer.ts）

新增 5 个 Redux actions：

```typescript
// 全选
{ type: "allEntriesSelected"; payload: { panelId: PanelId; tabId: string } }

// 清空选择
{ type: "entrySelectionCleared"; payload: { panelId: PanelId; tabId: string } }

// 设置特定的选中项列表（用于框选）
{ type: "entrySelectionSet"; payload: { panelId: PanelId; tabId: string; entryIds: string[] } }

// 范围选择
{ type: "entryRangeSelected"; payload: { panelId: PanelId; tabId: string; fromEntryId: string; toEntryId: string } }

// 原有的切换选择（保持兼容）
{ type: "entrySelectionChanged"; payload: { panelId: PanelId; tabId: string; entryId: string; multi: boolean } }
```

新增辅助函数：

```typescript
// 计算范围选择的条目 IDs
function selectEntryRange(entries: { id: string }[], fromEntryId: string, toEntryId: string): string[]
```

### 2. UI 组件（FileListing.tsx）

#### 新增状态

```typescript
// 框选状态
const [marqueeSelection, setMarqueeSelection] = useState<MarqueeSelection>({
  active: boolean;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
});

// 记录上次点击的条目（用于 Shift 范围选择）
const lastClickedEntryIdRef = useRef<string | null>(null);

// 滚动容器引用（用于框选计算）
const scrollContainerRef = useRef<HTMLDivElement | null>(null);
```

#### 框选逻辑

1. **开始框选**：`handleListingMouseDown`
   - 检测鼠标左键在空白区域按下
   - 记录起始坐标
   - 启动框选状态

2. **框选过程**：`handleMouseMove`
   - 更新框选矩形坐标
   - 计算与每个列表项的相交
   - 实时更新选中状态

3. **结束框选**：`handleMouseUp`
   - 清除框选状态
   - 移除事件监听器

#### 范围选择逻辑

在 `buildEntryHandlers` 中处理 Shift+点击：

```typescript
if (event.shiftKey && lastClickedEntryIdRef.current) {
  // 计算从上次点击到当前点击之间的所有项
  const rangeIds = sortedEntries.slice(startIndex, endIndex + 1).map((e) => e.id);
  // 触发范围选择事件
  window.dispatchEvent(new CustomEvent("file-listing-range-select", { detail: { panelId, tabId, entryIds: rangeIds } }));
}
```

#### 框选矩形渲染

```tsx
{marqueeSelection.active && (
  <div
    className="file-listing__marquee"
    style={{
      position: "fixed",
      left: Math.min(marqueeSelection.startX, marqueeSelection.currentX),
      top: Math.min(marqueeSelection.startY, marqueeSelection.currentY),
      width: Math.abs(marqueeSelection.currentX - marqueeSelection.startX),
      height: Math.abs(marqueeSelection.currentY - marqueeSelection.startY),
      border: "1px solid #0078d4",
      backgroundColor: "rgba(0, 120, 212, 0.1)",
      pointerEvents: "none",
      zIndex: 1000
    }}
  />
)}
```

### 3. 控制器（useWorkspaceController.ts）

通过自定义事件连接 UI 和状态管理：

```typescript
// 监听文件列表触发的自定义事件
window.addEventListener("file-listing-select-all", handleFileListingSelectAll);
window.addEventListener("file-listing-range-select", handleFileListingRangeSelect);
window.addEventListener("file-listing-marquee-select", handleFileListingMarqueeSelect);

// 事件处理函数
const handleFileListingSelectAll = (event: Event) => {
  const { panelId, tabId } = customEvent.detail;
  dispatch({ type: "allEntriesSelected", payload: { panelId, tabId } });
};

const handleFileListingRangeSelect = (event: Event) => {
  const { panelId, tabId, entryIds } = customEvent.detail;
  dispatch({ type: "entrySelectionSet", payload: { panelId, tabId, entryIds } });
};

const handleFileListingMarqueeSelect = (event: Event) => {
  const { panelId, tabId, entryIds } = customEvent.detail;
  dispatch({ type: "entrySelectionSet", payload: { panelId, tabId, entryIds } });
};
```

## 测试覆盖

### 单元测试（workspaceReducer.test.ts）

新增 5 个测试用例，全部通过：

1. ✅ `workspaceReducer selects all entries with allEntriesSelected action`
2. ✅ `workspaceReducer clears all selection with entrySelectionCleared action`
3. ✅ `workspaceReducer selects range of entries with entryRangeSelected action`
4. ✅ `workspaceReducer sets specific entry ids with entrySelectionSet action`
5. ✅ 保持原有的 `workspaceReducer clears the previously focused panel selection when focus changes` 测试通过

### 集成测试

- ✅ 所有现有的 FileListing 测试保持通过
- ✅ 编译成功，无 TypeScript 错误
- ✅ 所有 workspace 相关测试通过

## 用户交互流程

### 场景 1：框选多个文件
1. 用户在文件列表空白处按下鼠标左键
2. 拖动鼠标，出现蓝色半透明框选矩形
3. 与框选区相交的文件/文件夹实时高亮
4. 释放鼠标，选中所有相交的项

### 场景 2：Shift 范围选择
1. 用户点击文件 A
2. 按住 Shift 键，点击文件 C
3. 文件 A、B、C 全部被选中

### 场景 3：Ctrl 多选
1. 用户点击文件 A（选中 A）
2. 按住 Ctrl，点击文件 C（A 和 C 都选中）
3. 按住 Ctrl，再次点击文件 A（取消选中 A，只剩 C 选中）

### 场景 4：Ctrl+A 全选
1. 用户按下 Ctrl+A
2. 当前目录所有文件和文件夹被选中

### 场景 5：取消选择
1. 用户在任何空白处单击鼠标左键
2. 所有选中状态被清除

## 设计决策

### 1. 为什么使用自定义事件？
- React 组件层级深，通过 props 传递复杂选择逻辑会导致 prop drilling
- 自定义事件提供了解耦的通信方式
- 保持了单向数据流：UI → Event → Controller → Reducer → UI

### 2. 为什么框选判定用相交而非完全包含？
- 符合 Windows 资源管理器的行为习惯
- 用户体验更好：部分框选即可选中
- 避免用户需要精确框选整个条目

### 3. 为什么记录 lastClickedEntryId？
- 支持 Shift 范围选择的锚点机制
- 与 Windows 资源管理器行为一致
- 提供更直观的多选体验

## 性能优化

1. **框选节流**：只在鼠标移动时更新，避免过度渲染
2. **事件委托**：使用全局事件监听器，避免为每个条目添加监听器
3. **条件渲染**：只在 `marqueeSelection.active` 时渲染框选矩形
4. **清理函数**：正确清理所有事件监听器，避免内存泄漏

## 样式说明

框选矩形样式：
- 边框：`1px solid #0078d4`（Windows 蓝色）
- 背景：`rgba(0, 120, 212, 0.1)`（半透明蓝色）
- `pointerEvents: none`：避免干扰鼠标事件
- `position: fixed`：相对视口定位
- `zIndex: 1000`：确保在所有内容之上

## 后续改进建议

1. **性能优化**
   - 使用虚拟滚动时的框选优化
   - 使用 requestAnimationFrame 优化框选动画

2. **功能增强**
   - 支持键盘导航（上下箭头 + Shift）
   - 支持 Ctrl+Space 切换选中状态
   - 记忆上次选择的锚点

3. **可访问性**
   - 添加 ARIA 属性标注选中状态
   - 键盘快捷键的屏幕阅读器支持

## 文件清单

修改的文件：
1. `src/features/workspace/workspaceReducer.ts` - 新增 5 个 actions
2. `src/features/workspace/FileListing.tsx` - 实现框选和多选 UI
3. `src/features/workspace/useWorkspaceController.ts` - 连接事件和 actions
4. `src/features/workspace/workspaceReducer.test.ts` - 新增测试用例

新增的文件：
1. `FEATURE_MULTI_SELECT.md` - 本文档

## 总结

本次实现完整地为文件管理器添加了现代文件管理器必备的多选和框选功能，所有功能点均已实现并通过测试。代码遵循项目现有的架构模式，保持了良好的可维护性和扩展性。
