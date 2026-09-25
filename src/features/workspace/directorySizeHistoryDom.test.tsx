import assert from "node:assert/strict";
import React, { act, useReducer } from "react";
import ReactDOM from "react-dom/client";
import { controllerFixture, sizeTransport } from "./directorySizeControllerTestSupport";
import { createTestGateway, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import { expansionInteractions } from "./folderExpansionTestSupport";
import { DirectorySizeControl } from "./DirectorySizeControl";
import { SizeShareCell } from "./SizeShareCell";
import { currentDirectorySizes, projectEntrySize } from "./directorySizes";
import { sizeRecord, sizeSnapshot } from "./directorySizeTestSupport";
import { useDirectorySizeController } from "./useDirectorySizeController";
import { workspaceReducer } from "./workspaceReducer";

export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  const f = controllerFixture(); const createdAt = "2026-09-20T00:00:00Z";
  f.parent.sizeCreatedAt = createdAt;
  f.tab.snapshot.directorySizeCache = { generation: 0, sequence: 0, historical: true,
    directories: [{ ...sizeRecord(f.parent.path, "60"), cachedAt: "2026-09-23T12:00:00Z", createdAt }] };
  let consumerId = "";
  const wire = sizeTransport({ subscribe: async (request) => {
    consumerId = request.consumerId; return sizeSnapshot({ consumerId, phase: "scanning" });
  } });
  const gateway = createTestGateway(() => undefined, expansionInteractions()); gateway.directorySizes = wire.gateway;
  function Harness() {
    const [state, dispatch] = useReducer(workspaceReducer, f.state);
    useDirectorySizeController({ state, dispatch, workspaceGateway: gateway });
    const tab = state.panels["panel-1"].tabs[0];
    const props = { statistics: currentDirectorySizes(tab), locationKind: "local" as const, background: true, onAction() {} };
    return <><DirectorySizeControl {...props} /><SizeShareCell entry={projectEntrySize(tab, tab.snapshot.entries.find((entry) => entry.path === f.parent.path)!)} /></>;
  }
  try {
    await act(async () => { root.render(<Harness />); await flushEffects(); });
    assert.equal(container.querySelector(".size-share-label")?.textContent, "60 B");
    assert.ok(container.querySelector(".size-share-track"), "historical size has a first-render bar");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
    assert.equal(Boolean(container.querySelector('[role="status"]')), false, "cached display refreshes silently");
    assert.match(container.querySelector(".size-share-value")!.getAttribute("title")!, /2026.*后台刷新/);
    await act(async () => { wire.emit(sizeSnapshot({ consumerId, generation: 2, sequence: 3, phase: "failed", reason: "offline" })); await flushEffects(); });
    assert.equal(container.querySelector(".size-share-label")?.textContent, "60 B");
    assert.ok(container.querySelector(".size-share-track"), "failed refresh keeps the bar with its size");
    assert.match(container.querySelector(".size-share-value")!.getAttribute("title")!, /刷新失败.*offline/);
    console.log("ok - restored sizes render through live background refresh without a loading banner");
  } finally { await act(async () => root.unmount()); container.remove(); dom.window.close(); }
})();
