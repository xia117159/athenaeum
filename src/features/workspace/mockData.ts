import type {
  BookmarkItem,
  DirectoryNode,
  DirectorySnapshot,
  EntryViewModel,
  LocationDescriptor,
  LocationKind,
  PanelId,
  PanelState,
  SearchQuery,
  SearchResult,
  SettingsModel,
  TabState,
  WorkspaceBootstrap
} from "./types";

type CatalogDirectory = {
  path: string;
  label: string;
  note: string;
  kind: LocationKind;
  children: string[];
  entries: EntryViewModel[];
};

const DEFAULT_MOCK_COLUMNS: SettingsModel["columns"] = [
  { id: "name", label: "鍚嶇О", visible: true, width: "2.2fr", align: "left" },
  { id: "type", label: "绫诲瀷", visible: true, width: "1.1fr", align: "left" },
  { id: "size", label: "澶у皬", visible: true, width: "0.9fr", align: "right" },
  { id: "modified", label: "淇敼鏃堕棿", visible: true, width: "1.2fr", align: "left" },
  { id: "tags", label: "鏍囩", visible: true, width: "1.1fr", align: "left" },
  { id: "location", label: "浣嶇疆", visible: false, width: "1.3fr", align: "left" }
];

function cloneMockColumns(columns: SettingsModel["columns"] = DEFAULT_MOCK_COLUMNS) {
  return columns.map((column) => ({ ...column }));
}

const ROOT_PATHS = ["C:\\", "D:\\", "sftp://deploy@edge-01/", "ftp://media@archive-server/shared"];
let tabSequence = 0;

function cloneEntry(entry: EntryViewModel): EntryViewModel {
  return {
    ...entry,
    attributes: [...entry.attributes],
    tags: [...entry.tags]
  };
}

function cloneSnapshot(snapshot: DirectorySnapshot): DirectorySnapshot {
  return {
    location: { ...snapshot.location },
    breadcrumbs: snapshot.breadcrumbs.map((breadcrumb) => ({ ...breadcrumb })),
    entries: snapshot.entries.map(cloneEntry)
  };
}

function getLeafLabel(path: string) {
  if (path.startsWith("sftp://") || path.startsWith("ftp://")) {
    const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
    const segments = trimmed.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? trimmed;
  }

  if (/^[A-Za-z]:\\$/.test(path)) {
    return path.slice(0, 2);
  }

  const normalized = path.endsWith("\\") ? path.slice(0, -1) : path;
  const segments = normalized.split("\\").filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

function joinLocationPath(parentPath: string, name: string) {
  if (parentPath.startsWith("sftp://") || parentPath.startsWith("ftp://")) {
    return parentPath.endsWith("/") ? `${parentPath}${name}` : `${parentPath}/${name}`;
  }
  return parentPath.endsWith("\\") ? `${parentPath}${name}` : `${parentPath}\\${name}`;
}

function getRemoteRootPath(path: string) {
  return ROOT_PATHS.find((rootPath) => {
    if (!rootPath.startsWith("sftp://") && !rootPath.startsWith("ftp://")) {
      return false;
    }
    const normalizedRoot = normalizeLocationPath(rootPath);
    const rootPrefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
    return path === normalizedRoot || path.startsWith(rootPrefix);
  });
}

function parseMockSizeLabel(sizeLabel: string) {
  const match = /^([\d.]+)\s*(B|KB|MB|GB|TB)$/i.exec(sizeLabel.trim());
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return null;
  }
  const unit = match[2].toUpperCase();
  const multiplier = unit === "B" ? 1 : unit === "KB" ? 1024 : unit === "MB" ? 1024 ** 2 : unit === "GB" ? 1024 ** 3 : 1024 ** 4;
  return Math.round(value * multiplier);
}

function createFileEntry(
  parentPath: string,
  name: string,
  options: Partial<
    Pick<
      EntryViewModel,
      "sizeBytes" | "sizeLabel" | "modifiedLabel" | "attributes" | "accentColor" | "tags" | "description" | "contentText"
    >
  > = {}
): EntryViewModel {
  const extension = name.includes(".") ? `.${name.split(".").pop()}` : "";
  const sizeLabel = options.sizeLabel ?? "24 KB";
  return {
    id: `${parentPath}:${name}`,
    name,
    kind: "file",
    path: joinLocationPath(parentPath, name),
    parentPath,
    sizeBytes: options.sizeBytes ?? parseMockSizeLabel(sizeLabel),
    sizeLabel,
    modifiedLabel: options.modifiedLabel ?? "2026-04-18 09:24",
    extension,
    attributes: options.attributes ?? ["A"],
    accentColor: options.accentColor ?? "#29659f",
    tags: options.tags ?? [],
    description: options.description ?? "用于前端渲染的模拟文件。",
    contentText: options.contentText
  };
}

function createFolderEntry(
  parentPath: string,
  path: string,
  tags: string[] = [],
  accentColor = "#2f6b57",
  description = "文件夹目录项"
): EntryViewModel {
  return {
    id: path,
    name: getLeafLabel(path),
    kind: "folder",
    path,
    parentPath,
    sizeBytes: null,
    sizeLabel: "--",
    modifiedLabel: "2026-04-18 08:12",
    extension: "",
    attributes: ["D"],
    accentColor,
    tags,
    description
  };
}

