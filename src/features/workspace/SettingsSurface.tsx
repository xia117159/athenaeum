import { useEffect, useState } from "react";
import type { ColumnDefinition, RemoteConnectionProfile, WorkspaceState } from "./types";

export type SettingsSurfaceProps = {
  state: WorkspaceState;
  onSelectSection: (section: WorkspaceState["settings"]["section"]) => void;
  onUpdateShortcut: (id: string, binding: string) => void;
  onUpdateColorRule: (id: string, color: string) => void;
  onUpdatePanelFocusAccent: (color: string) => void;
  onUpdateTabMinWidth: (value: number) => void;
  onUpdateDetailsRowHeight: (value: number) => void;
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
  id: WorkspaceState["settings"]["section"];
  label: string;
  description: string;
};

const SETTINGS_SECTIONS: SettingsSectionDefinition[] = [
  {
    id: "shortcuts",
    label: "快捷键",
    description: "键盘操作与工作区命令"
  },
  {
    id: "theme",
    label: "主题",
    description: "焦点面板顶部强调色"
  },
  {
    id: "rules",
    label: "规则与列",
    description: "颜色规则、标签和列表列"
  },
  {
    id: "connections",
    label: "连接",
    description: "FTP/SFTP 远程配置"
  }
];

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

function getLocalizedShortcutAction(action: string) {
  const dictionary: Record<string, string> = {
    Copy: "复制",
    Paste: "粘贴",
    Delete: "删除",
    Rename: "重命名",
    Refresh: "刷新",
    "Next panel": "切换到下一个面板",
    "Search drawer": "打开搜索面板",
    "New tab": "新建标签页",
    "Close tab": "关闭标签页",
    "Navigate up": "上一级",
    "navigate-up": "上一级",
    "Navigate forward": "回到下一级",
    "navigate-forward": "回到下一级",
    "Drag move": "拖放时移动",
    "drag-move": "拖放时移动",
    "切换到下一个面板": "切换到下一个面板",
    "打开搜索面板": "打开搜索面板",
    "新建标签页": "新建标签页",
    "关闭标签页": "关闭标签页",
    "拖放时移动": "拖放时移动"
  };
  return dictionary[action] ?? action;
}

