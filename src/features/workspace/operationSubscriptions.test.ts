import assert from "node:assert/strict";
import { subscribeOperationEvents, type OperationSubscriptionSource } from "./operationSubscriptions";

const calls: string[] = [];
const source: OperationSubscriptionSource = {
  async listenOperationTasks() {
    calls.push("tasks");
    return () => calls.push("dispose-tasks");
  },
  async listenOperationHistory() {
    calls.push("history");
    throw new Error("history listener failed");
  },
  async listenOperationRecordsCleared() {
    calls.push("cleared");
    return () => calls.push("dispose-cleared");
  }
};

export const completion = (async () => {
  await assert.rejects(
    subscribeOperationEvents(source, { task: () => undefined, history: () => undefined, cleared: () => undefined }),
    /history listener failed/u
  );
  assert.deepEqual(calls, ["tasks", "history", "dispose-tasks"]);
  console.log("ok - partial operation event subscription failure disposes installed listeners");
})();
