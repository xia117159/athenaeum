import assert from "node:assert/strict";
import { test } from "node:test";
import { createDirectorySizesGateway } from "./directorySizeGateway";
import { sizeSnapshot } from "./directorySizeTestSupport";
import type { DirectorySizeSnapshot } from "./directorySizeTypes";

test("directory size gateway uses typed requests, decimal bytes, dedicated event and propagates failures", async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const events: string[] = [];
  const gateway = createDirectorySizesGateway({ runtimeHost: { __TAURI_INTERNALS__: {} },
    invoke: async <T>(command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "lookup_directory_sizes") throw new Error("lookup denied");
      return sizeSnapshot({ totalBytes: "18446744073709551615" }) as T;
    },
    listen: async <T>(name: string, handler: (event: { payload: T }) => void) => {
      events.push(name); handler({ payload: sizeSnapshot() as T }); return () => events.push("disposed");
    }
  });
  const request = { consumerId: "size-test", target: { kind: "remote" as const, profileId: "p1", path: "/home" }, refresh: true };
  assert.equal((await gateway.subscribe(request)).totalBytes, "18446744073709551615");
  await gateway.release("size-test");
  const lookup = { consumerId: "size-test", generation: 1, paths: ["/home"] };
  await assert.rejects(gateway.lookup(lookup), /lookup denied/);
  assert.deepEqual(calls, [
    { command: "subscribe_directory_sizes", args: { request } },
    { command: "release_directory_sizes", args: { consumerId: "size-test" } },
    { command: "lookup_directory_sizes", args: { request: lookup } }
  ]);
  let received: DirectorySizeSnapshot | undefined;
  const dispose = await gateway.listen((snapshot) => { received = snapshot; });
  assert.equal(received?.generation, 1);
  dispose();
  assert.deepEqual(events, ["directory_sizes_changed", "disposed"]);
});

test("browser-only size gateway explicitly reports unavailable metadata, never complete mock totals", async () => {
  const gateway = createDirectorySizesGateway({ runtimeHost: {} });
  const snapshot = await gateway.subscribe({ consumerId: "browser", target: { kind: "local", path: "C:\\files" }, refresh: false });
  assert.equal(snapshot.phase, "failed");
  assert.equal(snapshot.totalBytes, null);
  assert.match(snapshot.reason ?? "", /桌面/);
});
