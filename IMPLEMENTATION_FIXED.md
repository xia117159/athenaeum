# 文件列表多选和框选功能实现 - 修正版

## 问题分析

初次实现使用了自定义事件（CustomEvent）在组件间传递选择状态，但这导致了以下问题：
1. 事件处理逻辑分散，难以追踪
2. 回调函数没有正确连接到实际的 action
3. 功能在运行时无法正常工作

## 修正方案

改用标准的 React props 回调机制，直接将 action 分发函数作为 props 传递给组件。

## 实现的功能

### ✅ 1. 鼠标框选（Marquee Selection）
- 鼠标按下并拖动出现矩形框选区域
- 框选区域与列表项相交即选中
- 实时更新框选区域和选中状态
- 框选独立模式：不影响普通点击

### ✅ 2. Ctrl+A 全选
- 按下 Ctrl+A（或 Cmd+A）全选当前目录所有文件

### ✅ 3. Shift+点击范围选择
- 从上次点击到当前点击之间的所有项被选中

### ✅ 4. Ctrl+点击多选
- 切换单个项的选中状态（原有功能，保持兼容）

### ✅ 5. 点击空白处取消选择
- 点击文件列表空白区域清除所有选择

### ✅ 6. 所有视图模式支持
- details、list、small-icons、medium-icons、large-icons、extra-large-icons、tiles、content

## 技术实现

### 1. 组件接口（FileListing.tsx）

新增 5 个可选回调 props：

```typescript
interface FileListingShellProps {
  // ... 现有 props
  onSelect: (entry: EntryViewModel, multi: boolean) => void;
  onSelectMultiple?: (entryIds: string[]) => void;       // 批量选择（框选）
  onSelectAll?: () => void;                               // 全选
  onSelectRange?: (fromEntryId: string, toEntryId: string) => void; // 范围选择
  onClearSelection?: () => void;                          // 清空选择
  // ... 其他 props
}
```

### 2. 状态管理（workspaceReducer.ts）

新增 4 个 Redux actions：

```typescript
// 全选
{ type: "allEntriesSelected"; payload: { panelId, tabId } }

// 清空选择
{ type: "entrySelectionCleared"; payload: { panelId, tabId } }

// 批量设置（用于框选）
{ type: "entrySelectionSet"; payload: { panelId, tabId, entryIds } }

// 范围选择
{ type: "entryRangeSelected"; payload: { panelId, tabId, fromEntryId, toEntryId } }
```

辅助函数：

```typescript
function selectEntryRange(entries: { id: string }[], fromEntryId: string, toEntryId: string): string[] {
  const fromIndex = entries.findIndex((entry) => entry.id === fromEntryId);
  const toIndex = entries.findIndex((entry) => entry.id === toEntryId);

  if (fromIndex === -1 || toIndex === -1) {
    return [];
  }

  const startIndex = Math.min(fromIndex, toIndex);
  const endIndex = Math.max(fromIndex, toIndex);

  return entries.slice(startIndex, endIndex + 1).map((entry) => entry.id);
}
```

### 3. 控制器层（useWorkspaceController.ts）

在 actions 对象中添加新方法：

```typescript
const actions = {
  // ... 现有 actions
  selectEntry: (panelId, tabId, entryId, multi) =>
    dispatch({ type: "entrySelectionChanged", payload: { panelId, tabId, entryId, multi } }),
  
  selectMultipleEntries: (panelId, tabId, entryIds) =>
    dispatch({ type: "entrySelectionSet", payload: { panelId, tabId, entryIds } }),
  
  selectAllEntries: (panelId, tabId) =>
    dispatch({ type: "allEntriesSelected", payload: { panelId, tabId } }),
  
  selectEntryRange: (panelId, tabId, fromEntryId, toEntryId) =>
    dispatch({ type: "entryRangeSelected", payload: { panelId, tabId, fromEntryId, toEntryId } }),
  
  clearSelection: (panelId, tabId) =>
    dispatch({ type: "entrySelectionCleared", payload: { panelId, tabId } }),
  // ... 其他 actions
};
```

