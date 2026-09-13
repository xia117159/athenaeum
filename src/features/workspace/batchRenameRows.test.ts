import assert from "node:assert/strict";
import type { BatchRenameRow } from "../../app/batchRename";
import type { OperationTaskSnapshot } from "../../app/types";
import { batchRenameResultRows } from "./batchRenameRows";

const rows: BatchRenameRow[] = [{ id: "1", sourcePath: "C:\\Test.txt", parentPath: "C:\\", oldName: "Test.txt",
  newName: "Proposed.txt", targetPath: "C:\\Proposed.txt", isDirectory: false, status: "changed", diagnostic: null }];
const task = { status: "failed", entryResults: [{ source: { kind: "local", path: "C:\\Test.txt" },
  destination: { kind: "local", path: "C:\\Test.txt" }, kind: "failed", error: { retryable: true, message: "已恢复" } }] } as OperationTaskSnapshot;
const restored = batchRenameResultRows(rows, task);
assert.equal(restored[0].newName, "Test.txt", "failure results show actual restored names instead of the old proposal");
assert.equal(restored[0].status, "unchanged");
task.entryResults[0].destination = { kind: "local", path: "C:\\temporary-name" };
const partial = batchRenameResultRows(rows, task);
assert.equal(partial[0].newName, "temporary-name");
assert.equal(partial[0].targetPath, "C:\\temporary-name");
assert.equal(partial[0].status, "changed");
task.entryResults[0].error!.retryable = false;
assert.equal(batchRenameResultRows(rows, task)[0].status, "error", "uncertain identity is visibly marked");
console.log("ok - failed batches display the backend's actual remaining paths");
