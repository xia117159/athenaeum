import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { createMockWorkspaceBootstrap } from "./mockData";
import { useWorkspaceController } from "./useWorkspaceController";
import {
  assertTest,
  createTestGateway,
  flushEffects,
  installDomEnvironment,
  waitFor
} from "./workspaceControllerTestHarness";
import { createNavigationTab } from "./workspaceReducer";

export const navigationControllerTests = (async () => {
  const dom = installDomEnvironment();
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }

  await assertTest("useWorkspaceController recovers navigation status when target refresh fails", async () => {
    const path = "C:\\Users\\Admin\\Documents\\report.txt";
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
      navigationResolves: [] as string[][]
    };
    const bootstrap = createMockWorkspaceBootstrap("tauri");
    bootstrap.navigationItems = [
      {
        id: "nav-report",
        displayName: "Report",
        description: "",
        path,
        targetKind: "file",
        targetStatus: "ok",
        sortOrder: 1,
        createdAt: "2026-06-08T09:00:00Z",
        updatedAt: "2026-06-08T09:00:00Z"
      }
    ];
    bootstrap.panels["panel-1"] = {
      ...bootstrap.panels["panel-1"],
      tabs: [createNavigationTab("navigation-tab")],
      activeTabId: "navigation-tab"
    };
    bootstrap.activePanelId = "panel-1";

    let controller: ReturnType<typeof useWorkspaceController> | undefined;
    const gateway = createTestGateway(() => undefined, interactions, {
      loadBootstrap: () => bootstrap,
      resolveNavigationTargets: async () => {
        throw new Error("backend unavailable");
      }
    });

    function Harness() {
      controller = useWorkspaceController(gateway);
      return React.createElement("div", null, controller.state.navigation.status);
    }

    const root = ReactDOM.createRoot(container);

    try {
      await act(async () => {
        root.render(React.createElement(Harness));
        await flushEffects();
      });
      await waitFor(() => controller?.state.status === "ready", "navigation controller did not bootstrap");

      await act(async () => {
        controller?.actions.refreshPanel("panel-1");
        await flushEffects();
      });

      await waitFor(
        () =>
          interactions.navigationResolves.length === 1 &&
          controller?.state.navigation.status === "idle" &&
          controller.state.notifications.some((item) => item.intent === "danger" && item.message.includes("backend unavailable")),
        "navigation target refresh failure did not restore idle status with an error notification"
      );
      assert.deepEqual(interactions.navigationResolves, [[path]]);
    } finally {
      await act(async () => {
        root.unmount();
        await flushEffects();
      });
    }
  });

  await assertTest("useWorkspaceController refreshes directory tabs after entry metadata changes", async () => {
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
      nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>
    };
    let controller: ReturnType<typeof useWorkspaceController> | undefined;
    const gateway = createTestGateway(() => undefined, interactions, {
      loadBootstrap: () => createMockWorkspaceBootstrap("tauri")
    });

    function Harness() {
      controller = useWorkspaceController(gateway);
      return React.createElement("div", null, controller.state.status);
    }

    const root = ReactDOM.createRoot(container);

    try {
      await act(async () => {
        root.render(React.createElement(Harness));
        await flushEffects();
      });
      await waitFor(() => controller?.state.status === "ready", "metadata refresh controller did not bootstrap");

      await act(async () => {
        window.dispatchEvent(
          new dom.window.CustomEvent("entry_metadata_changed", {
            detail: ["D:\\Projects\\Atlas\\report.txt"]
          })
        );
        await flushEffects();
      });

      await waitFor(
        () => interactions.resolvedPaths.includes("D:\\Projects\\Atlas"),
        "entry metadata change did not refresh the parent directory tab"
      );
    } finally {
      await act(async () => {
        root.unmount();
        await flushEffects();
      });
    }
  });

  dom.window.close();
})();