const DIRECTORY_CATALOG: Record<string, CatalogDirectory> = {
  "C:\\": {
    path: "C:\\",
    label: "Local Disk (C:)",
    note: "System drive",
    kind: "local",
    children: ["C:\\Users", "C:\\Tools"],
    entries: [
      createFolderEntry("C:\\", "C:\\Users", ["Users"]),
      createFolderEntry("C:\\", "C:\\Tools", ["Pinned"], "#7a5b2a", "Portable toolchain root"),
      createFileEntry("C:\\", "pagefile.sys", {
        sizeLabel: "4.0 GB",
        attributes: ["H", "S"],
        accentColor: "#8d4a42",
        tags: ["System"],
        description: "System managed memory file."
      })
    ]
  },
  "C:\\Users": {
    path: "C:\\Users",
    label: "Users",
    note: "Profiles",
    kind: "local",
    children: ["C:\\Users\\Admin"],
    entries: [
      createFolderEntry("C:\\Users", "C:\\Users\\Admin", ["Workspace"], "#2266a8", "Primary working profile")
    ]
  },
  "C:\\Users\\Admin": {
    path: "C:\\Users\\Admin",
    label: "Admin",
    note: "Primary profile",
    kind: "local",
    children: ["C:\\Users\\Admin\\Documents", "C:\\Users\\Admin\\Downloads", "C:\\Users\\Admin\\Desktop"],
    entries: [
      createFolderEntry("C:\\Users\\Admin", "C:\\Users\\Admin\\Documents", ["Work"]),
      createFolderEntry("C:\\Users\\Admin", "C:\\Users\\Admin\\Downloads", ["Inbox"], "#8d6b2c"),
      createFolderEntry("C:\\Users\\Admin", "C:\\Users\\Admin\\Desktop", ["Quick Access"], "#5e509b"),
      createFileEntry("C:\\Users\\Admin", "notes.txt", {
        sizeLabel: "11 KB",
        tags: ["Review"],
        description: "Daily scratchpad for release notes.",
        contentText: "Remember to review the edge deployment before 16:00."
      })
    ]
  },
  "C:\\Users\\Admin\\Documents": {
    path: "C:\\Users\\Admin\\Documents",
    label: "Documents",
    note: "Working documents",
    kind: "local",
    children: ["C:\\Users\\Admin\\Documents\\Contracts"],
    entries: [
      createFolderEntry(
        "C:\\Users\\Admin\\Documents",
        "C:\\Users\\Admin\\Documents\\Contracts",
        ["Legal"],
        "#7a5b2a",
        "Client contract archive"
      ),
      createFileEntry("C:\\Users\\Admin\\Documents", "Q2-roadmap.docx", {
        sizeLabel: "842 KB",
        accentColor: "#2266a8",
        tags: ["Roadmap"],
        description: "Roadmap draft for the operations group.",
        contentText: "Workspace redesign, hotlist shortcuts, and SFTP parity are scheduled for Q2."
      }),
      createFileEntry("C:\\Users\\Admin\\Documents", "release-notes.md", {
        sizeLabel: "18 KB",
        accentColor: "#23715c",
        tags: ["Docs", "Release"],
        description: "Markdown release notes.",
        contentText: "The Atlas release contains search streaming and updated layout persistence."
      }),
      createFileEntry("C:\\Users\\Admin\\Documents", "bookmarks.json", {
        sizeLabel: "3 KB",
        accentColor: "#8d6b2c",
        tags: ["Config"],
        description: "Exported bookmark definitions."
      })
    ]
  },
  "C:\\Users\\Admin\\Documents\\Contracts": {
    path: "C:\\Users\\Admin\\Documents\\Contracts",
    label: "Contracts",
    note: "Reference documents",
    kind: "local",
    children: [],
    entries: [
      createFileEntry("C:\\Users\\Admin\\Documents\\Contracts", "NDA-template.pdf", {
        sizeLabel: "212 KB",
        accentColor: "#8d4a42",
        tags: ["Legal"],
        description: "Legal PDF template."
      }),
      createFileEntry("C:\\Users\\Admin\\Documents\\Contracts", "renewal-checklist.txt", {
        sizeLabel: "7 KB",
        accentColor: "#7a5b2a",
        tags: ["Checklist"],
        description: "Contract renewal reminder list.",
        contentText: "Confirm approval routing, archive signed copy, and update the hotlist entry."
      })
    ]
  },
  "C:\\Users\\Admin\\Downloads": {
    path: "C:\\Users\\Admin\\Downloads",
    label: "Downloads",
    note: "Incoming files",
    kind: "local",
    children: ["C:\\Users\\Admin\\Downloads\\release-candidate"],
    entries: [
      createFolderEntry(
        "C:\\Users\\Admin\\Downloads",
        "C:\\Users\\Admin\\Downloads\\release-candidate",
        ["Staging"],
        "#8d6b2c",
        "Temporary release drop"
      ),
      createFileEntry("C:\\Users\\Admin\\Downloads", "desktop-build.msi", {
        sizeLabel: "62 MB",
        accentColor: "#8d4a42",
        tags: ["Installer"],
        description: "Desktop installer package."
      }),
      createFileEntry("C:\\Users\\Admin\\Downloads", "assets.zip", {
        sizeLabel: "184 MB",
        accentColor: "#2266a8",
        tags: ["Archive"],
        description: "UI asset bundle."
      })
    ]
  },
  "C:\\Users\\Admin\\Downloads\\release-candidate": {
    path: "C:\\Users\\Admin\\Downloads\\release-candidate",
    label: "release-candidate",
    note: "Transient folder",
    kind: "local",
    children: [],
    entries: [
      createFileEntry("C:\\Users\\Admin\\Downloads\\release-candidate", "readme.txt", {
        sizeLabel: "2 KB",
        tags: ["Notes"],
        description: "Drop instructions.",
        contentText: "Validate SFTP uploads and run the smoke checklist."
      }),
      createFileEntry("C:\\Users\\Admin\\Downloads\\release-candidate", "manifest.json", {
        sizeLabel: "12 KB",
        tags: ["Manifest"],
        description: "Release manifest."
      })
    ]
  },
  "C:\\Users\\Admin\\Desktop": {
    path: "C:\\Users\\Admin\\Desktop",
    label: "Desktop",
    note: "Visual staging area",
    kind: "local",
    children: [],
    entries: [
      createFileEntry("C:\\Users\\Admin\\Desktop", "deployment-plan.url", {
        sizeLabel: "1 KB",
        tags: ["Shortcut"],
        description: "Pinned browser link."
      }),
      createFileEntry("C:\\Users\\Admin\\Desktop", "TODO.txt", {
        sizeLabel: "5 KB",
        tags: ["Task"],
        description: "Visible reminder list.",
        contentText: "Finish shortcut editor, confirm custom context rules, and polish panel focus visuals."
      })
    ]
  },
  "C:\\Tools": {
    path: "C:\\Tools",
    label: "Tools",
    note: "Portable utilities",
    kind: "local",
    children: [],
    entries: [
      createFileEntry("C:\\Tools", "rg.exe", {
        sizeLabel: "5.1 MB",
        tags: ["Utility"],
        description: "ripgrep binary"
      }),
      createFileEntry("C:\\Tools", "winscp.exe", {
        sizeLabel: "12 MB",
        tags: ["SFTP"],
        description: "Portable remote client"
      })
    ]
  },
  "D:\\": {
    path: "D:\\",
    label: "Projects (D:)",
    note: "High-throughput workspace",
    kind: "local",
    children: ["D:\\Projects", "D:\\Archive"],
    entries: [
      createFolderEntry("D:\\", "D:\\Projects", ["Pinned"], "#2266a8", "Active codebases"),
      createFolderEntry("D:\\", "D:\\Archive", ["Cold Storage"], "#7a5b2a", "Long-term archive")
    ]
  },
  "D:\\Projects": {
    path: "D:\\Projects",
    label: "Projects",
    note: "Source roots",
    kind: "local",
    children: ["D:\\Projects\\Atlas", "D:\\Projects\\Helix"],
    entries: [
      createFolderEntry("D:\\Projects", "D:\\Projects\\Atlas", ["Frontend"], "#2266a8", "Tauri file manager UI"),
      createFolderEntry("D:\\Projects", "D:\\Projects\\Helix", ["Backend"], "#23715c", "Service adapter"),
      createFileEntry("D:\\Projects", "shared-components.md", {
        sizeLabel: "15 KB",
        tags: ["Reference"],
        description: "Component audit and follow-up notes.",
        contentText: "Panel layout shell, search drawer, and settings surface are ready for review."
      })
    ]
  },
  "D:\\Projects\\Atlas": {
    path: "D:\\Projects\\Atlas",
    label: "Atlas",
    note: "Primary app workspace",
    kind: "local",
    children: ["D:\\Projects\\Atlas\\src", "D:\\Projects\\Atlas\\docs"],
    entries: [
      createFolderEntry("D:\\Projects\\Atlas", "D:\\Projects\\Atlas\\src", ["Source"], "#2266a8", "App source tree"),
      createFolderEntry("D:\\Projects\\Atlas", "D:\\Projects\\Atlas\\docs", ["Docs"], "#23715c", "Design and ADRs"),
      createFileEntry("D:\\Projects\\Atlas", "sprint-plan.md", {
        sizeLabel: "9 KB",
        tags: ["Planning"],
        description: "Current sprint plan",
        contentText: "Implement panel reducer tests before wiring the visual workspace shell."
      }),
      createFileEntry("D:\\Projects\\Atlas", "design-tokens.json", {
        sizeLabel: "6 KB",
        tags: ["Theme"],
        description: "Workspace tokens"
      })
    ]
  },
  "D:\\Projects\\Atlas\\src": {
    path: "D:\\Projects\\Atlas\\src",
    label: "src",
    note: "Application code",
    kind: "local",
    children: [],
    entries: [
      createFileEntry("D:\\Projects\\Atlas\\src", "main.tsx", {
        sizeLabel: "3 KB",
        tags: ["Entry"],
        description: "React entrypoint"
      }),
      createFileEntry("D:\\Projects\\Atlas\\src", "WorkspaceView.tsx", {
        sizeLabel: "24 KB",
        tags: ["UI"],
        description: "Workspace shell implementation",
        contentText: "Resizable multi-panel layout with tabs, address bar, tree shell, and settings drawer."
      })
    ]
  },
  "D:\\Projects\\Atlas\\docs": {
    path: "D:\\Projects\\Atlas\\docs",
    label: "docs",
    note: "Project documents",
    kind: "local",
    children: [],
    entries: [
      createFileEntry("D:\\Projects\\Atlas\\docs", "design.md", {
        sizeLabel: "28 KB",
        tags: ["Design"],
        description: "Detailed design document"
      }),
      createFileEntry("D:\\Projects\\Atlas\\docs", "adr-004-panel-focus.md", {
        sizeLabel: "11 KB",
        tags: ["ADR"],
        description: "Decision note about focus order.",
        contentText: "Tab cycles through visible panels in visual order."
      })
    ]
  },
  "D:\\Projects\\Helix": {
    path: "D:\\Projects\\Helix",
    label: "Helix",
    note: "Remote adapter workspace",
    kind: "local",
    children: [],
    entries: [
      createFileEntry("D:\\Projects\\Helix", "remote-service.rs", {
        sizeLabel: "31 KB",
        tags: ["Rust"],
        description: "FTP/SFTP service module."
      }),
      createFileEntry("D:\\Projects\\Helix", "search-indexer.rs", {
        sizeLabel: "20 KB",
        tags: ["Rust", "Search"],
        description: "Streaming search implementation.",
        contentText: "Search tasks emit partial results so the UI stays responsive."
      })
    ]
  },
  "D:\\Archive": {
    path: "D:\\Archive",
    label: "Archive",
    note: "Long-term storage",
    kind: "local",
    children: [],
    entries: [
      createFileEntry("D:\\Archive", "2025-audit.zip", {
        sizeLabel: "420 MB",
        tags: ["Archive"],
        description: "Archived audit bundle"
      }),
      createFileEntry("D:\\Archive", "legacy-bookmarks.csv", {
        sizeLabel: "14 KB",
        tags: ["Import"],
        description: "Imported bookmark inventory."
      })
    ]
  },
  "sftp://deploy@edge-01/": {
    path: "sftp://deploy@edge-01/",
    label: "edge-01",
    note: "SFTP remote",
    kind: "sftp",
    children: ["sftp://deploy@edge-01/releases", "sftp://deploy@edge-01/logs"],
    entries: [
      createFolderEntry(
        "sftp://deploy@edge-01/",
        "sftp://deploy@edge-01/releases",
        ["Remote"],
        "#2266a8",
        "Release drops"
      ),
      createFolderEntry("sftp://deploy@edge-01/", "sftp://deploy@edge-01/logs", ["Logs"], "#8d6b2c", "Server logs"),
      createFileEntry("sftp://deploy@edge-01/", "readme.txt", {
        sizeLabel: "1 KB",
        tags: ["Remote"],
        description: "Server note",
        contentText: "Use Ctrl plus right click to inspect the custom command surface."
      })
    ]
  },
  "sftp://deploy@edge-01/releases": {
    path: "sftp://deploy@edge-01/releases",
    label: "releases",
    note: "Deployment bundles",
    kind: "sftp",
    children: [
      "sftp://deploy@edge-01/releases/2026-04-16",
      "sftp://deploy@edge-01/releases/2026-04-18"
    ],
    entries: [
      createFolderEntry(
        "sftp://deploy@edge-01/releases",
        "sftp://deploy@edge-01/releases/2026-04-16",
        ["Stable"],
        "#23715c",
        "Validated bundle"
      ),
      createFolderEntry(
        "sftp://deploy@edge-01/releases",
        "sftp://deploy@edge-01/releases/2026-04-18",
        ["Latest"],
        "#2266a8",
        "Current release candidate"
      ),
      createFileEntry("sftp://deploy@edge-01/releases", "manifest.yml", {
        sizeLabel: "4 KB",
        tags: ["Manifest"],
        description: "Remote manifest.",
        contentText: "release: 2026-04-18\nartifacts:\n  - desktop-build.msi\n  - manifest.json"
      })
    ]
  },
  "sftp://deploy@edge-01/releases/2026-04-16": {
    path: "sftp://deploy@edge-01/releases/2026-04-16",
    label: "2026-04-16",
    note: "Stable bundle",
    kind: "sftp",
    children: [],
    entries: [
      createFileEntry("sftp://deploy@edge-01/releases/2026-04-16", "atlas-win-x64.zip", {
        sizeLabel: "93 MB",
        tags: ["Release"],
        description: "Stable build artifact"
      }),
      createFileEntry("sftp://deploy@edge-01/releases/2026-04-16", "checksums.txt", {
        sizeLabel: "2 KB",
        tags: ["Checksum"],
        description: "Hash manifest"
      })
    ]
  },
  "sftp://deploy@edge-01/releases/2026-04-18": {
    path: "sftp://deploy@edge-01/releases/2026-04-18",
    label: "2026-04-18",
    note: "Current release candidate",
    kind: "sftp",
    children: [],
    entries: [
      createFileEntry("sftp://deploy@edge-01/releases/2026-04-18", "atlas-win-x64.zip", {
        sizeLabel: "94 MB",
        tags: ["Release", "Latest"],
        description: "Release candidate bundle"
      }),
      createFileEntry("sftp://deploy@edge-01/releases/2026-04-18", "release-notes.txt", {
        sizeLabel: "5 KB",
        tags: ["Notes"],
        description: "Deployment note",
        contentText: "Smoke test the quad layout and the shortcut editor before promotion."
      })
    ]
  },
  "sftp://deploy@edge-01/logs": {
    path: "sftp://deploy@edge-01/logs",
    label: "logs",
    note: "Remote logs",
    kind: "sftp",
    children: [],
    entries: [
      createFileEntry("sftp://deploy@edge-01/logs", "app.log", {
        sizeLabel: "18 MB",
        tags: ["Logs"],
        description: "Current application log"
      }),
      createFileEntry("sftp://deploy@edge-01/logs", "sync.log", {
        sizeLabel: "2 MB",
        tags: ["Logs"],
        description: "Sync activity log",
        contentText: "copy complete, rename complete, delete pending retry"
      })
    ]
  },
  "ftp://media@archive-server/shared": {
    path: "ftp://media@archive-server/shared",
    label: "shared",
    note: "FTP media share",
    kind: "ftp",
    children: ["ftp://media@archive-server/shared/incoming", "ftp://media@archive-server/shared/exports"],
    entries: [
      createFolderEntry(
        "ftp://media@archive-server/shared",
        "ftp://media@archive-server/shared/incoming",
        ["FTP"],
        "#8d6b2c",
        "Inbound assets"
      ),
      createFolderEntry(
        "ftp://media@archive-server/shared",
        "ftp://media@archive-server/shared/exports",
        ["Export"],
        "#2266a8",
        "Outgoing bundles"
      ),
      createFileEntry("ftp://media@archive-server/shared", "nightly.csv", {
        sizeLabel: "26 KB",
        tags: ["Report"],
        description: "Nightly transfer report"
      })
    ]
  },
  "ftp://media@archive-server/shared/incoming": {
    path: "ftp://media@archive-server/shared/incoming",
    label: "incoming",
    note: "Inbound remote content",
    kind: "ftp",
    children: [],
    entries: [
      createFileEntry("ftp://media@archive-server/shared/incoming", "brand-assets.tar", {
        sizeLabel: "211 MB",
        tags: ["Asset"],
        description: "Brand asset pack"
      })
    ]
  },
  "ftp://media@archive-server/shared/exports": {
    path: "ftp://media@archive-server/shared/exports",
    label: "exports",
    note: "Outbound remote content",
    kind: "ftp",
    children: [],
    entries: [
      createFileEntry("ftp://media@archive-server/shared/exports", "marketing-kit.zip", {
        sizeLabel: "128 MB",
        tags: ["Asset", "Export"],
        description: "Marketing export bundle"
      })
    ]
  }
};

