import assert from "node:assert/strict";
import { getParentLocationPath, normalizeLocationPath } from "./mockData";
import {
  DEFAULT_COLUMNS,
  DEFAULT_SHORTCUTS,
  NAVIGATION_COLUMNS,
  DEFAULT_THEME,
  createTabFromSnapshot,
  mapDirectoryListingToSnapshot,
  mapFavoriteCollections,
  mapSettingsModel,
  mapWorkspaceBootstrap,
  normalizeNavigationColumns,
  normalizeSettingsModel
} from "./workspaceMappers";

function assertTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

assertTest("DEFAULT_THEME includes configurable drag highlight colors", () => {
  assert.deepEqual(DEFAULT_THEME, {
    panelFocusAccent: "#0f6cbd",
    activeTabBackground: "#ffffff",
    dropHighlightFill: "#0f6cbd",
    dropHighlightBorder: "#0f6cbd",
    tabMinWidth: 96
  });
});

assertTest("DEFAULT_COLUMNS exposes the file-list detail columns in the default order", () => {
  assert.deepEqual(
    DEFAULT_COLUMNS.map((column) => column.id),
    ["name", "type", "extension", "size", "created", "modified", "accessed", "tags", "comment", "location"]
  );
  assert.equal(DEFAULT_COLUMNS.find((column) => column.id === "modified")?.label, "修改日期");
  assert.equal(DEFAULT_COLUMNS.find((column) => column.id === "location")?.visible, false);
});

assertTest("NAVIGATION_COLUMNS exposes the navigation detail columns in the default order", () => {
  assert.deepEqual(
    NAVIGATION_COLUMNS.map((column) => column.id),
    ["name", "kind", "path", "comment", "status", "lastOpened"]
  );
  assert.deepEqual(
    NAVIGATION_COLUMNS.map((column) => column.width),
    ["220px", "96px", "180px", "112px", "80px", "132px"]
  );
  assert.equal(NAVIGATION_COLUMNS.find((column) => column.id === "comment")?.label, "\u6ce8\u91ca");
});

assertTest("normalizeNavigationColumns preserves compact auto-fit widths above the header minimum", () => {
  const columns = normalizeNavigationColumns([
    { id: "kind", label: "\u7c7b\u578b", visible: true, width: "42px", align: "left" }
  ]);

  assert.equal(columns.find((column) => column.id === "kind")?.width, "42px");
});

assertTest("normalizeNavigationColumns migrates the legacy default widths to the compact defaults", () => {
  const columns = normalizeNavigationColumns([
    { id: "name", label: "\u540d\u79f0", visible: true, width: "240px", align: "left" },
    { id: "kind", label: "\u7c7b\u578b", visible: true, width: "112px", align: "left" },
    { id: "path", label: "\u8def\u5f84", visible: true, width: "220px", align: "left" },
    { id: "comment", label: "\u6ce8\u91ca", visible: true, width: "148px", align: "left" },
    { id: "status", label: "\u72b6\u6001", visible: true, width: "120px", align: "left" },
    { id: "lastOpened", label: "\u6700\u8fd1\u6253\u5f00", visible: true, width: "148px", align: "left" }
  ]);

  assert.deepEqual(
    columns.map((column) => column.width),
    NAVIGATION_COLUMNS.map((column) => column.width)
  );
});

