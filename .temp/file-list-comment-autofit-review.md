# 审查报告：文件列表注释返回与列宽自动调整

> 生成时间：2026-06-28
> 审查范围：`list_directory` 注释字段返回 `null` 问题 + 自动调整列宽不按实际内容测量问题

---

## 1. 摘要结论

| 问题 | 根因类型 | 严重程度 | 结论 |
|------|----------|----------|------|
| `list_directory` 返回 `comment: null` | **路径 key 不匹配（Windows verbatim path `\\?\` 前缀）** | 高 | 后端 `metadata_path_key` 未剥离 `\\?\` 前缀，导致保存时用的非 verbatim 路径与列表查询时用的 verbatim 路径产生不同 key |
| 自动调整列宽不符合预期 | **估算方式为字符计数启发式，非 DOM/Canvas 实测** | 中 | `estimateAutoFitColumnWidth` 使用 `getTextMeasureUnits` 字符宽度估算 + 固定 7px/单位，未考虑实际字体渲染宽度 |

两个问题均不需要立即修复即可保证主路径可运行，但问题一会直接导致用户保存的注释在列表中不可见，建议尽快修复。

---

## 2. 问题一：`list_directory.comment === null`

### 2.1 现象

- 用户通过注释编辑窗口（`CommentWindowView`）保存注释后，`list_directory` 返回的条目 `comment` 字段仍为 `null`。
- 但 `get_entry_comment` 命令能正确返回已保存的注释内容（注释编辑窗口加载时能读到）。
- 说明注释已成功写入 `MetadataStore.entry_comments`，但 `list_directory` 查询时无法命中。

### 2.2 根因

**Windows verbatim path 前缀 `\\?\` 导致 metadata path key 不匹配。**

完整链路追踪如下：

#### 保存路径（前端 → 后端）

1. 前端 `mapEntryViewModel`（`workspaceMappers.ts:550-555`）对后端返回的 `entry.path` 调用 `normalizeLocationPath(entry.path)`：
   ```ts
   // mockData.ts:673-677
   const withoutVerbatimPrefix = trimmed
     .replace(/^\\\\\?\\UNC\\/i, "\\\\")
     .replace(/^\\\\\?\\/, "")   // ← 剥离 \\?\ 前缀
     .replace(/^\\\?\\/, "")
     .replace(/^\\\\\.\\/, "");
   ```
   后端返回的 `entry.path` 是 verbatim 路径 `\\?\C:\Users\...\file.txt`，经 `normalizeLocationPath` 后变为 `C:\Users\...\file.txt`（非 verbatim）。

2. 前端 `CommentWindowView`（`CommentWindowView.tsx:119`）调用 `saveWorkspaceEntryComment(params.path, draft)`，其中 `params.path` 来自 URL 参数，是**非 verbatim** 路径。

3. 后端 `save_entry_comment`（`settings.rs:352-370`）调用 `metadata.upsert_entry_comment(&path, comment, now)`。

4. `upsert_entry_comment`（`metadata_store.rs:383-408`）存储时用 `metadata_path_key(path)` 计算 key：
   ```rust
   // metadata_store.rs:497-503
   fn metadata_path_key(path: &str) -> String {
       let trimmed = path.trim();
       if let Some(remote_key) = remote_metadata_path_key(trimmed) {
           return remote_key;
       }
       normalize_path(Path::new(trimmed))
   }
   ```
   ```rust
   // metadata_store.rs:488-495
   fn normalize_path(path: &Path) -> String {
       let rendered = path.to_string_lossy();
       if cfg!(windows) {
           rendered.to_lowercase()   // ← 仅小写，不剥离 \\?\ 前缀
       } else {
           rendered.into_owned()
       }
   }
   ```
   **保存 key** = `normalize_path("C:\Users\...\file.txt")` = `c:\users\...\file.txt`

#### 查询路径（list_directory）

5. 后端 `list_directory`（`workspace.rs:62-78`）调用 `fs_service::list_directory`，传入闭包 `|entry_path| { (metadata.tags_for_path(entry_path), metadata.comment_for_path(entry_path)) }`。

6. `fs_service::list_directory`（`fs_service.rs:230-268`）：
   ```rust
   // fs_service.rs:238-242
   let canonical = if path.exists() {
       path.canonicalize().unwrap_or_else(|_| path.to_path_buf())  // ← Windows 上返回 \\?\C:\...
   } else {
       path.to_path_buf()
   };
   ```
   ```rust
   // fs_service.rs:245-251
   for entry in fs::read_dir(&canonical)... {
       let entry_path = entry.path();  // ← \\?\C:\Users\...\file.txt (verbatim)
       let (tags, comment) = metadata_for_path(&entry_path.to_string_lossy());
       ...
   }
   ```
   `entry_path.to_string_lossy()` = `\\?\C:\Users\...\file.txt`（**verbatim**）。

7. `comment_for_path`（`metadata_store.rs:375-381`）用 `metadata_path_key` 查找：
   **查询 key** = `normalize_path("\\?\C:\Users\...\file.txt")` = `\\?\c:\users\...\file.txt`

#### Key 对比

| 操作 | 输入路径 | `metadata_path_key` 结果 |
|------|----------|--------------------------|
| 保存（save_entry_comment） | `C:\Users\...\file.txt` | `c:\users\...\file.txt` |
| 查询（list_directory） | `\\?\C:\Users\...\file.txt` | `\\?\c:\users\...\file.txt` |

**两个 key 不匹配** → `comment_for_path` 返回 `None` → 序列化为 `null`。

#### 为什么 `get_entry_comment` 能正确返回

`get_entry_comment`（`settings.rs:343-349`）接收前端传入的**非 verbatim** 路径 `C:\Users\...\file.txt`，用 `metadata_path_key` 计算 key = `c:\users\...\file.txt`，与保存 key 一致 → 命中。

### 2.3 影响范围

- **注释字段**：`list_directory` 返回的所有本地条目 `comment` 均为 `null`，前端列表中注释列显示 `--`。
- **标签字段**：`tags_for_path`（`metadata_store.rs:353-373`）使用相同的 `metadata_path_key`，因此**标签也存在同样的 key 不匹配问题**。前端保存的标签在 `list_directory` 返回时也会丢失（`decoration.tags` 为空数组）。
- **远程路径不受影响**：远程路径（`ftp://`、`sftp://`）走 `remote_metadata_path_key` 分支，不经过 `normalize_path`，无此问题。
- **`initialize_workspace`**（`workspace.rs:17-59`）也调用 `fs_service::list_directory`，存在同样问题（首次加载也看不到注释）。

