import assert from "node:assert/strict";
import {
  createEmptyOperationHistoryReadState,
  getOperationHistoryUnreadCounts,
  markOperationHistoryTabSeen,
  parseOperationHistoryReadState,
  persistOperationHistoryReadState
} from "./operationHistoryReadStore";

const empty = createEmptyOperationHistoryReadState("epoch-a");
const ids = {
  running: ["run-1"],
  waiting: ["wait-1"],
  problems: ["problem-1", "problem-2"],
  completed: ["done-1"],
  history: ["history-1"]
};
assert.deepEqual(getOperationHistoryUnreadCounts(empty, ids), {
  running: 1,
  waiting: 1,
  problems: 2,
  completed: 1,
  history: 1
});

const problemsSeen = markOperationHistoryTabSeen(empty, "problems", ids.problems);
assert.equal(problemsSeen.revision, empty.revision);
assert.deepEqual(getOperationHistoryUnreadCounts(problemsSeen, ids), {
  running: 1,
  waiting: 1,
  problems: 0,
  completed: 1,
  history: 1
});
assert.equal(problemsSeen.seenIdsByTab.completed.length, 0);

const malformed = parseOperationHistoryReadState("{broken", () => "epoch-recovered");
assert.equal(malformed.state.epoch, "epoch-recovered");
assert.equal(malformed.status, "malformed");

const normalized = parseOperationHistoryReadState(JSON.stringify({
  ...createEmptyOperationHistoryReadState("epoch-preserved"),
  revision: 7,
  selectedTab: "unknown-tab",
  seenIdsByTab: {
    ...createEmptyOperationHistoryReadState("epoch-preserved").seenIdsByTab,
    problems: ["problem-1"],
    completed: ["done-1", "done-1"]
  }
}), () => "epoch-must-not-replace-valid-state");
assert.equal(normalized.state.epoch, "epoch-preserved");
assert.equal(normalized.state.revision, 7);
assert.equal(normalized.state.selectedTab, "running");
assert.deepEqual(normalized.state.seenIdsByTab.problems, ["problem-1"]);
assert.deepEqual(normalized.state.seenIdsByTab.completed, ["done-1"]);
assert.equal(normalized.status, "normalized");

let stored = "";
const persisted = persistOperationHistoryReadState(problemsSeen, {
  setItem(_key, value) {
    stored = value;
  }
});
assert.equal(persisted.ok, true);
assert.equal(persisted.state.revision, 1);
assert.equal(JSON.parse(stored).revision, 1);

const failed = persistOperationHistoryReadState(problemsSeen, {
  setItem() {
    throw new Error("quota");
  }
});
assert.equal(failed.ok, false);
assert.equal(failed.state, problemsSeen);

console.log("ok - operation history read state is per-tab, recoverable, and revisioned after persistence");
