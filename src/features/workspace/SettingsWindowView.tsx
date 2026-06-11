import { useEffect, useState } from "react";
import { SettingsSurface } from "./SettingsSurface";
import type { RemoteConnectionProfile, SettingsModel, SettingsSection, WorkspaceState } from "./types";
import { normalizeDetailsRowHeight, normalizeSettingsModel, normalizeTabMinWidth, normalizeThemeAccentColor } from "./workspaceMappers";
import { useWorkspaceController } from "./useWorkspaceController";
import "./workspace.css";

function cloneSettingsModel(model: SettingsModel): SettingsModel {
  return {
    shortcuts: model.shortcuts.map((shortcut) => ({ ...shortcut })),
    colorRules: model.colorRules.map((rule) => ({ ...rule })),
    tagRules: model.tagRules.map((rule) => ({ ...rule })),
    columns: model.columns.map((column) => ({ ...column })),
    detailsRowHeight: model.detailsRowHeight,
    theme: { ...model.theme }
  };
}

function createDraftState(state: WorkspaceState): WorkspaceState {
  return {
    ...state,
    status: "ready",
    settings: {
      ...state.settings,
      model: cloneSettingsModel(normalizeSettingsModel(state.settings.model))
    },
    remoteProfiles: state.remoteProfiles.map((profile) => ({ ...profile }))
  };
}

function upsertRemoteProfile(profiles: RemoteConnectionProfile[], profile: RemoteConnectionProfile) {
  const nextProfiles = profiles.some((item) => item.id === profile.id)
    ? profiles.map((item) => (item.id === profile.id ? { ...profile } : item))
    : [...profiles, { ...profile }];
  return nextProfiles.sort((left, right) => left.name.localeCompare(right.name));
}

function hasSameJsonShape(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function getSettingsErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function closeSettingsWindow() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
    return;
  } catch {
    // Browser fallback for local component development and tests.
  }

  try {
    window.close();
  } catch {
    // Closing a browser fallback window is best-effort.
  }
}

