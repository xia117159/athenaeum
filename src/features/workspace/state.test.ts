import assert from "node:assert/strict";
import { createInitialState, getActiveTab, getVisiblePanelIds, workspaceReducer } from "./state";

function assertTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

assertTest("layout visibility follows selected mode", () => {
  assert.deepEqual(getVisiblePanelIds("single"), ["panel-1"]);
  assert.deepEqual(getVisiblePanelIds("dual"), ["panel-1", "panel-2"]);
  assert.deepEqual(getVisiblePanelIds("triple"), ["panel-1", "panel-2", "panel-3"]);
  assert.deepEqual(getVisiblePanelIds("quad"), ["panel-1", "panel-2", "panel-3", "panel-4"]);
});

assertTest("opening a tab activates the new tab", () => {
  const state = createInitialState();
  const panel = state.panels[0];
  const next = workspaceReducer(state, {
    type: "open-tab",
    payload: {
      panelId: panel.id,
      listing: {
        location: { kind: "local", path: "D:\\Projects" },
        entries: [],
        parent: "D:\\",
        canGoUp: true
      }
    }
  });

  const updatedPanel = next.panels[0];
  assert.equal(updatedPanel.tabs.length, 2);
  assert.equal(getActiveTab(updatedPanel).path, "D:\\Projects");
});

assertTest("selecting paths updates the active tab selection", () => {
  const state = createInitialState();
  const panel = state.panels[0];
  const activeTab = getActiveTab(panel);
  const next = workspaceReducer(state, {
    type: "select-paths",
    payload: {
      panelId: panel.id,
      tabId: activeTab.id,
      selectedPaths: ["C:\\Users\\Administrator\\notes.md"]
    }
  });

  assert.deepEqual(getActiveTab(next.panels[0]).selectedPaths, ["C:\\Users\\Administrator\\notes.md"]);
});
