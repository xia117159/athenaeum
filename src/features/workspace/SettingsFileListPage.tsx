export function SettingsFileListPage({
  detailsRowHeight,
  sizeBarMode,
  onUpdateSizeBarMode,
  folderExpansionEnabled,
  onUpdateFolderExpansionEnabled,
  tooltipHoverDelayMs,
  metadataRetentionHours,
  disabled,
  onUpdateDetailsRowHeight,
  onUpdateTooltipHoverDelay,
  onUpdateMetadataRetentionHours
}: {
  detailsRowHeight: number;
  sizeBarMode: "folder-total" | "folder-max";
  onUpdateSizeBarMode: (value: "folder-total" | "folder-max") => void;
  folderExpansionEnabled: boolean;
  onUpdateFolderExpansionEnabled: (enabled: boolean) => void;
  tooltipHoverDelayMs: number;
  metadataRetentionHours: number | null;
  disabled: boolean;
  onUpdateDetailsRowHeight: (value: number) => void;
  onUpdateTooltipHoverDelay: (value: number) => void;
  onUpdateMetadataRetentionHours: (value: number | null) => void;
}) {
  const retentionNever = metadataRetentionHours === null;
  return (
    <div className="settings-page">
      <section className="settings-group">
        <header className="settings-group__header">
          <div>
            <strong>文件列表</strong>
            <span>调整详细信息视图密度、悬停提示和注释/标签保留策略。</span>
          </div>
        </header>
        <div className="settings-row">
          <div>
            <strong>详细信息列表内展开文件夹</strong>
            <span>点击箭头原地展开子项，适用于本地、FTP 和 SFTP 目录，不含搜索结果。</span>
          </div>
          <label className="settings-check-inline">
            <input
              type="checkbox"
              aria-label="详细信息列表内展开文件夹"
              data-setting-id="folder-expansion-enabled"
              checked={folderExpansionEnabled}
              disabled={disabled}
              onChange={(event) => onUpdateFolderExpansionEnabled(event.currentTarget.checked)}
            />
            <span>启用</span>
          </label>
        </div>
        <div className="settings-row">
          <div>
            <strong>行高</strong>
            <span>范围 12px - 72px</span>
          </div>
          <label className="settings-control-inline">
            <input
              type="number"
              min={12}
              max={72}
              step={2}
              value={String(detailsRowHeight)}
              data-setting-id="details-row-height"
              onInput={(event) => onUpdateDetailsRowHeight(Number(event.currentTarget.value))}
              disabled={disabled}
            />
            <span>px</span>
          </label>
        </div>
        <div className="settings-row">
          <div><strong>大小占比基准</strong></div>
          <div className="settings-segmented" role="group" aria-label="大小占比基准">
            <button type="button" className={sizeBarMode === "folder-total" ? "is-active" : undefined}
              data-setting-id="size-bar-mode-folder-total" aria-pressed={sizeBarMode === "folder-total"}
              disabled={disabled} onClick={() => onUpdateSizeBarMode("folder-total")}>所在文件夹总大小</button>
            <button type="button" className={sizeBarMode === "folder-max" ? "is-active" : undefined}
              data-setting-id="size-bar-mode-folder-max" aria-pressed={sizeBarMode === "folder-max"}
              disabled={disabled} onClick={() => onUpdateSizeBarMode("folder-max")}>所在文件夹最大项</button>
          </div>
        </div>
        <div className="settings-row">
          <div>
            <strong>列表项悬停提示等待时间</strong>
            <span>范围 0ms - 5000ms，0 表示鼠标移入即显示。</span>
          </div>
          <label className="settings-control-inline">
            <input
              type="number"
              min={0}
              max={5000}
              step={50}
              value={String(tooltipHoverDelayMs)}
              data-setting-id="tooltip-hover-delay"
              onInput={(event) => onUpdateTooltipHoverDelay(Number(event.currentTarget.value))}
              disabled={disabled}
            />
            <span>ms</span>
          </label>
        </div>
        <div className="settings-row">
          <div>
            <strong>注释/标签保留时间</strong>
            <span>单位小时，0 表示随文件一起删除。</span>
          </div>
          <div className="settings-retention-control">
            <label className="settings-control-inline">
              <input
                type="number"
                min={0}
                step={1}
                value={retentionNever ? "" : String(metadataRetentionHours)}
                data-setting-id="metadata-retention-hours"
                onInput={(event) => onUpdateMetadataRetentionHours(Number(event.currentTarget.value))}
                disabled={disabled || retentionNever}
              />
              <span>小时</span>
            </label>
            <label className="settings-check-inline">
              <input
                type="checkbox"
                checked={retentionNever}
                data-setting-id="metadata-retention-never"
                onChange={(event) => onUpdateMetadataRetentionHours(event.currentTarget.checked ? null : 720)}
                disabled={disabled}
              />
              <span>永不删除</span>
            </label>
          </div>
        </div>
      </section>
    </div>
  );
}
