import assert from "node:assert/strict";
import {
  createBrowserSettingsSnapshot,
  toNavigationItemUpsertRequest,
  toBackendTheme,
  toBackendColorRule,
  toBackendLayout,
  toBackendSettingsModelUpdate,
  toBackendShortcut,
  toRemoteProfileUpsertRequest
} from "./workspaceBackendDtos";
import type { NavigationItem, RemoteConnectionProfile, SettingsModel } from "./types";

function assertTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

assertTest("toBackendLayout converts workspace ratios into persisted UI layout", () => {
  assert.deepEqual(
    toBackendLayout("quad", {
      primary: 0.62,
      tripleSecondary: 0.5,
      quadLeftSecondary: 0.44,
      quadRightSecondary: 0.56,
      tree: 0.25,
      search: 0.3
    }),
    {
      layoutMode: "quad",
      panelProportions: [0.62, 0.38],
      sidebarWidth: 240,
      showTree: true,
      showSearch: true
    }
  );
});

assertTest("toBackendShortcut persists stable shortcut ids and accelerator bindings", () => {
  const shortcut: SettingsModel["shortcuts"][number] = {
    id: "copy",
    action: "Copy",
    scope: "listing",
    binding: "Ctrl+C",
    description: "Copy selected entries"
  };

  assert.deepEqual(toBackendShortcut(shortcut), {
    id: "copy",
    action: "copy",
    accelerator: "Ctrl+C",
    scope: "listing"
  });
});

assertTest("toBackendColorRule maps matcher tokens to backend mode and pattern", () => {
  assert.deepEqual(
    toBackendColorRule(
      {
        id: "rule-rs",
        label: "Rust",
        matcher: "extension:rs",
        color: "#ff6600",
        previewText: "Rust files"
      },
      2
    ),
    {
      id: "rule-rs",
      name: "Rust",
      target: "any",
      mode: "extension",
      pattern: "rs",
      colorHex: "#ff6600",
      priority: 3
    }
  );

  assert.deepEqual(
    toBackendColorRule(
      {
        id: "rule-hidden",
        label: "Hidden",
        matcher: "hidden",
        color: "#888888",
        previewText: "Hidden entries"
      },
      0
    ).pattern,
    null
  );
});

assertTest("toBackendTheme persists normalized theme values", () => {
  assert.deepEqual(toBackendTheme({ panelFocusAccent: "#c02f7a", tabMinWidth: 4096 }), {
    panelFocusAccent: "#c02f7a",
    tabMinWidth: 4096
  });
});

assertTest("toBackendSettingsModelUpdate serializes the complete settings model", () => {
  const model: SettingsModel = {
    shortcuts: [
      {
        id: "navigate-forward",
        action: "回到下一级",
        scope: "panel",
        binding: "Alt+Right",
        description: "回到历史中的下一级文件夹。"
      }
    ],
    colorRules: [
      {
        id: "rule-hidden",
        label: "Hidden",
        matcher: "hidden",
        color: "#777777",
        previewText: "Hidden"
      }
    ],
    tagRules: [],
    columns: [],
    detailsRowHeight: 46,
    theme: {
      panelFocusAccent: "invalid",
      tabMinWidth: 4096
    }
  };

  assert.deepEqual(toBackendSettingsModelUpdate(model), {
    shortcuts: [{ id: "navigate-forward", action: "navigate-forward", accelerator: "Alt+Right", scope: "panel" }],
    colorRules: [
      {
        id: "rule-hidden",
        name: "Hidden",
        target: "any",
        mode: "hidden",
        pattern: null,
        colorHex: "#777777",
        priority: 1
      }
    ],
    detailsRowHeight: 46,
    theme: {
      panelFocusAccent: "#0f6cbd",
      tabMinWidth: 4096
    }
  });
});

assertTest("toRemoteProfileUpsertRequest serializes optional remote auth fields explicitly", () => {
  const profile: RemoteConnectionProfile = {
    id: "remote-1",
    name: "Edge",
    protocol: "sftp",
    host: "edge.internal",
    port: 22,
    username: "deploy",
    rootPath: "/srv",
    authKind: "keyFile",
    passiveMode: true,
    ignoreHostKey: false,
    connectTimeoutSecs: 10,
    commandTimeoutSecs: 20
  };

  assert.deepEqual(toRemoteProfileUpsertRequest(profile), {
    profile: {
      id: "remote-1",
      name: "Edge",
      protocol: "sftp",
      host: "edge.internal",
      port: 22,
      username: "deploy",
      rootPath: "/srv",
      authKind: "keyFile",
      privateKeyPath: null,
      passiveMode: true,
      ignoreHostKey: false,
      connectTimeoutSecs: 10,
      commandTimeoutSecs: 20
    },
    password: null
  });
});

assertTest("createBrowserSettingsSnapshot provides a complete settings fallback shape", () => {
  const snapshot = createBrowserSettingsSnapshot({
    bookmarks: [{ id: "bookmark-1", name: "Docs", path: "D:\\Docs" }]
  });

  assert.equal(snapshot.bookmarks.length, 1);
  assert.equal(snapshot.hotlist.length, 0);
  assert.equal(snapshot.detailsRowHeight, 24);
  assert.equal(snapshot.layout.layoutMode, "dual");
  assert.equal(snapshot.theme!.panelFocusAccent, "#0f6cbd");
  assert.equal(snapshot.theme!.tabMinWidth, 96);
  assert.deepEqual(snapshot.remoteProfiles, []);
  assert.deepEqual(snapshot.navigationItems, []);
});

assertTest("toNavigationItemUpsertRequest sends only editable fields to the backend", () => {
  const item: NavigationItem = {
    id: "nav-1",
    displayName: "Docs",
    description: "Pinned docs",
    path: "C:\\Docs",
    targetKind: "folder",
    targetStatus: "ok",
    sortOrder: 1,
    createdAt: "2026-06-08T09:00:00Z",
    updatedAt: "2026-06-08T09:00:00Z"
  };

  assert.deepEqual(toNavigationItemUpsertRequest(item), {
    id: "nav-1",
    displayName: "Docs",
    description: "Pinned docs",
    path: "C:\\Docs"
  });

  assert.deepEqual(
    toNavigationItemUpsertRequest({
      displayName: "",
      description: "",
      path: "D:\\Downloads"
    }),
    {
      id: undefined,
      displayName: undefined,
      description: "",
      path: "D:\\Downloads"
    }
  );
});
