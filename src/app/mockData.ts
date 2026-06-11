import type {
  Bookmark,
  ColorRule,
  DirectoryListing,
  DriveInfo,
  EntryViewModel,
  HotlistEntry,
  RemoteProfile,
  SearchQuery,
  SearchResult,
  SettingsSnapshot,
  ShortcutBinding,
  TagDefinition,
  TreeNode,
  UiLayout,
  WorkspaceBootstrap
} from "./types";

const now = new Date().toISOString();

const drives: DriveInfo[] = [
  { path: "C:\\", label: "System (C:)" },
  { path: "D:\\", label: "Work (D:)" }
];

const tags: TagDefinition[] = [
  { id: "tag-project", name: "Project", colorHex: "#2266a8" },
  { id: "tag-media", name: "Media", colorHex: "#23715c" }
];

const rules: ColorRule[] = [
  {
    id: "rule-rust",
    name: "Rust source",
    target: "file",
    mode: "extension",
    pattern: "rs",
    colorHex: "#ca5a00",
    priority: 1
  },
  {
    id: "rule-hidden",
    name: "Hidden entries",
    target: "any",
    mode: "hidden",
    colorHex: "#7a5e2a",
    priority: 2
  }
];

const shortcuts: ShortcutBinding[] = [
  { id: "shortcut-copy", action: "copy", accelerator: "Ctrl+C", scope: "workspace" },
  { id: "shortcut-cut", action: "cut", accelerator: "Ctrl+X", scope: "workspace" },
  { id: "shortcut-paste", action: "paste", accelerator: "Ctrl+V", scope: "workspace" },
  { id: "shortcut-delete", action: "delete", accelerator: "Delete", scope: "workspace" },
  { id: "shortcut-next-panel", action: "focusNextPanel", accelerator: "Tab", scope: "workspace" },
  { id: "shortcut-up", action: "goUp", accelerator: "Alt+Up", scope: "workspace" },
  { id: "shortcut-back", action: "goBack", accelerator: "Alt+Left", scope: "workspace" },
  { id: "shortcut-forward", action: "goForward", accelerator: "Alt+Right", scope: "workspace" }
];

const layout: UiLayout = {
  layoutMode: "dual",
  panelProportions: [52, 58],
  sidebarWidth: 280,
  showTree: true,
  showSearch: true
};

const bookmarks: Bookmark[] = [
  { id: "bookmark-home", name: "Home", path: "C:\\Users\\Administrator" },
  { id: "bookmark-projects", name: "Projects", path: "D:\\Projects" }
];

const hotlist: HotlistEntry[] = [
  { id: "hot-docs", name: "Documents", path: "C:\\Users\\Administrator\\Documents" },
  { id: "hot-downloads", name: "Downloads", path: "C:\\Users\\Administrator\\Downloads" }
];

const remoteProfiles: RemoteProfile[] = [
  {
    id: "remote-demo",
    name: "Demo SFTP",
    protocol: "sftp",
    host: "files.example.internal",
    port: 22,
    username: "demo",
    rootPath: "/srv/shared"
  }
];

function createEntry(
  path: string,
  name: string,
  kind: "file" | "directory",
  decoration: EntryViewModel["decoration"] = { tags: [] }
): EntryViewModel {
  const extension = kind === "file" && name.includes(".") ? name.split(".").pop() ?? null : null;
  return {
    path,
    name,
    extension,
    kind,
    size: kind === "file" ? Math.round(Math.random() * 1024 * 1024) : null,
    modifiedAt: now,
    isHidden: name.startsWith("."),
    isReadOnly: false,
    isSymlink: false,
    location: { kind: "local", path },
    decoration
  };
}

const listings = new Map<string, DirectoryListing>([
  [
    "C:\\",
    {
      location: { kind: "local", path: "C:\\" },
      parent: null,
      canGoUp: false,
      entries: [
        createEntry("C:\\Users", "Users", "directory", { tags: ["Project"], colorHex: "#2266a8" }),
        createEntry("C:\\Program Files", "Program Files", "directory"),
        createEntry("C:\\Windows", "Windows", "directory"),
        createEntry("C:\\readme.txt", "readme.txt", "file")
      ]
    }
  ],
  [
    "C:\\Users\\Administrator",
    {
      location: { kind: "local", path: "C:\\Users\\Administrator" },
      parent: "C:\\Users",
      canGoUp: true,
      entries: [
        createEntry("C:\\Users\\Administrator\\Desktop", "Desktop", "directory"),
        createEntry("C:\\Users\\Administrator\\Documents", "Documents", "directory"),
        createEntry("C:\\Users\\Administrator\\Downloads", "Downloads", "directory"),
        createEntry("C:\\Users\\Administrator\\notes.md", "notes.md", "file", { tags: ["Project"], colorHex: "#23715c" }),
        createEntry("C:\\Users\\Administrator\\todo.txt", "todo.txt", "file")
      ]
    }
  ],
  [
    "D:\\Projects",
    {
      location: { kind: "local", path: "D:\\Projects" },
      parent: "D:\\",
      canGoUp: true,
      entries: [
        createEntry("D:\\Projects\\SimpleFileManager", "SimpleFileManager", "directory", {
          tags: ["Project"],
          colorHex: "#2266a8"
        }),
        createEntry("D:\\Projects\\assets", "assets", "directory"),
        createEntry("D:\\Projects\\notes", "notes", "directory"),
        createEntry("D:\\Projects\\readme.md", "readme.md", "file")
      ]
    }
  ],
  [
    "D:\\Projects\\SimpleFileManager",
    {
      location: { kind: "local", path: "D:\\Projects\\SimpleFileManager" },
      parent: "D:\\Projects",
      canGoUp: true,
      entries: [
        createEntry("D:\\Projects\\SimpleFileManager\\src", "src", "directory"),
        createEntry("D:\\Projects\\SimpleFileManager\\src-tauri", "src-tauri", "directory"),
        createEntry("D:\\Projects\\SimpleFileManager\\Cargo.toml", "Cargo.toml", "file", {
          tags: ["Project"],
          colorHex: "#ca5a00"
        }),
        createEntry("D:\\Projects\\SimpleFileManager\\README.md", "README.md", "file")
      ]
    }
  ]
]);