assertTest("mapSettingsModel normalizes configurable drag highlight colors", () => {
  const model = mapSettingsModel({
    bookmarks: [],
    hotlist: [],
    navigationItems: [],
    tagDefinitions: [],
    entryTags: [],
    colorRules: [],
    shortcuts: [],
    columns: [
      { id: "name", label: "名称", visible: true, width: "240px", align: "left" },
      { id: "size", label: "大小", visible: true, width: "96px", align: "right" },
      { id: "type", label: "类型", visible: true, width: "112px", align: "left" }
    ],
    navigationColumns: [
      { id: "path", label: "Path", visible: true, width: "300px", align: "left" },
      { id: "name", label: "Name", visible: false, width: "200px", align: "left" }
    ],
    detailsRowHeight: 24,
    tooltipHoverDelayMs: 350,
    metadataRetentionHours: null,
    contextMenu: {
      defaultMenu: "native"
    },
    theme: {
      panelFocusAccent: "#C02F7A80",
      activeTabBackground: "#FFFFFFCC",
      dropHighlightFill: "#ABCDEF66",
      dropHighlightBorder: "not-a-color",
      tabMinWidth: 96
    },
    layout: {
      layoutMode: "single",
      panelProportions: [1],
      sidebarWidth: 280,
      showTree: true,
      showSearch: false
    },
    remoteProfiles: []
  });

  assert.equal(model.theme.panelFocusAccent, "#c02f7a80");
  assert.equal(model.theme.activeTabBackground, "#ffffffcc");
  assert.equal(model.theme.dropHighlightFill, "#abcdef66");
  assert.equal(model.theme.dropHighlightBorder, "#0f6cbd");
  assert.deepEqual(model.columns.slice(0, 4).map((column) => column.id), ["name", "type", "extension", "size"]);
  assert.equal(model.columns.find((column) => column.id === "size")?.width, "96px");
  assert.equal(model.columns.some((column) => column.id === "comment"), true);
  assert.deepEqual(model.navigationColumns.slice(0, 3).map((column) => column.id), ["name", "kind", "path"]);
  assert.equal(model.navigationColumns.find((column) => column.id === "name")?.visible, false);
  assert.equal(model.navigationColumns.find((column) => column.id === "path")?.width, "300px");
  assert.equal(model.tooltipHoverDelayMs, 350);
  assert.equal(model.metadataRetentionHours, null);
});

assertTest("normalizeSettingsModel normalizes configurable drag highlight colors", () => {
  const model = normalizeSettingsModel({
    shortcuts: [],
    colorRules: [],
    tagRules: [],
    columns: [],
    navigationColumns: [],
    detailsRowHeight: 24,
    tooltipHoverDelayMs: 9999,
    metadataRetentionHours: -1,
    contextMenu: {
      defaultMenu: "native"
    },
    theme: {
      panelFocusAccent: "#C02F7A",
      activeTabBackground: "not-a-color",
      dropHighlightFill: "not-a-color",
      dropHighlightBorder: "#ABC12399",
      tabMinWidth: 96
    }
  });

  assert.equal(model.theme.panelFocusAccent, "#c02f7a");
  assert.equal(model.theme.activeTabBackground, "#ffffff");
  assert.equal(model.theme.dropHighlightFill, "#0f6cbd");
  assert.equal(model.theme.dropHighlightBorder, "#abc12399");
  assert.deepEqual(model.columns.map((column) => column.id), DEFAULT_COLUMNS.map((column) => column.id));
  assert.deepEqual(model.navigationColumns.map((column) => column.id), NAVIGATION_COLUMNS.map((column) => column.id));
  assert.equal(model.tooltipHoverDelayMs, 5000);
  assert.equal(model.metadataRetentionHours, 0);
});

assertTest("mapDirectoryListingToSnapshot translates backend entries into rich listing cells", () => {
  const snapshot = mapDirectoryListingToSnapshot({
    location: {
      kind: "local",
      path: "C:\\Workspace"
    },
    entries: [
      {
        path: "C:\\Workspace\\notes.txt",
        name: "notes.txt",
        extension: "txt",
        kind: "file",
        size: 1024,
        createdAt: "2026-04-17T09:08:07Z",
        modifiedAt: "2026-04-18T10:00:00Z",
        accessedAt: "2026-04-19T11:12:13Z",
        isHidden: false,
        isSystem: false,
        isProtectedOperatingSystem: false,
        isReadOnly: true,
        isSymlink: false,
        location: {
          kind: "local",
          path: "C:\\Workspace\\notes.txt"
        },
        decoration: {
          colorHex: "#ff6600",
          tags: ["Pinned", "Docs"]
        },
        comment: "Line one\nLine two"
      }
    ],
    parent: "C:\\",
    canGoUp: true
  });

  assert.equal(snapshot.location.path, "C:\\Workspace");
  assert.equal(snapshot.location.label, "Workspace");
  assert.equal(snapshot.breadcrumbs.length, 2);
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0].accentColor, "#ff6600");
  assert.deepEqual(snapshot.entries[0].tags, ["Pinned", "Docs"]);
  assert.equal(snapshot.entries[0].sizeLabel, "1 KB");
  assert.equal(snapshot.entries[0].createdLabel, "2026-04-17 17:08");
  assert.equal(snapshot.entries[0].accessedLabel, "2026-04-19 19:12");
  assert.equal(snapshot.entries[0].comment, "Line one\nLine two");
  assert.equal(snapshot.entries[0].description, "只读文件");
});

