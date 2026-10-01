import assert from "node:assert/strict";
import { test } from "node:test";
import { sizeFixture, sizeSnapshot } from "./directorySizeTestSupport";
import { workspaceReducer } from "./workspaceReducer";

test("artifact contribution changes invalidate row values before a new denominator is used", () => {
  const f = sizeFixture();
  Object.assign(f.sizes.snapshot!, { artifactRevision: "1" });
  const state = workspaceReducer(f.state, { type: "directorySizeSnapshotReceived", payload: {
    panelId: "panel-1", tabId: f.tab.id, rootPath: f.path, consumerId: "size-test", requestVersion: 0,
    snapshot: Object.assign(sizeSnapshot({ sequence: 3, totalBytes: "200" }), { artifactRevision: "2" })
  } });
  assert.deepEqual(state.panels["panel-1"].tabs[0].directorySizes!.records, {},
    "previous artifact bytes must not be combined with the new total");
});