### 2.4 涉及文件/行号

| 文件 | 行号 | 说明 |
|------|------|------|
| `src-tauri/src/services/metadata_store.rs` | 488-495 | `normalize_path` 函数：仅小写，未剥离 `\\?\` 前缀 — **根因所在** |
| `src-tauri/src/services/metadata_store.rs` | 497-503 | `metadata_path_key` 函数：调用 `normalize_path` |
| `src-tauri/src/services/metadata_store.rs` | 375-381 | `comment_for_path`：用 `metadata_path_key` 查找 |
| `src-tauri/src/services/metadata_store.rs` | 353-373 | `tags_for_path`：同样受影响 |
| `src-tauri/src/services/metadata_store.rs` | 383-408 | `upsert_entry_comment`：用 `metadata_path_key` 存储 |
| `src-tauri/src/services/fs_service.rs` | 238-242 | `list_directory`：`canonicalize()` 产生 verbatim 路径 |
| `src-tauri/src/services/fs_service.rs` | 245-251 | `entry.path()` 从 verbatim 目录产生 verbatim 条目路径 |
| `src-tauri/src/commands/workspace.rs` | 62-78 | `list_directory` 命令：传入闭包调用 `comment_for_path` |
| `src-tauri/src/commands/settings.rs` | 352-370 | `save_entry_comment` 命令：接收前端非 verbatim 路径 |
| `src/features/workspace/mockData.ts` | 650-683 | `normalizeLocationPath`：剥离 `\\?\` 前缀 |
| `src/features/workspace/workspaceMappers.ts` | 550-555 | `mapEntryViewModel`：对 `entry.path` 调用 `normalizeLocationPath` |
| `src/features/workspace/CommentWindowView.tsx` | 87, 119 | 注释窗口加载/保存使用 `params.path`（非 verbatim） |

### 2.5 推荐修复方案

**最佳方案：在 `metadata_store.rs` 的 `normalize_path` 中剥离 Windows verbatim 前缀。**

这样无论传入 verbatim 还是非 verbatim 路径，都能产生一致的 key，从根源上消除不匹配。

```rust
// metadata_store.rs - 修复后的 normalize_path
fn normalize_path(path: &Path) -> String {
    let rendered = path.to_string_lossy();
    let stripped = strip_verbatim_prefix(&rendered);
    if cfg!(windows) {
        stripped.to_lowercase()
    } else {
        stripped
    }
}