assertTest("mapDirectoryListingToSnapshot carries Windows system and protected attributes", () => {
  const snapshot = mapDirectoryListingToSnapshot({
    location: {
      kind: "local",
      path: "C:\\"
    },
    entries: [
      {
        path: "C:\\pagefile.sys",
        name: "pagefile.sys",
        extension: "sys",
        kind: "file",
        size: 4096,
        modifiedAt: "2026-04-18T10:00:00Z",
        isHidden: true,
        isSystem: true,
        isProtectedOperatingSystem: true,
        isReadOnly: false,
        isSymlink: false,
        location: {
          kind: "local",
          path: "C:\\pagefile.sys"
        },
        decoration: {
          colorHex: null,
          tags: []
        }
      }
    ],
    parent: null,
    canGoUp: false
  });

  assert.equal(snapshot.entries[0].isHidden, true);
  assert.equal(snapshot.entries[0].isSystem, true);
  assert.equal(snapshot.entries[0].isProtectedOperatingSystem, true);
  assert.deepEqual(snapshot.entries[0].attributes, ["A", "H", "S", "P"]);
  assert.equal(snapshot.entries[0].description, "受保护的操作系统文件");
});

assertTest("normalizeLocationPath strips Windows verbatim prefixes before further routing", () => {
  assert.equal(normalizeLocationPath("\\\\?\\E:\\"), "E:\\");
  assert.equal(normalizeLocationPath("\\\\?\\E:\\Workspace\\Logs"), "E:\\Workspace\\Logs");
});

assertTest("getParentLocationPath returns null for This PC virtual path", () => {
  assert.equal(getParentLocationPath("此电脑"), null);
});

assertTest("mapDirectoryListingToSnapshot keeps usable local paths when backend returns canonical Windows paths", () => {
  const snapshot = mapDirectoryListingToSnapshot({
    location: {
      kind: "local",
      path: "\\\\?\\E:\\Workspace"
    },
    entries: [
      {
        path: "\\\\?\\E:\\Workspace\\report.txt",
        name: "report.txt",
        extension: "txt",
        kind: "file",
        size: 128,
        modifiedAt: "2026-04-18T10:00:00Z",
        isHidden: false,
        isSystem: false,
        isProtectedOperatingSystem: false,
        isReadOnly: false,
        isSymlink: false,
        location: {
          kind: "local",
          path: "\\\\?\\E:\\Workspace\\report.txt"
        },
        decoration: {
          colorHex: "#0f6cbd",
          tags: []
        }
      }
    ],
    parent: "\\\\?\\E:\\",
    canGoUp: true
  });

  assert.equal(snapshot.location.path, "E:\\Workspace");
  assert.equal(snapshot.entries[0].path, "E:\\Workspace\\report.txt");
  assert.equal(snapshot.entries[0].parentPath, "E:\\Workspace");
});

