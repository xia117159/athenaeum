import assert from "node:assert/strict";
import { createMockWorkspaceBootstrap } from "./mockData";
import {
  createWorkspaceState,
  getActiveTab,
  type WorkspaceAction,
  workspaceReducer
} from "./workspaceReducer";
import type { WorkspaceState } from "./types";

function assertTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function createState() {
  return createWorkspaceState(createMockWorkspaceBootstrap());
}

function hideColumnsOnPanelOne(state: WorkspaceState, ids: Set<string>) {
  const targetTab = getActiveTab(state.panels["panel-1"]);
  return {
    ...state,
    settings: {
      ...state.settings,
      model: {
        ...state.settings.model,
        columns: state.settings.model.columns.map((column) =>
          ids.has(column.id) ? { ...column, visible: false } : column
        )
      }
    },
    panels: {
      ...state.panels,
      "panel-1": {
        ...state.panels["panel-1"],
        tabs: state.panels["panel-1"].tabs.map((tab) =>
          tab.id === targetTab.id
            ? {
                ...tab,
                columns: tab.columns.map((column) =>
                  ids.has(column.id) ? { ...column, visible: false } : column
                )
              }
            : tab
        )
      }
    }
  };
}

assertTest("workspaceReducer stores clamped file-list tooltip and metadata retention settings", () => {
  const state = createState();

  const tooltipState = workspaceReducer(state, {
    type: "tooltipHoverDelaySet",
    payload: { value: 9999 }
  } as unknown as WorkspaceAction);
  const neverRetentionState = workspaceReducer(state, {
    type: "metadataRetentionHoursSet",
    payload: { value: null }
  } as unknown as WorkspaceAction);
  const minRetentionState = workspaceReducer(state, {
    type: "metadataRetentionHoursSet",
    payload: { value: -4 }
  } as unknown as WorkspaceAction);

  assert.equal(tooltipState.settings.model.tooltipHoverDelayMs, 5000);
  assert.equal(neverRetentionState.settings.model.metadataRetentionHours, null);
  assert.equal(minRetentionState.settings.model.metadataRetentionHours, 0);
});

assertTest("workspaceReducer reorders detail columns on the target tab and default settings model", () => {
  const state = createState();
  const targetTab = state.panels["panel-1"].tabs[0];
  const withHiddenExtension = workspaceReducer(state, {
    type: "columnVisibilitySet",
    payload: {
      panelId: "panel-1",
      tabId: targetTab.id,
      id: "extension",
      visible: false
    }
  } as WorkspaceAction);

  const nextState = workspaceReducer(withHiddenExtension, {
    type: "columnOrderChanged",
    payload: {
      panelId: "panel-1",
      tabId: targetTab.id,
      sourceId: "size",
      targetId: "type",
      placement: "before"
    }
  } as unknown as WorkspaceAction);

  assert.deepEqual(
    getActiveTab(nextState.panels["panel-1"]).columns.slice(0, 4).map((column) => column.id),
    ["name", "size", "type", "extension"]
  );
  assert.deepEqual(
    nextState.settings.model.columns.slice(0, 4).map((column) => column.id),
    ["name", "size", "type", "extension"]
  );
  assert.equal(nextState.panels["panel-2"].tabs[0].columns[2].id, "extension");
  assert.equal(getActiveTab(nextState.panels["panel-1"]).columns.find((column) => column.id === "extension")?.visible, false);
});

assertTest("workspaceReducer shows columns on the target tab and default settings model", () => {
  const state = createState();
  const targetTab = getActiveTab(state.panels["panel-1"]);
  const hidden = hideColumnsOnPanelOne(state, new Set(["tags"]));

  const nextState = workspaceReducer(hidden, {
    type: "columnVisibilitySet",
    payload: {
      panelId: "panel-1",
      tabId: targetTab.id,
      id: "tags",
      visible: true
    }
  } as WorkspaceAction);

  assert.equal(getActiveTab(nextState.panels["panel-1"]).columns.find((column) => column.id === "tags")?.visible, true);
  assert.equal(nextState.settings.model.columns.find((column) => column.id === "tags")?.visible, true);
});

assertTest("workspaceReducer can show all requested columns on the target tab", () => {
  const state = createState();
  const targetTab = getActiveTab(state.panels["panel-1"]);
  const hidden = hideColumnsOnPanelOne(state, new Set(["modified", "tags"]));

  const nextState = workspaceReducer(hidden, {
    type: "columnsShown",
    payload: {
      panelId: "panel-1",
      tabId: targetTab.id,
      ids: ["name", "type", "size", "modified", "tags"]
    }
  } as WorkspaceAction);

  const nextTab = getActiveTab(nextState.panels["panel-1"]);
  assert.equal(nextTab.columns.find((column) => column.id === "modified")?.visible, true);
  assert.equal(nextTab.columns.find((column) => column.id === "tags")?.visible, true);
  assert.equal(nextState.settings.model.columns.find((column) => column.id === "modified")?.visible, true);
  assert.equal(nextState.settings.model.columns.find((column) => column.id === "tags")?.visible, true);
});

assertTest("workspaceReducer persists navigation column layout in the settings model", () => {
  const state = createState();
  const navigationColumns = state.settings.model.navigationColumns.map((column) =>
    column.id === "path"
      ? { ...column, width: "336px" }
      : column.id === "comment"
        ? { ...column, visible: false }
        : column
  );
  const [pathColumn] = navigationColumns.splice(2, 1);
  navigationColumns.splice(0, 0, pathColumn);
  const reordered = workspaceReducer(state, {
    type: "navigationColumnsUpdated",
    payload: navigationColumns
  } as WorkspaceAction);

  assert.deepEqual(reordered.settings.model.navigationColumns.slice(0, 2).map((column) => column.id), ["path", "name"]);
  assert.equal(reordered.settings.model.navigationColumns.find((column) => column.id === "path")?.width, "336px");
  assert.equal(reordered.settings.model.navigationColumns.find((column) => column.id === "comment")?.visible, false);
});

assertTest("workspaceReducer accumulates batched navigation column width updates", () => {
  const state = createState();
  const nextState = ["name", "kind", "path"].reduce(
    (current, id, index) =>
      workspaceReducer(current, {
        type: "navigationColumnWidthSet",
        payload: { id, width: `${280 + index * 16}px` }
      } as unknown as WorkspaceAction),
    state
  );

  assert.equal(nextState.settings.model.navigationColumns.find((column) => column.id === "name")?.width, "280px");
  assert.equal(nextState.settings.model.navigationColumns.find((column) => column.id === "kind")?.width, "296px");
  assert.equal(nextState.settings.model.navigationColumns.find((column) => column.id === "path")?.width, "312px");
});