fn strip_verbatim_prefix(path: &str) -> String {
    // 剥离 Windows verbatim 路径前缀，确保 key 一致
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", rest);
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    if let Some(rest) = path.strip_prefix(r"\\.\") {
        return rest.to_string();
    }
    path.to_string()
}
```

**为什么不改前端 `normalizeLocationPath` 或后端 `fs_service`：**
- 前端剥离 `\\?\` 是正确的 UI 行为（用户不应看到 verbatim 路径）。
- `fs_service::list_directory` 的 canonicalize 是必要的（处理符号链接、相对路径、大小写归一化）。
- 在 `metadata_store` 层统一归一化是最小改动且覆盖所有调用方（save、get、list、delete、mark_deleted）。

### 2.6 建议测试

**Rust 测试**（`metadata_store.rs` 的 `#[cfg(test)] mod tests`）：

```rust
#[test]
fn comment_lookup_matches_regardless_of_verbatim_prefix() {
    let mut store = MetadataStore::default();
    let display_path = r"C:\Data\notes.txt";
    let verbatim_path = r"\\?\C:\Data\notes.txt";

    // 用非 verbatim 路径保存
    store.upsert_entry_comment(display_path, "Test note", chrono::Utc::now);

    // 用 verbatim 路径查询（模拟 list_directory 的行为）
    assert_eq!(
        store.comment_for_path(verbatim_path),
        Some("Test note".to_string())
    );

    // 反向：用 verbatim 保存，非 verbatim 查询
    store.upsert_entry_comment(verbatim_path, "Updated", chrono::Utc::now);
    assert_eq!(
        store.comment_for_path(display_path),
        Some("Updated".to_string())
    );
}

#[test]
fn tags_lookup_matches_regardless_of_verbatim_prefix() {
    // 类似测试，验证 tags_for_path 也兼容 verbatim 前缀
}
```

**集成测试**（`fs_service.rs` 的 `#[cfg(test)] mod tests`）：

```rust
#[test]
fn list_directory_hydrates_comment_from_non_verbatim_save() {
    // 1. 创建临时目录和文件
    // 2. 用非 verbatim 路径调用 upsert_entry_comment
    // 3. 调用 list_directory，验证返回的 entry.comment == Some("...")
}
```

---

## 3. 问题二：自动调整列宽不按实际内容测量

### 3.1 现象

- 点击列头右键菜单中的"立即自动调整列宽"后，列宽被调整为某个估算值，但该值与实际内容渲染宽度不符。
- 中文/英文混排、不同字体大小下偏差明显。
- 本质上是调整到"估算的固定宽度"而非"该列所有行中内容显示所需的最大宽度"。

### 3.2 当前实现分析

#### 触发位置

`FileListing.tsx:1555-1559`：
```ts
const autoFitVisibleColumns = () => {
  visibleColumns.forEach((column) => {
    onResizeColumn(column.id, estimateAutoFitColumnWidth(column, entries, currentPath));
  });
};
```

由列头右键菜单"立即自动调整列宽"按钮触发（`FileListing.tsx:1616`）。

#### 估算逻辑

`fileListingPresentation.tsx:310-319`：
```ts
export function estimateAutoFitColumnWidth(column: ColumnDefinition, entries: EntryViewModel[], currentPath: string) {
  const label = getColumnMenuLabel(column.id);
  const maxUnits = [label, ...entries.map((entry) => getDetailsCellText(entry, column.id, currentPath))]
    .map(getTextMeasureUnits)
    .reduce((max, units) => Math.max(max, units), 0);
  const iconAllowance = column.id === "name" ? 34 : 0;
  const minWidth = column.id === "name" ? 160 : ["created", "modified", "accessed"].includes(column.id) ? 132 : 80;
  const width = Math.min(520, Math.max(minWidth, Math.ceil(maxUnits * 7 + 28 + iconAllowance)));
  return `${width}px`;
}
```

字符宽度估算 `getTextMeasureUnits`（`fileListingPresentation.tsx:303-308`）：
```ts
function getTextMeasureUnits(value: string) {
  return Array.from(value).reduce((sum, char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return sum + (codePoint >= 0x2e80 ? 2 : 1);  // CJK 记 2，其他记 1
  }, 0);
}
```

#### 当前实现的具体问题