assertTest("mapWorkspaceBootstrap builds panel shells, tree roots, and remote entry points", () => {
  const bootstrap = mapWorkspaceBootstrap({
    drives: [
      { path: "C:\\", label: "System (C:)" },
      { path: "D:\\", label: "Data (D:)" }
    ],
    initialPath: "C:\\Workspace",
    initialListing: {
      location: {
        kind: "local",
        path: "C:\\Workspace"
      },
      entries: [],
      parent: "C:\\",
      canGoUp: true
    },
    settings: {
      bookmarks: [{ id: "bookmark-1", name: "Docs", path: "C:\\Workspace" }],
      hotlist: [{ id: "hot-1", name: "Builds", path: "D:\\Builds" }],
      navigationItems: [
        {
          id: "nav-1",
          displayName: "Spec",
          description: "Project spec",
          path: "C:\\Workspace\\spec.md",
          targetKind: "file",
          targetStatus: "ok",
          sortOrder: 1,
          createdAt: "2026-06-08T09:00:00Z",
          updatedAt: "2026-06-08T09:00:00Z"
        }
      ],
      tagDefinitions: [{ id: "tag-1", name: "Pinned", colorHex: "#00aa66" }],
      entryTags: [],
      colorRules: [
        {
          id: "rule-1",
          name: "Rust",
          target: "file",
          mode: "extension",
          pattern: "rs",
          colorHex: "#ff6600",
          priority: 1
        }
      ],
      shortcuts: [{ id: "shortcut-1", action: "Copy", accelerator: "Ctrl+C", scope: "workspace" }],
      detailsRowHeight: 44,
      contextMenu: {
        defaultMenu: "custom"
      },
      theme: {
        panelFocusAccent: "#c02f7a",
        activeTabBackground: "#ffffff",
        dropHighlightFill: "#0f6cbd",
        dropHighlightBorder: "#0f6cbd",
        tabMinWidth: 128
      },
      layout: {
        layoutMode: "quad",
        panelProportions: [0.5, 0.5, 0.5, 0.5],
        sidebarWidth: 280,
        showTree: true,
        showSearch: true
      },
      remoteProfiles: [
        {
          id: "remote-1",
          name: "Edge",
          protocol: "sftp",
          host: "edge-01.internal",
          port: 22,
          username: "deploy",
          rootPath: "/releases"
        }
      ]
    }
  });

  assert.equal(bootstrap.source, "tauri");
  assert.equal(bootstrap.layoutMode, "quad");
  assert.equal(bootstrap.directoryTree.length, 3);
  assert.equal(bootstrap.directoryTree[2].kind, "remote-root");
  assert.equal(bootstrap.remoteProfiles.length, 1);
  assert.equal(bootstrap.remoteProfiles[0].name, "Edge");
  assert.equal(bootstrap.bookmarks[0].label, "Docs");
  assert.equal(bootstrap.hotlist[0].label, "Builds");
  assert.equal(bootstrap.navigationItems[0].displayName, "Spec");
  assert.equal(bootstrap.navigationItems[0].targetKind, "file");
  assert.equal(bootstrap.settingsModel.shortcuts.find((shortcut) => shortcut.id === "shortcut-1"), undefined);
  assert.equal(bootstrap.settingsModel.shortcuts.find((shortcut) => shortcut.id === "open-search")?.binding, "Ctrl+F");
  assert.equal(bootstrap.settingsModel.shortcuts.find((shortcut) => shortcut.id === "drag-move")?.binding, "Shift");
  assert.equal(bootstrap.settingsModel.shortcuts.find((shortcut) => shortcut.id === "context-menu-toggle")?.binding, "Shift");
  assert.equal(bootstrap.settingsModel.colorRules[0].color, "#ff6600");
  assert.equal(bootstrap.settingsModel.detailsRowHeight, 44);
  assert.equal(bootstrap.settingsModel.contextMenu.defaultMenu, "custom");
  assert.equal(bootstrap.settingsModel.theme.panelFocusAccent, "#c02f7a");
  assert.equal(bootstrap.settingsModel.theme.activeTabBackground, "#ffffff");
  assert.equal(bootstrap.settingsModel.theme.dropHighlightFill, "#0f6cbd");
  assert.equal(bootstrap.settingsModel.theme.dropHighlightBorder, "#0f6cbd");
  assert.equal(bootstrap.settingsModel.theme.tabMinWidth, 128);
  assert.ok(bootstrap.panels["panel-1"].tabs[0]);
});

