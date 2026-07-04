import { type FormEvent, type KeyboardEvent, useRef } from "react";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { FileSystemIcon } from "./FileSystemIcon";
import { OperationHistoryPanelContent, OperationSummaryButton } from "./OperationTaskCenter";
import type { EntryViewModel, InformationPanelTab, ItemPropertyField, WorkspaceState } from "./types";

const SEARCH_TABS = ["名称和位置", "大小", "日期", "标签", "内容", "重复", "排除"] as const;
const INFORMATION_TABS: Array<{ id: InformationPanelTab; label: string }> = [
  { id: "properties", label: "属性" },
  { id: "search", label: "查找" },
  { id: "history", label: "操作历史" }
];

const FIELD_STATE_LABELS: Record<string, string> = {
  available: "可用",
  notAvailable: "不可用",
  unsupported: "服务器未提供",
  permissionDenied: "无权读取",
  readFailed: "无法读取",
  notComputed: "未计算",
  computing: "正在计算"
};

const DIRECTORY_SIZE_STATE_LABELS: Record<string, string> = {
  notApplicable: "不适用",
  notComputed: "未计算",
  computing: "正在计算",
  failed: "无法读取"
};

function formatBytes(value?: number | null) {
  if (value == null) {
    return "不可用";
  }
  if (value < 1024) {
    return `${Math.round(value)} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let current = value / 1024;
  let unitIndex = 0;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }

  return `${current >= 10 ? current.toFixed(0) : current.toFixed(1)} ${units[unitIndex]}`;
}

function formatDate(value?: string | null) {
  if (!value) {
    return "不可用";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "不可用";
  }
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function summarizeEntrySizes(entries: EntryViewModel[]) {
  let knownBytes = 0;
  let knownCount = 0;
  for (const entry of entries) {
    if (typeof entry.sizeBytes === "number") {
      knownBytes += entry.sizeBytes;
      knownCount += 1;
    }
  }

  if (entries.length === 0) {
    return "0 项";
  }

  if (knownCount === 0) {
    return `${entries.length} 项`;
  }

  return `${entries.length} 项，${formatBytes(knownBytes)}`;
}

function selectedNames(entries: EntryViewModel[]) {
  if (entries.length === 0) {
    return "未选择";
  }

  const names = entries.slice(0, 3).map((entry) => entry.name).join(", ");
  return entries.length > 3 ? `${names} +${entries.length - 3}` : names;
}

function kindLabel(kind?: EntryViewModel["kind"]) {
  return kind === "folder" ? "文件夹" : "文件";
}

function getFieldStateText(properties: WorkspaceState["informationPanel"]["properties"], field: ItemPropertyField) {
  const fieldState = properties.item?.fieldStates.find((item) => item.field === field);
  if (!fieldState) {
    return undefined;
  }
  return fieldState.message ?? FIELD_STATE_LABELS[fieldState.state] ?? fieldState.state;
}

function getCommonExtensionFromEntries(entries: EntryViewModel[]) {
  if (entries.length === 0 || entries.some((entry) => entry.kind !== "file" || !entry.extension)) {
    return undefined;
  }
  const extensions = new Set(entries.map((entry) => entry.extension));
  return extensions.size === 1 ? [...extensions][0] : undefined;
}

function formatMultiExtensionValue(entries: EntryViewModel[], commonExtension?: string) {
  if (commonExtension) {
    return commonExtension;
  }
  return entries.every((entry) => entry.kind === "file" && Boolean(entry.extension)) ? "多个值" : "不可用";
}

function formatDirectorySizeState(item?: WorkspaceState["informationPanel"]["properties"]["item"]) {
  if (!item || item.kind !== "folder") {
    return undefined;
  }
  if (item.directorySizeState.state === "available") {
    return formatBytes(item.directorySizeState.sizeBytes ?? item.sizeBytes ?? null);
  }
  if (item.directorySizeState.state === "notApplicable") {
    return undefined;
  }
  return DIRECTORY_SIZE_STATE_LABELS[item.directorySizeState.state] ?? item.directorySizeState.message ?? item.directorySizeState.state;
}

function PropertyRow({
  label,
  value,
  detail
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="properties-panel__row">
      <span>{label}</span>
      <strong title={detail ?? value}>{value}</strong>
    </div>
  );
}

function PropertiesStatusPanel({
  state,
  message
}: {
  state: "loading" | "failed";
  message?: string;
}) {
  const isFailed = state === "failed";
  return (
    <div className="properties-panel properties-panel--status">
      <div className={`properties-panel__status properties-panel__status--${state}`}>
        <strong>{isFailed ? "无法读取属性" : "正在读取属性"}</strong>
        <span>{isFailed ? message || "属性请求失败。" : "正在从文件系统读取所选项目的属性。"}</span>
      </div>
    </div>
  );
}

function PropertiesPanel({
  properties,
  activeEntries,
  selectedEntries
}: {
  properties: WorkspaceState["informationPanel"]["properties"];
  activeEntries: EntryViewModel[];
  selectedEntries: EntryViewModel[];
}) {
  if (properties.status === "loading") {
    return <PropertiesStatusPanel state="loading" />;
  }

  if (properties.status === "failed") {
    return <PropertiesStatusPanel state="failed" message={properties.errorMessage} />;
  }

  if (selectedEntries.length > 1) {
    const knownSizeBytes =
      properties.summary?.knownSizeBytes ??
      selectedEntries.reduce((sum, entry) => sum + (typeof entry.sizeBytes === "number" ? entry.sizeBytes : 0), 0);
    const unknownSizeCount =
      properties.summary?.unknownSizeCount ??
      selectedEntries.filter((entry) => typeof entry.sizeBytes !== "number").length;
    const directoryCount = properties.summary?.directoryCount ?? selectedEntries.filter((entry) => entry.kind === "folder").length;
    const parentPaths = new Set(selectedEntries.map((entry) => entry.parentPath));
    const kinds = new Set(selectedEntries.map((entry) => entry.kind));
    const commonExtension = properties.summary
      ? properties.summary.commonExtension
      : getCommonExtensionFromEntries(selectedEntries);

    return (
      <div className="properties-panel">
        <div className="properties-panel__identity">
          <span className="properties-panel__icon">
            <FileSystemIcon kind="folder" size={48} />
          </span>
          <div>
            <strong>已选择 {selectedEntries.length} 项</strong>
            <span>多选属性摘要</span>
          </div>
        </div>
        <div className="properties-panel__grid">
          <PropertyRow label="位置" value={parentPaths.size === 1 ? [...parentPaths][0] : "多个位置"} />
          <PropertyRow label="类型" value={kinds.size === 1 ? kindLabel([...kinds][0]) : "多个类型"} />
          <PropertyRow label="后缀名" value={formatMultiExtensionValue(selectedEntries, commonExtension)} />
          <PropertyRow
            label="大小"
            value={unknownSizeCount > 0 ? `${formatBytes(knownSizeBytes)}，${unknownSizeCount} 项未知` : formatBytes(knownSizeBytes)}
          />
          <PropertyRow label="文件夹" value={`${directoryCount} 项`} />
        </div>
      </div>
    );
  }

  const selectedEntry = selectedEntries[0];
  const item = properties.item;
  if (selectedEntry || item) {
    const name = item?.name ?? selectedEntry?.name ?? "";
    const kind = item?.kind ?? selectedEntry?.kind ?? "file";
    const extension = item?.extension ?? selectedEntry?.extension ?? "";
    const location = item?.parentPath ?? selectedEntry?.parentPath ?? item?.displayPath ?? selectedEntry?.path ?? "";
    const sizeValue =
      formatDirectorySizeState(item) ??
      getFieldStateText(properties, kind === "folder" ? "directorySize" : "sizeBytes") ??
      formatBytes(item?.sizeBytes ?? selectedEntry?.sizeBytes ?? null);
    const allocatedValue = getFieldStateText(properties, "allocatedBytes") ?? formatBytes(item?.allocatedBytes ?? null);

    return (
      <div className="properties-panel">
        <div className="properties-panel__identity">
          <span className="properties-panel__icon">
            <FileSystemIcon kind={kind} path={item?.actualPath ?? selectedEntry?.path} extension={extension || undefined} size={48} />
          </span>
          <div>
            <strong title={name}>{name}</strong>
            <span>{kindLabel(kind)}</span>
          </div>
        </div>
        <div className="properties-panel__grid">
          <PropertyRow label="名称" value={name || "不可用"} />
          <PropertyRow label="后缀名" value={extension || "不可用"} />
          <PropertyRow label="位置" value={location || "不可用"} />
          <PropertyRow label="大小" value={sizeValue} />
          <PropertyRow label="占用空间" value={allocatedValue} />
          <PropertyRow label="创建日期" value={getFieldStateText(properties, "createdAt") ?? formatDate(item?.createdAt)} />
          <PropertyRow label="修改日期" value={getFieldStateText(properties, "modifiedAt") ?? formatDate(item?.modifiedAt)} />
          <PropertyRow label="访问日期" value={getFieldStateText(properties, "accessedAt") ?? formatDate(item?.accessedAt)} />
          <PropertyRow
            label="属性"
            value={
              item
                ? [item.isReadOnly ? "只读" : "", item.isHidden ? "隐藏" : "", item.isSymlink ? "符号链接" : ""]
                    .filter(Boolean)
                    .join(", ") || "普通"
                : selectedEntry?.attributes.join(", ") || "不可用"
            }
          />
        </div>
      </div>
    );
  }

  const knownSizeBytes = activeEntries.reduce((sum, entry) => sum + (typeof entry.sizeBytes === "number" ? entry.sizeBytes : 0), 0);
  const unknownSizeCount = activeEntries.filter((entry) => typeof entry.sizeBytes !== "number").length;

  return (
    <div className="properties-panel">
      <div className="properties-panel__identity">
        <span className="properties-panel__icon">
          <FileSystemIcon kind="folder" size={48} />
        </span>
        <div>
          <strong>当前文件夹</strong>
          <span>未选择项目</span>
        </div>
      </div>
      <div className="properties-panel__grid">
        <PropertyRow label="项目数" value={`${activeEntries.length} 项`} />
        <PropertyRow label="已知大小" value={formatBytes(knownSizeBytes)} />
        <PropertyRow label="未知大小" value={`${unknownSizeCount} 项`} />
      </div>
    </div>
  );
}

function SearchPanelContent({
  search,
  onRunSearch,
  onStopSearch,
  onSelectSearchTab,
  onUpdateQuery,
  onSelectHistory,
  onDeleteHistory
}: {
  search: WorkspaceState["search"];
  onRunSearch: () => void;
  onStopSearch: () => void;
  onSelectSearchTab: (tab: WorkspaceState["search"]["activeTab"]) => void;
  onUpdateQuery: (payload: Partial<WorkspaceState["search"]["query"]>) => void;
  onSelectHistory: (index: number) => void;
  onDeleteHistory: (index: number) => void;
}) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (search.loading) {
      onStopSearch();
      return;
    }
    onRunSearch();
  };

  const handleHistoryKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Delete" || search.selectedHistoryIndex === undefined) {
      return;
    }
    event.preventDefault();
    onDeleteHistory(search.selectedHistoryIndex);
  };

  const isNameSearch = search.activeTab === "name";
  const activePattern = isNameSearch ? search.query.name : search.query.content;
  const activeMode = isNameSearch ? search.query.nameMode : search.query.contentMode;
  const activeModeId = isNameSearch ? "info-name-mode" : "info-content-mode";
  const activeInputLabel = isNameSearch ? "名称" : "输入或粘贴要查找的文件的部分内容";

  return (
    <>
      <div className="information-panel__tabs" role="tablist" aria-label="搜索条件">
        {SEARCH_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={(tab === "名称和位置" && isNameSearch) || (tab === "内容" && !isNameSearch)}
            disabled={tab !== "名称和位置" && tab !== "内容"}
            className={`information-panel__tab${(tab === "名称和位置" && isNameSearch) || (tab === "内容" && !isNameSearch) ? " is-active" : ""}`}
            onClick={() => {
              if (tab === "名称和位置") {
                onSelectSearchTab("name");
              } else if (tab === "内容") {
                onSelectSearchTab("content");
              }
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      <form className="information-panel__content-search" onSubmit={handleSubmit}>
        <label className="information-panel__content-editor" htmlFor="info-search-pattern">
          <span className="information-panel__content-label">{activeInputLabel}</span>
          <textarea
            id="info-search-pattern"
            className="information-panel__content-input"
            value={activePattern}
            onInput={(event) =>
              onUpdateQuery(isNameSearch ? { name: event.currentTarget.value } : { content: event.currentTarget.value })
            }
          />
          {isNameSearch ? (
            <div className="information-panel__extension-filter">
              <select
                id="info-extension-filter-mode"
                value={search.query.extensionFilterMode}
                aria-label="后缀过滤模式"
                onChange={(event) =>
                  onUpdateQuery({
                    extensionFilterMode: event.target.value as WorkspaceState["search"]["query"]["extensionFilterMode"]
                  })
                }
              >
                <option value="include">包含</option>
                <option value="exclude">排除</option>
              </select>
              <input
                id="info-extension-filter"
                type="text"
                value={search.query.extensionFilterText}
                placeholder="后缀：txt;md;log"
                aria-label="文件后缀过滤"
                onInput={(event) => onUpdateQuery({ extensionFilterText: event.currentTarget.value })}
              />
            </div>
          ) : null}
        </label>

        <div className="information-panel__actions">
          <button
            type={search.loading ? "button" : "submit"}
            className="toolbar-button information-panel__run"
            disabled={!search.loading && !activePattern.trim()}
            onClick={search.loading ? onStopSearch : undefined}
          >
            <Search size={14} strokeWidth={2} aria-hidden="true" />
            <span>{search.loading ? "停止搜索" : "搜索"}</span>
          </button>

          <label className="information-panel__field" htmlFor={activeModeId}>
            <span>模式</span>
            <select
              id={activeModeId}
              value={activeMode}
              onChange={(event) =>
                onUpdateQuery(
                  isNameSearch
                    ? { nameMode: event.target.value as WorkspaceState["search"]["query"]["nameMode"] }
                    : { contentMode: event.target.value as WorkspaceState["search"]["query"]["contentMode"] }
                )
              }
            >
              <option value="normal">正常</option>
              <option value="wildcard">通配符</option>
              <option value="regex">正则表达式</option>
            </select>
          </label>

          <label className="information-panel__check" htmlFor="info-case-sensitive">
            <input
              id="info-case-sensitive"
              type="checkbox"
              checked={search.query.caseSensitive}
              onChange={(event) => onUpdateQuery({ caseSensitive: event.target.checked })}
            />
            <span>匹配大小写</span>
          </label>

          <label className="information-panel__check" htmlFor="info-recursive-search">
            <input
              id="info-recursive-search"
              type="checkbox"
              checked={search.query.recursive}
              onChange={(event) => onUpdateQuery({ recursive: event.target.checked })}
            />
            <span>递归搜索</span>
          </label>

          {isNameSearch ? (
            <label className="information-panel__check" htmlFor="info-include-folders">
              <input
                id="info-include-folders"
                type="checkbox"
                checked={search.query.includeFolders}
                onChange={(event) => onUpdateQuery({ includeFolders: event.target.checked })}
              />
              <span>包含文件夹</span>
            </label>
          ) : null}
        </div>

        <div
          className="information-panel__history"
          tabIndex={0}
          role="listbox"
          aria-label="搜索历史"
          onKeyDown={handleHistoryKeyDown}
        >
          {search.history.length === 0 ? (
            <div className="information-panel__history-empty">暂无历史记录</div>
          ) : (
            search.history.map((item, index) => (
              <button
                key={`${item}-${index}`}
                type="button"
                role="option"
                aria-selected={search.selectedHistoryIndex === index}
                className={`information-panel__history-item${search.selectedHistoryIndex === index ? " is-selected" : ""}`}
                title={item}
                onClick={() => onSelectHistory(index)}
              >
                {item}
              </button>
            ))
          )}
        </div>
      </form>
    </>
  );
}

export function WorkspaceInformationPanel({
  informationPanel,
  search,
  operations,
  activeEntries,
  selectedEntries,
  onToggleExpanded,
  onSelectInformationTab,
  onOpenHistory,
  onRunSearch,
  onStopSearch,
  onSelectSearchTab,
  onUpdateQuery,
  onUpdateFilter,
  onSelectHistory,
  onDeleteHistory,
  onCancelTask,
  onUndoLatest,
  onUndoRecord
}: {
  informationPanel: WorkspaceState["informationPanel"];
  search: WorkspaceState["search"];
  operations: WorkspaceState["operations"];
  activeEntries: EntryViewModel[];
  selectedEntries: EntryViewModel[];
  onToggleExpanded: (expanded: boolean) => void;
  onSelectInformationTab: (tab: InformationPanelTab) => void;
  onOpenHistory: () => void;
  onRunSearch: () => void;
  onStopSearch: () => void;
  onSelectSearchTab: (tab: WorkspaceState["search"]["activeTab"]) => void;
  onUpdateQuery: (payload: Partial<WorkspaceState["search"]["query"]>) => void;
  onUpdateFilter: (value: string) => void;
  onSelectHistory: (index: number) => void;
  onDeleteHistory: (index: number) => void;
  onCancelTask: (taskId: string) => void;
  onUndoLatest: () => void;
  onUndoRecord: (recordId: string) => void;
}) {
  const selectedSummary = summarizeEntrySizes(selectedEntries);
  const folderSummary = summarizeEntrySizes(activeEntries);
  const statusText = search.progress?.statusText ?? (search.loading ? "正在搜索..." : "就绪");
  const contentId = `information-panel-content-${informationPanel.activeTab}`;
  const topTabRefs = useRef<Record<InformationPanelTab, HTMLButtonElement | null>>({
    properties: null,
    search: null,
    history: null
  });

  const focusTopTab = (tab: InformationPanelTab) => {
    const focus = () => topTabRefs.current[tab]?.focus();
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(focus);
      return;
    }
    setTimeout(focus, 0);
  };

  const handleTopTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }

    event.preventDefault();
    const currentIndex = Math.max(
      INFORMATION_TABS.findIndex((tab) => tab.id === informationPanel.activeTab),
      0
    );
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? INFORMATION_TABS.length - 1
          : event.key === "ArrowLeft"
            ? (currentIndex + INFORMATION_TABS.length - 1) % INFORMATION_TABS.length
            : (currentIndex + 1) % INFORMATION_TABS.length;
    const nextTab = INFORMATION_TABS[nextIndex].id;
    onSelectInformationTab(nextTab);
    focusTopTab(nextTab);
  };

  return (
    <section
      className={`information-panel${informationPanel.expanded ? " is-expanded" : " is-collapsed"}`}
      aria-label="信息面板"
    >
      <div className="information-panel__summary">
        <label className="information-panel__filter">
          <span>过滤</span>
          <input
            type="search"
            value={search.filterText}
            onInput={(event) => onUpdateFilter(event.currentTarget.value)}
            aria-label="实时过滤"
          />
        </label>

        <div className="information-panel__summary-item">
          <span>文件夹</span>
          <strong>{folderSummary}</strong>
        </div>
        <div className="information-panel__summary-item">
          <span>已选</span>
          <strong>{selectedSummary}</strong>
        </div>
        <div className="information-panel__summary-item information-panel__summary-item--names" title={selectedNames(selectedEntries)}>
          <span>名称</span>
          <strong>{selectedNames(selectedEntries)}</strong>
        </div>
        <div className="information-panel__summary-item information-panel__progress">
          <span>状态</span>
          <strong>{statusText}</strong>
        </div>

        <OperationSummaryButton operations={operations} onOpen={onOpenHistory} />

        <button
          type="button"
          className="information-panel__collapse-toggle"
          aria-label={informationPanel.expanded ? "收缩信息面板" : "展开信息面板"}
          title={informationPanel.expanded ? "收缩信息面板" : "展开信息面板"}
          onClick={() => onToggleExpanded(!informationPanel.expanded)}
        >
          {informationPanel.expanded ? <ChevronDown size={14} strokeWidth={2} aria-hidden="true" /> : <ChevronUp size={14} strokeWidth={2} aria-hidden="true" />}
        </button>
      </div>

      {informationPanel.expanded ? (
        <div className="information-panel__content-shell">
          <div
            className="information-panel__top-tabs"
            role="tablist"
            aria-label="信息面板功能"
            onKeyDown={handleTopTabKeyDown}
          >
            {INFORMATION_TABS.map((tab) => (
              <button
                key={tab.id}
                id={`information-panel-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={informationPanel.activeTab === tab.id}
                aria-controls={`information-panel-content-${tab.id}`}
                tabIndex={informationPanel.activeTab === tab.id ? 0 : -1}
                className={`information-panel__top-tab${informationPanel.activeTab === tab.id ? " is-active" : ""}`}
                ref={(node) => {
                  topTabRefs.current[tab.id] = node;
                }}
                onClick={() => onSelectInformationTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div
            id={contentId}
            className="information-panel__content"
            role="tabpanel"
            aria-labelledby={`information-panel-tab-${informationPanel.activeTab}`}
          >
            {informationPanel.activeTab === "properties" ? (
              <PropertiesPanel
                properties={informationPanel.properties}
                activeEntries={activeEntries}
                selectedEntries={selectedEntries}
              />
            ) : informationPanel.activeTab === "search" ? (
              <SearchPanelContent
                search={search}
                onRunSearch={onRunSearch}
                onStopSearch={onStopSearch}
                onSelectSearchTab={onSelectSearchTab}
                onUpdateQuery={onUpdateQuery}
                onSelectHistory={onSelectHistory}
                onDeleteHistory={onDeleteHistory}
              />
            ) : (
              <OperationHistoryPanelContent
                operations={operations}
                onCancelTask={onCancelTask}
                onUndoLatest={onUndoLatest}
                onUndoRecord={onUndoRecord}
              />
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
