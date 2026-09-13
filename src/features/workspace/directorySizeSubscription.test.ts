import assert from "node:assert/strict";
import { test } from "node:test";
import { openDirectorySizeSubscription } from "./directorySizeSubscription";
import { sizeSnapshot } from "./directorySizeTestSupport";
import type { DirectorySizesGateway, DirectorySizeSnapshot } from "./directorySizeTypes";

const request = { consumerId: "size-test", target: { kind: "local" as const, path: "C:\\files" }, refresh: false };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fakeGateway(overrides: Partial<DirectorySizesGateway> = {}) {
  const calls: string[] = [];
  const gateway: DirectorySizesGateway = {
    listen: async () => { calls.push("listen"); return () => calls.push("unlisten"); },
    subscribe: async () => { calls.push("subscribe"); return sizeSnapshot(); },
    release: async () => { calls.push("release"); },
    lookup: async () => ({ consumerId: "size-test", generation: 1, sequence: 2, stale: false, directories: [] }), ...overrides
  };
  return { gateway, calls };
}

test("listen precedes invoke and a fast terminal event wins over an older subscribe return", async () => {
  let listener!: (snapshot: DirectorySizeSnapshot) => void;
  const { gateway, calls } = fakeGateway();
  gateway.listen = async (handler) => { calls.push("listen"); listener = handler; return () => calls.push("unlisten"); };
  gateway.subscribe = async () => {
    calls.push("subscribe");
    listener(sizeSnapshot({ generation: 3, sequence: 7 }));
    listener(sizeSnapshot({ consumerId: "unrelated", generation: 20 }));
    return sizeSnapshot({ generation: 3, sequence: 2, phase: "queued", totalBytes: null });
  };
  const received: DirectorySizeSnapshot[] = []; const errors: unknown[] = [];
  const lease = openDirectorySizeSubscription(gateway, request, (value) => received.push(value), (error) => errors.push(error));
  await flush();
  assert.deepEqual(calls, ["listen", "subscribe"]);
  assert.deepEqual(received.map(({ phase }) => phase), ["complete"]);
  listener(sizeSnapshot({ generation: 3, sequence: 4 }));
  assert.equal(received.length, 1);
  lease.close(); await flush();
  assert.deepEqual(calls, ["listen", "subscribe", "unlisten", "release"]);
  assert.deepEqual(errors, []);
});

test("release racing slow subscribe is repeated after it settles, without resurrecting display", async () => {
  const { gateway, calls } = fakeGateway();
  let finish!: (snapshot: DirectorySizeSnapshot) => void;
  gateway.subscribe = () => { calls.push("subscribe"); return new Promise((resolve) => { finish = resolve; }); };
  const received: DirectorySizeSnapshot[] = [];
  const lease = openDirectorySizeSubscription(gateway, request, (value) => received.push(value), () => undefined);
  await flush();
  assert.equal(typeof finish, "function");
  lease.close(); await flush();
  assert.equal(calls.filter((call) => call === "release").length, 1);
  finish(sizeSnapshot()); await flush();
  assert.equal(calls.filter((call) => call === "release").length, 2);
  assert.deepEqual(received, []);
});

test("a refresh event before its identical return keeps queued work cancellable", async () => {
  let listener!: (snapshot: DirectorySizeSnapshot) => void;
  const queued = sizeSnapshot({ generation: 2, sequence: 2, phase: "queued", totalBytes: null,
    knownBytes: "0", files: 0, directories: 0, freshness: "snapshot", reason: "已请求重新统计" });
  const { gateway } = fakeGateway({
    listen: async (handler) => { listener = handler; return () => undefined; },
    subscribe: async () => { listener(queued); return { ...queued }; }
  });
  const received: DirectorySizeSnapshot[] = [];
  const lease = openDirectorySizeSubscription(gateway, { ...request, refresh: true }, (value) => received.push(value), (error) => assert.fail(String(error)));
  try { await flush(); assert.deepEqual(received, [queued]); }
  finally { lease.close(); await flush(); }
});

test("listener failure is visible and does not invoke, late listener setup disposes without subscribing", async () => {
  const { gateway, calls } = fakeGateway({ listen: async () => { throw new Error("listener unavailable"); } });
  const errors: unknown[] = [];
  const failed = openDirectorySizeSubscription(gateway, request, () => undefined, (error) => errors.push(error));
  await flush();
  assert.match(String(errors[0]), /listener unavailable/);
  assert.equal(calls.includes("subscribe"), false);
  failed.close();
  let finish!: (dispose: () => void) => void;
  gateway.listen = () => new Promise((resolve) => { finish = resolve; });
  const late = openDirectorySizeSubscription(gateway, request, () => undefined, () => undefined);
  late.close(); finish(() => calls.push("late-unlisten")); await flush();
  assert.equal(calls.includes("late-unlisten"), true);
  assert.equal(calls.includes("subscribe"), false);
});
