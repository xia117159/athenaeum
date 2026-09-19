import { createMockWorkspaceBootstrap } from "./mockData";
import { createWorkspaceState } from "./workspaceReducer";
import type { SettingsSurfaceProps } from "./SettingsSurface";
import type { SettingsSection } from "./types";

export function settingsSurfaceProps(section: SettingsSection): SettingsSurfaceProps {
  const state = createWorkspaceState(createMockWorkspaceBootstrap("mock"));
  state.settings.section = section;
  const noop = () => undefined;
  return {
    state, onSelectSection: noop, onUpdateShortcut: noop, onUpdateColorRules: noop,
    onUpdateFileAssociations: noop, onChooseAssociationProgram: async () => null,
    onInspectAssociationPrograms: async () => [],
    onValidateColorRule: async () => ({ valid: true, message: null, span: null }),
    onOpenColorRulesHelp: noop, onUpdatePanelFocusAccent: noop, onUpdateActiveTabBackground: noop,
    onUpdateDropHighlightFill: noop, onUpdateDropHighlightBorder: noop, onUpdateTabMinWidth: noop,
    onUpdateDetailsRowHeight: noop, onUpdateFolderExpansionEnabled: noop,
    onUpdateFolderExpansionOnRowClick: noop,
    onUpdateTreeAutoFollowEnabled: noop, onUpdateNotificationsEnabled: noop,
    onUpdateTooltipHoverDelay: noop, onUpdateMetadataRetentionHours: noop,
    onUpdateContextMenuDefault: noop, onSaveRemoteProfile: noop, onDeleteRemoteProfile: noop,
    onTestRemoteProfile: noop, onConfirm: noop, onCancel: noop
  };
}