| 问题 | 说明 |
|------|------|
| **无 DOM/Canvas 实测** | 使用字符计数启发式，而非实际字体渲染测量 |
| **固定 7px/单位** | 不区分 "W"（宽）和 "i"（窄），所有非 CJK 字符都按 7px 计算 |
| **CJK 检测过于简单** | 仅判断 `codePoint >= 0x2e80`，漏掉部分全角字符（如全角标点 `．，：；` 在 0xFF00 区段），也误判部分非 CJK 宽字符 |
| **padding 魔法数 28** | 未从 CSS 实际 padding 推导（`.file-cell` 无显式 padding，但 `.file-row__grid` 有 `padding: 0 6px`，gap 为 `6px`） |
| **图标 allowance 固定 34** | 未考虑实际图标尺寸（CSS `--file-icon-size: 16px`）+ gap（`entry-name` gap 为 `6px`） |
| **无排序指示器 allowance** | 排序时表头有 `▲`/`▼`（`.file-header-button__indicator`），宽度未被考虑 |
| **无 resize handle allowance** | `.file-header-resizer` 宽 `8px`（绝对定位，`right: -4px`），虽然不影响内容区但可能影响视觉对齐 |
| **最大宽度 520px 硬上限** | 过长的注释/路径内容会被截断 |
| **标签列特殊渲染未考虑** | tags 列渲染为 `.tag-stack`（flex + 圆角标签），实际宽度远大于纯文本宽度 |
| **未考虑表头 vs 单元格字体差异** | 表头 `.file-cell--header` 有 `font-weight: 600`，同文字表头比单元格更宽 |

### 3.3 根因

`estimateAutoFitColumnWidth` 是一个纯函数，无法访问 DOM，只能用字符计数估算。它没有与实际渲染环境（字体、DPI、CSS padding）建立联系，因此无法准确反映内容真实显示宽度。

### 3.4 推荐实现方案

#### 方案 A：DOM 测量（推荐）

在组件层使用隐藏的测量元素（off-screen measuring element）或直接读取已渲染 DOM 元素的实际宽度：

```ts
// 组件层：autoFitVisibleColumns 改为 DOM 测量
const autoFitVisibleColumns = () => {
  const scrollContainer = scrollContainerRef.current;
  if (!scrollContainer) return;

  visibleColumns.forEach((column) => {
    // 1. 测量表头宽度
    const headerCell = scrollContainer.querySelector(
      `.file-header-cell[data-column-id="${column.id}"] .file-header-button`
    ) as HTMLElement | null;
    const headerWidth = headerCell?.scrollWidth ?? 0;

    // 2. 测量所有可见行的该列单元格宽度
    const cellWidths = Array.from(
      scrollContainer.querySelectorAll(`.file-cell[data-cell-column-id="${column.id}"]`)
    ).map((el) => (el as HTMLElement).scrollWidth);

    // 3. 取最大值 + padding 余量
    const maxWidth = Math.max(headerWidth, ...cellWidths);
    const padding = 16; // 左右各 8px 余量
    const finalWidth = clamp(getColumnHeaderMinWidth(column), maxWidth + padding, 960);
    onResizeColumn(column.id, `${finalWidth}px`);
  });
};
```

**优点**：准确反映实际渲染宽度，包括字体、padding、图标、标签等所有因素。
**缺点**：需要 DOM 已渲染（仅适用于非虚拟列表场景，当前项目无虚拟列表，可行）。

#### 方案 B：Canvas measureText

```ts
function measureTextWidth(text: string, font: string): number {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = font; // e.g. '600 12px "Microsoft YaHei UI", "Segoe UI", sans-serif'
  return ctx.measureText(text).width;
}
```

**优点**：不需要 DOM 渲染，可在纯函数中调用。
**缺点**：需要准确指定字体字符串；无法测量非文本元素（图标、标签 stack）；需要额外处理 padding/icon allowance。

#### 推荐：方案 A（DOM 测量）

理由：
1. 项目无虚拟列表，所有行均已渲染在 DOM 中，可直接测量。
2. DOM 测量天然包含所有 CSS 影响（字体、padding、图标、标签渲染），无需手动估算。
3. 表头和单元格使用不同字重，DOM 测量自动区分。

### 3.5 风险点

