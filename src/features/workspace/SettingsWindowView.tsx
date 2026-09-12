import { useEffect, useMemo, useState } from "react";
import { SettingsSurface } from "./SettingsSurface";
import type { RemoteConnectionProfile, SettingsModel, SettingsSection, WorkspaceState } from "./types";
import {
  DEFAULT_THEME,
  normalizeContextMenuDefault,
  normalizeDetailsRowHeight,
  normalizeSizeBarMode,
  normalizeMetadataRetentionHours,
  normalizeSettingsModel,
  normalizeTabMinWidth,
  normalizeTooltipHoverDelayMs,
  normalizeThemeAccentColor
} from "./workspaceMappers";
import { useWorkspaceController } from "./useWorkspaceController";
import { openColorFilterHelpWindow } from "./colorFilterHelpWindow";
import { associationRulesError, normalizeAssociationRule } from "./fileAssociations";
import { listenSettingsNavigation, requestedSettingsSection } from "./settingsNavigation";
import { getColorRuleNameErrors, hasColorRuleDraftChanges } from "./colorFilterEditorModel";
import {
  formatSettingsApplyFailure,
  runSettingsApplyPlan,
  SettingsApplyFailure,
  type SettingsApplyStep
} from "./settingsApplyPlan";
import "./workspace.css";