function getShortcutScopeLabel(scope: string) {
  switch (scope) {
    case "workspace":
      return "工作区";
    case "panel":
      return "面板";
    case "listing":
      return "列表";
    default:
      return scope;
  }
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

export function SettingsSurface({
  state,
  onSelectSection,
  onUpdateShortcut,
  onUpdateColorRule,
  onUpdatePanelFocusAccent,
  onUpdateTabMinWidth,
  onUpdateDetailsRowHeight,
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

  return (
    <section className="settings-window" aria-labelledby="settings-window-title" aria-busy={controlsDisabled ? true : undefined}>
        <header className="settings-window__header">
          <div>
            <h2 id="settings-window-title">设置</h2>
            <p>调整快捷键、显示规则和远程连接配置。</p>
          </div>
        </header>

        <div className="settings-window__body">
          <nav className="settings-window__nav" aria-label="设置分类">
            {SETTINGS_SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`settings-window__nav-item${settings.section === section.id ? " is-active" : ""}`}
                aria-current={settings.section === section.id ? "page" : undefined}
                onClick={() => onSelectSection(section.id)}
              >
                <span>{section.label}</span>
                <small>{section.description}</small>
              </button>
            ))}
          </nav>

          <main className="settings-window__content" aria-labelledby="settings-section-title">
            <div className="settings-window__section-title">
              <h3 id="settings-section-title">{selectedSection.label}</h3>
              <span>{selectedSection.description}</span>
            </div>

            {settings.section === "shortcuts" ? (
              <div className="settings-list">
                {settings.model.shortcuts.map((shortcut) => (
                  <div key={shortcut.id} className="settings-card">
                    <div>
                      <strong>{getLocalizedShortcutAction(shortcut.action)}</strong>
                      <span>
                        {getShortcutScopeLabel(shortcut.scope)} | {shortcut.description}
                      </span>
                    </div>
                    <input
                      type="text"
                      value={shortcut.binding}
                      onChange={(event) => onUpdateShortcut(shortcut.id, event.target.value)}
                      aria-label={`${getLocalizedShortcutAction(shortcut.action)} 的快捷键`}
                      disabled={controlsDisabled}
                    />
                  </div>
                ))}
              </div>
            ) : settings.section === "theme" ? (
              <div className="settings-list">
                <section className="settings-group">
                  <header>
                    <strong>主题</strong>
                    <span>配置当前焦点面板强调色和 Tab 选项卡尺寸。</span>
                  </header>
                  <div className="settings-card">
                    <div>
                      <strong>面板焦点强调色</strong>
                      <span>拥有焦点的标签页面板会在顶部显示该颜色。</span>
                    </div>
                    <div className="settings-card__inline">
                      <input
                        type="color"
                        value={settings.model.theme.panelFocusAccent}
                        onInput={(event) => onUpdatePanelFocusAccent(event.currentTarget.value)}
                        aria-label="面板焦点强调色"
                        disabled={controlsDisabled}
                      />
                      <span>{settings.model.theme.panelFocusAccent}</span>
                    </div>
                  </div>
                  <div className="settings-card">
                    <div>
                      <strong>Tab 选项卡最小宽度</strong>
                      <span>最低 1px</span>
                    </div>
                    <div className="settings-card__inline">
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={String(settings.model.theme.tabMinWidth)}
                        onInput={(event) => onUpdateTabMinWidth(Number(event.currentTarget.value))}
                        aria-label="Tab 选项卡最小宽度"
                        disabled={controlsDisabled}
                      />
                      <span>{settings.model.theme.tabMinWidth}px</span>
                    </div>
                  </div>
                </section>
              </div>
            ) : settings.section === "connections" ? (
              <ConnectionsEditor
                profiles={state.remoteProfiles}
                onSave={onSaveRemoteProfile}
                onDelete={onDeleteRemoteProfile}
                onTest={onTestRemoteProfile}
                disabled={controlsDisabled}
              />
            ) : (
              <div className="settings-list">
                <section className="settings-group">
                  <header>
                    <strong>颜色规则</strong>
                    <span>预览扩展名、属性和标签颜色。</span>
                  </header>
                  {settings.model.colorRules.map((rule) => (
                    <div key={rule.id} className="settings-card">
                      <div>
                        <strong>{rule.label}</strong>
                        <span>{rule.matcher}</span>
                      </div>
                      <div className="settings-card__inline">
                        <input
                          type="color"
                          value={rule.color}
                          onChange={(event) => onUpdateColorRule(rule.id, event.target.value)}
                          aria-label={`${rule.label} 的颜色`}
                          disabled={controlsDisabled}
                        />
                        <span>{rule.previewText}</span>
                      </div>
                    </div>
                  ))}
                </section>

                <section className="settings-group">
                  <header>
                    <strong>列表外观</strong>
                    <span>控制详细信息列表项高度，默认 24px。</span>
                  </header>
                  <div className="settings-card">
                    <div>
                      <strong>详细列表项高度</strong>
                      <span>范围 24px - 72px</span>
                    </div>
                    <div className="settings-card__inline">
                      <input
                        type="number"
                        min={24}
                        max={72}
                        step={2}
                        value={String(settings.model.detailsRowHeight)}
                        onChange={(event) => onUpdateDetailsRowHeight(Number(event.target.value))}
                        aria-label="详细列表项高度"
                        disabled={controlsDisabled}
                      />
                      <span>{settings.model.detailsRowHeight}px</span>
                    </div>
                  </div>
                </section>

                <section className="settings-group">
                  <header>
                    <strong>标签规则</strong>
                    <span>用于快速定位带标签的文件和文件夹。</span>
                  </header>
                  {settings.model.tagRules.map((rule) => (
                    <div key={rule.id} className="settings-card">
                      <div>
                        <strong>{rule.label}</strong>
                        <span>{rule.matcher}</span>
                      </div>
                      <span className="settings-readonly-value">{rule.quickFilter}</span>
                    </div>
                  ))}
                </section>

                <section className="settings-group">
                  <header>
                    <strong>显示列</strong>
                    <span>控制详细信息视图的显示列。</span>
                  </header>
                  {settings.model.columns.map((column) => (
                    <div key={column.id} className="column-toggle column-toggle--readonly">
                      <span>{getLocalizedColumnLabel(column)}</span>
                      <small>{column.visible ? "显示" : "隐藏"}</small>
                      <small>{column.width}</small>
                    </div>
                  ))}
                </section>
              </div>
            )}
          </main>
        </div>
        <footer className="settings-window__footer">
          {errorMessage ? <span className="settings-window__error">{errorMessage}</span> : null}
          <button type="button" className="toolbar-button toolbar-button--ghost" onClick={onCancel} disabled={applying}>
            取消
          </button>
          <button type="button" className="toolbar-button" onClick={onConfirm} disabled={controlsDisabled}>
            {applying ? "正在应用" : "确定"}
          </button>
        </footer>
      </section>
  );
}

