import assert from "node:assert/strict";
import { normalizeLocationPath } from "./mockData";
import {
  createTabFromSnapshot,
  mapDirectoryListingToSnapshot,
  mapFavoriteCollections,
  mapWorkspaceBootstrap
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
        modifiedAt: "2026-04-18T10:00:00Z",
        isHidden: false,
        isReadOnly: true,
        isSymlink: false,
        location: {
          kind: "local",
          path: "C:\\Workspace\\notes.txt"
        },
        decoration: {
          colorHex: "#ff6600",
          tags: ["Pinned", "Docs"]
        }
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
  assert.equal(snapshot.entries[0].description, "只读文件");
});

assertTest("normalizeLocationPath strips Windows verbatim prefixes before further routing", () => {
  assert.equal(normalizeLocationPath("\\\\?\\E:\\"), "E:\\");
  assert.equal(normalizeLocationPath("\\\\?\\E:\\Workspace\\Logs"), "E:\\Workspace\\Logs");
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
      theme: {
        panelFocusAccent: "#c02f7a",
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
  assert.equal(bootstrap.settingsModel.shortcuts.find((shortcut) => shortcut.id === "shortcut-1")?.binding, "Ctrl+C");
  assert.equal(bootstrap.settingsModel.shortcuts.find((shortcut) => shortcut.id === "open-search")?.binding, "Ctrl+F");
  assert.equal(bootstrap.settingsModel.shortcuts.find((shortcut) => shortcut.id === "drag-move")?.binding, "Shift");
  assert.equal(bootstrap.settingsModel.colorRules[0].color, "#ff6600");
  assert.equal(bootstrap.settingsModel.detailsRowHeight, 44);
  assert.equal(bootstrap.settingsModel.theme.panelFocusAccent, "#c02f7a");
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
