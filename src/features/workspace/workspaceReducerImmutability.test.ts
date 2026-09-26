import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createWorkspaceState, getActiveTab, workspaceReducer } from "./workspaceReducer";

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

test("selection accepts a deeply frozen 20k listing", () => {
  const state = createWorkspaceState(createMockWorkspaceBootstrap());
  const tab = getActiveTab(state.panels["panel-1"]);
  const base = tab.snapshot.entries[0];
  assert.ok(base);
  const large = {
    ...state,
    panels: {
      ...state.panels,
      "panel-1": {
        ...state.panels["panel-1"],
        tabs: [{ ...tab, snapshot: { ...tab.snapshot, entries: Array.from({ length: 20_000 }, (_, index) => ({
          ...base, id: `frozen-${index}`, name: `frozen-${index}.txt`, path: `D:\\frozen\\frozen-${index}.txt`
        })) } }]
      }
    }
  };
  const frozen = deepFreeze(large);
  assert.doesNotThrow(() => workspaceReducer(frozen, {
    type: "entrySelectionSet", payload: { panelId: "panel-1", tabId: tab.id, entryIds: ["frozen-10000"] }
  }));
});