export function normalizeLocationPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "D:\\Projects\\Atlas";
  }

  if (trimmed.startsWith("sftp://") || trimmed.startsWith("ftp://")) {
    const protocolMatch = trimmed.match(/^(sftp|ftp):\/\//);
    if (!protocolMatch) {
      return trimmed;
    }
    const protocol = protocolMatch[0];
    const withoutProtocol = trimmed.slice(protocol.length).replace(/\\/g, "/");
    const normalizedRemote = `${protocol}${withoutProtocol.replace(/\/{2,}/g, "/")}`;
    if (DIRECTORY_CATALOG[normalizedRemote]) {
      return normalizedRemote;
    }
    if (normalizedRemote.endsWith("/")) {
      return normalizedRemote;
    }
    return normalizedRemote;
  }

  const withoutVerbatimPrefix = trimmed
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "")
    .replace(/^\\\?\\/, "")
    .replace(/^\\\\\.\\/, "");
  const normalized = withoutVerbatimPrefix.replace(/\//g, "\\").replace(/\\{2,}/g, "\\");
  if (/^[A-Za-z]:\\?$/.test(normalized)) {
    return normalized.endsWith("\\") ? normalized : `${normalized}\\`;
  }
  return normalized.endsWith("\\") ? normalized.slice(0, -1) : normalized;
}