| 风险 | 缓解措施 |
|------|----------|
| **布局抖动** | 测量时不要修改 DOM 结构；仅在用户主动触发"自动调整"时执行；避免在每次 render 时测量 |
| **大量行时性能** | 对 1000+ 行目录，querySelectorAll 遍历所有单元格可能有性能开销。可限制只测量前 N 行（如前 200 行），或使用 `requestAnimationFrame` 分批测量 |
| **虚拟列表兼容** | 当前无虚拟列表。未来引入虚拟列表后，需改为"测量可见行 + 采样缓冲区行"策略 |
| **字体异步加载** | 如果使用 Web Font，首次测量可能在使用 fallback 字体时进行。可在 `document.fonts.ready` 后再测量 |
| **隐藏列** | 仅测量 `visibleColumns`，隐藏列不参与计算，不影响正确性 |
| **拖拽列顺序** | 列顺序变化后 DOM 重新排列，重新测量时自动适配 |

### 3.6 建议测试

当前测试（`FileListing.test.tsx:666-706`）的问题：

```ts
// 当前测试仅验证：
assert.deepEqual(resizedColumns.map((item) => item.columnId), ["name", "type", "size", "modified"]);
assert.equal(resizedColumns.every((item) => /^\d+px$/.test(item.width)), true);
assert.equal(Number.parseInt(resizedColumns[0].width, 10) > Number.parseInt(resizedColumns[1].width, 10), true);
// ← 仅检查 name > type 的相对大小，不验证宽度是否真正适配内容
```

**建议改进测试**：

1. **验证测量值与实际内容宽度一致**（DOM 测量方案）：
   ```ts
   // 设置已知内容宽度的条目，验证 auto-fit 后列宽 >= 最大单元格 scrollWidth
   ```

2. **验证中文/英文混排准确性**：
   ```ts
   // 条目名称包含中文长文本（如"项目管理配置文件备份_2026Q2.md"），
   // 验证 auto-fit 后列宽足够完整显示该文本（不出现 ellipsis）
   ```

3. **验证表头宽度参与计算**：
   ```ts
   // 当表头文字比所有单元格内容都长时，列宽应以表头宽度为依据
   ```

4. **验证最小/最大宽度约束**：
   ```ts
   // 空目录时列宽不低于 minWidth
   // 超长内容时列宽不超过 maxWidth
   ```

### 3.7 逻辑分层建议

| 层级 | 职责 |
|------|------|
| **组件层**（`FileListing.tsx`） | 触发 auto-fit、执行 DOM 测量、调用 `onResizeColumn` |
| **Reducer 层**（`workspaceReducerColumns.ts`） | 接收 `columnWidthChanged` action，执行 `setColumnWidth` 归一化和状态更新 |
| **展示层**（`fileListingPresentation.tsx`） | 提供 `getColumnHeaderMinWidth` 等纯函数辅助计算最小宽度约束；不再承载 `estimateAutoFitColumnWidth` 估算逻辑（如改用 DOM 测量则此函数可移除或仅保留 fallback） |

---

## 4. 优先级排序

| 优先级 | 问题 | 理由 |
|--------|------|------|
| **P0** | 问题一：注释返回 `null` | 用户保存的注释在列表中完全不可见，功能直接失效；且标签也受同样根因影响；修复范围小（仅 `normalize_path` 一处） |
| **P1** | 问题二：列宽自动调整 | 功能可用但不准确，不影响核心文件操作；修复需引入 DOM 测量，改动较大 |

---

## 5. 是否需要立即修复的判断

### 问题一：需要尽快修复

- **影响**：注释和标签在列表中完全不可见，用户保存后看不到效果。
- **修复成本**：低 — 仅需修改 `metadata_store.rs` 的 `normalize_path` 函数（约 10 行），加 2-3 个测试。
- **风险**：低 — 路径归一化是幂等操作，不会破坏已有数据。
- **建议**：在下一个开发周期内修复。

### 问题二：可排期修复

- **影响**：列宽估算不准，用户体验下降但不阻断操作。
- **修复成本**：中 — 需要在组件层引入 DOM 测量逻辑，可能需要重构 `estimateAutoFitColumnWidth`。
- **风险**：中 — DOM 测量涉及浏览器渲染时序，需处理布局抖动和性能问题。
- **建议**：作为独立改进任务排期，不与问题一混在同一 PR。

---

## 6. 建议的 TDD 步骤

### 问题一 TDD 步骤

