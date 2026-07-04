import type { DirectoryNode, EntryViewModel, FileVisibilityState } from "./types";

export const DEFAULT_FILE_VISIBILITY: FileVisibilityState = {
  showHidden: false,
  showSystem: false,
  hideProtectedOperatingSystemFiles: true
};

export function entryMatchesFileVisibility(
  entry: Pick<EntryViewModel, "isHidden" | "isSystem" | "isProtectedOperatingSystem">,
  visibility: FileVisibilityState
) {
  if (entry.isProtectedOperatingSystem && visibility.hideProtectedOperatingSystemFiles) {
    return false;
  }
  if (entry.isHidden && !visibility.showHidden) {
    return false;
  }
  if (entry.isSystem && !visibility.showSystem) {
    return false;
  }
  return true;
}

export function filterEntriesByFileVisibility(entries: EntryViewModel[], visibility: FileVisibilityState) {
  return entries.filter((entry) => entryMatchesFileVisibility(entry, visibility));
}

export function filterDirectoryNodesByFileVisibility(nodes: DirectoryNode[], visibility: FileVisibilityState): DirectoryNode[] {
  let changed = false;
  const filteredNodes: DirectoryNode[] = [];

  for (const node of nodes) {
    if (!entryMatchesFileVisibility(node, visibility)) {
      changed = true;
      continue;
    }

    const nextChildren = filterDirectoryNodesByFileVisibility(node.children, visibility);
    if (nextChildren !== node.children) {
      changed = true;
      filteredNodes.push({
        ...node,
        children: nextChildren
      });
      continue;
    }

    filteredNodes.push(node);
  }

  return changed ? filteredNodes : nodes;
}
