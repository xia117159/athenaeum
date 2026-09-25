import assert from "node:assert/strict";
import { test } from "node:test";
import { DirectorySizeSlot } from "./directorySizeSlot";
import { sizeTransport } from "./directorySizeControllerTestSupport";
import { sizeSnapshot } from "./directorySizeTestSupport";
import type { DirectorySizeSnapshot, SubscribeDirectorySizesRequest } from "./directorySizeTypes";

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function intent(id: string, fail: (error: unknown) => void = () => {}) {
  return { request: { consumerId: id, target: { kind: "local" as const, path: "C:\\root" }, refresh: false }, receive: () => {}, fail };
}

test("rapid tab switches keep one handoff in flight and coalesce to the latest tab", async () => {
  const requests: SubscribeDirectorySizesRequest[] = []; let reply!: (value: DirectorySizeSnapshot) => void;
  const wire = sizeTransport({ subscribe: (request) => { requests.push(request); return new Promise((resolve) => { reply = resolve; }); } });
  const slot = new DirectorySizeSlot(wire.gateway, "panel-1");
  try {
    slot.replace(intent("a")); await settle();
    slot.replace(intent("b")); slot.replace(intent("c")); await settle();
    assert.equal(requests.length, 1); assert.equal(wire.released.length, 0);
    reply(sizeSnapshot({ consumerId: "a" })); await settle();
    assert.equal(requests.length, 2); assert.equal(requests[1].consumerId, "c");
    assert.equal(requests[1].handoffFrom, "a"); assert.equal(wire.released.length, 0);
    reply(sizeSnapshot({ consumerId: "c" })); await settle();
    assert.deepEqual(wire.released, ["a"]);
  } finally { slot.clear(); await settle(); }
  assert.equal(wire.listeners.size, 0);
});

test("timed out handoff closes the slot and late replies cannot revive a subscription", async () => {
  let reply!: (value: DirectorySizeSnapshot) => void; const errors: unknown[] = [];
  const wire = sizeTransport({ subscribe: () => new Promise((resolve) => { reply = resolve; }) });
  const slot = new DirectorySizeSlot(wire.gateway, "panel-1", 10);
  slot.replace(intent("late", (error) => errors.push(error))); await settle();
  await new Promise((resolve) => setTimeout(resolve, 30)); await settle();
  assert.equal(errors.length, 1); assert.equal(wire.listeners.size, 0); assert.deepEqual(wire.released, ["late"]);
  reply(sizeSnapshot({ consumerId: "late" })); await settle();
  assert.deepEqual(wire.released, ["late", "late"]); slot.clear();
});