```
1. [RED] 在 metadata_store.rs tests 中新增测试：
   - comment_lookup_matches_regardless_of_verbatim_prefix
   - tags_lookup_matches_regardless_of_verbatim_prefix
   → 编译失败或测试失败（当前 normalize_path 不剥离 \\?\ 前缀）

2. [GREEN] 修改 normalize_path，增加 strip_verbatim_prefix 逻辑：
   - 剥离 \\?\UNC\ → \\
   - 剥离 \\?\ → (empty)
   - 剥离 \\.\ → (empty)
   → 测试通过

3. [REFACTOR] 提取 strip_verbatim_prefix 为独立函数，保持可测试性

4. [验证] 运行：
   - cargo test --manifest-path src-tauri/Cargo.toml --offline
   - npm test（前端无改动，确认无回归）
   - npm run build
```

### 问题二 TDD 步骤

```
1. [RED] 在 FileListing.test.tsx 中新增测试：
   - autoFit_uses_dom_measurement_for_column_width
   - 准备已知宽度的中文/英文混排条目
   - 断言 auto-fit 后列宽 >= 实际单元格 scrollWidth（允许 padding 余量）
   → 当前使用 estimateAutoFitColumnWidth 估算，测试失败

2. [GREEN] 在 FileListing.tsx 的 autoFitVisibleColumns 中：
   - 改用 DOM 测量（scrollWidth / getBoundingClientRect）
   - 对每列取 max(headerWidth, maxCellWidth) + padding
   - clamp 到 [minWidth, maxWidth]
   → 测试通过

3. [REFACTOR] 提取 DOM 测量逻辑为独立 hook 或工具函数
   - 保留 estimateAutoFitColumnWidth 作为 SSR/无 DOM 环境的 fallback
   - 清理魔法数字，从 CSS 变量或常量推导 padding

4. [验证] 运行：
   - npm test
   - npm run build
   - 人工验证：npx tauri dev，在真实目录中测试中英文混排列宽
```

---

## 附录：关键代码引用索引

### 问题一相关

- `src-tauri/src/services/metadata_store.rs:488-495` — `normalize_path`（根因）
- `src-tauri/src/services/metadata_store.rs:497-503` — `metadata_path_key`
- `src-tauri/src/services/metadata_store.rs:375-381` — `comment_for_path`
- `src-tauri/src/services/metadata_store.rs:353-373` — `tags_for_path`（同样受影响）
- `src-tauri/src/services/fs_service.rs:238-242` — `canonicalize()` 产生 verbatim 路径
- `src-tauri/src/services/fs_service.rs:245-251` — `entry.path()` 产生 verbatim 条目路径
- `src-tauri/src/commands/workspace.rs:62-78` — `list_directory` 命令
- `src-tauri/src/commands/settings.rs:352-370` — `save_entry_comment` 命令
- `src/features/workspace/mockData.ts:650-683` — `normalizeLocationPath`（前端剥离 `\\?\`）
- `src/features/workspace/workspaceMappers.ts:550-555` — `mapEntryViewModel`
- `src/features/workspace/CommentWindowView.tsx:87,119` — 注释加载/保存

### 问题二相关

- `src/features/workspace/fileListingPresentation.tsx:303-308` — `getTextMeasureUnits`（字符计数估算）
- `src/features/workspace/fileListingPresentation.tsx:310-319` — `estimateAutoFitColumnWidth`（估算主逻辑）
- `src/features/workspace/fileListingPresentation.tsx:321-324` — `getColumnHeaderMinWidth`
- `src/features/workspace/fileListingPresentation.tsx:335-350` — `getDetailsGridMetrics`（网格布局计算）
- `src/features/workspace/FileListing.tsx:1555-1559` — `autoFitVisibleColumns`（触发入口）
- `src/features/workspace/FileListing.tsx:1612-1621` — 右键菜单"立即自动调整列宽"按钮
- `src/features/workspace/workspaceReducerColumns.ts:6-15` — `normalizeColumnWidth`（reducer 归一化）
- `src/features/workspace/workspaceReducerColumns.ts:17-31` — `setColumnWidth`（reducer 状态更新）
- `src/features/workspace/workspace.listing.css:57-62` — `.file-listing__header` / `.file-row__grid`（grid + gap:6px）
- `src/features/workspace/workspace.listing.css:352-358` — `.file-cell`（overflow:hidden + ellipsis）
- `src/features/workspace/workspace.listing.css:93-102` — `.file-header-resizer`（8px 宽）
- `src/features/workspace/FileListing.test.tsx:666-706` — auto-fit 测试（仅验证相对大小，不验证内容适配）
