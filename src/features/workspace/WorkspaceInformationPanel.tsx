import { type FormEvent, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import type { EntryViewModel, WorkspaceState } from "./types";

const SEARCH_TABS = ["名称和位置", "大小", "日期", "标签", "内容", "重复", "排除"] as const;

function parseSizeLabel(sizeLabel: string): number | null {
  const trimmed = sizeLabel.trim();
  if (!trimmed || trimmed === "--") {
    return null;
  }

  const match = /^([\d.]+)\s*(B|KB|MB|GB|TB)$/i.exec(trimmed);
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return null;
  }

  const unit = match[2].toUpperCase() as "B" | "KB" | "MB" | "GB" | "TB";
  const multipliers: Record<typeof unit, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4
  };
  return value * multipliers[unit];
}

function formatBytes(value: number) {
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

function summarizeEntrySizes(entries: EntryViewModel[]) {
  let knownBytes = 0;
  let knownCount = 0;
  for (const entry of entries) {
    const size = parseSizeLabel(entry.sizeLabel);
    if (size !== null) {
      knownBytes += size;
      knownCount += 1;
    }
  }

  if (entries.length === 0) {
    return "0 项";
  }

  if (knownCount === 0) {
    return `${entries.length} 项`;
  }

  return `${entries.length} 项 ${formatBytes(knownBytes)}`;
}

function selectedNames(entries: EntryViewModel[]) {
  if (entries.length === 0) {
    return "未选择";
  }

  const names = entries.slice(0, 3).map((entry) => entry.name).join(", ");
  return entries.length > 3 ? `${names} +${entries.length - 3}` : names;
}

export function WorkspaceInformationPanel({
  search,
  activeEntries,
  selectedEntries,
  onToggle,
  onRunSearch,
  onStopSearch,
  onSelectSearchTab,
  onUpdateQuery,
  onUpdateFilter,
  onSelectHistory,
  onDeleteHistory
}: {
  search: WorkspaceState["search"];
  activeEntries: EntryViewModel[];
  selectedEntries: EntryViewModel[];
  onToggle: (open: boolean) => void;
  onRunSearch: () => void;
  onStopSearch: () => void;
  onSelectSearchTab: (tab: WorkspaceState["search"]["activeTab"]) => void;
  onUpdateQuery: (payload: Partial<WorkspaceState["search"]["query"]>) => void;
  onUpdateFilter: (value: string) => void;
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

  const selectedSummary = summarizeEntrySizes(selectedEntries);
  const folderSummary = summarizeEntrySizes(activeEntries);
  const statusText = search.progress?.statusText ?? (search.loading ? "正在搜索..." : "就绪");
  const isNameSearch = search.activeTab === "name";
  const activePattern = isNameSearch ? search.query.name : search.query.content;
  const activeMode = isNameSearch ? search.query.nameMode : search.query.contentMode;
  const activeModeId = isNameSearch ? "info-name-mode" : "info-content-mode";
  const activeInputLabel = isNameSearch ? "名称" : "输入或粘贴要查找的文件的部分内容";

  return (
    <section className="information-panel" aria-label="信息面板">
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

        <button
          type="button"
          className="information-panel__close"
          aria-label="关闭信息面板"
          title="关闭信息面板"
          onClick={() => onToggle(false)}
        >
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

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
    </section>
  );
}