assertTest("mapWorkspaceBootstrap preserves configured drag move shortcut binding", () => {
  const bootstrap = mapWorkspaceBootstrap({
    drives: [{ path: "C:\\", label: "System (C:)" }],
    initialPath: "C:\\Workspace",
    initialListing: {
      location: {
        kind: "local",
        path: "C:\\Workspace"
      },
      entries: [],
      parent: "C:\\",
      canGoUp: true
    },
    settings: {
      bookmarks: [],
      hotlist: [],
      navigationItems: [],
      tagDefinitions: [],
      entryTags: [],
      colorRules: [],
      shortcuts: [{ id: "drag-move", action: "drag-move", accelerator: "Alt", scope: "listing" }],
      detailsRowHeight: 24,
      theme: {
        panelFocusAccent: "#0f6cbd",
        activeTabBackground: "#ffffff",
        dropHighlightFill: "#0f6cbd",
        dropHighlightBorder: "#0f6cbd",
        tabMinWidth: 96
      },
      layout: {
        layoutMode: "single",
        panelProportions: [1],
        sidebarWidth: 280,
        showTree: true,
        showSearch: false
      },
      remoteProfiles: []
    }
  });

  const dragMove = bootstrap.settingsModel.shortcuts.find((shortcut) => shortcut.id === "drag-move");

  assert.equal(dragMove?.binding, "Alt");
  assert.equal(dragMove?.action, "拖放时移动");
  assert.equal(dragMove?.description, "拖放文件或文件夹时执行移动而不是复制。");
});

assertTest("mapWorkspaceBootstrap gives panels independent snapshot and entry references", () => {
  const bootstrap = mapWorkspaceBootstrap({
    drives: [{ path: "C:\\", label: "System (C:)" }],
    initialPath: "C:\\Workspace",
    initialListing: {
      location: {
        kind: "local",
        path: "C:\\Workspace"
      },
      entries: [
        {
          path: "C:\\Workspace\\notes.txt",
          name: "notes.txt",
          extension: "txt",
          kind: "file",
          size: 1024,
          modifiedAt: "2026-04-18T10:00:00Z",
          isHidden: false,
          isSystem: false,
          isProtectedOperatingSystem: false,
          isReadOnly: false,
          isSymlink: false,
          location: {
            kind: "local",
            path: "C:\\Workspace\\notes.txt"
          },
          decoration: {
            colorHex: "#2266a8",
            tags: []
          }
        }
      ],
      parent: "C:\\",
      canGoUp: true
    },
    settings: {
      bookmarks: [],
      hotlist: [],
      navigationItems: [],
      tagDefinitions: [],
      entryTags: [],
      colorRules: [],
      shortcuts: [],
      detailsRowHeight: 24,
      theme: {
        panelFocusAccent: "#0f6cbd",
        activeTabBackground: "#ffffff",
        dropHighlightFill: "#0f6cbd",
        dropHighlightBorder: "#0f6cbd",
        tabMinWidth: 96
      },
      layout: {
        layoutMode: "quad",
        panelProportions: [0.5, 0.5, 0.5, 0.5],
        sidebarWidth: 280,
        showTree: true,
        showSearch: true
      },
      remoteProfiles: []
    }
  });

  const panel1Tab = bootstrap.panels["panel-1"].tabs[0];
  const panel2Tab = bootstrap.panels["panel-2"].tabs[0];

  assert.notEqual(panel1Tab.snapshot, panel2Tab.snapshot);
  assert.notEqual(panel1Tab.snapshot.entries, panel2Tab.snapshot.entries);
  assert.notEqual(panel1Tab.snapshot.entries[0], panel2Tab.snapshot.entries[0]);
});

assertTest("createTabFromSnapshot clones mutable tab fields from overrides", () => {
  const snapshot = mapDirectoryListingToSnapshot({
    location: {
      kind: "local",
      path: "C:\\Workspace"
    },
    entries: [],
    parent: "C:\\",
    canGoUp: true
  });
  const overrides = {
    history: ["C:\\Workspace", "C:\\Workspace\\Docs"],
    selectedEntryIds: ["notes"],
    expandedNodePaths: ["C:\\Workspace"],
    sort: {
      columnId: "modified" as const,
      direction: "desc" as const
    }
  };

  const tab = createTabFromSnapshot(snapshot, "tab-1", overrides);

  assert.notEqual(tab.history, overrides.history);
  assert.notEqual(tab.selectedEntryIds, overrides.selectedEntryIds);
  assert.notEqual(tab.expandedNodePaths, overrides.expandedNodePaths);
  assert.notEqual(tab.sort, overrides.sort);
});

assertTest("DEFAULT_SHORTCUTS does not contain navigate-parent", () => {
  assert.equal(DEFAULT_SHORTCUTS.some((s) => s.id === "navigate-parent"), false);
});

