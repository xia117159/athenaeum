import assert from "node:assert/strict";
import { acquireSystemIcon, clearSystemIconCacheForTests, peekSystemIcon } from "./systemIconGateway";

const calls: Array<{ command: string; args: any }> = [];
const raceReplies: Array<(items: { key: string }[]) => void> = [];
let nextBlob = 0;
const revoked: string[] = [];
const previousWindow = globalThis.window;
const previousCreate = URL.createObjectURL;
const previousRevoke = URL.revokeObjectURL;
globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (command: string, args: any) => {
      calls.push({ command, args });
      if (command === "resolve_system_icon_keys") {
        if (args.request.items.some((item: { path: string }) => item.path.includes("race"))) {
          return new Promise((resolve) => { raceReplies.push(resolve); });
        }
        return args.request.items.map((item: { path: string }) => ({
          key: item.path.includes("many-") ? `idx:${item.path.match(/many-(\d+)/)?.[1]}:0:small` :
            item.path.endsWith("unique.exe") ? "idx:7:0:small" : "idx:1:0:small"
        }));
      }
      if (command === "resolve_system_icon_bitmap") return new Uint8Array([137, 80, 78, 71]);
      throw new Error(`unexpected command ${command}`);
    }
  }
} as unknown as Window & typeof globalThis;
URL.createObjectURL = () => `blob:test-${++nextBlob}`;
URL.revokeObjectURL = (value) => { revoked.push(value); };

export const completion = (async () => {
  try {
    clearSystemIconCacheForTests();
    const first = acquireSystemIcon({ kind: "file", path: "C:\\a.txt", extension: ".txt", imageList: "small", includeOverlays: true, modifiedAt: "t1" });
    const second = acquireSystemIcon({ kind: "file", path: "C:\\b.txt", extension: ".txt", imageList: "small", includeOverlays: true, modifiedAt: "t1" });
    assert.equal(await first.promise, "blob:test-1");
    assert.equal(await second.promise, "blob:test-1", "equal shell indexes share one bitmap");
    assert.equal(calls.filter((call) => call.command === "resolve_system_icon_keys").length, 1, "same tick requests share one keys IPC");
    assert.equal(calls.filter((call) => call.command === "resolve_system_icon_bitmap").length, 1);
    assert.equal(peekSystemIcon({ kind: "file", path: "C:\\a.txt", extension: ".txt", imageList: "small", includeOverlays: true, modifiedAt: "t1" }), "blob:test-1");
    first.release();
    second.release();
    const priorCount = calls.length;
    const third = acquireSystemIcon({ kind: "file", path: "C:\\a.txt", extension: ".txt", imageList: "small", includeOverlays: true, modifiedAt: "t2" });
    assert.equal(await third.promise, "blob:test-1");
    assert.equal(calls.filter((call) => call.command === "resolve_system_icon_keys").length, 2, "modifiedAt changes path key lookup");
    assert.equal(calls.length, priorCount + 1, "the same bitmap still reuses its decoded URL");
    third.release();
    assert.deepEqual(revoked, [], "a reusable unreferenced icon is retained under the free-entry budget");
    console.log("ok - icon keys batch, bitmap deduplication, modifiedAt invalidation and retained URL");

    clearSystemIconCacheForTests();
    calls.length = 0;
    revoked.length = 0;
    const leases = Array.from({ length: 514 }, (_, index) => acquireSystemIcon({
      kind: "file", path: `C:\\many-${index}.exe`, extension: ".exe", imageList: "small", includeOverlays: true
    }));
    const urls = await Promise.all(leases.map((lease) => lease.promise));
    assert.equal(calls.filter((call) => call.command === "resolve_system_icon_keys").length, 3, "key batches are capped at 256 items");
    assert.equal(new Set(urls).size, 514, "unique indexes have distinct bitmap URLs");
    assert.deepEqual(revoked, [], "all mounted icons remain alive above the free-entry limit");
    leases.slice(1).forEach((lease) => lease.release());
    assert.equal(revoked.length, 1, "free bitmap cache retains at most 512 URLs");
    assert.equal(revoked.some((value: string) => value === urls[0]), false, "a referenced URL is never revoked");
    leases[0].release();
    console.log("ok - 256-item batches and bitmap URL refcount protect mounted icons");

    clearSystemIconCacheForTests();
    const old = acquireSystemIcon({ kind: "file", path: "C:\\race.txt", extension: ".txt", imageList: "small", includeOverlays: true, modifiedAt: "old" });
    await Promise.resolve();
    const newer = acquireSystemIcon({ kind: "file", path: "C:\\race.txt", extension: ".txt", imageList: "small", includeOverlays: true, modifiedAt: "new" });
    await Promise.resolve();
    assert.equal(raceReplies.length, 2);
    raceReplies[1]([{ key: "idx:2:0:small" }]);
    const newUrl = await newer.promise;
    raceReplies[0]([{ key: "idx:1:0:small" }]);
    await old.promise;
    assert.equal(peekSystemIcon({ kind: "file", path: "C:\\race.txt", extension: ".txt", imageList: "small", includeOverlays: true, modifiedAt: "new" }), newUrl,
      "late older key result cannot overwrite newer modifiedAt key");
    old.release();
    newer.release();
    console.log("ok - stale path-key responses cannot overwrite a newer icon identity");
  } finally {
    clearSystemIconCacheForTests();
    globalThis.window = previousWindow;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
  }
})();