function cloneSettingsModel(model: SettingsModel): SettingsModel {
  return {
    fileAssociations: (model.fileAssociations ?? []).map(rule => ({ ...rule })),
    shortcuts: model.shortcuts.map((shortcut) => ({ ...shortcut })),
    colorRules: model.colorRules.map((rule) => ({ ...rule })),
    colorFilterEnabled: model.colorFilterEnabled ?? true,
    colorFilterRevision: model.colorFilterRevision ?? "0",
    colorRulesRevision: model.colorRulesRevision ?? "0",
    tagRules: model.tagRules.map((rule) => ({ ...rule })),
    columns: model.columns.map((column) => ({ ...column })),
    navigationColumns: model.navigationColumns.map((column) => ({ ...column })),
    detailsRowHeight: model.detailsRowHeight,
    sizeBarMode: model.sizeBarMode,
    folderExpansionEnabled: model.folderExpansionEnabled === true,
    tooltipHoverDelayMs: model.tooltipHoverDelayMs,
    metadataRetentionHours: model.metadataRetentionHours,
    fileVisibility: { ...model.fileVisibility },
    contextMenu: { ...model.contextMenu },
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

function computeDirtySections(
  persisted: WorkspaceState,
  draft: WorkspaceState,
  normalizedPersistedModel: SettingsModel,
  deletedRemoteProfileIds: string[],
  remoteProfilePasswords: Record<string, string | undefined>,
  colorRulesRawDraftDirty: boolean
): Set<SettingsSection> {
  const sections = new Set<SettingsSection>();
  const dm = draft.settings.model;
  const pm = normalizedPersistedModel;
  if (!hasSameJsonShape(pm.shortcuts, dm.shortcuts)) sections.add("shortcuts");
  if (!hasSameJsonShape(pm.fileAssociations, dm.fileAssociations)) sections.add("file-associations");
  if (
    !hasSameJsonShape(pm.columns, dm.columns) ||
    !hasSameJsonShape(pm.navigationColumns, dm.navigationColumns) ||
    pm.detailsRowHeight !== dm.detailsRowHeight ||
    pm.sizeBarMode !== dm.sizeBarMode ||
    pm.folderExpansionEnabled !== dm.folderExpansionEnabled ||
    pm.tooltipHoverDelayMs !== dm.tooltipHoverDelayMs ||
    pm.metadataRetentionHours !== dm.metadataRetentionHours
  ) {
    sections.add("file-list");
  }
  if (!hasSameJsonShape(pm.contextMenu, dm.contextMenu)) sections.add("menu-mouse");
  if (!hasSameJsonShape(pm.theme, dm.theme)) sections.add("appearance");
  if (hasColorRuleDraftChanges(dm.colorRules, pm.colorRules, colorRulesRawDraftDirty)) {
    sections.add("color-rules");
  }
  if (!hasSameJsonShape(pm.tagRules, dm.tagRules)) sections.add("tag-rules");
  if (
    !hasSameJsonShape(persisted.remoteProfiles, draft.remoteProfiles) ||
    deletedRemoteProfileIds.length > 0 ||
    Object.keys(remoteProfilePasswords).length > 0
  ) {
    sections.add("connections");
  }
  return sections;
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
  const { state, actions } = useWorkspaceController(undefined, { role: "settings" });
  const settingsReady = state.status === "ready";
  const [draftState, setDraftState] = useState<WorkspaceState>(() => {
    const draft = createDraftState(state);
    draft.settings.section = requestedSettingsSection(window.location.search, draft.settings.section);
    return draft;
  });
  const [dirty, setDirty] = useState(false);
  const [applying, setApplying] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [remoteProfilePasswords, setRemoteProfilePasswords] = useState<Record<string, string | undefined>>({});
  const [deletedRemoteProfileIds, setDeletedRemoteProfileIds] = useState<string[]>([]);
  const [baselineColorRules, setBaselineColorRules] = useState(() => state.settings.model.colorRules.map((rule) => ({ ...rule })));
  const [colorRulesBaseRevision, setColorRulesBaseRevision] = useState(state.settings.model.colorRulesRevision ?? "0");
  const [colorRulesConflict, setColorRulesConflict] = useState(false);
  const [colorRulesValid, setColorRulesValid] = useState(true);
  const [colorRulesRawDraftDirty, setColorRulesRawDraftDirty] = useState(false);
  const [colorRulesResetSequence, setColorRulesResetSequence] = useState(0);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listenSettingsNavigation(section => {
      if (!disposed) setDraftState(current => ({ ...current, settings: { ...current.settings, section } }));
    }).then(unlisten => {
      if (disposed) unlisten(); else stop = unlisten;
    }).catch(error => {
      if (!disposed) setErrorMessage(getSettingsErrorMessage(error, "无法切换设置页"));
    });
    return () => { disposed = true; stop?.(); };
  }, []);

  const normalizedPersistedModel = useMemo(
    () => normalizeSettingsModel(state.settings.model),
    [state.settings.model]
  );

  const dirtySections = useMemo(
    () => computeDirtySections(
      state,
      draftState,
      normalizedPersistedModel,
      deletedRemoteProfileIds,
      remoteProfilePasswords,
      colorRulesRawDraftDirty
    ),
    [
      state,
      draftState,
      normalizedPersistedModel,
      deletedRemoteProfileIds,
      remoteProfilePasswords,
      colorRulesRawDraftDirty
    ]
  );

  useEffect(() => {
    if (!settingsReady) {
      return;
    }
    if (dirty || colorRulesRawDraftDirty || applying) {
      return;
    }
    setDraftState((current) => {
      const next = createDraftState(state);
      next.settings.section = current.settings.section;
      return next;
    });
    setRemoteProfilePasswords({});
    setDeletedRemoteProfileIds([]);
    setBaselineColorRules(state.settings.model.colorRules.map((rule) => ({ ...rule })));
    setColorRulesBaseRevision(state.settings.model.colorRulesRevision ?? "0");
    setColorRulesConflict(false);
    setErrorMessage(null);
  }, [state, settingsReady, dirty, colorRulesRawDraftDirty, applying]);

  useEffect(() => {
    if (!settingsReady || applying) return;
    const incomingRulesRevision = state.settings.model.colorRulesRevision ?? "0";
    setDraftState((current) => {
      if (incomingRulesRevision === colorRulesBaseRevision) {
        return {
          ...current,
          settings: {
            ...current.settings,
            model: {
              ...current.settings.model,
              colorFilterEnabled: state.settings.model.colorFilterEnabled ?? true,
              colorFilterRevision: state.settings.model.colorFilterRevision ?? "0"
            }
          }
        };
      }
      const draftRulesDirty = hasColorRuleDraftChanges(
        current.settings.model.colorRules,
        baselineColorRules,
        colorRulesRawDraftDirty
      );
      if (draftRulesDirty) {
        setColorRulesConflict(true);
        return current;
      }
      setBaselineColorRules(state.settings.model.colorRules.map((rule) => ({ ...rule })));
      setColorRulesBaseRevision(incomingRulesRevision);
      setColorRulesConflict(false);
      return {
        ...current,
        settings: {
          ...current.settings,
          model: {
            ...current.settings.model,
            colorRules: state.settings.model.colorRules.map((rule) => ({ ...rule })),
            colorFilterEnabled: state.settings.model.colorFilterEnabled ?? true,
            colorFilterRevision: state.settings.model.colorFilterRevision ?? "0",
            colorRulesRevision: incomingRulesRevision
          }
        }
      };
    });
  }, [
    applying,
    baselineColorRules,
    colorRulesBaseRevision,
    colorRulesRawDraftDirty,
    settingsReady,
    state.settings.model.colorFilterEnabled,
    state.settings.model.colorFilterRevision,
    state.settings.model.colorRules,
    state.settings.model.colorRulesRevision
  ]);

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

  const getRemoteProfileUpserts = () => {
    const deletedIds = new Set(deletedRemoteProfileIds);
    const persistedById = new Map(state.remoteProfiles.map((profile) => [profile.id, profile]));
    return draftState.remoteProfiles.filter((profile) => {
      if (deletedIds.has(profile.id)) return false;
      const persistedProfile = persistedById.get(profile.id);
      const passwordChanged = Object.prototype.hasOwnProperty.call(remoteProfilePasswords, profile.id);
      return !persistedProfile || passwordChanged || !hasSameJsonShape(persistedProfile, profile);
    });
  };

  const handleConfirm = async () => {
    if (!settingsReady || applying) {
      return;
    }
    setApplying(true);
    setErrorMessage(null);
    try {
      const model = {
        ...draftState.settings.model,
        fileAssociations: (draftState.settings.model.fileAssociations ?? []).map(normalizeAssociationRule)
      };
      const associationsError = associationRulesError(model.fileAssociations);
      if (associationsError) {
        setErrorMessage(associationsError);
        return;
      }
      const nameErrors = getColorRuleNameErrors(model.colorRules);
      const expressionResults = await Promise.all(
        model.colorRules.map(async (rule) => ({ rule, result: await actions.validateColorRule(rule.expression) }))
      );
      if (
        !colorRulesValid ||
        Object.keys(nameErrors).length > 0 ||
        expressionResults.some(({ rule, result }) => rule.enabled && !result.valid)
      ) {
        setErrorMessage("请先修复已启用颜色规则中的错误");
        return;
      }
      if (colorRulesConflict) {
        setErrorMessage("颜色规则已发生冲突，请重新加载或明确覆盖");
        return;
      }

      const steps: SettingsApplyStep[] = [];
      const hasGeneralChanges = [...dirtySections].some(
        (section) => section !== "color-rules" && section !== "connections"
      );
      if (hasGeneralChanges) {
        steps.push({
          label: "常规设置",
          run: () => actions.applySettingsModel(model, draftState.settings.section)
        });
      }

      let colorRulesConflictDuringApply = false;
      if (!hasSameJsonShape(model.colorRules, baselineColorRules)) {
        let committedRules = model.colorRules;
        let committedEnabled = model.colorFilterEnabled ?? true;
        let committedRevision = model.colorFilterRevision ?? "0";
        let committedRulesRevision = model.colorRulesRevision ?? "0";
        steps.push({
          label: "颜色规则",
          run: async () => {
            const result = await actions.replaceColorRules(model.colorRules, colorRulesBaseRevision, false);
            if (result.status === "conflict") {
              colorRulesConflictDuringApply = true;
              throw new Error("颜色规则已在其他窗口中修改");
            }
            committedRules = result.snapshot.rules.map((rule) => ({ ...rule }));
            committedEnabled = result.snapshot.enabled;
            committedRevision = result.snapshot.revision;
            committedRulesRevision = result.snapshot.rulesRevision;
          },
          onCommitted: () => {
            setDraftState((current) => ({
              ...current,
              settings: {
                ...current.settings,
                model: {
                  ...current.settings.model,
                  colorRules: committedRules,
                  colorFilterEnabled: committedEnabled,
                  colorFilterRevision: committedRevision,
                  colorRulesRevision: committedRulesRevision
                }
              }
            }));
            setBaselineColorRules(committedRules);
            setColorRulesBaseRevision(committedRulesRevision);
            setColorRulesConflict(false);
          }
        });
      }

      for (const profile of getRemoteProfileUpserts()) {
        steps.push({
          label: `连接“${profile.name}”`,
          run: () => actions.saveRemoteProfile(profile, remoteProfilePasswords[profile.id]),
          onCommitted: () => {
            setRemoteProfilePasswords((current) => {
              const { [profile.id]: _saved, ...rest } = current;
              return rest;
            });
          }
        });
      }
      for (const id of deletedRemoteProfileIds) {
        const profileName = state.remoteProfiles.find((profile) => profile.id === id)?.name ?? id;
        steps.push({
          label: `删除连接“${profileName}”`,
          run: () => actions.deleteRemoteProfile(id),
          onCommitted: () => {
            setDeletedRemoteProfileIds((current) => current.filter((currentId) => currentId !== id));
          }
        });
      }

      try {
        await runSettingsApplyPlan(steps);
      } catch (error) {
        if (colorRulesConflictDuringApply) setColorRulesConflict(true);
        throw error;
      }
      setDirty(false);
      setRemoteProfilePasswords({});
      setDeletedRemoteProfileIds([]);
      await closeSettingsWindow();
    } catch (error) {
      setErrorMessage(
        error instanceof SettingsApplyFailure
          ? formatSettingsApplyFailure(error)
          : getSettingsErrorMessage(error, "无法应用设置")
      );
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

  const reloadColorRules = () => {
    const rules = state.settings.model.colorRules.map((rule) => ({ ...rule }));
    setDraftState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        model: {
          ...current.settings.model,
          colorRules: rules,
          colorFilterEnabled: state.settings.model.colorFilterEnabled ?? true,
          colorFilterRevision: state.settings.model.colorFilterRevision ?? "0",
          colorRulesRevision: state.settings.model.colorRulesRevision ?? "0"
        }
      }
    }));
    setBaselineColorRules(rules);
    setColorRulesBaseRevision(state.settings.model.colorRulesRevision ?? "0");
    setColorRulesConflict(false);
    setColorRulesValid(true);
    setColorRulesRawDraftDirty(false);
    setColorRulesResetSequence((current) => current + 1);
    setErrorMessage(null);
  };

  const overwriteColorRules = async () => {
    if (applying || !colorRulesValid) return;
    setApplying(true);
    setErrorMessage(null);
    try {
      const latestRevision = state.settings.model.colorRulesRevision ?? "0";
      const result = await actions.replaceColorRules(draftState.settings.model.colorRules, latestRevision, true);
      if (result.status !== "applied") {
        setErrorMessage("覆盖保存颜色规则失败");
        return;
      }
      const rules = result.snapshot.rules.map((rule) => ({ ...rule }));
      setDraftState((current) => ({
        ...current,
        settings: {
          ...current.settings,
          model: {
            ...current.settings.model,
            colorRules: rules,
            colorFilterEnabled: result.snapshot.enabled,
            colorFilterRevision: result.snapshot.revision,
            colorRulesRevision: result.snapshot.rulesRevision
          }
        }
      }));
      setBaselineColorRules(rules);
      setColorRulesBaseRevision(result.snapshot.rulesRevision);
      setColorRulesConflict(false);
      setColorRulesRawDraftDirty(false);
    } catch (error) {
      setErrorMessage(getSettingsErrorMessage(error, "无法覆盖保存颜色规则"));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="settings-window-shell">
      <SettingsSurface
        onUpdateFileAssociations={(fileAssociations) => updateDraftModel(model => ({...model, fileAssociations}))}
        onChooseAssociationProgram={actions.chooseAssociationProgram}
        onInspectAssociationPrograms={actions.inspectAssociationPrograms}
        state={draftState}
        dirtySections={dirtySections}
        onSelectSection={updateDraftSection}
        onUpdateShortcut={(id, binding) =>
          updateDraftModel((model) => ({
            ...model,
            shortcuts: model.shortcuts.map((shortcut) => (shortcut.id === id ? { ...shortcut, binding } : shortcut))
          }))
        }
        onUpdateColorRules={(colorRules) =>
          updateDraftModel((model) => ({
            ...model,
            colorRules
          }))
        }
        onValidateColorRule={actions.validateColorRule}
        onOpenColorRulesHelp={() => {
          void openColorFilterHelpWindow().catch((error) => {
            setErrorMessage(getSettingsErrorMessage(error, "无法打开颜色过滤器帮助"));
          });
        }}
        onColorRulesValidityChange={setColorRulesValid}
        onColorRulesDraftDirtyChange={setColorRulesRawDraftDirty}
        colorRulesResetToken={`${colorRulesBaseRevision}:${colorRulesResetSequence}`}
        colorRulesConflict={colorRulesConflict}
        onReloadColorRules={reloadColorRules}
        onOverwriteColorRules={() => void overwriteColorRules()}
        colorRulesValid={colorRulesValid}
        onUpdatePanelFocusAccent={(color) =>
          updateDraftModel((model) => ({
            ...model,
            theme: {
              ...model.theme,
              panelFocusAccent: normalizeThemeAccentColor(color)
            }
          }))
        }
        onUpdateActiveTabBackground={(color) =>
          updateDraftModel((model) => ({
            ...model,
            theme: {
              ...model.theme,
              activeTabBackground: normalizeThemeAccentColor(color)
            }
          }))
        }
        onUpdateDropHighlightFill={(color) =>
          updateDraftModel((model) => ({
            ...model,
            theme: {
              ...model.theme,
              dropHighlightFill: normalizeThemeAccentColor(color)
            }
          }))
        }
        onUpdateDropHighlightBorder={(color) =>
          updateDraftModel((model) => ({
            ...model,
            theme: {
              ...model.theme,
              dropHighlightBorder: normalizeThemeAccentColor(color)
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
        onUpdateSizeBarColor={(endpoint, color) => updateDraftModel((model) => ({ ...model, theme: {
          ...model.theme, [endpoint]: normalizeThemeAccentColor(color, DEFAULT_THEME[endpoint])
        } }))}
        onUpdateDetailsRowHeight={(value) =>
          updateDraftModel((model) => ({
            ...model,
            detailsRowHeight: normalizeDetailsRowHeight(value)
          }))
        }
        onUpdateSizeBarMode={(value) => updateDraftModel((model) => ({ ...model, sizeBarMode: normalizeSizeBarMode(value) }))}
        onUpdateFolderExpansionEnabled={(enabled) =>
          updateDraftModel((model) => ({ ...model, folderExpansionEnabled: enabled }))
        }
        onUpdateTooltipHoverDelay={(value) =>
          updateDraftModel((model) => ({
            ...model,
            tooltipHoverDelayMs: normalizeTooltipHoverDelayMs(value)
          }))
        }
        onUpdateMetadataRetentionHours={(value) =>
          updateDraftModel((model) => ({
            ...model,
            metadataRetentionHours: normalizeMetadataRetentionHours(value)
          }))
        }
        onUpdateContextMenuDefault={(value) =>
          updateDraftModel((model) => ({
            ...model,
            contextMenu: {
              ...model.contextMenu,
              defaultMenu: normalizeContextMenuDefault(value)
            }
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