const tree = new Map<string, TreeNode[]>([
  ["C:\\", [{ path: "C:\\Users", name: "Users", hasChildren: true }]],
  [
    "C:\\Users",
    [
      { path: "C:\\Users\\Administrator", name: "Administrator", hasChildren: true },
      { path: "C:\\Users\\Public", name: "Public", hasChildren: true }
    ]
  ],
  [
    "C:\\Users\\Administrator",
    [
      { path: "C:\\Users\\Administrator\\Desktop", name: "Desktop", hasChildren: false },
      { path: "C:\\Users\\Administrator\\Documents", name: "Documents", hasChildren: false },
      { path: "C:\\Users\\Administrator\\Downloads", name: "Downloads", hasChildren: false }
    ]
  ],
  [
    "D:\\",
    [{ path: "D:\\Projects", name: "Projects", hasChildren: true }]
  ],
  [
    "D:\\Projects",
    [{ path: "D:\\Projects\\SimpleFileManager", name: "SimpleFileManager", hasChildren: true }]
  ]
]);

export function getMockBootstrap(): WorkspaceBootstrap {
  const fallbackListing: DirectoryListing = {
    location: { kind: "local", path: "C:\\" },
    parent: null,
    canGoUp: false,
    entries: []
  };
  const initialListing = listings.get("C:\\Users\\Administrator") ?? [...listings.values()][0] ?? fallbackListing;
  return {
    drives,
    initialPath: initialListing.location.path,
    initialListing,
    settings: {
      bookmarks,
      hotlist,
      tagDefinitions: tags,
      entryTags: [],
      colorRules: rules,
      shortcuts,
      detailsRowHeight: 36,
      layout,
      remoteProfiles
    }
  };
}

export function getMockListing(path: string): DirectoryListing {
  return (
    listings.get(path) ?? {
      location: { kind: "local", path },
      parent: path.includes("\\") ? path.slice(0, Math.max(path.lastIndexOf("\\"), 2)) : null,
      canGoUp: path.includes("\\"),
      entries: []
    }
  );
}

export function getMockTreeChildren(path: string): TreeNode[] {
  return tree.get(path) ?? [];
}

export function searchMockFilesystem(query: SearchQuery): SearchResult[] {
  const roots = query.roots.length > 0 ? query.roots : [getMockBootstrap().initialPath];
  const loweredName = query.namePattern?.toLowerCase() ?? "";
  const loweredContent = query.contentPattern?.toLowerCase() ?? "";
  const extensions = query.extensions.map((extension) => extension.trim().replace(/^\./, "").toLowerCase()).filter(Boolean);

  const candidates = [...listings.values()].flatMap((listing) => listing.entries);
  return candidates
    .filter((entry) => roots.some((root) => entry.path.startsWith(root)))
    .filter((entry) => {
      if (!query.includeFolders && entry.kind === "directory") {
        return false;
      }
      if (entry.kind !== "directory" && extensions.length > 0) {
        const extension = (entry.extension ?? "").replace(/^\./, "").toLowerCase();
        const matched = extensions.includes(extension);
        if (query.extensionFilterMode === "include" ? !matched : matched) {
          return false;
        }
      }
      const matchesName = loweredName.length === 0 || entry.name.toLowerCase().includes(loweredName);
      const matchesContent =
        loweredContent.length === 0 ||
        `${entry.name} ${entry.path} ${entry.decoration.tags.join(" ")}`.toLowerCase().includes(loweredContent);
      return matchesName && matchesContent;
    })
    .map((entry, index) => ({
      searchId: query.searchId ?? `mock-search-${index}`,
      path: entry.path,
      name: entry.name,
      parent: entry.path.slice(0, Math.max(entry.path.lastIndexOf("\\"), 1)),
      isDirectory: entry.kind === "directory",
      matchedOn: [
        ...(loweredName ? ["name"] : []),
        ...(loweredContent ? ["content"] : [])
      ],
      excerpt: loweredContent ? `Matched "${query.contentPattern}" in ${entry.name}` : null
    }));
}

export function createMockSettings(): SettingsSnapshot {
  return getMockBootstrap().settings;
}