### 4. 视图层连接（WorkspaceView.tsx）

将 actions 连接到组件 props：

```tsx
<WorkspaceFileListingShell
  // ... 其他 props
  onSelect={(entry, multi) => actions.selectEntry(panel.id, activeTab.id, entry.id, multi)}
  onSelectMultiple={(entryIds) => actions.selectMultipleEntries(panel.id, activeTab.id, entryIds)}
  onSelectAll={() => actions.selectAllEntries(panel.id, activeTab.id)}
  onSelectRange={(fromId, toId) => actions.selectEntryRange(panel.id, activeTab.id, fromId, toId)}
  onClearSelection={() => actions.clearSelection(panel.id, activeTab.id)}
  // ... 其他 props
/>
```

### 5. UI 交互实现（FileListing.tsx）

#### 框选逻辑

```typescript
const handleListingMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
  if (event.button !== 0) return;
  
  const target = event.target as HTMLElement;
  if (target.closest("[data-entry-path]") || target.closest(".inline-edit-input")) {
    return;
  }

  // 清除选择
  if (onClearSelection && selectedEntryIds.length > 0) {
    onClearSelection();
  }

  // 开始框选
  const startX = event.clientX;
  const startY = event.clientY;
  
  setMarqueeSelection({ active: true, startX, startY, currentX: startX, currentY: startY });

  const handleMouseMove = (moveEvent: MouseEvent) => {
    setMarqueeSelection({
      active: true,
      startX,
      startY,
      currentX: moveEvent.clientX,
      currentY: moveEvent.clientY
    });

    // 计算相交的条目
    const selectedIds: string[] = [];
    const entryElements = scrollContainer.querySelectorAll("[data-entry-path]");

    entryElements.forEach((element) => {
      const entryRect = element.getBoundingClientRect();
      const marqueeRect = {
        left: Math.min(startX, moveEvent.clientX),
        top: Math.min(startY, moveEvent.clientY),
        right: Math.max(startX, moveEvent.clientX),
        bottom: Math.max(startY, moveEvent.clientY)
      };
      
      const intersects =
        marqueeRect.left < entryRect.right &&
        marqueeRect.right > entryRect.left &&
        marqueeRect.top < entryRect.bottom &&
        marqueeRect.bottom > entryRect.top;

      if (intersects) {
        const entryPath = (element as HTMLElement).dataset.entryPath;
        const entry = sortedEntries.find((e) => e.path === entryPath);
        if (entry && !entry.inlineCreate) {
          selectedIds.push(entry.id);
        }
      }
    });

    if (selectedIds.length > 0 && onSelectMultiple) {
      onSelectMultiple(selectedIds);
    }
  };

  const handleMouseUp = () => {
    setMarqueeSelection({ active: false, startX: 0, startY: 0, currentX: 0, currentY: 0 });
    window.removeEventListener("mousemove", handleMouseMove);
    window.removeEventListener("mouseup", handleMouseUp);
  };

  window.addEventListener("mousemove", handleMouseMove);
  window.addEventListener("mouseup", handleMouseUp);
};
```

#### Shift 范围选择

```typescript
onClick: (event: ReactMouseEvent<HTMLElement>) => {
  if (event.shiftKey && lastClickedEntryIdRef.current) {
    event.preventDefault();
    event.stopPropagation();
    if (onSelectRange) {
      onSelectRange(lastClickedEntryIdRef.current, entry.id);
    }
    return;
  }

  lastClickedEntryIdRef.current = entry.id;
  onSelect(entry, event.ctrlKey || event.metaKey);
}
```

#### Ctrl+A 全选

