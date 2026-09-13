import assert from "node:assert/strict";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createWorkspaceState, workspaceReducer } from "./workspaceReducer";
import type { ColorFilterConfigSnapshot } from "./colorFilterTypes";

function test(name: string, run: () => void) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function snapshot(revision: string, enabled: boolean): ColorFilterConfigSnapshot {
  return {
    enabled,
    revision,
    rulesRevision: "9007199254740992",
    rules: []
  };
}

test("color filter reducer converges for event-before-response and response-before-event", () => {
  const initial = createWorkspaceState(createMockWorkspaceBootstrap("tauri"));
  const eventFirst = workspaceReducer(initial, {
    type: "colorFilterSnapshotReceived",
    payload: snapshot("9007199254740993", false)
  });
  const staleResponse = workspaceReducer(eventFirst, {
    type: "colorFilterSnapshotReceived",
    payload: snapshot("9007199254740992", true)
  });
  assert.equal(staleResponse, eventFirst);
  assert.equal(staleResponse.settings.model.colorFilterEnabled, false);

  const responseFirst = workspaceReducer(initial, {
    type: "colorFilterSnapshotReceived",
    payload: snapshot("9007199254740993", false)
  });
  const duplicateEvent = workspaceReducer(responseFirst, {
    type: "colorFilterSnapshotReceived",
    payload: snapshot("9007199254740993", false)
  });
  assert.equal(duplicateEvent, responseFirst);
});

test("color filter reducer rejects divergent content at the same revision", () => {
  const initial = createWorkspaceState(createMockWorkspaceBootstrap("tauri"));
  const accepted = workspaceReducer(initial, {
    type: "colorFilterSnapshotReceived",
    payload: snapshot("9007199254740993", false)
  });
  const divergent = workspaceReducer(accepted, {
    type: "colorFilterSnapshotReceived",
    payload: snapshot("9007199254740993", true)
  });

  assert.equal(divergent, accepted);
  assert.equal(divergent.settings.model.colorFilterEnabled, false);
});

test("color filter reducer tracks pessimistic toggle pending state independently", () => {
  const initial = createWorkspaceState(createMockWorkspaceBootstrap("tauri"));
  const pending = workspaceReducer(initial, {
    type: "colorFilterTogglePendingSet",
    payload: true
  });
  assert.equal(pending.colorFilterTogglePending, true);
  assert.equal(pending.settings.model.colorFilterEnabled, initial.settings.model.colorFilterEnabled);
});
