import { SettingsFileListPage } from "./SettingsFileListPage";
import { SettingsGroupHeader, SettingsRow } from "./SettingsPrimitives";
import { TemplateSettingsPage } from "./TemplateSettingsPage";
import type { SettingsSurfaceProps } from "./SettingsSurface";

export function SettingsGeneralPage({ state, disabled = false,
  onUpdateDetailsRowHeight, onUpdateSizeBarMode = () => {}, onUpdateTreeAutoFollowEnabled = () => {},
  onUpdateFolderExpansionEnabled, onUpdateTooltipHoverDelay, onUpdateMetadataRetentionHours,
  onUpdateContextMenuDefault, onUpdateNotificationsEnabled, onUpdateTemplateRoot = () => {},
  onChooseTemplateRoot = async () => null
}: Pick<SettingsSurfaceProps, "state" | "disabled" | "onUpdateDetailsRowHeight" | "onUpdateSizeBarMode" |
  "onUpdateTreeAutoFollowEnabled" | "onUpdateFolderExpansionEnabled" | "onUpdateTooltipHoverDelay" |
  "onUpdateMetadataRetentionHours" | "onUpdateContextMenuDefault" | "onUpdateNotificationsEnabled" |
  "onUpdateTemplateRoot" | "onChooseTemplateRoot">) {
  const model = state.settings.model;
  return <div className="settings-page settings-page--general">
    <SettingsFileListPage detailsRowHeight={model.detailsRowHeight} sizeBarMode={model.sizeBarMode}
      onUpdateSizeBarMode={onUpdateSizeBarMode} treeAutoFollowEnabled={model.treeAutoFollowEnabled === true}
      onUpdateTreeAutoFollowEnabled={onUpdateTreeAutoFollowEnabled} folderExpansionEnabled={model.folderExpansionEnabled === true}
      onUpdateFolderExpansionEnabled={onUpdateFolderExpansionEnabled} tooltipHoverDelayMs={model.tooltipHoverDelayMs}
      metadataRetentionHours={model.metadataRetentionHours} disabled={disabled} onUpdateDetailsRowHeight={onUpdateDetailsRowHeight}
      onUpdateTooltipHoverDelay={onUpdateTooltipHoverDelay} onUpdateMetadataRetentionHours={onUpdateMetadataRetentionHours} />
    <section className="settings-group" id="settings-group-menu-mouse">
      <SettingsGroupHeader title="菜单与鼠标" />
      <div className="settings-group__fields">
        <SettingsRow title="默认右键菜单" description="选择普通右键优先打开的菜单类型。Ctrl/Shift 组合行为仍按文件列表快捷键设置判断。">
          <div className="settings-segmented" role="group" aria-label="默认右键菜单">
            <button type="button" className={model.contextMenu.defaultMenu === "native" ? "is-active" : undefined}
              data-context-menu-value="native" onClick={() => onUpdateContextMenuDefault("native")} disabled={disabled}>Windows 系统</button>
            <button type="button" className={model.contextMenu.defaultMenu === "custom" ? "is-active" : undefined}
              data-context-menu-value="custom" onClick={() => onUpdateContextMenuDefault("custom")} disabled={disabled}>软件自定义</button>
          </div>
        </SettingsRow>
        <SettingsRow title="显示通知提示" description="控制右下角弹出的错误与操作结果通知。关闭后不再弹出任何右下角通知（含错误提示）；文件打开进度条仍会显示。">
          <label className="settings-check-inline">
            <input type="checkbox" aria-label="显示通知提示" data-setting-id="notifications-enabled"
              checked={model.notificationsEnabled === true} disabled={disabled}
              onChange={event => onUpdateNotificationsEnabled(event.currentTarget.checked)} />
            <span>启用</span>
          </label>
        </SettingsRow>
      </div>
    </section>
    <TemplateSettingsPage path={model.templateRoot ?? ""} disabled={disabled} onChange={onUpdateTemplateRoot} onChoose={onChooseTemplateRoot} />
  </div>;
}
