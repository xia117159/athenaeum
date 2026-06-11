import assert from "node:assert/strict";
import {
  deleteWorkspaceBookmark,
  deleteWorkspaceNavigationItem,
  getWorkspaceRemoteHostKey,
  listenWorkspaceSettingsChanged,
  markWorkspaceNavigationItemOpened,
  saveWorkspaceBookmark,
  saveWorkspaceColorRules,
  saveWorkspaceLayout,
  saveWorkspaceNavigationItem,
  saveWorkspaceRemoteProfile,
  saveWorkspaceSettingsModel,
  saveWorkspaceTheme,
  reorderWorkspaceNavigationItems,
  trustWorkspaceRemoteHostKey
} from "./workspaceSettingsGateway";
import type {
  RemoteProfile as BackendRemoteProfile,
  SettingsSnapshot as BackendSettingsSnapshot
} from "../../app/types";
import type { RemoteConnectionProfile, SettingsModel } from "./types";
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
    colorRules: [],
    shortcuts: [],
    detailsRowHeight: 36,
    theme: {
      panelFocusAccent: "#0f6cbd",
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
            showTree: true,
            showSearch: true
          }
        }
      }
    ]);
  });

  await assertAsyncTest("saveWorkspaceColorRules saves rules sequentially with backend priorities", async () => {
    const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      invocations.push({ command, args });
      return createSettingsSnapshot() as T;
    };
    const colorRules: SettingsModel["colorRules"] = [
      {
        id: "rule-rs",
        label: "Rust",
        matcher: "extension:rs",
        color: "#d85f00",
        previewText: "Rust"
      },
      {
        id: "rule-hidden",
        label: "Hidden",
        matcher: "hidden",
        color: "#777777",
        previewText: "Hidden"
      }
    ];

    await saveWorkspaceColorRules(colorRules, { invoke, runtimeHost });

    assert.deepEqual(
      invocations.map((item) => item.args),
      [
        {
          rule: {
            id: "rule-rs",
            name: "Rust",
            target: "any",
            mode: "extension",
            pattern: "rs",
            colorHex: "#d85f00",
            priority: 1
          }
        },
        {
          rule: {
            id: "rule-hidden",
            name: "Hidden",
            target: "any",
            mode: "hidden",
            pattern: null,
            colorHex: "#777777",
            priority: 2
          }
        }
      ]
    );
  });

  await assertAsyncTest("saveWorkspaceTheme invokes the typed theme command", async () => {
    const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      invocations.push({ command, args });
      return createSettingsSnapshot({ theme: { panelFocusAccent: "#c02f7a", tabMinWidth: 132 } }) as T;
    };

    await saveWorkspaceTheme({ panelFocusAccent: "#c02f7a", tabMinWidth: 132 }, { invoke, runtimeHost });

    assert.deepEqual(invocations, [
      {
        command: "save_ui_theme",
        args: {
          theme: {
            panelFocusAccent: "#c02f7a",
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
      return createSettingsSnapshot({ theme: { panelFocusAccent: "#c02f7a", tabMinWidth: 4096 } }) as T;
    };
    const model: SettingsModel = {
      shortcuts: [
        {
          id: "navigate-up",
          action: "上一级",
          scope: "panel",
          binding: "Alt+Up",
          description: "打开当前文件夹的上一级。"
        }
      ],
      colorRules: [
        {
          id: "rule-rs",
          label: "Rust",
          matcher: "extension:rs",
          color: "#d85f00",
          previewText: "Rust"
        }
      ],
      tagRules: [],
      columns: [],
      detailsRowHeight: 44,
      theme: {
        panelFocusAccent: "#c02f7a",
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
            colorRules: [
              {
                id: "rule-rs",
                name: "Rust",
                target: "any",
                mode: "extension",
                pattern: "rs",
                colorHex: "#d85f00",
                priority: 1
              }
            ],
            detailsRowHeight: 44,
            theme: {
              panelFocusAccent: "#c02f7a",
              tabMinWidth: 4096
            }
          }
        }
      }
    ]);
  });

  await assertAsyncTest("listenWorkspaceSettingsChanged maps backend settings snapshots", async () => {
    const listened: string[] = [];
    const unlisten = await listenWorkspaceSettingsChanged(
      (payload) => {
        assert.equal(payload.settingsModel.theme.tabMinWidth, 4096);
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
              theme: { panelFocusAccent: "#0f6cbd", tabMinWidth: 4096 }
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