assertTest("mergeShortcutDefaults does not carry forward navigate-parent from stored shortcuts", () => {
  const model = normalizeSettingsModel({
    shortcuts: [
      { id: "navigate-parent", action: "返回上一级", scope: "listing", binding: "Backspace", description: "" },
      { id: "navigate-up", action: "上一级", scope: "panel", binding: "Alt+Up", description: "" }
    ],
    colorRules: [],
    tagRules: [],
    columns: [],
    navigationColumns: [],
    detailsRowHeight: 24,
    tooltipHoverDelayMs: 350,
    metadataRetentionHours: null,
    contextMenu: { defaultMenu: "native" },
    theme: { panelFocusAccent: "#0f6cbd", activeTabBackground: "#ffffff", dropHighlightFill: "#0f6cbd", dropHighlightBorder: "#0f6cbd", tabMinWidth: 96 }
  });
  assert.equal(model.shortcuts.some((s) => s.id === "navigate-parent"), false);
});

assertTest("mergeShortcutDefaults does not carry forward shortcuts not in the default table", () => {
  const model = mapSettingsModel({
    bookmarks: [],
    hotlist: [],
    navigationItems: [],
    tagDefinitions: [],
    entryTags: [],
    colorRules: [],
    shortcuts: [{ id: "shortcut-1", action: "Copy", accelerator: "Ctrl+C", scope: "workspace" }],
    columns: [],
    navigationColumns: [],
    detailsRowHeight: 24,
    tooltipHoverDelayMs: 350,
    metadataRetentionHours: null,
    contextMenu: { defaultMenu: "native" },
    theme: { panelFocusAccent: "#0f6cbd", activeTabBackground: "#ffffff", dropHighlightFill: "#0f6cbd", dropHighlightBorder: "#0f6cbd", tabMinWidth: 96 },
    layout: { layoutMode: "single", panelProportions: [1], sidebarWidth: 280, showTree: true, showSearch: false },
    remoteProfiles: []
  });
  assert.equal(model.shortcuts.some((s) => s.id === "shortcut-1"), false);
});

assertTest("mapFavoriteCollections converts settings snapshot collections into bookmark chips", () => {
  const favorites = mapFavoriteCollections({
    bookmarks: [{ id: "bookmark-1", name: "Docs", path: "C:\\Docs" }],
    hotlist: [{ id: "hot-1", name: "Remote", path: "sftp://deploy@example/root" }],
    navigationItems: [],
    tagDefinitions: [],
    entryTags: [],
    colorRules: [],
    shortcuts: [],
    detailsRowHeight: 36,
    theme: {
      panelFocusAccent: "#0f6cbd",
      activeTabBackground: "#ffffff",
      dropHighlightFill: "#0f6cbd",
      dropHighlightBorder: "#0f6cbd",
      tabMinWidth: 96
    },
    layout: {
      layoutMode: "dual",
      panelProportions: [0.5, 0.5],
      sidebarWidth: 280,
      showTree: true,
      showSearch: true
    },
    remoteProfiles: []
  });

  assert.equal(favorites.bookmarks[0].label, "Docs");
  assert.equal(favorites.bookmarks[0].kind, "bookmark");
  assert.equal(favorites.hotlist[0].label, "Remote");
  assert.equal(favorites.hotlist[0].kind, "hotlist");
});

assertTest("mapRemoteProfile preserves password and credentialTarget from backend", () => {
  const { mapRemoteProfile } = require("./workspaceMappers");
  const backendProfile = {
    id: "test-profile-1",
    name: "Test Server",
    protocol: "sftp",
    host: "example.com",
    port: 22,
    username: "testuser",
    rootPath: "/home/testuser",
    authKind: "password",
    passiveMode: true,
    ignoreHostKey: false,
    connectTimeoutSecs: 10,
    commandTimeoutSecs: 20,
    credentialTarget: "Athenaeum.Remote.test-profile-1",
    password: "secret-password-123"
  };

  const mapped = mapRemoteProfile(backendProfile);

  assert.equal(mapped.id, "test-profile-1");
  assert.equal(mapped.name, "Test Server");
  assert.equal(mapped.credentialTarget, "Athenaeum.Remote.test-profile-1");
  assert.equal(mapped.password, "secret-password-123");
});
