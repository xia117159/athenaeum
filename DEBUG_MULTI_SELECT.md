# 多选功能调试指南

## 已添加的调试日志

### 1. FileListing.tsx
- **Ctrl+A 处理**（第 481-494 行）
  ```
  [FileListing] Ctrl+A detected, onSelectAll: [function]
  [FileListing] Calling onSelectAll
  ```

- **Shift+点击处理**（第 753-763 行）
  ```
  [FileListing] Shift+Click detected, from: [id] to: [id], onSelectRange: [function]
  [FileListing] Calling onSelectRange
  ```

- **点击空白取消选择**（第 1104-1121 行）
  ```
  [FileListing] Mouse down on blank area, onClearSelection: [function], selectedEntryIds: [array]
  [FileListing] Calling onClearSelection
  ```

- **框选功能**（第 1123-1193 行）
  ```
  [FileListing] Starting marquee selection, onSelectMultiple: [function]
  [FileListing] Marquee selected IDs: [array]
  [FileListing] Calling onSelectMultiple with [n] items
  ```

### 2. useWorkspaceController.ts（第 2165-2180 行）
```
[useWorkspaceController] selectMultipleEntries called with: [array]
[useWorkspaceController] selectAllEntries called for panelId: [id] tabId: [id]
[useWorkspaceController] selectEntryRange called from: [id] to: [id]
[useWorkspaceController] clearSelection called for panelId: [id] tabId: [id]
```

### 3. workspaceReducer.ts（第 1415-1481 行）
```
[workspaceReducer] entrySelectionSet: {payload}
[workspaceReducer] entryRangeSelected: {payload}
[workspaceReducer] allEntriesSelected: {payload}
[workspaceReducer] entrySelectionCleared: {payload}
```

## 调试步骤

### 第一步：启动应用并打开浏览器开发者工具
1. 停止当前运行的开发服务器
2. 运行 `npm run dev`
3. 在应用窗口中按 `F12` 打开开发者工具
4. 切换到 Console 标签

### 第二步：测试 Ctrl+A
1. 在文件列表中按 `Ctrl+A`
2. 查看 Console 输出：
   - **期望看到**：
     ```
     [FileListing] Ctrl+A detected, onSelectAll: function
     [FileListing] Calling onSelectAll
     [useWorkspaceController] selectAllEntries called for panelId: panel-1 tabId: ...
     [workspaceReducer] allEntriesSelected: {...}
     ```
   - **如果看不到任何输出**：说明键盘事件没有被捕获
   - **如果只看到第一行**：说明 `onSelectAll` 是 undefined
   - **如果看到前两行但没有后续**：说明 action 方法没有被调用

### 第三步：测试 Shift+点击
1. 点击文件 A
2. 按住 Shift，点击文件 C
3. 查看 Console 输出：
   - **期望看到**：
     ```
     [FileListing] Shift+Click detected, from: [id-A] to: [id-C], onSelectRange: function
     [FileListing] Calling onSelectRange
     [useWorkspaceController] selectEntryRange called from: [id-A] to: [id-C]
     [workspaceReducer] entryRangeSelected: {...}
     ```

### 第四步：测试点击空白取消
1. 选中一些文件
2. 点击文件列表空白区域
3. 查看 Console 输出：
   - **期望看到**：
     ```
     [FileListing] Mouse down on blank area, onClearSelection: function, selectedEntryIds: [...]
     [FileListing] Calling onClearSelection
     [useWorkspaceController] clearSelection called for panelId: ... tabId: ...
     [workspaceReducer] entrySelectionCleared: {...}
     ```

### 第五步：测试框选
1. 在文件列表空白处按下鼠标
2. 拖动鼠标
3. 查看 Console 输出：
   - **期望看到**：
     ```
     [FileListing] Starting marquee selection, onSelectMultiple: function
     [FileListing] Marquee selected IDs: [...]
     [FileListing] Calling onSelectMultiple with [n] items
     [useWorkspaceController] selectMultipleEntries called with: [...]
     [workspaceReducer] entrySelectionSet: {...}
     ```

## 可能的问题场景

### 场景 1：没有任何日志输出
**原因**：事件监听器没有正确注册
**解决**：检查组件是否正确渲染，useEffect 是否执行

### 场景 2：只有 FileListing 日志，没有后续
**原因**：回调函数是 undefined 或 actions 没有正确连接
**解决**：检查 WorkspaceView.tsx 是否传递了 props

### 场景 3：有 useWorkspaceController 日志，但没有 reducer 日志
**原因**：dispatch 没有触发或 action type 不匹配
**解决**：检查 action type 字符串是否完全匹配

### 场景 4：所有日志都有，但 UI 没有更新
**原因**：reducer 更新了 state，但组件没有重新渲染
**解决**：检查 selectedEntryIds 是否正确传递给 FileListing

## 根据日志输出定位问题

请运行应用并测试，然后将 Console 中的完整日志输出提供给我，我会根据日志判断问题所在。