```typescript
useEffect(() => {
  const handleKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "a") {
      event.preventDefault();
      if (onSelectAll) {
        onSelectAll();
      }
    }
  };

  window.addEventListener("keydown", handleKeyDown);
  return () => window.removeEventListener("keydown", handleKeyDown);
}, [onSelectAll]);
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

## 测试覆盖

### 单元测试（workspaceReducer.test.ts）

新增 4 个测试用例，全部通过：

1. ✅ `workspaceReducer selects all entries with allEntriesSelected action`
2. ✅ `workspaceReducer clears all selection with entrySelectionCleared action`
3. ✅ `workspaceReducer selects range of entries with entryRangeSelected action`
4. ✅ `workspaceReducer sets specific entry ids with entrySelectionSet action`

### 编译验证

- ✅ TypeScript 编译成功，无错误
- ✅ 所有现有测试保持通过

## 使用方法

### 1. 框选文件
1. 鼠标在文件列表空白处按下
2. 拖动鼠标形成蓝色框选区
3. 与框选区相交的文件被选中
4. 释放鼠标完成选择

### 2. 全选文件
- 按 `Ctrl+A`（Windows/Linux）或 `Cmd+A`（Mac）

### 3. 范围选择
1. 点击文件 A
2. 按住 `Shift` 键，点击文件 C
3. 文件 A 到 C 之间的所有文件被选中

### 4. 多选切换
1. 点击文件 A（选中）
2. 按住 `Ctrl`，点击文件 C（A 和 C 都选中）
3. 按住 `Ctrl`，再次点击 A（取消选中 A）

### 5. 取消选择
- 点击文件列表任何空白区域

## 数据流

```
用户交互 → FileListing 组件
    ↓
回调函数（props）
    ↓
WorkspaceView actions
    ↓
useWorkspaceController dispatch
    ↓
workspaceReducer 处理 action
    ↓
更新 state.selectedEntryIds
    ↓
重新渲染 FileListing（高亮选中项）
```

## 设计优势

### 相比初始实现的改进

1. **类型安全**：TypeScript 完全检查回调参数类型
2. **代码可追踪**：数据流清晰，容易 debug
3. **性能更好**：直接函数调用，无事件系统开销
4. **更易维护**：符合 React 最佳实践

### 与 Windows 资源管理器的对齐

- ✅ 框选相交判定（不需要完全包含）
- ✅ Shift 范围选择
- ✅ Ctrl 多选切换
- ✅ Ctrl+A 全选
- ✅ 点击空白取消

## 文件清单

修改的文件：
1. `src/features/workspace/workspaceReducer.ts` - 新增 4 个 actions 和辅助函数
2. `src/features/workspace/FileListing.tsx` - 实现框选和多选 UI + 新增 props
3. `src/features/workspace/useWorkspaceController.ts` - 添加 5 个新 actions
4. `src/features/workspace/WorkspaceView.tsx` - 连接回调到 actions
5. `src/features/workspace/workspaceReducer.test.ts` - 新增 4 个测试用例

文档：
1. `IMPLEMENTATION_FIXED.md` - 本文档（修正版实现说明）
2. `FEATURE_MULTI_SELECT.md` - 原始功能说明文档

## 后续可测试的功能点

请在运行的应用中测试以下功能：

1. **框选测试**
   - [ ] 在空白处按下鼠标拖动，出现蓝色框选矩形
   - [ ] 与框选区相交的文件实时高亮
   - [ ] 释放鼠标后选中状态保持

2. **Ctrl+A 测试**
   - [ ] 按下 Ctrl+A，所有文件被选中
   - [ ] 选中数量显示正确

3. **Shift 范围选择测试**
   - [ ] 点击文件 A
   - [ ] Shift+点击文件 C
   - [ ] A 到 C 之间所有文件被选中

4. **Ctrl 多选测试**
   - [ ] Ctrl+点击文件 A（选中）
   - [ ] Ctrl+点击文件 C（A 和 C 都选中）
   - [ ] Ctrl+点击 A（取消选中 A）

5. **取消选择测试**
   - [ ] 选中一些文件
   - [ ] 点击空白处
   - [ ] 所有选择被清除

6. **视图模式测试**
   - [ ] 切换到不同视图模式
   - [ ] 框选和多选在所有模式下正常工作

## 总结

修正后的实现使用标准的 React props 回调机制，完全符合项目架构模式，所有单元测试通过，编译成功。现在功能应该可以在运行的应用中正常工作了。

请重新启动开发服务器并测试各项功能是否正常。
