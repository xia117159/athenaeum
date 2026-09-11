import assert from "node:assert/strict";
import { test } from "node:test";
import { DirectorySizeAlignmentRequest, type SizeAlignmentTarget } from "./directorySizeAlignmentRequest";
import { expansionEntry, expansionSnapshot } from "./folderExpansionTestSupport";

test("completed alignment attempts retain neither full listings nor captured consumer snapshots", () => {
  const requests: DirectorySizeAlignmentRequest[] = [];
  for (let index = 0; index < 128; index++) {
    const path = `C:\\root\\folder${index}`;
    const snapshot = expansionSnapshot(path, Array.from({ length: 200 }, (_, n) => expansionEntry(path, `file${n}`, "file")));
    const target: SizeAlignmentTarget = { panelId: "panel-1", tabId: "tab", rootPath: path, path,
      consumerId: "first", requestVersion: 0, generation: 1, expectedRoot: snapshot };
    const request = new DirectorySizeAlignmentRequest(); requests.push(request);
    request.enroll(target); request.enroll({ ...target, consumerId: "second", expectedRoot: { ...snapshot } });
    request.start();
    assert.equal(request.enroll({ ...target, consumerId: "late" }), false, "do not attach a newer consumer snapshot to an older read");
    let delivered = 0;
    request.finish({ snapshot }, () => { delivered++; assert.equal(request.retainedPayloadEntries, 200); });
    assert.equal(delivered, 2);
    assert.equal(request.retainedPayloadEntries, 0);
    assert.equal(request.retainedConsumers, 0);
    assert.equal(request.enroll(target), false, "a tombstone prevents another read after collapse/reopen");
  }
  assert.equal(requests.reduce((sum, request) => sum + request.retainedPayloadEntries, 0), 0);
});

test("obsolete in-flight targets and late completions cannot restore discarded listing retention", () => {
  const snapshot = expansionSnapshot("C:\\root", [expansionEntry("C:\\root", "file", "file")]);
  const request = new DirectorySizeAlignmentRequest();
  request.enroll({ panelId: "panel-1", tabId: "tab", rootPath: "C:\\root", path: "C:\\root", consumerId: "first",
    requestVersion: 0, generation: 1, expectedRoot: snapshot });
  request.start(); request.prune(() => false);
  assert.equal(request.retainedConsumers, 0);
  request.discard(); request.finish({ snapshot }, () => assert.fail("discarded target was revived"));
  assert.equal(request.retainedPayloadEntries, 0);
  assert.equal(request.retainedConsumers, 0);
});