export function SettingsWindowView() {
  const { state, actions } = useWorkspaceController();
  const settingsReady = state.status === "ready";
  const [draftState, setDraftState] = useState<WorkspaceState>(() => createDraftState(state));
  const [dirty, setDirty] = useState(false);
  const [applying, setApplying] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [remoteProfilePasswords, setRemoteProfilePasswords] = useState<Record<string, string | undefined>>({});
  const [deletedRemoteProfileIds, setDeletedRemoteProfileIds] = useState<string[]>([]);

  useEffect(() => {
    if (!settingsReady) {
      return;
    }
    if (dirty || applying) {
      return;
    }
    setDraftState(createDraftState(state));
    setRemoteProfilePasswords({});
    setDeletedRemoteProfileIds([]);
    setErrorMessage(null);
  }, [state, settingsReady, dirty, applying]);

  const updateDraftModel = (updater: (model: SettingsModel) => SettingsModel) => {
    if (!settingsReady || applying) {
      return;
    }
    setDirty(true);
    setErrorMessage(null);
    setDraftState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        model: normalizeSettingsModel(updater(current.settings.model))
      }
    }));
  };

  const updateDraftSection = (section: SettingsSection) => {
    setDraftState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        section
      }
    }));
  };

  const saveDraftRemoteProfile = (profile: RemoteConnectionProfile, password?: string) => {
    if (!settingsReady || applying) {
      return;
    }
    setDirty(true);
    setErrorMessage(null);
    setDraftState((current) => ({
      ...current,
      remoteProfiles: upsertRemoteProfile(current.remoteProfiles, profile)
    }));
    setDeletedRemoteProfileIds((current) => current.filter((id) => id !== profile.id));
    if (password !== undefined) {
      setRemoteProfilePasswords((current) => ({
        ...current,
        [profile.id]: password
      }));
    }
  };

  const deleteDraftRemoteProfile = (id: string) => {
    if (!settingsReady || applying) {
      return;
    }
    setDirty(true);
    setErrorMessage(null);
    setDraftState((current) => ({
      ...current,
      remoteProfiles: current.remoteProfiles.filter((profile) => profile.id !== id)
    }));
    setRemoteProfilePasswords((current) => {
      const { [id]: _removed, ...rest } = current;
      return rest;
    });
    if (state.remoteProfiles.some((profile) => profile.id === id)) {
      setDeletedRemoteProfileIds((current) => (current.includes(id) ? current : [...current, id]));
    }
  };

  const applyRemoteProfileUpserts = async () => {
    const deletedIds = new Set(deletedRemoteProfileIds);
    const persistedById = new Map(state.remoteProfiles.map((profile) => [profile.id, profile]));

    for (const profile of draftState.remoteProfiles) {
      if (deletedIds.has(profile.id)) {
        continue;
      }

      const persistedProfile = persistedById.get(profile.id);
      const passwordChanged = Object.prototype.hasOwnProperty.call(remoteProfilePasswords, profile.id);
      if (!persistedProfile || passwordChanged || !hasSameJsonShape(persistedProfile, profile)) {
        await actions.saveRemoteProfile(profile, remoteProfilePasswords[profile.id]);
      }
    }
  };

  const applyRemoteProfileDeletions = async () => {
    for (const id of deletedRemoteProfileIds) {
      await actions.deleteRemoteProfile(id);
    }
  };

  const handleConfirm = async () => {
    if (!settingsReady || applying) {
      return;
    }
    setApplying(true);
    setErrorMessage(null);
    try {
      await applyRemoteProfileUpserts();
      await actions.applySettingsModel(draftState.settings.model, draftState.settings.section);
      await applyRemoteProfileDeletions();
      setDirty(false);
      setRemoteProfilePasswords({});
      setDeletedRemoteProfileIds([]);
      await closeSettingsWindow();
    } catch (error) {
      setErrorMessage(getSettingsErrorMessage(error, "无法应用设置"));
    } finally {
      setApplying(false);
    }
  };

  const handleCancel = () => {
    setDirty(false);
    setDraftState(createDraftState(state));
    setRemoteProfilePasswords({});
    setDeletedRemoteProfileIds([]);
    void closeSettingsWindow();
  };

  return (
    <div className="settings-window-shell">
      <SettingsSurface
        state={draftState}
        onSelectSection={updateDraftSection}
        onUpdateShortcut={(id, binding) =>
          updateDraftModel((model) => ({
            ...model,
            shortcuts: model.shortcuts.map((shortcut) => (shortcut.id === id ? { ...shortcut, binding } : shortcut))
          }))
        }
        onUpdateColorRule={(id, color) =>
          updateDraftModel((model) => ({
            ...model,
            colorRules: model.colorRules.map((rule) => (rule.id === id ? { ...rule, color } : rule))
          }))
        }
        onUpdatePanelFocusAccent={(color) =>
          updateDraftModel((model) => ({
            ...model,
            theme: {
              ...model.theme,
              panelFocusAccent: normalizeThemeAccentColor(color)
            }
          }))
        }
        onUpdateTabMinWidth={(value) =>
          updateDraftModel((model) => ({
            ...model,
            theme: {
              ...model.theme,
              tabMinWidth: normalizeTabMinWidth(value)
            }
          }))
        }
        onUpdateDetailsRowHeight={(value) =>
          updateDraftModel((model) => ({
            ...model,
            detailsRowHeight: normalizeDetailsRowHeight(value)
          }))
        }
        onSaveRemoteProfile={saveDraftRemoteProfile}
        onDeleteRemoteProfile={deleteDraftRemoteProfile}
        onTestRemoteProfile={(profile, password) => actions.testRemoteProfile(profile, password)}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
        applying={applying}
        disabled={!settingsReady}
        errorMessage={errorMessage}
      />
    </div>
  );
}