function ConnectionsEditor({
  profiles,
  onSave,
  onDelete,
  onTest,
  disabled = false
}: {
  profiles: RemoteConnectionProfile[];
  onSave: (profile: RemoteConnectionProfile, password?: string) => void;
  onDelete: (id: string) => void;
  onTest: (profile: RemoteConnectionProfile, password?: string) => void;
  disabled?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string>(profiles[0]?.id ?? "new");
  const [draft, setDraft] = useState<RemoteConnectionProfile>(() => profiles[0] ?? createEmptyRemoteProfile());
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (selectedId === "new") {
      if (profiles.length === 0) {
        setDraft(createEmptyRemoteProfile());
      }
      return;
    }

    const selectedProfile = profiles.find((profile) => profile.id === selectedId);
    if (selectedProfile) {
      setDraft(selectedProfile);
      setPassword("");
      return;
    }

    setSelectedId(profiles[0]?.id ?? "new");
    setDraft(profiles[0] ?? createEmptyRemoteProfile());
    setPassword("");
  }, [profiles, selectedId]);

  const selectNewProfile = () => {
    if (disabled) {
      return;
    }
    setSelectedId("new");
    setDraft(createEmptyRemoteProfile());
    setPassword("");
  };

  const commitProfile = (mode: "save" | "test") => {
    if (disabled) {
      return;
    }
    const profile: RemoteConnectionProfile = {
      ...draft,
      id:
        draft.id ||
        (typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `remote-${Date.now()}`),
      name: draft.name.trim(),
      host: draft.host.trim(),
      username: draft.username.trim(),
      rootPath: draft.rootPath.trim() || "/",
      port: Number(draft.port) || (draft.protocol === "ftp" ? 21 : 22),
      connectTimeoutSecs: Number(draft.connectTimeoutSecs) || 10,
      commandTimeoutSecs: Number(draft.commandTimeoutSecs) || 20
    };

    if (mode === "save") {
      onSave(profile, password || undefined);
      setSelectedId(profile.id);
      setDraft(profile);
      return;
    }

    onTest(profile, password || undefined);
  };

  return (
    <div className="settings-list">
      <section className="settings-group">
        <header className="settings-group__header">
          <div>
            <strong>远程连接</strong>
            <span>创建、测试并管理 FTP/SFTP 连接配置。</span>
          </div>
          <button type="button" className="toolbar-button toolbar-button--ghost" onClick={selectNewProfile} disabled={disabled}>
            新建配置
          </button>
        </header>

        {profiles.length > 0 ? (
          <div className="connection-chip-row">
            {profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                className={`connection-chip${selectedId === profile.id ? " is-active" : ""}`}
                onClick={() => {
                  if (disabled) {
                    return;
                  }
                  setSelectedId(profile.id);
                  setDraft(profile);
                  setPassword("");
                }}
                disabled={disabled}
              >
                <span>{profile.name}</span>
                <small>
                  {profile.protocol.toUpperCase()} - {profile.host}:{profile.port}
                </small>
              </button>
            ))}
          </div>
        ) : (
          <div className="search-empty">
            <strong>暂无远程连接配置</strong>
            <span>暂存配置并点击确定后，它会显示在远程功能列表中。</span>
          </div>
        )}

        <div className="settings-card settings-card--stack">
          <div className="settings-card__inline">
            <div className="settings-field">
              <label htmlFor="remote-name">名称</label>
              <input
                id="remote-name"
                type="text"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                disabled={disabled}
              />
            </div>
            <div className="settings-field">
              <label htmlFor="remote-protocol">协议</label>
              <select
                id="remote-protocol"
                value={draft.protocol}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    protocol: event.target.value as RemoteConnectionProfile["protocol"],
                    port: event.target.value === "ftp" ? 21 : 22,
                    authKind: event.target.value === "ftp" && draft.authKind === "keyFile" ? "password" : draft.authKind
                  })
                }
                disabled={disabled}
              >
                <option value="sftp">SFTP</option>
                <option value="ftp">FTP</option>
              </select>
            </div>
          </div>

          <div className="settings-card__inline">
            <div className="settings-field">
              <label htmlFor="remote-host">主机</label>
              <input
                id="remote-host"
                type="text"
                value={draft.host}
                onChange={(event) => setDraft({ ...draft, host: event.target.value })}
                disabled={disabled}
              />
            </div>
            <div className="settings-field settings-field--short">
              <label htmlFor="remote-port">端口</label>
              <input
                id="remote-port"
                type="number"
                value={String(draft.port)}
                onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })}
                disabled={disabled}
              />
            </div>
          </div>

          <div className="settings-card__inline">
            <div className="settings-field">
              <label htmlFor="remote-user">用户名</label>
              <input
                id="remote-user"
                type="text"
                value={draft.username}
                onChange={(event) => setDraft({ ...draft, username: event.target.value })}
                disabled={disabled || draft.authKind === "anonymous"}
              />
            </div>
            <div className="settings-field">
              <label htmlFor="remote-root">根路径</label>
              <input
                id="remote-root"
                type="text"
                value={draft.rootPath}
                onChange={(event) => setDraft({ ...draft, rootPath: event.target.value })}
                disabled={disabled}
              />
            </div>
          </div>

          <div className="settings-card__inline">
            <div className="settings-field">
              <label htmlFor="remote-auth">认证方式</label>
              <select
                id="remote-auth"
                value={draft.authKind}
                onChange={(event) => setDraft({ ...draft, authKind: event.target.value as RemoteConnectionProfile["authKind"] })}
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
            </div>
            {draft.authKind === "keyFile" ? (
              <div className="settings-field">
                <label htmlFor="remote-key">私钥路径</label>
                <input
                  id="remote-key"
                  type="text"
                  value={draft.privateKeyPath ?? ""}
                  onChange={(event) => setDraft({ ...draft, privateKeyPath: event.target.value })}
                  disabled={disabled}
                />
              </div>
            ) : (
              <div className="settings-field">
                <label htmlFor="remote-password">密码</label>
                <input
                  id="remote-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={selectedId === "new" ? "保存或测试时请输入密码" : "留空则保留已存储的凭据"}
                  disabled={disabled || draft.authKind === "anonymous"}
                />
              </div>
            )}
          </div>

          <div className="settings-card__inline">
            <label className="column-toggle settings-field">
              <input
                type="checkbox"
                checked={draft.passiveMode}
                onChange={() => setDraft({ ...draft, passiveMode: !draft.passiveMode })}
                disabled={disabled}
              />
              <span>被动模式</span>
              <small>FTP</small>
            </label>
            <label className="column-toggle settings-field">
              <input
                type="checkbox"
                checked={draft.ignoreHostKey}
                onChange={() => setDraft({ ...draft, ignoreHostKey: !draft.ignoreHostKey })}
                disabled={disabled}
              />
              <span>忽略主机密钥</span>
              <small>谨慎使用</small>
            </label>
          </div>

          <div className="settings-card__inline">
            <div className="settings-field">
              <label htmlFor="remote-connect-timeout">连接超时</label>
              <input
                id="remote-connect-timeout"
                type="number"
                value={String(draft.connectTimeoutSecs)}
                onChange={(event) => setDraft({ ...draft, connectTimeoutSecs: Number(event.target.value) })}
                disabled={disabled}
              />
            </div>
            <div className="settings-field">
              <label htmlFor="remote-command-timeout">命令超时</label>
              <input
                id="remote-command-timeout"
                type="number"
                value={String(draft.commandTimeoutSecs)}
                onChange={(event) => setDraft({ ...draft, commandTimeoutSecs: Number(event.target.value) })}
                disabled={disabled}
              />
            </div>
          </div>

          <div className="settings-card__inline settings-card__inline--actions">
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
                selectNewProfile();
                onDelete(deletingId);
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
      </section>
    </div>
  );
}
