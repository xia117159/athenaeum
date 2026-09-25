import assert from "node:assert/strict";
import { test } from "node:test";
import { sizeFixture } from "./directorySizeTestSupport";
import { collectDirectorySizeViews, DirectorySizeViewsPublisher } from "./directorySizeViews";

test("view manifests include inactive local tabs, dedupe equivalent paths and prioritize visible tabs", () => {
  const { state, tab } = sizeFixture();
  state.panels["panel-1"].tabs.push({ ...tab, id: "inactive", snapshot: { ...tab.snapshot,
    location: { ...tab.snapshot.location, path: "D:\\inactive" } } });
  state.panels["panel-1"].tabs.push({ ...tab, id: "duplicate", snapshot: { ...tab.snapshot,
    location: { ...tab.snapshot.location, path: tab.snapshot.location.path.replace(/^[A-Z]:/i, (drive) => drive.toLowerCase()) } } });
  const scopes = collectDirectorySizeViews(state);
  assert.equal(scopes.filter((scope) => scope.path.toLowerCase() === tab.snapshot.location.path.toLowerCase()).length, 1);
  assert.equal(scopes.find((scope) => scope.path === "D:\\inactive")?.priority, 1);
  assert.equal(scopes.find((scope) => scope.path === tab.snapshot.location.path)?.priority, 0);
});

test("view manifests preserve distinct path components on case-sensitive local directories", () => {
  const { state, tab } = sizeFixture();
  for (const panel of Object.values(state.panels)) panel.tabs = [];
  state.panels["panel-1"].tabs = ["C:\\work\\Project", "c:\\work\\project"].map((path, index) => ({
    ...tab, id: `case-${index}`, snapshot: { ...tab.snapshot, location: { ...tab.snapshot.location, path } }
  }));
  assert.equal(collectDirectorySizeViews(state).length, 2);
  state.panels["panel-1"].tabs.push({ ...tab, id: "verbatim", snapshot: { ...tab.snapshot, location: { ...tab.snapshot.location, path: "\\\\?\\C:\\work\\Project" } } });
  assert.equal(collectDirectorySizeViews(state).length, 2);
});

test("view publisher coalesces in-flight updates, uses owner epoch and freezes the latest final scope", async () => {
  const calls: Array<{ revision: number; ownerEpoch?: string; shutdownNonce?: string; scopes: Array<{ path: string; priority: number }> }> = [];
  let resolve!: () => void;
  const publisher = new DirectorySizeViewsPublisher(async (request) => {
    calls.push(request);
    if (calls.length === 2) await new Promise<void>((done) => { resolve = done; });
    return { acceptedRevision: request.revision, ownerEpoch: "42", truncated: false };
  });
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  publisher.update([{ path: "C:\\a", priority: 0 }]); await settle();
  publisher.update([{ path: "C:\\b", priority: 0 }]);
  publisher.update([{ path: "C:\\c", priority: 0 }]);
  publisher.freeze({ ownerEpoch: "old", nonce: "old" });
  publisher.freeze({ ownerEpoch: "42", nonce: "exit" });
  await settle();
  assert.equal(calls.length, 3, "a hung ordinary update must not delay the final manifest");
  publisher.update([{ path: "C:\\late", priority: 0 }]); resolve(); await settle();
  assert.equal(calls.length, 3);
  assert.equal(calls[0].ownerEpoch, undefined);
  assert.equal(calls[1].ownerEpoch, "42");
  assert.equal(calls[2].shutdownNonce, "exit");
  assert.equal(calls[2].scopes[0].path, "C:\\c");
  publisher.close();
});

test("a final request arriving before the handshake reply is validated and sent after the epoch arrives", async () => {
  const calls: Array<{ ownerEpoch?: string; shutdownNonce?: string }> = [];
  let release!: () => void; let frozen = false;
  const publisher = new DirectorySizeViewsPublisher(async (request) => {
    calls.push(request);
    if (!request.ownerEpoch) await new Promise<void>((resolve) => { release = resolve; });
    return { acceptedRevision: request.revision, ownerEpoch: "9", truncated: false };
  }, () => { frozen = true; });
  publisher.update([{ path: "C:\\latest", priority: 0 }]);
  publisher.freeze({ nonce: "exit", ownerEpoch: "9" });
  release(); for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(frozen, true);
  assert.equal(calls.at(-1)?.shutdownNonce, "exit"); publisher.close();
});