export function getParentLocationPath(path: string): string | null {
  const normalized = normalizeLocationPath(path);

  if (normalized.startsWith("sftp://") || normalized.startsWith("ftp://")) {
    const remoteRoot = getRemoteRootPath(normalized);
    if (!remoteRoot) {
      return null;
    }
    if (normalized === remoteRoot) {
      return null;
    }
    const rootPrefix = remoteRoot.endsWith("/") ? remoteRoot : `${remoteRoot}/`;
    const remainder = normalized.slice(rootPrefix.length).split("/").filter(Boolean);
    if (remainder.length <= 1) {
      return remoteRoot;
    }
    return `${rootPrefix}${remainder.slice(0, -1).join("/")}`;
  }

  if (/^[A-Za-z]:\\$/.test(normalized)) {
    return null;
  }

  const parts = normalized.split("\\");
  if (parts.length <= 2) {
    return `${parts[0]}\\`;
  }
  return parts.slice(0, -1).join("\\");
}

export function getPathLabel(path: string): string {
  const normalized = normalizeLocationPath(path);
  const catalogRecord = DIRECTORY_CATALOG[normalized];
  if (catalogRecord) {
    return catalogRecord.label;
  }

  if (normalized.startsWith("sftp://") || normalized.startsWith("ftp://")) {
    const segments = normalized.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? normalized;
  }

  if (/^[A-Za-z]:\\$/.test(normalized)) {
    return `磁盘 ${normalized.slice(0, 2)}`;
  }

  const segments = normalized.split("\\").filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

function createLocationDescriptor(path: string): LocationDescriptor {
  const normalized = normalizeLocationPath(path);
  const catalogRecord = DIRECTORY_CATALOG[normalized];
  if (catalogRecord) {
    return {
      kind: catalogRecord.kind,
      label: catalogRecord.label,
      path: catalogRecord.path,
      subtitle: catalogRecord.note
    };
  }

  if (normalized.startsWith("sftp://")) {
    return { kind: "sftp", label: getPathLabel(normalized), path: normalized, subtitle: "远程路径" };
  }
  if (normalized.startsWith("ftp://")) {
    return { kind: "ftp", label: getPathLabel(normalized), path: normalized, subtitle: "远程路径" };
  }

  return { kind: "local", label: getPathLabel(normalized), path: normalized, subtitle: "文件系统路径" };
}

function createBreadcrumbs(path: string) {
  const normalized = normalizeLocationPath(path);

  if (normalized.startsWith("sftp://") || normalized.startsWith("ftp://")) {
    const remoteRoot = getRemoteRootPath(normalized);
    if (!remoteRoot) {
      return [];
    }
    const rootPrefix = remoteRoot.endsWith("/") ? remoteRoot : `${remoteRoot}/`;
    const breadcrumbs = [{ id: remoteRoot, label: DIRECTORY_CATALOG[remoteRoot]?.label ?? remoteRoot, path: remoteRoot }];
    const parts = normalized.slice(rootPrefix.length).split("/").filter(Boolean);
    let currentPath = remoteRoot;
    for (const part of parts) {
      currentPath = currentPath.endsWith("/") ? `${currentPath}${part}` : `${currentPath}/${part}`;
      breadcrumbs.push({ id: currentPath, label: getPathLabel(currentPath), path: currentPath });
    }
    return breadcrumbs;
  }

  const drive = normalized.slice(0, 3);
  const breadcrumbs = [{ id: drive, label: DIRECTORY_CATALOG[drive]?.label ?? drive, path: drive }];
  const parts = normalized.slice(3).split("\\").filter(Boolean);
  let currentPath = drive.endsWith("\\") ? drive.slice(0, -1) : drive;
  for (const part of parts) {
    currentPath = currentPath.endsWith("\\") ? `${currentPath}${part}` : `${currentPath}\\${part}`;
    breadcrumbs.push({ id: currentPath, label: part, path: currentPath });
  }
  return breadcrumbs;
}

function buildDirectoryNode(path: string): DirectoryNode {
  const catalogRecord = DIRECTORY_CATALOG[path];
  const isRemote = catalogRecord.kind === "ftp" || catalogRecord.kind === "sftp";

  return {
    id: path,
    label: catalogRecord.label,
    path,
    kind: isRemote ? "remote-root" : /^[A-Za-z]:\\$/.test(path) ? "drive" : "folder",
    badge: catalogRecord.note,
    expandable: catalogRecord.children.length > 0,
    loaded: true,
    children: catalogRecord.children.map(buildDirectoryNode)
  };
}

export function buildMockDirectoryTree(): DirectoryNode[] {
  return ROOT_PATHS.map(buildDirectoryNode);
}

export function resolveMockDirectory(path: string): DirectorySnapshot {
  const normalized = normalizeLocationPath(path);
  const catalogRecord = DIRECTORY_CATALOG[normalized];

  if (catalogRecord) {
    return {
      location: createLocationDescriptor(catalogRecord.path),
      breadcrumbs: createBreadcrumbs(catalogRecord.path),
      entries: catalogRecord.entries.map(cloneEntry)
    };
  }

  return {
    location: createLocationDescriptor(normalized),
    breadcrumbs: createBreadcrumbs(normalized),
    entries: []
  };
}

function createPanelState(
  panelId: PanelId,
  label: string,
  paths: string[],
  activeIndex: number,
  tabIdBase: string
): PanelState {
  const tabs = paths.map((path, index) =>
    createTabState(path, `${tabIdBase}-${index + 1}`, {
      expandedNodePaths: createBreadcrumbs(path).map((item) => item.path)
    })
  );

  return {
    id: panelId,
    label,
    tabs,
    activeTabId: tabs[Math.min(activeIndex, tabs.length - 1)]?.id ?? tabs[0].id
  };
}

export function nextGeneratedTabId(panelId: PanelId) {
  tabSequence += 1;
  return `${panelId}-generated-tab-${tabSequence.toString(36)}`;
}

export function createTabState(
  path: string,
  id: string,
  overrides: Partial<Omit<TabState, "id" | "snapshot" | "title" | "addressDraft">> & {
    title?: string;
  } = {}
): TabState {
  const snapshot = resolveMockDirectory(path);
  const history = overrides.history ? [...overrides.history] : [snapshot.location.path];
  const historyIndex = Math.min(overrides.historyIndex ?? history.length - 1, history.length - 1);

  return {
    id,
    title: overrides.title ?? snapshot.location.label,
    titleOverride: overrides.title,
    kind: "directory",
    snapshot: cloneSnapshot(snapshot),
    addressDraft: snapshot.location.path,
    history,
    historyIndex,
    selectedEntryIds: overrides.selectedEntryIds ? [...overrides.selectedEntryIds] : [],
    expandedNodePaths: overrides.expandedNodePaths
      ? [...overrides.expandedNodePaths]
      : createBreadcrumbs(snapshot.location.path).map((item) => item.path),
    viewMode: overrides.viewMode ?? "details",
    sort: overrides.sort
      ? { ...overrides.sort }
      : {
          columnId: "name",
          direction: "asc"
        },
    columns: overrides.columns ? cloneMockColumns(overrides.columns) : cloneMockColumns(),
    status: overrides.status ?? "ready",
    locked: overrides.locked
  };
}

function createSettingsModel(): SettingsModel {
  return {
    shortcuts: [
      {
        id: "focus-next-panel",
        action: "切换到下一个面板",
        scope: "workspace",
        binding: "Tab",
        description: "按顺序切换可见面板焦点。"
      },
      {
        id: "open-search",
        action: "打开搜索面板",
        scope: "workspace",
        binding: "Ctrl+F",
        description: "打开停靠式搜索面板。"
      },
      {
        id: "copy",
        action: "复制",
        scope: "listing",
        binding: "Ctrl+C",
        description: "复制当前选中项。"
      },
      {
        id: "paste",
        action: "粘贴",
        scope: "listing",
        binding: "Ctrl+V",
        description: "将剪贴板内容粘贴到当前目录。"
      },
      {
        id: "cut",
        action: "剪切",
        scope: "listing",
        binding: "Ctrl+X",
        description: "剪切当前选中项。"
      },
      {
        id: "drag-move",
        action: "拖放时移动",
        scope: "listing",
        binding: "Shift",
        description: "拖放文件或文件夹时执行移动而不是复制。"
      },
      {
        id: "create-folder",
        action: "新建文件夹",
        scope: "listing",
        binding: "Ctrl+Shift+N",
        description: "在当前目录中新建文件夹。"
      },
      {
        id: "delete",
        action: "删除",
        scope: "listing",
        binding: "Delete",
        description: "删除当前选中项。"
      },
      {
        id: "rename",
        action: "重命名",
        scope: "listing",
        binding: "F2",
        description: "重命名当前选中项。"
      },
      {
        id: "refresh",
        action: "刷新",
        scope: "panel",
        binding: "F5",
        description: "刷新当前面板。"
      },
      {
        id: "new-tab",
        action: "新建标签页",
        scope: "panel",
        binding: "Ctrl+T",
        description: "在新标签页中打开当前目录。"
      },
      {
        id: "close-tab",
        action: "关闭标签页",
        scope: "panel",
        binding: "Ctrl+W",
        description: "当存在多个标签页时关闭当前标签页。"
      }
    ],
    colorRules: [
      {
        id: "rule-release",
        label: "发布产物",
        matcher: "*.zip | tag:Release",
        color: "#2266a8",
        previewText: "在高密度列表中突出显示发布包。"
      },
      {
        id: "rule-system",
        label: "系统文件",
        matcher: "attribute:H,S",
        color: "#8d4a42",
        previewText: "高亮危险文件或系统托管文件。"
      }
    ],
    tagRules: [
      {
        id: "tag-latest",
        label: "最新",
        matcher: "name:2026-04-18*",
        accentColor: "#2266a8",
        quickFilter: "最新"
      },
      {
        id: "tag-review",
        label: "待审阅",
        matcher: "content:review",
        accentColor: "#8d6b2c",
        quickFilter: "待审阅"
      }
    ],
    columns: [
      { id: "name", label: "名称", visible: true, width: "2.2fr", align: "left" },
      { id: "type", label: "类型", visible: true, width: "1.1fr", align: "left" },
      { id: "size", label: "大小", visible: true, width: "0.9fr", align: "right" },
      { id: "modified", label: "修改时间", visible: true, width: "1.2fr", align: "left" },
      { id: "tags", label: "标签", visible: true, width: "1.1fr", align: "left" },
      { id: "location", label: "位置", visible: false, width: "1.3fr", align: "left" }
    ],
    detailsRowHeight: 24,
    theme: {
      panelFocusAccent: "#0f6cbd",
      tabMinWidth: 96
    }
  };
}

function createBookmarks(): BookmarkItem[] {
  return [
    {
      id: "bookmark-atlas",
      label: "Atlas",
      path: "D:\\Projects\\Atlas",
      tint: "#2266a8",
      note: "主应用工作区",
      kind: "bookmark"
    },
    {
      id: "bookmark-docs",
      label: "Documents",
      path: "C:\\Users\\Admin\\Documents",
      tint: "#23715c",
      note: "工作文档",
      kind: "bookmark"
    },
    {
      id: "bookmark-releases",
      label: "edge-01 发布包",
      path: "sftp://deploy@edge-01/releases",
      tint: "#8d6b2c",
      note: "远程部署包",
      kind: "bookmark"
    }
  ];
}

function createHotlist(): BookmarkItem[] {
  return [
    {
      id: "hotlist-downloads",
      label: "Downloads",
      path: "C:\\Users\\Admin\\Downloads",
      tint: "#8d6b2c",
      note: "下载文件",
      kind: "hotlist"
    },
    {
      id: "hotlist-archive",
      label: "Archive",
      path: "D:\\Archive",
      tint: "#7a5b2a",
      note: "归档目录",
      kind: "hotlist"
    },
    {
      id: "hotlist-ftp",
      label: "FTP 导出目录",
      path: "ftp://media@archive-server/shared/exports",
      tint: "#2266a8",
      note: "远程导出目录",
      kind: "hotlist"
    }
  ];
}

export function createMockWorkspaceBootstrap(source: WorkspaceBootstrap["source"] = "mock"): WorkspaceBootstrap {
  return {
    source,
    layoutMode: "quad",
    layoutRatios: {
      primary: 0.52,
      tripleSecondary: 0.54,
      quadLeftSecondary: 0.54,
      quadRightSecondary: 0.54,
      tree: 0.28,
      search: 0.28
    },
    informationPanel: {
      expanded: false,
      activeTab: "properties",
      properties: {
        status: "idle"
      }
    },
    panels: {
      "panel-1": createPanelState(
        "panel-1",
        "面板 1",
        ["D:\\Projects\\Atlas", "C:\\Users\\Admin\\Documents"],
        0,
        "panel-1-tab"
      ),
      "panel-2": createPanelState(
        "panel-2",
        "面板 2",
        ["C:\\Users\\Admin\\Downloads", "D:\\Projects"],
        0,
        "panel-2-tab"
      ),
      "panel-3": createPanelState(
        "panel-3",
        "面板 3",
        ["sftp://deploy@edge-01/releases", "ftp://media@archive-server/shared"],
        0,
        "panel-3-tab"
      ),
      "panel-4": createPanelState(
        "panel-4",
        "面板 4",
        ["D:\\Archive", "C:\\Tools"],
        1,
        "panel-4-tab"
      )
    },
    activePanelId: "panel-1",
    directoryTree: buildMockDirectoryTree(),
    bookmarks: createBookmarks(),
    hotlist: createHotlist(),
    navigationItems: [],
    remoteProfiles: [
      {
        id: "remote-sftp-edge-01",
        name: "edge-01",
        protocol: "sftp",
        host: "edge-01",
        port: 22,
        username: "deploy",
        rootPath: "/",
        authKind: "password",
        passiveMode: true,
        ignoreHostKey: false,
        connectTimeoutSecs: 10,
        commandTimeoutSecs: 20
      },
      {
        id: "remote-ftp-archive",
        name: "archive-server",
        protocol: "ftp",
        host: "archive-server",
        port: 21,
        username: "media",
        rootPath: "/shared",
        authKind: "password",
        passiveMode: true,
        ignoreHostKey: false,
        connectTimeoutSecs: 10,
        commandTimeoutSecs: 20
      }
    ],
    settingsModel: createSettingsModel()
  };
}

function getSearchPathSeparator(path: string) {
  return path.startsWith("sftp://") || path.startsWith("ftp://") ? "/" : "\\";
}

function isWithinSearchScope(path: string, scopePaths: string[], recursive: boolean) {
  if (scopePaths.length === 0) {
    return true;
  }

  const normalizedPath = normalizeLocationPath(path).toLowerCase();
  return scopePaths.some((scopePath) => {
    const normalizedScope = normalizeLocationPath(scopePath).toLowerCase();
    const separator = getSearchPathSeparator(normalizedScope);
    const scopePrefix = normalizedScope.endsWith(separator) ? normalizedScope : `${normalizedScope}${separator}`;
    if (normalizedPath === normalizedScope) {
      return true;
    }
    if (!normalizedPath.startsWith(scopePrefix)) {
      return false;
    }
    if (recursive) {
      return true;
    }

    const remainder = normalizedPath.slice(scopePrefix.length);
    return Boolean(remainder) && !remainder.includes(separator);
  });
}

function buildSearchSnippet(
  entry: EntryViewModel,
  contentFilter: string,
  contentMode: SearchQuery["contentMode"],
  caseSensitive: boolean
) {
  if (contentFilter && contentMode === "normal" && entry.contentText) {
    const contentSource = caseSensitive ? entry.contentText : entry.contentText.toLowerCase();
    const filterSource = caseSensitive ? contentFilter : contentFilter.toLowerCase();
    const matchIndex = contentSource.indexOf(filterSource);
    if (matchIndex >= 0) {
      return entry.contentText.slice(Math.max(0, matchIndex - 12), matchIndex + contentFilter.length + 28);
    }
  }
  return entry.description;
}

function wildcardToRegExp(pattern: string) {
  return new RegExp(
    pattern
      .split("")
      .map((character) => {
        if (character === "*") {
          return ".*";
        }
        if (character === "?") {
          return ".";
        }
        return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("")
  );
}

function matchesSearchPattern(value: string, pattern: string, mode: SearchQuery["nameMode"], caseSensitive: boolean) {
  if (!pattern) {
    return true;
  }

  if (mode === "normal") {
    return caseSensitive ? value.includes(pattern) : value.toLowerCase().includes(pattern.toLowerCase());
  }

  try {
    const regex =
      mode === "wildcard"
        ? wildcardToRegExp(pattern)
        : new RegExp(pattern, caseSensitive ? "" : "i");
    if (mode === "wildcard" && !caseSensitive) {
      return new RegExp(regex.source, "i").test(value);
    }
    return regex.test(value);
  } catch {
    return false;
  }
}

function parseExtensionFilter(value: string) {
  return value
    .split(";")
    .map((extension) => extension.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
}

function entryMatchesExtensionFilter(entry: EntryViewModel, query: SearchQuery) {
  if (entry.kind === "folder") {
    return true;
  }

  const extensions = parseExtensionFilter(query.extensionFilterText);
  if (extensions.length === 0) {
    return true;
  }

  const extension = entry.extension.replace(/^\./, "").toLowerCase();
  const matched = extensions.includes(extension);
  return query.extensionFilterMode === "include" ? matched : !matched;
}

export function searchMockCatalog(query: SearchQuery, scopePaths: string[]): SearchResult[] {
  const nameFilter = query.name.trim();
  const contentFilter = query.content.trim();

  if (!nameFilter && !contentFilter) {
    return [];
  }

  const results: SearchResult[] = [];

  for (const directory of Object.values(DIRECTORY_CATALOG)) {
    if (!isWithinSearchScope(directory.path, scopePaths, query.recursive)) {
      continue;
    }

    const directoryNameMatches = matchesSearchPattern(directory.label, nameFilter, query.nameMode, query.caseSensitive);
    if (query.includeFolders && directoryNameMatches && !contentFilter) {
      results.push({
        id: `${directory.path}#directory`,
        name: directory.label,
        kind: "folder",
        path: directory.path,
        parentPath: getParentLocationPath(directory.path) ?? directory.path,
        openPath: directory.path,
        location: createLocationDescriptor(directory.path),
        match: directory.note
      });
    }

    for (const entry of directory.entries) {
      if (!isWithinSearchScope(entry.path, scopePaths, query.recursive)) {
        continue;
      }

      if (!query.includeFolders && entry.kind === "folder") {
        continue;
      }

      if (!entryMatchesExtensionFilter(entry, query)) {
        continue;
      }

      const matchesName = matchesSearchPattern(entry.name, nameFilter, query.nameMode, query.caseSensitive);
      const matchesContent =
        !contentFilter ||
        (entry.contentText
          ? matchesSearchPattern(entry.contentText, contentFilter, query.contentMode, query.caseSensitive)
          : false);

      if ((nameFilter && !matchesName) || (contentFilter && !matchesContent)) {
        continue;
      }

      results.push({
        id: `${entry.id}#search`,
        name: entry.name,
        kind: entry.kind,
        path: entry.path,
        parentPath: entry.parentPath,
        openPath: entry.kind === "folder" ? entry.path : entry.parentPath,
        location: createLocationDescriptor(entry.parentPath),
        match: buildSearchSnippet(entry, contentFilter, query.contentMode, query.caseSensitive)
      });
    }
  }

  return results.slice(0, 40);
}
