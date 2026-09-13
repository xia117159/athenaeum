import assert from "node:assert/strict";
import { BATCH_RENAME_HISTORY_KEY, readBatchRenameHistory, rememberBatchRenameExpression } from "./batchRenameHistory";

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); }
};
assert.deepEqual(readBatchRenameHistory(storage), []);
rememberBatchRenameExpression("New_*", storage);
rememberBatchRenameExpression("new_*", storage);
rememberBatchRenameExpression("New_*", storage);
assert.deepEqual(readBatchRenameHistory(storage), ["New_*", "new_*"], "case-sensitive expressions are distinct, exact matches move to front");
for (let index = 0; index < 25; index++) rememberBatchRenameExpression("File" + index + "_*", storage);
assert.equal(readBatchRenameHistory(storage).length, 20);
assert.equal(readBatchRenameHistory(storage)[0], "File24_*");
rememberBatchRenameExpression("  *", storage);
assert.equal(readBatchRenameHistory(storage)[0], "  *", "leading whitespace is meaningful and must not be trimmed");
values.set(BATCH_RENAME_HISTORY_KEY, "{broken");
assert.deepEqual(readBatchRenameHistory(storage), []);
values.set(BATCH_RENAME_HISTORY_KEY, JSON.stringify([42, null, "", "\n", "  ", "New_*", "New_*", "new_*"]));
assert.deepEqual(readBatchRenameHistory(storage), ["New_*", "new_*"]);
console.log("ok - batch rename history persists, preserves expression semantics and handles damaged storage");
