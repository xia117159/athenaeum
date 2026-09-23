import { installQuickFilterTestWorker, settleQuickFilter } from "./quickFilterWorkerTestSupport";
import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { useWorkspaceController } from "./useWorkspaceController";
import { expansionFixture, expansionInteractions } from "./folderExpansionTestSupport";
import { resolveQuickFilterInput } from "./quickFilterState";
import { assertTest, createTestGateway, flushEffects, installDomEnvironment, waitFor } from "./workspaceControllerTestHarness";
import type { WorkspaceBootstrap } from "./types";

async function mount(bootstrap: WorkspaceBootstrap) {
  const gateway = createTestGateway(() => undefined, expansionInteractions(), { loadBootstrap: () => bootstrap });
  let current!: ReturnType<typeof useWorkspaceController>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  function Harness() { current = useWorkspaceController(gateway); return React.createElement("div"); }
  await act(async () => { root.render(React.createElement(Harness)); await flushEffects(); });
  await waitFor(() => current?.state.status === "ready", "bootstrap did not complete");
  return {
    get controller() { return current; },
    async settle() { await settleQuickFilter(() => current.state, expansionFixture().path); },
    async close() { await act(async () => { root.unmount(); await flushEffects(); }); container.remove(); }
  };
}

export const completion = (async () => {
  installDomEnvironment();
  installQuickFilterTestWorker();

  await assertTest("R1 a stale regex error is cleared once the text returns to the last valid pattern", async () => {
    const h = await mount(expansionFixture().bootstrap);
    try {
      const path = expansionFixture().path;
      await act(async () => { h.controller.actions.changeQuickFilterSyntax("regex"); await flushEffects(); });

      await act(async () => { h.controller.actions.updateQuickFilterText(path, "p.*t"); await flushEffects(); });
      await h.settle();
      assert.equal(resolveQuickFilterInput(h.controller.state, path).error, null, "a valid pattern must be clean");

      await act(async () => { h.controller.actions.updateQuickFilterText(path, "p.*t("); await flushEffects(); });
      await h.settle();
      assert.match(resolveQuickFilterInput(h.controller.state, path).error ?? "", /./, "an invalid pattern must report");

      // 退格回到上一个有效模式：这是最常见的"打错再改回来"路径。
      await act(async () => { h.controller.actions.updateQuickFilterText(path, "p.*t"); await flushEffects(); });
      await h.settle();
      assert.equal(resolveQuickFilterInput(h.controller.state, path).error, null,
        "R1: returning to the last valid pattern must clear the stale diagnostic (spec §5.7)");
    } finally { await h.close(); }
  });

})();
