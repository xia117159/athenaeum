import assert from "node:assert/strict";
import { test } from "node:test";
import { controllerFixture } from "./directorySizeControllerTestSupport";
import { workspaceReducer } from "./workspaceReducer";
import { projectEntrySize } from "./directorySizes";
import { sizeRecord } from "./directorySizeTestSupport";

test("asynchronous cache enrichment displays identified history and rejects responses from an older listing", () => {
  const f = controllerFixture(); const panelId = "panel-1" as const;
  const tab = f.state.panels[panelId].tabs[0];
  const entry = tab.snapshot.entries.find((entry) => entry.kind === "folder")!;
  entry.sizeCreatedAt = "2026-06-10T15:46:28.468277800Z";
  const payload = { panelId, tabId: tab.id, rootPath: tab.snapshot.location.path, expectedEntries: tab.snapshot.entries,
    lookup: { path: tab.snapshot.location.path, requestVersion: 1, revision: "1", entries: [{ path: entry.path, status: "hit" as const,
      record: { ...sizeRecord(entry.path, "60", "stamp"), cachedAt: "2026-09-25T00:00:00Z", createdAt: entry.sizeCreatedAt } }] } };
  const state = workspaceReducer(f.state, { type: "directorySizeCacheReceived", payload });
  const enriched = state.panels[panelId].tabs[0];
  assert.equal(projectEntrySize(enriched, enriched.snapshot.entries.find((item) => item.path === entry.path)!).sizeLabel, "60 B");
  assert.equal(enriched.directorySizes, undefined, "historical enrichment never creates a lease");
  Object.assign(enriched.snapshot.directorySizeCache!, { revision: "10" });
  const late = { ...payload, lookup: { ...payload.lookup, entries: payload.lookup.entries.map((entry) => ({ ...entry,
    record: { ...entry.record, bytes: "33" } })) } };
  const afterLate = workspaceReducer(state, { type: "directorySizeCacheReceived", payload: late }).panels[panelId].tabs[0];
  assert.equal(projectEntrySize(afterLate, entry).sizeLabel, "60 B", "older cache revisions cannot overwrite a newer displayed result");
  const moved = { ...state, panels: { ...state.panels, [panelId]: { ...state.panels[panelId], tabs: [{ ...enriched,
    snapshot: { ...enriched.snapshot, entries: enriched.snapshot.entries.map((entry) => ({ ...entry, sizeCreatedAt: "replacement" })) } }] } } };
  assert.deepEqual(workspaceReducer(moved, { type: "directorySizeCacheReceived", payload }).panels[panelId].tabs[0].snapshot,
    moved.panels[panelId].tabs[0].snapshot);
});
