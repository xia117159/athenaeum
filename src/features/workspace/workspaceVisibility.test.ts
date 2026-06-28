import assert from "node:assert/strict";
import {
  DEFAULT_FILE_VISIBILITY,
  entryMatchesFileVisibility,
  filterDirectoryNodesByFileVisibility,
  filterEntriesByFileVisibility
} from "./workspaceVisibility";
import type { DirectoryNode, EntryViewModel, FileVisibilityState } from "./types";

function assertTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function createEntry(id: string, flags: Partial<Pick<EntryViewModel, "isHidden" | "isSystem" | "isProtectedOperatingSystem">> = {}) {
  return {
    id,
    name: `${id}.txt`,
    kind: "file",
    path: `C:\\Workspace\\${id}.txt`,
    parentPath: "C:\\Workspace",
    sizeLabel: "1 KB",
    modifiedLabel: "2026-06-28 12:00",
    extension: ".txt",
    attributes: ["A"],
    accentColor: "#29659f",
    tags: [],
    description: "file",
    ...flags
  } satisfies EntryViewModel;
}

function createNode(
  path: string,
  flags: Partial<Pick<DirectoryNode, "isHidden" | "isSystem" | "isProtectedOperatingSystem">> = {},
  children: DirectoryNode[] = []
): DirectoryNode {
  return {
    id: path,
    label: path.split("\\").pop() ?? path,
    path,
    kind: "folder",
    expandable: children.length > 0,
    loaded: true,
    children,
    ...flags
  };
}

assertTest("DEFAULT_FILE_VISIBILITY follows Windows Explorer safe defaults", () => {
  assert.deepEqual(DEFAULT_FILE_VISIBILITY, {
    showHidden: false,
    showSystem: false,
    hideProtectedOperatingSystemFiles: true
  });
});

assertTest("entryMatchesFileVisibility hides hidden, system, and protected items until their switches allow them", () => {
  const normal = createEntry("normal");
  const hidden = createEntry("hidden", { isHidden: true });
  const system = createEntry("system", { isSystem: true });
  const protectedEntry = createEntry("protected", {
    isHidden: true,
    isSystem: true,
    isProtectedOperatingSystem: true
  });

  assert.equal(entryMatchesFileVisibility(normal, DEFAULT_FILE_VISIBILITY), true);
  assert.equal(entryMatchesFileVisibility(hidden, DEFAULT_FILE_VISIBILITY), false);
  assert.equal(entryMatchesFileVisibility(system, DEFAULT_FILE_VISIBILITY), false);
  assert.equal(entryMatchesFileVisibility(protectedEntry, DEFAULT_FILE_VISIBILITY), false);

  const showHiddenOnly: FileVisibilityState = {
    ...DEFAULT_FILE_VISIBILITY,
    showHidden: true
  };
  assert.equal(entryMatchesFileVisibility(hidden, showHiddenOnly), true);
  assert.equal(entryMatchesFileVisibility(system, showHiddenOnly), false);
  assert.equal(entryMatchesFileVisibility(protectedEntry, showHiddenOnly), false);

  const showAllButProtected: FileVisibilityState = {
    ...DEFAULT_FILE_VISIBILITY,
    showHidden: true,
    showSystem: true
  };
  assert.equal(entryMatchesFileVisibility(system, showAllButProtected), true);
  assert.equal(entryMatchesFileVisibility(protectedEntry, showAllButProtected), false);

  const showProtected: FileVisibilityState = {
    showHidden: true,
    showSystem: true,
    hideProtectedOperatingSystemFiles: false
  };
  assert.equal(entryMatchesFileVisibility(protectedEntry, showProtected), true);
});

assertTest("filterEntriesByFileVisibility keeps listing order while removing invisible entries", () => {
  const entries = [
    createEntry("normal"),
    createEntry("hidden", { isHidden: true }),
    createEntry("system", { isSystem: true }),
    createEntry("protected", { isHidden: true, isSystem: true, isProtectedOperatingSystem: true })
  ];

  assert.deepEqual(
    filterEntriesByFileVisibility(entries, DEFAULT_FILE_VISIBILITY).map((entry) => entry.id),
    ["normal"]
  );
  assert.deepEqual(
    filterEntriesByFileVisibility(entries, {
      showHidden: true,
      showSystem: true,
      hideProtectedOperatingSystemFiles: false
    }).map((entry) => entry.id),
    ["normal", "hidden", "system", "protected"]
  );
});

assertTest("filterDirectoryNodesByFileVisibility filters tree nodes recursively", () => {
  const nodes = [
    createNode("C:\\Visible", {}, [
      createNode("C:\\Visible\\Hidden", { isHidden: true }),
      createNode("C:\\Visible\\System", { isSystem: true }),
      createNode("C:\\Visible\\Normal")
    ]),
    createNode("C:\\Protected", { isHidden: true, isSystem: true, isProtectedOperatingSystem: true }, [
      createNode("C:\\Protected\\Child")
    ])
  ];

  const filtered = filterDirectoryNodesByFileVisibility(nodes, DEFAULT_FILE_VISIBILITY);
  assert.deepEqual(filtered.map((node) => node.path), ["C:\\Visible"]);
  assert.deepEqual(filtered[0].children.map((node) => node.path), ["C:\\Visible\\Normal"]);
  assert.deepEqual(nodes[0].children.map((node) => node.path), [
    "C:\\Visible\\Hidden",
    "C:\\Visible\\System",
    "C:\\Visible\\Normal"
  ]);
});
