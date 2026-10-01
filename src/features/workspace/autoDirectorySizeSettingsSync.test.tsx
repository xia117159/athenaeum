import assert from "node:assert/strict";
import React, { act } from "react";
import { assertTest, createTestGateway, flushEffects, installDomEnvironment, waitFor } from "./workspaceControllerTestHarness";
import { expansionFixture, expansionInteractions } from "./folderExpansionTestSupport";
import { sizeTransport } from "./directorySizeControllerTestSupport";
import type { WorkspaceGateway } from "./workspaceGateway";

export const completion = (async () => {
  const dom = installDomEnvironment();
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const { useWorkspaceController } = require("./useWorkspaceController") as typeof import("./useWorkspaceController");
  try {
    await assertTest("a settings event that only changes the automatic list is applied without a save and starts the automatic lease (E7)", async () => {
      const f = expansionFixture();
      const interactions = expansionInteractions();
      const gateway = createTestGateway(() => undefined, interactions, { loadBootstrap: () => f.bootstrap });
      const wire = sizeTransport(); gateway.directorySizes = wire.gateway;
      let onSettings!: Parameters<WorkspaceGateway["listenSettingsChanged"]>[0];
      gateway.listenSettingsChanged = async (listener) => { onSettings = listener; return () => undefined; };
      let current!: ReturnType<typeof useWorkspaceController>;
      const container = document.createElement("div"); document.body.appendChild(container);
      const root = ReactDOM.createRoot(container);
      function Harness() { current = useWorkspaceController(gateway); return React.createElement("div"); }
      await act(async () => { root.render(React.createElement(Harness)); await flushEffects(); });
      try {
        await waitFor(() => current?.state.status === "ready" && onSettings !== undefined, "bootstrap did not complete");
        assert.equal(current.state.source, "tauri");
        assert.deepEqual(current.state.settings.model.autoDirectorySizePaths ?? [], []);
        assert.equal(wire.subscribed.length, 0);
        const saves = interactions.savedSettingsModels.length;
        await act(async () => {
          const state = current.state;
          onSettings({ settingsModel: { ...state.settings.model, autoDirectorySizePaths: [f.path] }, bookmarks: state.bookmarks,
            hotlist: state.hotlist, remoteProfiles: state.remoteProfiles, navigationItems: state.navigation.items });
          await flushEffects();
        });
        assert.deepEqual(current.state.settings.model.autoDirectorySizePaths, [f.path]);
        assert.equal(interactions.savedSettingsModels.length, saves, "the list is never echoed back through a settings save");
        await waitFor(() => wire.subscribed.length > 0, "the automatic lease did not start");
        assert.equal(wire.subscribed[0].intent, "auto");
      } finally { await act(async () => { root.unmount(); await flushEffects(); }); container.remove(); }
    });
  } finally { dom.window.close(); }
})();
