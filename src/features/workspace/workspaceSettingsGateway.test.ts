import assert from "node:assert/strict";
import {
  deleteWorkspaceBookmark,
  deleteWorkspaceNavigationItem,
  getWorkspaceEntryComment,
  getWorkspaceRemoteHostKey,
  listenWorkspaceSettingsChanged,
  markWorkspaceEntryMetadataDeleted,
  markWorkspaceNavigationItemOpened,
  removeWorkspaceEntryComment,
  saveWorkspaceBookmark,
  saveWorkspaceEntryComment,
  saveWorkspaceLayout,
  saveWorkspaceNavigationItem,
  saveWorkspaceRemoteProfile,
  saveWorkspaceSettingsModel,
  saveWorkspaceShortcuts,
  saveWorkspaceTheme,
  reorderWorkspaceNavigationItems,
  trustWorkspaceRemoteHostKey
} from "./workspaceSettingsGateway";
import type {
  RemoteProfile as BackendRemoteProfile,
  SettingsSnapshot as BackendSettingsSnapshot
} from "../../app/types";
import type { RemoteConnectionProfile, SettingsModel } from "./types";
import { NAVIGATION_COLUMNS } from "./NavigationTabColumns";
import type { WorkspaceInvoke } from "./workspaceIpc";

async function assertAsyncTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const runtimeHost = { __TAURI_INTERNALS__: {} };

function createSettingsSnapshot(overrides: Partial<BackendSettingsSnapshot> = {}): BackendSettingsSnapshot {
  return {
    bookmarks: [],
    hotlist: [],
    navigationItems: [],
    tagDefinitions: [],
    entryTags: [],
    colorFilter: { enabled: true, rules: [], revision: "0", rulesRevision: "0" },
    shortcuts: [],
    detailsRowHeight: 36,
    theme: {
      panelFocusAccent: "#0f6cbd",
      activeTabBackground: "#ffffff",
      dropHighlightFill: "#0f6cbd",
      dropHighlightBorder: "#0f6cbd",
      sizeBarLow: "#dceaf7",
      sizeBarHigh: "#3979b7",
      tabMinWidth: 96
    },
    layout: {
      layoutMode: "dual",
      panelProportions: [0.52, 0.48],
      sidebarWidth: 269,
      showTree: true,
      showSearch: true
    },
    remoteProfiles: [],
    ...overrides
  };
}

const remoteProfile: RemoteConnectionProfile = {
  id: "remote-1",
  name: "Deploy",
  protocol: "sftp",
  host: "edge.internal",
  port: 22,
  username: "deploy",
  rootPath: "/srv",
  authKind: "password",
  passiveMode: true,
  ignoreHostKey: false,
  connectTimeoutSecs: 10,
  commandTimeoutSecs: 20
};

type SaveRemoteProfileArgs = {
  request: {
    profile: BackendRemoteProfile;
    password: string | null;
  };
};

