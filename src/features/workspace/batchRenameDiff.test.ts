import assert from "node:assert/strict";
import { renameDiff } from "./batchRenameDiff";

function changed(before: string, after: string) {
  const diff = renameDiff(before, after);
  assert.equal(diff.before.map(part => part.text).join(""), before);
  assert.equal(diff.after.map(part => part.text).join(""), after);
  return {
    before: diff.before.filter(part => part.changed).map(part => part.text),
    after: diff.after.filter(part => part.changed).map(part => part.text)
  };
}
assert.deepEqual(changed("Test1.txt", "NEW_2026-09-12.txt").after, ["NEW_2026-09-12"]);
assert.deepEqual(changed("Test2.txt", "Test2-001.txt").after, ["-001"]);
assert.deepEqual(changed("prefix-Test-old.txt", "Test.txt").before, ["prefix-", "-old"]);
assert.deepEqual(changed("A😀中.txt", "A😀文.txt"), { before: ["中"], after: ["文"] });
assert.deepEqual(changed("same.txt", "same.txt"), { before: [], after: [] });
assert.deepEqual(changed("ab-cd.txt", "AB-cD.txt").after, ["AB", "D"]);
changed("A".repeat(10000), "B".repeat(10000));
console.log("ok - Unicode rename diff highlights edits and preserves unchanged suffixes");
