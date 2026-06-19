import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { HexAlphaColorPicker } from "react-colorful";
import type {
  ColumnDefinition,
  RemoteConnectionProfile,
  SettingsModel,
  SettingsSection,
  ShortcutBinding,
  ShortcutScope,
  WorkspaceState
} from "./types";
import {
  eventToShortcutCaptureCandidate,
  formatShortcutBindingForDisplay,
  isReservedSystemShortcutCandidate,
  normalizeShortcutBindingForStorage
} from "./workspaceShortcuts";

export type SettingsSurfaceProps = {
  state: WorkspaceState;
  onSelectSection: (section: WorkspaceState["settings"]["section"]) => void;
  onUpdateShortcut: (id: string, binding: string) => void;
  onUpdateColorRule: (id: string, color: string) => void;
  onUpdatePanelFocusAccent: (color: string) => void;
  onUpdateActiveTabBackground: (color: string) => void;
  onUpdateDropHighlightFill: (color: string) => void;
  onUpdateDropHighlightBorder: (color: string) => void;
  onUpdateTabMinWidth: (value: number) => void;
  onUpdateDetailsRowHeight: (value: number) => void;
  onUpdateContextMenuDefault: (value: WorkspaceState["settings"]["model"]["contextMenu"]["defaultMenu"]) => void;
  onSaveRemoteProfile: (profile: RemoteConnectionProfile, password?: string) => void;
  onDeleteRemoteProfile: (id: string) => void;
  onTestRemoteProfile: (profile: RemoteConnectionProfile, password?: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  applying?: boolean;
  disabled?: boolean;
  errorMessage?: string | null;
};

type SettingsSectionDefinition = {
  id: SettingsSection;
  label: string;
  description: string;
};

type SettingsSectionGroup = {
  label: string;
  sections: SettingsSectionDefinition[];
};

const SETTINGS_SECTION_GROUPS: SettingsSectionGroup[] = [
  {
    label: "常规",
    sections: [
      { id: "shortcuts", label: "快捷键", description: "键盘操作与工作区命令" },
      { id: "file-list", label: "文件列表", description: "详细信息视图与显示列" },
      { id: "menu-mouse", label: "菜单与鼠标", description: "右键菜单默认行为" }
    ]
  },
  {
    label: "颜色和风格",
    sections: [
      { id: "appearance", label: "外观", description: "焦点强调色和标签尺寸" },
      { id: "color-rules", label: "颜色规则", description: "文件颜色预览规则" },
      { id: "tag-rules", label: "标签规则", description: "标签快速筛选" }
    ]
  },
  {
    label: "连接",
    sections: [{ id: "connections", label: "FTP/SFTP", description: "远程连接配置" }]
  }
];

const SETTINGS_SECTIONS = SETTINGS_SECTION_GROUPS.flatMap((group) => group.sections);
const SHORTCUT_SCOPE_ORDER: ShortcutScope[] = ["workspace", "panel", "listing", "context-menu"];

function getLocalizedColumnLabel(column: ColumnDefinition) {
  switch (column.id) {
    case "name":
      return "名称";
    case "type":
      return "类型";
    case "size":
      return "大小";
    case "modified":
      return "修改时间";
    case "tags":
      return "标签";
    case "location":
      return "位置";
    default:
      return column.label;
  }
}

function getShortcutScopeLabel(scope: string) {
  switch (scope) {
    case "workspace":
      return "工作区";
    case "panel":
      return "面板";
    case "listing":
      return "文件列表";
    case "context-menu":
      return "右键菜单";
    default:
      return scope;
  }
}

function getLocalizedShortcutAction(shortcut: ShortcutBinding) {
  const dictionary: Record<string, string> = {
    "focus-next-panel": "切换到下一个面板",
    "open-search": "打开搜索面板",
    "new-tab": "新建标签页",
    "close-tab": "关闭标签页",
    copy: "复制",
    cut: "剪切",
    paste: "粘贴",
    undo: "撤销",
    "create-folder": "新建文件夹",
    delete: "删除",
    rename: "重命名",
    refresh: "刷新",
    "navigate-up": "上一级",
    "navigate-forward": "前进",
    "drag-move": "拖放时移动",
    "context-menu-toggle": "右键菜单切换"
  };
  return dictionary[shortcut.id] ?? dictionary[shortcut.action] ?? shortcut.action;
}

function createEmptyRemoteProfile(): RemoteConnectionProfile {
  return {
    id: "",
    name: "",
    protocol: "sftp",
    host: "",
    port: 22,
    username: "",
    rootPath: "/",
    authKind: "password",
    passiveMode: true,
    ignoreHostKey: false,
    connectTimeoutSecs: 10,
    commandTimeoutSecs: 20
  };
}

function hasSameJsonShape(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function getShortcutConflictIds(shortcuts: SettingsModel["shortcuts"]) {
  const groups = new Map<string, string[]>();
  for (const shortcut of shortcuts) {
    const accelerator = normalizeShortcutBindingForStorage(shortcut.binding).trim().toLowerCase();
    if (!accelerator) {
      continue;
    }
    const key = `${shortcut.scope.trim().toLowerCase()}:${accelerator}`;
    groups.set(key, [...(groups.get(key) ?? []), shortcut.id]);
  }

  const conflictIds = new Set<string>();
  for (const ids of groups.values()) {
    if (ids.length > 1) {
      ids.forEach((id) => conflictIds.add(id));
    }
  }
  return conflictIds;
}

function getShortcutConflictMessage(shortcuts: SettingsModel["shortcuts"], conflictIds: Set<string>) {
  if (conflictIds.size === 0) {
    return null;
  }
  const firstConflict = shortcuts.find((shortcut) => conflictIds.has(shortcut.id));
  if (!firstConflict) {
    return "发现快捷键冲突，请调整重复绑定。";
  }
  return `发现快捷键冲突：${getShortcutScopeLabel(firstConflict.scope)} / ${formatShortcutBindingForDisplay(firstConflict.binding)}`;
}

export function SettingsSurface({
  state,
  onSelectSection,
  onUpdateShortcut,
  onUpdateColorRule,
  onUpdatePanelFocusAccent,
  onUpdateActiveTabBackground,
  onUpdateDropHighlightFill,
  onUpdateDropHighlightBorder,
  onUpdateTabMinWidth,
  onUpdateDetailsRowHeight,
  onUpdateContextMenuDefault,
  onSaveRemoteProfile,
  onDeleteRemoteProfile,
  onTestRemoteProfile,
  onConfirm,
  onCancel,
  applying = false,
  disabled = false,
  errorMessage = null
}: SettingsSurfaceProps) {
  const { settings } = state;
  const selectedSection = SETTINGS_SECTIONS.find((section) => section.id === settings.section) ?? SETTINGS_SECTIONS[0];
  const controlsDisabled = disabled || applying;
  const shortcutConflictIds = useMemo(() => getShortcutConflictIds(settings.model.shortcuts), [settings.model.shortcuts]);
  const shortcutConflictMessage = getShortcutConflictMessage(settings.model.shortcuts, shortcutConflictIds);
  const [localErrorMessage, setLocalErrorMessage] = useState<string | null>(null);
  const [remoteDraftDirty, setRemoteDraftDirty] = useState(false);
  const remoteDraftDirtyRef = useRef(false);

  const updateRemoteDraftDirty = useCallback((dirty: boolean) => {
    remoteDraftDirtyRef.current = dirty;
    setRemoteDraftDirty(dirty);
  }, []);

  useEffect(() => {
    setLocalErrorMessage(null);
  }, [settings.section]);

  const handleSelectSection = (section: SettingsSection) => {
    if (remoteDraftDirtyRef.current && section !== "connections") {
      setLocalErrorMessage("请先暂存当前连接配置或放弃修改。");
      return;
    }
    onSelectSection(section);
  };

  const handleConfirm = () => {
    if (controlsDisabled || shortcutConflictMessage) {
      return;
    }
    if (remoteDraftDirtyRef.current) {
      setLocalErrorMessage("请先暂存当前连接配置或放弃修改。");
      return;
    }
    setLocalErrorMessage(null);
    onConfirm();
  };

  const renderedErrorMessage = localErrorMessage ?? shortcutConflictMessage ?? errorMessage;
  const confirmDisabled = controlsDisabled || Boolean(shortcutConflictMessage) || remoteDraftDirty;

  return (
    <section className="settings-window" aria-labelledby="settings-window-title" aria-busy={controlsDisabled ? true : undefined}>
      <div className="settings-window__body">
        <nav className="settings-window__nav" aria-label="设置分类">
          {SETTINGS_SECTION_GROUPS.map((group) => (
            <div key={group.label} className="settings-window__nav-group">
              <strong className="settings-window__nav-heading">{group.label}</strong>
              {group.sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className={`settings-window__nav-item${settings.section === section.id ? " is-active" : ""}`}
                  aria-current={settings.section === section.id ? "page" : undefined}
                  data-section-id={section.id}
                  onClick={() => handleSelectSection(section.id)}
                  disabled={controlsDisabled}
                >
                  <span>{section.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <main className="settings-window__content" aria-labelledby="settings-window-title">
          <header className="settings-page__header">
            <h2 id="settings-window-title">{selectedSection.label}</h2>
            <p>{selectedSection.description}</p>
          </header>

          {settings.section === "shortcuts" ? (
            <ShortcutsPage
              shortcuts={settings.model.shortcuts}
              conflictIds={shortcutConflictIds}
              disabled={controlsDisabled}
              onUpdateShortcut={(id, binding) => {
                setLocalErrorMessage(null);
                onUpdateShortcut(id, binding);
              }}
            />
          ) : settings.section === "file-list" ? (
            <FileListPage
              columns={settings.model.columns}
              detailsRowHeight={settings.model.detailsRowHeight}
              disabled={controlsDisabled}
              onUpdateDetailsRowHeight={onUpdateDetailsRowHeight}
            />
          ) : settings.section === "menu-mouse" ? (
            <MenuMousePage
              defaultMenu={settings.model.contextMenu.defaultMenu}
              disabled={controlsDisabled}
              onUpdateContextMenuDefault={onUpdateContextMenuDefault}
            />
          ) : settings.section === "appearance" ? (
            <AppearancePage
              panelFocusAccent={settings.model.theme.panelFocusAccent}
              activeTabBackground={settings.model.theme.activeTabBackground}
              dropHighlightFill={settings.model.theme.dropHighlightFill}
              dropHighlightBorder={settings.model.theme.dropHighlightBorder}
              tabMinWidth={settings.model.theme.tabMinWidth}
              disabled={controlsDisabled}
              onUpdatePanelFocusAccent={onUpdatePanelFocusAccent}
              onUpdateActiveTabBackground={onUpdateActiveTabBackground}
              onUpdateDropHighlightFill={onUpdateDropHighlightFill}
              onUpdateDropHighlightBorder={onUpdateDropHighlightBorder}
              onUpdateTabMinWidth={onUpdateTabMinWidth}
            />
          ) : settings.section === "color-rules" ? (
            <ColorRulesPage colorRules={settings.model.colorRules} disabled={controlsDisabled} onUpdateColorRule={onUpdateColorRule} />
          ) : settings.section === "tag-rules" ? (
            <TagRulesPage tagRules={settings.model.tagRules} />
          ) : (
            <ConnectionsEditor
              profiles={state.remoteProfiles}
              onSave={(profile, password) => {
                setLocalErrorMessage(null);
                onSaveRemoteProfile(profile, password);
              }}
              onDeleteRemoteProfile={onDeleteRemoteProfile}
              onTest={onTestRemoteProfile}
              onDirtyChange={updateRemoteDraftDirty}
              disabled={controlsDisabled}
            />
          )}
        </main>
      </div>

      <footer className="settings-window__footer">
        {renderedErrorMessage ? (
          <span className="settings-window__error" role="alert">
            {renderedErrorMessage}
          </span>
        ) : null}
        <button type="button" className="toolbar-button toolbar-button--ghost" onClick={onCancel} disabled={applying}>
          取消
        </button>
        <button type="button" className="toolbar-button" data-action="confirm-settings" onClick={handleConfirm} disabled={confirmDisabled}>
          {applying ? "正在应用" : "确定"}
        </button>
      </footer>
    </section>
  );
}

function ShortcutsPage({
  shortcuts,
  conflictIds,
  disabled,
  onUpdateShortcut
}: {
  shortcuts: SettingsModel["shortcuts"];
  conflictIds: Set<string>;
  disabled: boolean;
  onUpdateShortcut: (id: string, binding: string) => void;
}) {
  return (
    <div className="settings-page settings-page--shortcuts">
      {SHORTCUT_SCOPE_ORDER.map((scope) => {
        const scopedShortcuts = shortcuts.filter((shortcut) => shortcut.scope === scope);
        if (scopedShortcuts.length === 0) {
          return null;
        }

        return (
          <section key={scope} className="settings-group settings-group--table">
            <header className="settings-group__header">
              <div>
                <strong>{getShortcutScopeLabel(scope)}</strong>
                <span>配置该范围内的键盘操作。</span>
              </div>
            </header>
            <div className="settings-table-scroll">
              <table className="settings-table settings-table--shortcuts">
                <thead>
                  <tr>
                    <th>功能</th>
                    <th>作用范围</th>
                    <th>快捷键</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {scopedShortcuts.map((shortcut) => {
                    const hasConflict = conflictIds.has(shortcut.id);
                    return (
                      <tr key={shortcut.id} className={hasConflict ? "has-conflict" : undefined}>
                        <td>
                          <strong>{getLocalizedShortcutAction(shortcut)}</strong>
                          <span>{shortcut.description}</span>
                        </td>
                        <td>{getShortcutScopeLabel(shortcut.scope)}</td>
                        <td>
                          <ShortcutCaptureInput shortcut={shortcut} disabled={disabled} onCommit={onUpdateShortcut} hasConflict={hasConflict} />
                        </td>
                        <td>
                          <span className={hasConflict ? "shortcut-status shortcut-status--conflict" : "shortcut-status"}>
                            {hasConflict ? "冲突" : "正常"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}

type CaptureState = "unfocused" | "capturing" | "committedFocused" | "cancelledFocused";

function ShortcutCaptureInput({
  shortcut,
  disabled,
  onCommit,
  hasConflict
}: {
  shortcut: ShortcutBinding;
  disabled: boolean;
  onCommit: (id: string, binding: string) => void;
  hasConflict: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const captureStateRef = useRef<CaptureState>("unfocused");
  const hasCommittedCurrentCaptureRef = useRef(false);
  const candidateBindingRef = useRef<string | null>(null);
  const originalBindingRef = useRef(shortcut.binding);
  const [captureState, setCaptureState] = useState<CaptureState>("unfocused");
  const [displayBinding, setDisplayBinding] = useState(formatShortcutBindingForDisplay(shortcut.binding));

  const setVisibleBinding = (nextBinding: string) => {
    setDisplayBinding(nextBinding);
    if (inputRef.current && inputRef.current.value !== nextBinding) {
      inputRef.current.value = nextBinding;
    }
  };

  useEffect(() => {
    if (inputRef.current && inputRef.current.value !== displayBinding) {
      inputRef.current.value = displayBinding;
    }
  }, [displayBinding]);

  useEffect(() => {
    if (captureStateRef.current !== "capturing") {
      setVisibleBinding(formatShortcutBindingForDisplay(shortcut.binding));
    }
    originalBindingRef.current = shortcut.binding;
  }, [shortcut.binding]);

  const transitionTo = (nextState: CaptureState) => {
    captureStateRef.current = nextState;
    setCaptureState(nextState);
  };

  const startCapture = () => {
    if (disabled) {
      return;
    }
    originalBindingRef.current = shortcut.binding;
    candidateBindingRef.current = null;
    hasCommittedCurrentCaptureRef.current = false;
    setVisibleBinding(formatShortcutBindingForDisplay(shortcut.binding));
    transitionTo("capturing");
  };

  const restoreOriginalBinding = () => {
    setVisibleBinding(formatShortcutBindingForDisplay(originalBindingRef.current));
    candidateBindingRef.current = null;
  };

  const commitCapture = (reason: "keyup" | "enter" | "blur" | "window-blur") => {
    if (captureStateRef.current !== "capturing" || hasCommittedCurrentCaptureRef.current) {
      return;
    }
    hasCommittedCurrentCaptureRef.current = true;

    const nextBinding = normalizeShortcutBindingForStorage(candidateBindingRef.current ?? "");
    if (!nextBinding || isReservedSystemShortcutCandidate(nextBinding)) {
      restoreOriginalBinding();
      transitionTo(reason === "blur" || reason === "window-blur" ? "unfocused" : "cancelledFocused");
      return;
    }

    setVisibleBinding(nextBinding);
    onCommit(shortcut.id, nextBinding);
    transitionTo(reason === "blur" || reason === "window-blur" ? "unfocused" : "committedFocused");
  };

  const cancelCapture = (nextState: CaptureState) => {
    if (captureStateRef.current !== "capturing" || hasCommittedCurrentCaptureRef.current) {
      return;
    }
    hasCommittedCurrentCaptureRef.current = true;
    restoreOriginalBinding();
    transitionTo(nextState);
  };

  useEffect(() => {
    const handleWindowBlur = () => {
      if (captureStateRef.current === "capturing") {
        commitCapture("window-blur");
      }
    };
    window.addEventListener("blur", handleWindowBlur);
    return () => window.removeEventListener("blur", handleWindowBlur);
  });

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }

    const preventTextInput = (event: Event) => {
      event.preventDefault();
    };

    const handleFocus = () => {
      if (captureStateRef.current === "unfocused") {
        startCapture();
      }
    };

    const handleClick = () => {
      if (captureStateRef.current === "committedFocused" || captureStateRef.current === "cancelledFocused") {
        startCapture();
      }
    };

    const handleBlur = () => {
      if (captureStateRef.current === "capturing") {
        commitCapture("blur");
        return;
      }
      transitionTo("unfocused");
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (disabled) {
        return;
      }
      if (captureStateRef.current === "unfocused") {
        startCapture();
      }
      if (captureStateRef.current !== "capturing") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        cancelCapture("cancelledFocused");
        return;
      }

      if (event.key === "Enter") {
        commitCapture("enter");
        return;
      }

      if (event.repeat) {
        return;
      }

      const candidate = eventToShortcutCaptureCandidate(event);
      if (!candidate) {
        return;
      }

      candidateBindingRef.current = candidate;
      setVisibleBinding(candidate);
    };

    const handleKeyUp = (event: globalThis.KeyboardEvent) => {
      if (disabled || captureStateRef.current !== "capturing") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (candidateBindingRef.current) {
        commitCapture("keyup");
      }
    };

    input.addEventListener("focus", handleFocus);
    input.addEventListener("click", handleClick);
    input.addEventListener("blur", handleBlur);
    input.addEventListener("keydown", handleKeyDown);
    input.addEventListener("keyup", handleKeyUp);
    input.addEventListener("beforeinput", preventTextInput);
    input.addEventListener("input", preventTextInput);
    input.addEventListener("paste", preventTextInput);
    input.addEventListener("dragover", preventTextInput);
    input.addEventListener("drop", preventTextInput);
    input.addEventListener("compositionstart", preventTextInput);
    input.addEventListener("compositionupdate", preventTextInput);
    input.addEventListener("compositionend", preventTextInput);

    return () => {
      input.removeEventListener("focus", handleFocus);
      input.removeEventListener("click", handleClick);
      input.removeEventListener("blur", handleBlur);
      input.removeEventListener("keydown", handleKeyDown);
      input.removeEventListener("keyup", handleKeyUp);
      input.removeEventListener("beforeinput", preventTextInput);
      input.removeEventListener("input", preventTextInput);
      input.removeEventListener("paste", preventTextInput);
      input.removeEventListener("dragover", preventTextInput);
      input.removeEventListener("drop", preventTextInput);
      input.removeEventListener("compositionstart", preventTextInput);
      input.removeEventListener("compositionupdate", preventTextInput);
      input.removeEventListener("compositionend", preventTextInput);
    };
  });

  return (
    <input
      ref={inputRef}
      type="text"
      className={`shortcut-capture${captureState === "capturing" ? " is-capturing" : ""}`}
      defaultValue={displayBinding}
      readOnly
      data-shortcut-id={shortcut.id}
      aria-label={`${getLocalizedShortcutAction(shortcut)} 的快捷键`}
      aria-invalid={hasConflict ? true : undefined}
      disabled={disabled}
    />
  );
}

function FileListPage({
  columns,
  detailsRowHeight,
  disabled,
  onUpdateDetailsRowHeight
}: {
  columns: SettingsModel["columns"];
  detailsRowHeight: number;
  disabled: boolean;
  onUpdateDetailsRowHeight: (value: number) => void;
}) {
  return (
    <div className="settings-page">
      <section className="settings-group">
        <header className="settings-group__header">
          <div>
            <strong>详细信息视图</strong>
            <span>调整文件列表行高。</span>
          </div>
        </header>
        <div className="settings-row">
          <div>
            <strong>行高</strong>
            <span>范围 24px - 72px</span>
          </div>
          <label className="settings-control-inline">
            <input
              type="number"
              min={24}
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
      </section>

      <section className="settings-group">
        <header className="settings-group__header">
          <div>
            <strong>显示列</strong>
            <span>当前列设置为只读预览。</span>
          </div>
        </header>
        <div className="settings-table-scroll">
          <div className="settings-table settings-table--columns" role="table" aria-label="显示列">
            {columns.map((column) => (
              <div key={column.id} className="column-toggle column-toggle--readonly" role="row">
                <span>{getLocalizedColumnLabel(column)}</span>
                <small>{column.visible ? "显示" : "隐藏"}</small>
                <small>{column.width}</small>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function MenuMousePage({
  defaultMenu,
  disabled,
  onUpdateContextMenuDefault
}: {
  defaultMenu: SettingsModel["contextMenu"]["defaultMenu"];
  disabled: boolean;
  onUpdateContextMenuDefault: (value: SettingsModel["contextMenu"]["defaultMenu"]) => void;
}) {
  return (
    <div className="settings-page">
      <section className="settings-group">
        <header className="settings-group__header">
          <div>
            <strong>右键菜单</strong>
            <span>选择普通右键优先打开的菜单类型。</span>
          </div>
        </header>
        <div className="settings-row">
          <div>
            <strong>默认右键菜单</strong>
            <span>Ctrl/Shift 组合行为仍按文件列表快捷键设置判断。</span>
          </div>
          <div className="settings-segmented" role="group" aria-label="默认右键菜单">
            <button
              type="button"
              className={defaultMenu === "native" ? "is-active" : undefined}
              data-context-menu-value="native"
              onClick={() => onUpdateContextMenuDefault("native")}
              disabled={disabled}
            >
              Windows 系统
            </button>
            <button
              type="button"
              className={defaultMenu === "custom" ? "is-active" : undefined}
              data-context-menu-value="custom"
              onClick={() => onUpdateContextMenuDefault("custom")}
              disabled={disabled}
            >
              软件自定义
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const HEX_BASE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function normalizeRenderableThemeColor(value: string, fallback: string) {
  const trimmed = value.trim();
  if (HEX_COLOR_PATTERN.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return fallback;
}

function clampOpacityPercent(value: number) {
  if (!Number.isFinite(value)) {
    return 100;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

function getThemeColorBase(value: string, fallback: string) {
  return normalizeRenderableThemeColor(value, fallback).slice(0, 7);
}

function getThemeColorOpacityPercent(value: string, fallback: string) {
  const normalized = normalizeRenderableThemeColor(value, fallback);
  if (normalized.length !== 9) {
    return 100;
  }
  return clampOpacityPercent((Number.parseInt(normalized.slice(7, 9), 16) / 255) * 100);
}

function formatThemeColor(baseColor: string, opacityPercent: number) {
  const normalizedBase = HEX_BASE_COLOR_PATTERN.test(baseColor.trim()) ? baseColor.trim().toLowerCase() : "#0f6cbd";
  const alpha = Math.round((clampOpacityPercent(opacityPercent) / 100) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${normalizedBase}${alpha}`;
}

function ThemeColorControl({
  value,
  fallback,
  settingId,
  disabled,
  isOpen,
  onOpenChange,
  onUpdate
}: {
  value: string;
  fallback: string;
  settingId: string;
  disabled: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdate: (color: string) => void;
}) {
  const normalizedColor = normalizeRenderableThemeColor(value, fallback);
  const colorBase = getThemeColorBase(value, fallback);
  const opacity = getThemeColorOpacityPercent(value, fallback);
  const [hexDraft, setHexDraft] = useState(normalizedColor);
  const controlRef = useRef<HTMLDivElement | null>(null);
  const panelId = `${settingId}-color-panel`;

  useEffect(() => {
    setHexDraft(normalizedColor);
  }, [normalizedColor]);

  useEffect(() => {
    if (disabled && isOpen) {
      onOpenChange(false);
    }
  }, [disabled, isOpen, onOpenChange]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handleDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && controlRef.current?.contains(target)) {
        return;
      }
      onOpenChange(false);
    };

    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    };

    document.addEventListener("mousedown", handleDocumentMouseDown);
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleDocumentMouseDown);
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [isOpen, onOpenChange]);

  const handlePickerChange = (color: string) => {
    if (disabled) {
      return;
    }
    onUpdate(normalizeRenderableThemeColor(color, fallback));
  };

  const handleHexInput = (nextValue: string) => {
    setHexDraft(nextValue);
    const trimmed = nextValue.trim();
    if (/^#[0-9a-fA-F]{8}$/.test(trimmed)) {
      onUpdate(trimmed.toLowerCase());
      return;
    }
    if (HEX_BASE_COLOR_PATTERN.test(trimmed)) {
      onUpdate(formatThemeColor(trimmed, opacity));
    }
  };

  const handleHexBlur = () => {
    if (!HEX_COLOR_PATTERN.test(hexDraft.trim()) && !HEX_BASE_COLOR_PATTERN.test(hexDraft.trim())) {
      setHexDraft(normalizedColor);
    }
  };

  return (
    <div className={isOpen ? "theme-color-control is-open" : "theme-color-control"} ref={controlRef}>
      <button
        type="button"
        className="theme-color-control__trigger"
        data-setting-id={settingId}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? panelId : undefined}
        title={normalizedColor}
        onClick={() => {
          if (!disabled) {
            onOpenChange(!isOpen);
          }
        }}
        disabled={disabled}
      >
        <span className="theme-color-control__swatch-frame" aria-hidden="true">
          <span className="theme-color-control__swatch" style={{ backgroundColor: normalizedColor }} />
        </span>
        <span className="theme-color-control__value">{normalizedColor}</span>
      </button>
      {isOpen ? (
        <div className="theme-color-control__panel" id={panelId} role="dialog" aria-label="Color picker">
          <HexAlphaColorPicker
            color={normalizedColor}
            onChange={handlePickerChange}
            className="theme-color-control__picker"
          />
          <div className="theme-color-control__fields">
            <label>
              <span>HEX</span>
              <input
                type="text"
                value={hexDraft}
                data-setting-id={`${settingId}-hex`}
                spellCheck={false}
                onInput={(event) => handleHexInput(event.currentTarget.value)}
                onBlur={handleHexBlur}
              />
            </label>
            <label>
              <span>Alpha</span>
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={String(opacity)}
                data-setting-id={`${settingId}-opacity`}
                onInput={(event) => onUpdate(formatThemeColor(colorBase, Number(event.currentTarget.value)))}
              />
            </label>
            <span className="theme-color-control__panel-value">{normalizedColor}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AppearancePage({
  panelFocusAccent,
  activeTabBackground,
  dropHighlightFill,
  dropHighlightBorder,
  tabMinWidth,
  disabled,
  onUpdatePanelFocusAccent,
  onUpdateActiveTabBackground,
  onUpdateDropHighlightFill,
  onUpdateDropHighlightBorder,
  onUpdateTabMinWidth
}: {
  panelFocusAccent: string;
  activeTabBackground: string;
  dropHighlightFill: string;
  dropHighlightBorder: string;
  tabMinWidth: number;
  disabled: boolean;
  onUpdatePanelFocusAccent: (color: string) => void;
  onUpdateActiveTabBackground: (color: string) => void;
  onUpdateDropHighlightFill: (color: string) => void;
  onUpdateDropHighlightBorder: (color: string) => void;
  onUpdateTabMinWidth: (value: number) => void;
}) {
  const [openThemeColorId, setOpenThemeColorId] = useState<string | null>(null);
  const setThemeColorOpen = useCallback((settingId: string, open: boolean) => {
    setOpenThemeColorId(open ? settingId : null);
  }, []);

  return (
    <div className="settings-page">
      <section className="settings-group">
        <header className="settings-group__header">
          <div>
            <strong>面板</strong>
            <span>控制当前焦点面板的强调色。</span>
          </div>
        </header>
        <div className="settings-row">
          <div>
            <strong>焦点强调色</strong>
            <span>用于活动面板顶部强调线。</span>
          </div>
          <ThemeColorControl
            value={panelFocusAccent}
            fallback="#0f6cbd"
            settingId="panel-focus-accent"
            disabled={disabled}
            isOpen={openThemeColorId === "panel-focus-accent"}
            onOpenChange={(open) => setThemeColorOpen("panel-focus-accent", open)}
            onUpdate={onUpdatePanelFocusAccent}
          />
        </div>
        <div className="settings-row">
          <div>
            <strong>活动选项卡背景色</strong>
            <span>与焦点强调色配对，用于当前焦点面板的活动选项卡背景。</span>
          </div>
          <ThemeColorControl
            value={activeTabBackground}
            fallback="#ffffff"
            settingId="active-tab-background"
            disabled={disabled}
            isOpen={openThemeColorId === "active-tab-background"}
            onOpenChange={(open) => setThemeColorOpen("active-tab-background", open)}
            onUpdate={onUpdateActiveTabBackground}
          />
        </div>
        <div className="settings-row">
          <div>
            <strong>拖拽填充色</strong>
            <span>用于列表、文件夹行和标签页的拖拽高亮底色。</span>
          </div>
          <ThemeColorControl
            value={dropHighlightFill}
            fallback="#0f6cbd"
            settingId="drop-highlight-fill"
            disabled={disabled}
            isOpen={openThemeColorId === "drop-highlight-fill"}
            onOpenChange={(open) => setThemeColorOpen("drop-highlight-fill", open)}
            onUpdate={onUpdateDropHighlightFill}
          />
        </div>
        <div className="settings-row">
          <div>
            <strong>拖拽描边色</strong>
            <span>用于拖拽目标边框和强调线。</span>
          </div>
          <ThemeColorControl
            value={dropHighlightBorder}
            fallback="#0f6cbd"
            settingId="drop-highlight-border"
            disabled={disabled}
            isOpen={openThemeColorId === "drop-highlight-border"}
            onOpenChange={(open) => setThemeColorOpen("drop-highlight-border", open)}
            onUpdate={onUpdateDropHighlightBorder}
          />
        </div>
      </section>

      <section className="settings-group">
        <header className="settings-group__header">
          <div>
            <strong>标签页</strong>
            <span>控制标签页最小宽度。</span>
          </div>
        </header>
        <div className="settings-row">
          <div>
            <strong>最小宽度</strong>
            <span>最低 1px</span>
          </div>
          <label className="settings-control-inline">
            <input
              type="number"
              min={1}
              step={1}
              value={String(tabMinWidth)}
              data-setting-id="tab-min-width"
              onInput={(event) => onUpdateTabMinWidth(Number(event.currentTarget.value))}
              disabled={disabled}
            />
            <span>px</span>
          </label>
        </div>
      </section>
    </div>
  );
}

function ColorRulesPage({
  colorRules,
  disabled,
  onUpdateColorRule
}: {
  colorRules: SettingsModel["colorRules"];
  disabled: boolean;
  onUpdateColorRule: (id: string, color: string) => void;
}) {
  return (
    <div className="settings-page">
      <section className="settings-group settings-group--table">
        <header className="settings-group__header">
          <div>
            <strong>规则列表</strong>
            <span>预览扩展名、属性和标签颜色。</span>
          </div>
        </header>
        <div className="settings-table-scroll">
          <table className="settings-table settings-table--rules">
            <thead>
              <tr>
                <th>规则</th>
                <th>匹配</th>
                <th>颜色</th>
                <th>预览</th>
              </tr>
            </thead>
            <tbody>
              {colorRules.map((rule) => (
                <tr key={rule.id}>
                  <td>{rule.label}</td>
                  <td>{rule.matcher}</td>
                  <td>
                    <input
                      type="color"
                      value={rule.color}
                      data-color-rule-id={rule.id}
                      onInput={(event) => onUpdateColorRule(rule.id, event.currentTarget.value)}
                      disabled={disabled}
                    />
                  </td>
                  <td>{rule.previewText}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function TagRulesPage({ tagRules }: { tagRules: SettingsModel["tagRules"] }) {
  return (
    <div className="settings-page">
      <section className="settings-group settings-group--table">
        <header className="settings-group__header">
          <div>
            <strong>规则列表</strong>
            <span>用于快速定位带标签的文件和文件夹。</span>
          </div>
        </header>
        <div className="settings-table-scroll">
          <table className="settings-table settings-table--rules">
            <thead>
              <tr>
                <th>规则</th>
                <th>匹配</th>
                <th>快速筛选</th>
              </tr>
            </thead>
            <tbody>
              {tagRules.map((rule) => (
                <tr key={rule.id}>
                  <td>{rule.label}</td>
                  <td>{rule.matcher}</td>
                  <td>
                    <span className="settings-readonly-value">{rule.quickFilter}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function normalizeRemoteProfileDraft(profile: RemoteConnectionProfile): RemoteConnectionProfile {
  return {
    ...profile,
    name: profile.name.trim(),
    host: profile.host.trim(),
    username: profile.username.trim(),
    rootPath: profile.rootPath.trim() || "/",
    port: Number(profile.port) || (profile.protocol === "ftp" ? 21 : 22),
    connectTimeoutSecs: Number(profile.connectTimeoutSecs) || 10,
    commandTimeoutSecs: Number(profile.commandTimeoutSecs) || 20
  };
}

function isRemoteProfileDraftDirty(draft: RemoteConnectionProfile, baseline: RemoteConnectionProfile, password: string) {
  return password.length > 0 || !hasSameJsonShape(normalizeRemoteProfileDraft(draft), normalizeRemoteProfileDraft(baseline));
}

function ConnectionsEditor({
  profiles,
  onSave,
  onDeleteRemoteProfile,
  onTest,
  onDirtyChange,
  disabled = false
}: {
  profiles: RemoteConnectionProfile[];
  onSave: (profile: RemoteConnectionProfile, password?: string) => void;
  onDeleteRemoteProfile: (id: string) => void;
  onTest: (profile: RemoteConnectionProfile, password?: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  disabled?: boolean;
}) {
  const initialProfile = profiles[0] ?? createEmptyRemoteProfile();
  const [selectedId, setSelectedId] = useState<string>(profiles[0]?.id ?? "new");
  const [draft, setDraft] = useState<RemoteConnectionProfile>(initialProfile);
  const [baseline, setBaseline] = useState<RemoteConnectionProfile>(initialProfile);
  const [password, setPassword] = useState("");
  const [warning, setWarning] = useState<string | null>(null);

  const dirty = isRemoteProfileDraftDirty(draft, baseline, password);

  const updateDraft = (nextDraft: RemoteConnectionProfile) => {
    onDirtyChange(isRemoteProfileDraftDirty(nextDraft, baseline, password));
    setDraft(nextDraft);
  };

  const updatePassword = (nextPassword: string) => {
    onDirtyChange(isRemoteProfileDraftDirty(draft, baseline, nextPassword));
    setPassword(nextPassword);
  };

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (dirty) {
      return;
    }

    if (selectedId === "new") {
      const empty = createEmptyRemoteProfile();
      setDraft(empty);
      setBaseline(empty);
      setPassword("");
      onDirtyChange(false);
      return;
    }

    const selectedProfile = profiles.find((profile) => profile.id === selectedId);
    if (selectedProfile) {
      setDraft(selectedProfile);
      setBaseline(selectedProfile);
      setPassword("");
      onDirtyChange(false);
      return;
    }

    const fallback = profiles[0] ?? createEmptyRemoteProfile();
    setSelectedId(profiles[0]?.id ?? "new");
    setDraft(fallback);
    setBaseline(fallback);
    setPassword("");
    onDirtyChange(false);
  }, [profiles, selectedId, dirty, onDirtyChange]);

  const selectProfile = (id: string) => {
    if (disabled) {
      return;
    }
    if (dirty) {
      setWarning("请先暂存当前连接配置或放弃修改。");
      return;
    }
    setWarning(null);
    if (id === "new") {
      const empty = createEmptyRemoteProfile();
      setSelectedId("new");
      setDraft(empty);
      setBaseline(empty);
      setPassword("");
      onDirtyChange(false);
      return;
    }

    const profile = profiles.find((item) => item.id === id);
    if (profile) {
      setSelectedId(profile.id);
      setDraft(profile);
      setBaseline(profile);
      setPassword("");
      onDirtyChange(false);
    }
  };

  const commitProfile = (mode: "save" | "test") => {
    if (disabled) {
      return;
    }
    const profile = normalizeRemoteProfileDraft({
      ...draft,
      id:
        draft.id ||
        (typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `remote-${Date.now()}`)
    });

    if (mode === "save") {
      onSave(profile, password || undefined);
      setSelectedId(profile.id);
      setDraft(profile);
      setBaseline(profile);
      setPassword("");
      onDirtyChange(false);
      setWarning(null);
      return;
    }

    onTest(profile, password || undefined);
  };

  return (
    <div className="settings-page settings-page--connections">
      <section className="settings-group settings-group--connections">
        <header className="settings-group__header">
          <div>
            <strong>远程连接</strong>
            <span>创建、测试并管理 FTP/SFTP 连接配置。</span>
          </div>
          <button type="button" className="toolbar-button toolbar-button--ghost" onClick={() => selectProfile("new")} disabled={disabled}>
            新建配置
          </button>
        </header>

        <div className="connections-editor">
          <div className="connections-editor__list" aria-label="远程连接配置列表">
            {profiles.length > 0 ? (
              profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className={`connection-list-item${selectedId === profile.id ? " is-active" : ""}`}
                  onClick={() => selectProfile(profile.id)}
                  disabled={disabled}
                >
                  <span>{profile.name}</span>
                  <small>
                    {profile.protocol.toUpperCase()} - {profile.host}:{profile.port}
                  </small>
                </button>
              ))
            ) : (
              <div className="search-empty">
                <strong>暂无远程连接配置</strong>
                <span>暂存配置并点击确定后，它会显示在远程功能列表中。</span>
              </div>
            )}
          </div>

          <div className="connections-editor__form">
            {warning || dirty ? (
              <div className="settings-inline-warning">{warning ?? "当前连接配置尚未暂存。"}</div>
            ) : null}

            <div className="settings-form-grid">
              <SettingsField label="名称" htmlFor="remote-name">
                <input
                  id="remote-name"
                  data-setting-id="remote-name"
                  type="text"
                  value={draft.name}
                  onInput={(event) => updateDraft({ ...draft, name: event.currentTarget.value })}
                  disabled={disabled}
                />
              </SettingsField>
              <SettingsField label="协议" htmlFor="remote-protocol">
                <select
                  id="remote-protocol"
                  value={draft.protocol}
                  onChange={(event) =>
                    updateDraft({
                      ...draft,
                      protocol: event.currentTarget.value as RemoteConnectionProfile["protocol"],
                      port: event.currentTarget.value === "ftp" ? 21 : 22,
                      authKind: event.currentTarget.value === "ftp" && draft.authKind === "keyFile" ? "password" : draft.authKind
                    })
                  }
                  disabled={disabled}
                >
                  <option value="sftp">SFTP</option>
                  <option value="ftp">FTP</option>
                </select>
              </SettingsField>
              <SettingsField label="主机" htmlFor="remote-host">
                <input
                  id="remote-host"
                  type="text"
                  value={draft.host}
                  onInput={(event) => updateDraft({ ...draft, host: event.currentTarget.value })}
                  disabled={disabled}
                />
              </SettingsField>
              <SettingsField label="端口" htmlFor="remote-port">
                <input
                  id="remote-port"
                  type="number"
                  value={String(draft.port)}
                  onInput={(event) => updateDraft({ ...draft, port: Number(event.currentTarget.value) })}
                  disabled={disabled}
                />
              </SettingsField>
              <SettingsField label="用户名" htmlFor="remote-user">
                <input
                  id="remote-user"
                  type="text"
                  value={draft.username}
                  onInput={(event) => updateDraft({ ...draft, username: event.currentTarget.value })}
                  disabled={disabled || draft.authKind === "anonymous"}
                />
              </SettingsField>
              <SettingsField label="根路径" htmlFor="remote-root">
                <input
                  id="remote-root"
                  type="text"
                  value={draft.rootPath}
                  onInput={(event) => updateDraft({ ...draft, rootPath: event.currentTarget.value })}
                  disabled={disabled}
                />
              </SettingsField>
              <SettingsField label="认证方式" htmlFor="remote-auth">
                <select
                  id="remote-auth"
                  value={draft.authKind}
                  onChange={(event) => updateDraft({ ...draft, authKind: event.currentTarget.value as RemoteConnectionProfile["authKind"] })}
                  disabled={disabled}
                >
                  <option value="password">密码</option>
                  <option value="keyFile" disabled={disabled || draft.protocol === "ftp"}>
                    密钥文件
                  </option>
                  <option value="anonymous" disabled={disabled || draft.protocol === "sftp"}>
                    匿名
                  </option>
                </select>
              </SettingsField>
              {draft.authKind === "keyFile" ? (
                <SettingsField label="私钥路径" htmlFor="remote-key">
                  <input
                    id="remote-key"
                    type="text"
                    value={draft.privateKeyPath ?? ""}
                    onInput={(event) => updateDraft({ ...draft, privateKeyPath: event.currentTarget.value })}
                    disabled={disabled}
                  />
                </SettingsField>
              ) : (
                <SettingsField label="密码" htmlFor="remote-password">
                  <input
                    id="remote-password"
                    type="password"
                    value={password}
                    onInput={(event) => updatePassword(event.currentTarget.value)}
                    placeholder={selectedId === "new" ? "保存或测试时请输入密码" : "留空则保留已存储的凭据"}
                    disabled={disabled || draft.authKind === "anonymous"}
                  />
                </SettingsField>
              )}
              <SettingsField label="连接超时" htmlFor="remote-connect-timeout">
                <input
                  id="remote-connect-timeout"
                  type="number"
                  value={String(draft.connectTimeoutSecs)}
                  onInput={(event) => updateDraft({ ...draft, connectTimeoutSecs: Number(event.currentTarget.value) })}
                  disabled={disabled}
                />
              </SettingsField>
              <SettingsField label="命令超时" htmlFor="remote-command-timeout">
                <input
                  id="remote-command-timeout"
                  type="number"
                  value={String(draft.commandTimeoutSecs)}
                  onInput={(event) => updateDraft({ ...draft, commandTimeoutSecs: Number(event.currentTarget.value) })}
                  disabled={disabled}
                />
              </SettingsField>
            </div>

            <div className="settings-toggle-grid">
              <label className="column-toggle settings-field">
                <input
                  type="checkbox"
                  checked={draft.passiveMode}
                  onChange={() => updateDraft({ ...draft, passiveMode: !draft.passiveMode })}
                  disabled={disabled}
                />
                <span>被动模式</span>
                <small>FTP</small>
              </label>
              <label className="column-toggle settings-field">
                <input
                  type="checkbox"
                  checked={draft.ignoreHostKey}
                  onChange={() => updateDraft({ ...draft, ignoreHostKey: !draft.ignoreHostKey })}
                  disabled={disabled}
                />
                <span>忽略主机密钥</span>
                <small>谨慎使用</small>
              </label>
            </div>

            <div className="settings-form-actions">
              <button type="button" className="toolbar-button" onClick={() => commitProfile("test")} disabled={disabled}>
                测试连接
              </button>
              <button
                type="button"
                className="toolbar-button toolbar-button--ghost"
                onClick={() => {
                  const deletingId = draft.id;
                  if (!deletingId) {
                    return;
                  }
                  onDeleteRemoteProfile(deletingId);
                  selectProfile("new");
                }}
                disabled={disabled || !draft.id}
              >
                移除配置
              </button>
              <button type="button" className="toolbar-button" onClick={() => commitProfile("save")} disabled={disabled}>
                暂存配置
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function SettingsField({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="settings-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}