export const workspaceSettingsGatewayTests = (async () => {
  await assertAsyncTest("saveWorkspaceLayout invokes the typed layout command", async () => {
    const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      invocations.push({ command, args });
      return createSettingsSnapshot() as T;
    };

    await saveWorkspaceLayout(
      "quad",
      {
        primary: 0.62,
        tripleSecondary: 0.5,
        quadLeftSecondary: 0.44,
        quadRightSecondary: 0.56,
        tree: 0.25,
        search: 0.3
      },
      false,
      { invoke, runtimeHost }
    );

    assert.deepEqual(invocations, [
      {
        command: "save_ui_layout",
        args: {
          layout: {
            layoutMode: "quad",
            panelProportions: [0.62, 0.38],
            sidebarWidth: 240,
            showTree: false,
            showSearch: true
          }
        }
      }
    ]);
  });

  await assertAsyncTest("saveWorkspaceTheme invokes the typed theme command", async () => {
    const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      invocations.push({ command, args });
      return createSettingsSnapshot({
        theme: {
          panelFocusAccent: "#c02f7a80",
          activeTabBackground: "#ffffffcc",
          dropHighlightFill: "#abcdef66",
          dropHighlightBorder: "#336699",
          sizeBarLow: "#dceaf7",
          sizeBarHigh: "#3979b7",
          tabMinWidth: 132
        }
      }) as T;
    };

    await saveWorkspaceTheme(
      {
        panelFocusAccent: "#c02f7a80",
        activeTabBackground: "#ffffffcc",
        dropHighlightFill: "#abcdef66",
        dropHighlightBorder: "#336699",
        sizeBarLow: "#dceaf7",
        sizeBarHigh: "#3979b7",
        tabMinWidth: 132
      },
      { invoke, runtimeHost }
    );

    assert.deepEqual(invocations, [
      {
        command: "save_ui_theme",
        args: {
          theme: {
            panelFocusAccent: "#c02f7a80",
            activeTabBackground: "#ffffffcc",
            dropHighlightFill: "#abcdef66",
            dropHighlightBorder: "#336699",
            sizeBarLow: "#dceaf7",
            sizeBarHigh: "#3979b7",
            tabMinWidth: 132
          }
        }
      }
    ]);
  });

  await assertAsyncTest("saveWorkspaceSettingsModel invokes one complete typed settings command", async () => {
    const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      invocations.push({ command, args });
      return createSettingsSnapshot({
        theme: {
          panelFocusAccent: "#c02f7a",
          activeTabBackground: "#ffffff80",
          dropHighlightFill: "#abcdef",
          dropHighlightBorder: "#336699",
          sizeBarLow: "#dceaf7",
          sizeBarHigh: "#3979b7",
          tabMinWidth: 4096
        }
      }) as T;
    };
    const fileVisibility = {
      showHidden: true,
      showSystem: false,
      hideProtectedOperatingSystemFiles: false
    };
    const model: SettingsModel = {
      shortcuts: [
        {
          id: "navigate-up",
          action: "上一级",
          scope: "panel",
          binding: " up + alt ",
          description: "打开当前文件夹的上一级。"
        }
      ],
      colorRules: [
        {
          id: "rule-rs",
          name: "Rust",
          enabled: true,
          target: "file",
          expression: "Extension == \".rs\"",
          caseSensitive: false,
          foregroundColorHex: "#d85f00",
          backgroundColorHex: null,
          priority: 1
        }
      ],
      tagRules: [],
      columns: [
        { id: "name", label: "名称", visible: true, width: "240px", align: "left" },
        { id: "comment", label: "注释", visible: true, width: "220px", align: "left" }
      ],
      navigationColumns: [
        { id: "name", label: "Name", visible: true, width: "220px", align: "left" },
        { id: "path", label: "Path", visible: true, width: "180px", align: "left" }
      ],
      detailsRowHeight: 44,
      sizeBarMode: "folder-total",
      tooltipHoverDelayMs: 125,
      metadataRetentionHours: null,
      fileVisibility,
      contextMenu: {
        defaultMenu: "custom"
      },
      theme: {
        panelFocusAccent: "#c02f7a",
        activeTabBackground: "#ffffff80",
        dropHighlightFill: "#abcdef",
        dropHighlightBorder: "#336699",
        sizeBarLow: "#dceaf7",
        sizeBarHigh: "#3979b7",
        tabMinWidth: 4096
      }
    };
    await saveWorkspaceSettingsModel(model, { invoke, runtimeHost });

    assert.deepEqual(invocations, [
      {
        command: "save_settings_model",
        args: {
          model: {
            shortcuts: [{ id: "navigate-up", action: "navigate-up", accelerator: "Alt+Up", scope: "panel" }],
            columns: [
              { id: "name", label: "名称", visible: true, width: "240px", align: "left" },
              { id: "type", label: "类型", visible: true, width: "112px", align: "left" },
              { id: "extension", label: "扩展名", visible: true, width: "96px", align: "left" },
              { id: "size", label: "大小", visible: true, width: "96px", align: "right" },
              { id: "created", label: "创建日期", visible: true, width: "148px", align: "left" },
              { id: "modified", label: "修改日期", visible: true, width: "148px", align: "left" },
              { id: "accessed", label: "访问日期", visible: true, width: "148px", align: "left" },
              { id: "tags", label: "标签", visible: true, width: "120px", align: "left" },
              { id: "comment", label: "注释", visible: true, width: "220px", align: "left" },
              { id: "location", label: "位置", visible: false, width: "220px", align: "left" }
            ],
            navigationColumns: NAVIGATION_COLUMNS.map((column) =>
              column.id === "name"
                ? { ...column, label: "Name" }
                : column.id === "path"
                  ? { ...column, label: "Path" }
                  : column
            ),
            detailsRowHeight: 44,
            sizeBarMode: "folder-total",
            folderExpansionEnabled: false,
            tooltipHoverDelayMs: 125,
            metadataRetentionHours: null,
            fileVisibility,
            contextMenu: {
              defaultMenu: "custom"
            },
            theme: {
              panelFocusAccent: "#c02f7a",
              activeTabBackground: "#ffffff80",
              dropHighlightFill: "#abcdef",
              dropHighlightBorder: "#336699",
              sizeBarLow: "#dceaf7",
              sizeBarHigh: "#3979b7",
              tabMinWidth: 4096
            }
          }
        }
      }
    ]);
  });

  await assertAsyncTest("saveWorkspaceShortcuts normalizes legacy bindings through the same DTO boundary", async () => {
    const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      invocations.push({ command, args });
      return createSettingsSnapshot() as T;
    };

    await saveWorkspaceShortcuts(
      [
        {
          id: "open-search",
          action: "open-search",
          scope: "workspace",
          binding: " alt + ctrl + p ",
          description: "Open search"
        }
      ],
      { invoke, runtimeHost }
    );

    assert.deepEqual(invocations, [
      {
        command: "save_shortcuts",
        args: {
          shortcuts: [{ id: "open-search", action: "open-search", accelerator: "Ctrl+Alt+P", scope: "workspace" }]
        }
      }
    ]);
  });

  await assertAsyncTest("listenWorkspaceSettingsChanged maps backend settings snapshots", async () => {
    const listened: string[] = [];
    const unlisten = await listenWorkspaceSettingsChanged(
      (payload) => {
        assert.equal(payload.settingsModel.theme.tabMinWidth, 4096);
        assert.equal(payload.settingsModel.theme.activeTabBackground, "#ffffff80");
        assert.equal(payload.settingsModel.theme.dropHighlightFill, "#0f6cbd");
        assert.equal(payload.settingsModel.theme.dropHighlightBorder, "#0f6cbd");
        assert.equal(payload.settingsModel.shortcuts.find((shortcut) => shortcut.id === "navigate-up")?.binding, "Alt+Up");
        assert.equal(payload.navigationItems.length, 0);
      },
      {
        runtimeHost,
        listen: async <T,>(eventName: string, handler: (event: { payload: T }) => void | Promise<void>) => {
          listened.push(eventName);
          handler({
            payload: createSettingsSnapshot({
              shortcuts: [{ id: "navigate-up", action: "navigate-up", accelerator: "Alt+Up", scope: "panel" }],
              theme: {
                panelFocusAccent: "#0f6cbd",
                activeTabBackground: "#ffffff80",
                dropHighlightFill: "#0f6cbd",
                dropHighlightBorder: "#0f6cbd",
                sizeBarLow: "#dceaf7",
                sizeBarHigh: "#3979b7",
                tabMinWidth: 4096
              }
            }) as unknown as T
          });
          return () => listened.push("unlisten");
        }
      }
    );

    assert.deepEqual(listened, ["settings_changed"]);
    unlisten();
    assert.deepEqual(listened, ["settings_changed", "unlisten"]);
  });

  await assertAsyncTest("saveWorkspaceBookmark maps the returned settings snapshot", async () => {
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      assert.equal(command, "save_bookmark");
      assert.deepEqual(args, {
        bookmark: {
          id: "bookmark-fixed",
          name: "Docs",
          path: "D:\\Docs"
        }
      });
      return createSettingsSnapshot({
        bookmarks: [{ id: "bookmark-fixed", name: "Docs", path: "D:\\Docs" }]
      }) as T;
    };

    const result = await saveWorkspaceBookmark("D:\\Docs", "Docs", {
      invoke,
      runtimeHost,
      createId: (prefix: string) => `${prefix}-fixed`
    });

    assert.equal(result.bookmarks[0].label, "Docs");
    assert.equal(result.bookmarks[0].kind, "bookmark");
    assert.equal(result.hotlist.length, 0);
  });

  await assertAsyncTest("deleteWorkspaceBookmark propagates real Tauri command failures", async () => {
    const commandError = new Error("delete failed");

    await assert.rejects(
      () =>
        deleteWorkspaceBookmark("bookmark-1", {
          invoke: async <T>() => {
            throw commandError;
          },
          runtimeHost
        }),
      commandError
    );
  });

  await assertAsyncTest("saveWorkspaceNavigationItem invokes the upsert command and maps returned items", async () => {
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      assert.equal(command, "save_navigation_item");
      assert.deepEqual(args, {
        request: {
          id: undefined,
          displayName: "Docs",
          description: "Pinned docs",
          path: "D:\\Docs"
        }
      });
      return createSettingsSnapshot({
        navigationItems: [
          {
            id: "nav-1",
            displayName: "Docs",
            description: "Pinned docs",
            path: "D:\\Docs",
            targetKind: "folder",
            targetStatus: "ok",
            sortOrder: 1,
            createdAt: "2026-06-08T09:00:00Z",
            updatedAt: "2026-06-08T09:00:00Z"
          }
        ]
      }) as T;
    };

    const result = await saveWorkspaceNavigationItem(
      {
        displayName: "Docs",
        description: "Pinned docs",
        path: "D:\\Docs"
      },
      { invoke, runtimeHost }
    );

    assert.equal(result.navigationItems[0].id, "nav-1");
    assert.equal(result.navigationItems[0].targetKind, "folder");
  });

  await assertAsyncTest("delete, reorder, and mark-opened navigation item helpers keep command arguments stable", async () => {
    const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      invocations.push({ command, args });
      return createSettingsSnapshot() as T;
    };

    await deleteWorkspaceNavigationItem("nav-1", { invoke, runtimeHost });
    await reorderWorkspaceNavigationItems(["nav-2", "nav-1"], { invoke, runtimeHost });
    await markWorkspaceNavigationItemOpened("nav-2", { invoke, runtimeHost });

    assert.deepEqual(invocations, [
      {
        command: "delete_navigation_item",
        args: { id: "nav-1" }
      },
      {
        command: "reorder_navigation_items",
        args: { ids: ["nav-2", "nav-1"] }
      },
      {
        command: "mark_navigation_item_opened",
        args: { id: "nav-2" }
      }
    ]);
  });

  await assertAsyncTest("entry comment helpers keep command arguments stable", async () => {
    const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      invocations.push({ command, args });
      if (command === "get_entry_comment") {
        return "existing comment" as T;
      }
      if (command === "save_entry_comment") {
        return (args.comment as string) as T;
      }
      return undefined as T;
    };
    const path = "D:\\Docs\\report.txt";

    const loaded = await getWorkspaceEntryComment(path, { invoke, runtimeHost });
    const saved = await saveWorkspaceEntryComment(path, "updated comment", { invoke, runtimeHost });
    await removeWorkspaceEntryComment(path, { invoke, runtimeHost });
    await markWorkspaceEntryMetadataDeleted([path], { invoke, runtimeHost });

    assert.equal(loaded, "existing comment");
    assert.equal(saved, "updated comment");
    assert.deepEqual(invocations, [
      {
        command: "get_entry_comment",
        args: { path }
      },
      {
        command: "save_entry_comment",
        args: { path, comment: "updated comment" }
      },
      {
        command: "remove_entry_comment",
        args: { path }
      },
      {
        command: "mark_entry_metadata_deleted",
        args: { paths: [path] }
      }
    ]);
  });

  await assertAsyncTest("saveWorkspaceRemoteProfile maps backend profiles and keeps request credentials explicit", async () => {
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      const requestArgs = args as SaveRemoteProfileArgs;
      assert.equal(command, "save_remote_profile");
      assert.deepEqual(requestArgs, {
        request: {
          profile: {
            id: "remote-1",
            name: "Deploy",
            protocol: "sftp",
            host: "edge.internal",
            port: 22,
            username: "deploy",
            rootPath: "/srv",
            authKind: "password",
            privateKeyPath: null,
            passiveMode: true,
            ignoreHostKey: false,
            connectTimeoutSecs: 10,
            commandTimeoutSecs: 20
          },
          password: "secret"
        }
      });
      return [
        {
          ...requestArgs.request.profile,
          passiveMode: true,
          ignoreHostKey: false,
          connectTimeoutSecs: 10,
          commandTimeoutSecs: 20
        } as BackendRemoteProfile
      ] as T;
    };

    const result = await saveWorkspaceRemoteProfile(remoteProfile, "secret", {
      invoke,
      runtimeHost
    });

    assert.equal(result.remoteProfiles[0].id, "remote-1");
    assert.equal(result.remoteProfiles[0].authKind, "password");
  });

  await assertAsyncTest("remote host key helpers invoke typed confirmation commands", async () => {
    const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
    const hostKey = {
      profileId: "remote-1",
      host: "edge.internal",
      port: 2222,
      algorithm: "ssh-ed25519",
      fingerprintSha256: "SHA256:abc",
      keyBase64: "AAAA",
      knownHostsEntry: "[edge.internal]:2222 ssh-ed25519 AAAA",
      trustState: "unknown" as const
    };
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      invocations.push({ command, args });
      return {
        ...hostKey,
        trustState: command === "trust_remote_host_key" ? "trusted" : "unknown"
      } as T;
    };

    const info = await getWorkspaceRemoteHostKey("remote-1", { invoke, runtimeHost });
    assert.equal(info.fingerprintSha256, "SHA256:abc");

    const trusted = await trustWorkspaceRemoteHostKey(
      {
        profileId: "remote-1",
        host: "edge.internal",
        port: 2222,
        algorithm: "ssh-ed25519",
        keyBase64: "AAAA"
      },
      { invoke, runtimeHost }
    );
    assert.equal(trusted.trustState, "trusted");
    assert.deepEqual(invocations, [
      {
        command: "get_remote_host_key",
        args: {
          profileId: "remote-1"
        }
      },
      {
        command: "trust_remote_host_key",
        args: {
          request: {
            profileId: "remote-1",
            host: "edge.internal",
            port: 2222,
            algorithm: "ssh-ed25519",
            keyBase64: "AAAA"
          }
        }
      }
    ]);
  });
})();
