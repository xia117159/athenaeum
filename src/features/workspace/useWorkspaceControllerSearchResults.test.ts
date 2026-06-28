import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { createMockWorkspaceBootstrap, createTabState } from "./mockData";
import { useWorkspaceController } from "./useWorkspaceController";
import {
  assertTest,
  createEntry,
  createTestGateway,
  flushEffects,
  installDomEnvironment,
  waitFor
} from "./workspaceControllerTestHarness";
import { getActiveTab } from "./workspaceReducer";

export const completion = (async () => {
  installDomEnvironment();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);

  try {
    await assertTest("useWorkspaceController opens search result folders in a new active tab", async () => {
      const interactions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
        createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>,
        systemOpens: [] as string[]
      };
      const bootstrap = createMockWorkspaceBootstrap("tauri");
      const sourceTab = bootstrap.panels["panel-1"].tabs[0];
      const folderResult = createEntry(sourceTab.snapshot.location.path, "SearchHitFolder", "folder");
      const searchTab = {
        ...createTabState(sourceTab.snapshot.location.path, "search-results-tab-open"),
        title: "搜索结果",
        kind: "search-results" as const,
        snapshot: { ...sourceTab.snapshot, entries: [folderResult] },
        search: {
          sourceTabId: sourceTab.id,
          sourcePath: sourceTab.snapshot.location.path,
          query: {
            name: "SearchHitFolder",
            content: "",
            nameMode: "normal" as const,
            contentMode: "normal" as const,
            extensionFilterText: "",
            extensionFilterMode: "include" as const,
            includeFolders: true,
            recursive: true,
            caseSensitive: false,
            scope: "active-panel" as const
          },
          results: []
        }
      };
      bootstrap.panels["panel-1"] = { ...bootstrap.panels["panel-1"], tabs: [sourceTab, searchTab], activeTabId: searchTab.id };
      bootstrap.activePanelId = "panel-1";

      let controller: ReturnType<typeof useWorkspaceController> | undefined;
      const gateway = createTestGateway(() => undefined, interactions, { loadBootstrap: () => bootstrap });
      function Harness() {
        controller = useWorkspaceController(gateway);
        return React.createElement("div", null, controller.state.status);
      }

      await act(async () => {
        root.render(React.createElement(Harness));
        await flushEffects();
      });
      await waitFor(() => controller?.state.status === "ready", "search controller did not bootstrap");

      const tabCountBefore = controller!.state.panels["panel-1"].tabs.length;
      await act(async () => {
        controller?.actions.openSearchResult("panel-1", folderResult);
        await flushEffects();
      });

      await waitFor(
        () => getActiveTab(controller!.state.panels["panel-1"]).snapshot.location.path === folderResult.path,
        "search result folder did not open in an active tab"
      );
      const activeAfterOpen = getActiveTab(controller!.state.panels["panel-1"]);
      assert.equal(controller!.state.panels["panel-1"].tabs.length, tabCountBefore + 1);
      assert.equal(activeAfterOpen.kind, "directory");
      assert.deepEqual(interactions.resolvedPaths, [folderResult.path]);
      assert.deepEqual(interactions.systemOpens, []);
    });
  } finally {
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    container.remove();
  }
})();
