import assert from "node:assert/strict";
import { createMockWorkspaceBootstrap, searchMockCatalog } from "./mockData";
import type { SearchQuery } from "./types";

function assertTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function createSearchQuery(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
    name: "",
    content: "",
    nameMode: "normal",
    contentMode: "normal",
    extensionFilterText: "",
    extensionFilterMode: "include",
    includeFolders: false,
    recursive: true,
    caseSensitive: false,
    scope: "active-panel",
    ...overrides
  };
}

assertTest("searchMockCatalog treats unchecked case matching as case-insensitive content search", () => {
  const insensitiveResults = searchMockCatalog(
    createSearchQuery({ content: "atlas", caseSensitive: false }),
    ["C:\\Users\\Admin\\Documents"]
  );
  const sensitiveResults = searchMockCatalog(
    createSearchQuery({ content: "atlas", caseSensitive: true }),
    ["C:\\Users\\Admin\\Documents"]
  );
  const wildcardResults = searchMockCatalog(
    createSearchQuery({ content: "atlas*SEARCH", contentMode: "wildcard", caseSensitive: false }),
    ["C:\\Users\\Admin\\Documents"]
  );

  assert.equal(insensitiveResults.some((result) => result.name === "release-notes.md"), true);
  assert.equal(sensitiveResults.some((result) => result.name === "release-notes.md"), false);
  assert.equal(wildcardResults.some((result) => result.name === "release-notes.md"), true);
  assert.equal(insensitiveResults.some((result) => result.name === "bookmarks.json"), false);
});

assertTest("searchMockCatalog excludes nested folder content when recursive search is disabled", () => {
  const nonRecursiveResults = searchMockCatalog(
    createSearchQuery({ content: "archive signed", recursive: false }),
    ["C:\\Users\\Admin\\Documents"]
  );
  const recursiveResults = searchMockCatalog(
    createSearchQuery({ content: "archive signed", recursive: true }),
    ["C:\\Users\\Admin\\Documents"]
  );

  assert.equal(nonRecursiveResults.some((result) => result.name === "renewal-checklist.txt"), false);
  assert.equal(recursiveResults.some((result) => result.name === "renewal-checklist.txt"), true);
});

assertTest("createMockWorkspaceBootstrap exposes Shift as the configurable drag move shortcut", () => {
  const bootstrap = createMockWorkspaceBootstrap();
  const dragMove = bootstrap.settingsModel.shortcuts.find((shortcut) => shortcut.id === "drag-move");

  assert.equal(dragMove?.binding, "Shift");
  assert.equal(dragMove?.scope, "listing");
});
