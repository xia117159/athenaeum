import { SettingsGroupHeader, SettingsRow } from "./SettingsPrimitives";

export function SettingsFileListPage({
  treeAutoFollowEnabled,
  onUpdateTreeAutoFollowEnabled,
  detailsRowHeight,
  sizeBarMode,
  onUpdateSizeBarMode,
  folderExpansionEnabled,
  onUpdateFolderExpansionEnabled,
  folderExpansionOnRowClick,
  onUpdateFolderExpansionOnRowClick,
  tooltipHoverDelayMs,
  metadataRetentionHours,
  disabled,
  onUpdateDetailsRowHeight,
  onUpdateTooltipHoverDelay,
  onUpdateMetadataRetentionHours
}: {
  treeAutoFollowEnabled: boolean;
  onUpdateTreeAutoFollowEnabled: (enabled: boolean) => void;
  detailsRowHeight: number;
  sizeBarMode: "folder-total" | "folder-max";
  onUpdateSizeBarMode: (value: "folder-total" | "folder-max") => void;
  folderExpansionEnabled: boolean;
  onUpdateFolderExpansionEnabled: (enabled: boolean) => void;
  folderExpansionOnRowClick: boolean;
  onUpdateFolderExpansionOnRowClick: (enabled: boolean) => void;
  tooltipHoverDelayMs: number;
  metadataRetentionHours: number | null;
  disabled: boolean;
  onUpdateDetailsRowHeight: (value: number) => void;
  onUpdateTooltipHoverDelay: (value: number) => void;
  onUpdateMetadataRetentionHours: (value: number | null) => void;
}) {
  const retentionNever = metadataRetentionHours === null;
  return (
    <section className="settings-group" id="settings-group-file-list">
      <SettingsGroupHeader title="文件列表" description="调整详细信息视图密度、悬停提示和注释/标签保留策略。" />
      <div className="settings-group__fields">
        <SettingsRow title="目录树自动跟踪展开" description="跟随当前标签页的目录，自动选中并展开目录树；关闭后，切换标签页和浏览目录时保持目录树状态。">
          <label className="settings-check-inline">
            <input type="checkbox" aria-label="目录树自动跟踪展开" data-setting-id="tree-auto-follow-enabled"
              checked={treeAutoFollowEnabled} disabled={disabled}
              onChange={event => onUpdateTreeAutoFollowEnabled(event.currentTarget.checked)} />
            <span>启用</span>
          </label>
        </SettingsRow>
        <SettingsRow title="详细信息列表内展开文件夹" description="点击箭头原地展开子项，适用于本地、FTP 和 SFTP 目录，不含搜索结果。">
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
        </SettingsRow>
        <SettingsRow title="单击文件夹行展开/收起" description="默认关闭：单击选中，双击进入，点击箭头展开/收起。启用后单击整行立即展开/收起，双击时可能先展开再进入。">
          <label className="settings-check-inline">
            <input
              type="checkbox"
              aria-label="单击文件夹行展开/收起"
              data-setting-id="folder-expansion-on-row-click"
              checked={folderExpansionOnRowClick}
              disabled={disabled || !folderExpansionEnabled}
              onChange={(event) => onUpdateFolderExpansionOnRowClick(event.currentTarget.checked)}
            />
            <span>启用</span>
          </label>
        </SettingsRow>
        <SettingsRow title="文件列表行高" description="范围 12px - 72px">
          <label className="settings-control-inline">
            <input
              type="number"
              min={12}
              max={72}
              step={2}
              value={String(detailsRowHeight)}
              data-setting-id="details-row-height"
              aria-label="文件列表行高"
              onInput={(event) => onUpdateDetailsRowHeight(Number(event.currentTarget.value))}
              disabled={disabled}
            />
            <span>px</span>
          </label>
        </SettingsRow>
        <SettingsRow title="大小占比基准" wide>
          <div className="settings-segmented" role="group" aria-label="大小占比基准">
            <button type="button" className={sizeBarMode === "folder-total" ? "is-active" : undefined}
              data-setting-id="size-bar-mode-folder-total" aria-pressed={sizeBarMode === "folder-total"}
              disabled={disabled} onClick={() => onUpdateSizeBarMode("folder-total")}>所在文件夹总大小</button>
            <button type="button" className={sizeBarMode === "folder-max" ? "is-active" : undefined}
              data-setting-id="size-bar-mode-folder-max" aria-pressed={sizeBarMode === "folder-max"}
              disabled={disabled} onClick={() => onUpdateSizeBarMode("folder-max")}>所在文件夹最大项</button>
          </div>
        </SettingsRow>
        <SettingsRow title="列表项悬停提示等待时间" description="范围 0ms - 5000ms，0 表示鼠标移入即显示。">
          <label className="settings-control-inline">
            <input
              type="number"
              min={0}
              max={5000}
              step={50}
              value={String(tooltipHoverDelayMs)}
              data-setting-id="tooltip-hover-delay"
              aria-label="列表项悬停提示等待时间"
              onInput={(event) => onUpdateTooltipHoverDelay(Number(event.currentTarget.value))}
              disabled={disabled}
            />
            <span>ms</span>
          </label>
        </SettingsRow>
        <SettingsRow title="注释/标签保留时间" description="单位小时，0 表示随文件一起删除。">
          <div className="settings-retention-control">
            <label className="settings-control-inline">
              <input
                type="number"
                min={0}
                step={1}
                value={retentionNever ? "" : String(metadataRetentionHours)}
                data-setting-id="metadata-retention-hours"
                aria-label="注释/标签保留时间"
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
        </SettingsRow>
      </div>
    </section>
  );
}
