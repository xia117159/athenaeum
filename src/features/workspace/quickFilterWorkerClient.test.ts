import assert from "node:assert/strict";
import { test } from "node:test";
import { QuickFilterWorkerClient, type QuickFilterWorkerEndpoint } from "./quickFilterWorkerClient";
import type { QuickFilterEvaluationResult } from "./quickFilterTypes";

class FakeWorker implements QuickFilterWorkerEndpoint {
  onmessage: QuickFilterWorkerEndpoint["onmessage"] = null;
  onerror: QuickFilterWorkerEndpoint["onerror"] = null;
  onmessageerror: QuickFilterWorkerEndpoint["onmessageerror"] = null;
  terminated = false;
  messages: Array<{ id: number }> = [];
  postMessage(message: { id: number }) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  reply(id: number, result: QuickFilterEvaluationResult) { this.onmessage?.({ data: { id, result } } as MessageEvent); }
}

test("worker client serializes requests, ignores stale IDs and reuses its endpoint", async () => {
  const worker = new FakeWorker();
  const client = new QuickFilterWorkerClient(() => worker);
  const first = client.evaluate({ text: "a", fallbackText: "", names: ["a"] });
  const second = client.evaluate({ text: "b", fallbackText: "", names: ["b"] });
  assert.equal(worker.messages.length, 1);
  worker.reply(worker.messages[0].id, { error: null, evaluation: { text: "a", matches: {} } });
  assert.equal((await first).evaluation?.text, "a");
  worker.reply(worker.messages[0].id, { error: null, evaluation: { text: "stale", matches: {} } });
  worker.reply(worker.messages[1].id, { error: null, evaluation: { text: "b", matches: {} } });
  assert.equal((await second).evaluation?.text, "b");
  assert.equal(worker.terminated, false);
  client.dispose();
  assert.equal(worker.terminated, true);
});

test("aborting one evaluation rejects outstanding batch work and terminates worker", async () => {
  const worker = new FakeWorker();
  const client = new QuickFilterWorkerClient(() => worker);
  const controller = new AbortController();
  const request = client.evaluate({ text: "a", fallbackText: "", names: ["a"] }, controller.signal);
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(worker.terminated, true);
  client.dispose();
});

test("worker disposal rejects outstanding evaluations", async () => {
  const worker = new FakeWorker();
  const client = new QuickFilterWorkerClient(() => worker);
  const request = client.evaluate({ text: "a", fallbackText: "", names: ["a"] });
  client.dispose();
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(worker.terminated, true);
});

test("cancelling an active path restarts queued paths without rejecting them", async () => {
  const workers: FakeWorker[] = [];
  const client = new QuickFilterWorkerClient(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
  const controller = new AbortController();
  const first = client.evaluate({ text: "a", fallbackText: "", names: ["a"] }, controller.signal);
  const second = client.evaluate({ text: "b", fallbackText: "", names: ["b"] });
  const firstRejected = assert.rejects(first, { name: "AbortError" });
  const secondResult = second.catch(error => error);
  assert.equal(workers[0].messages.length, 1, "one active batch, other paths queue");
  controller.abort();
  await firstRejected;
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 2);
  workers[1].reply(workers[1].messages[0].id, { error: null, evaluation: { text: "b", matches: {} } });
  assert.equal((await secondResult).evaluation.text, "b");
  client.dispose();
});

test("queued cancellation leaves the running path intact", async () => {
  const worker = new FakeWorker();
  const client = new QuickFilterWorkerClient(() => worker);
  const first = client.evaluate({ text: "a", fallbackText: "", names: [] });
  const controller = new AbortController();
  const second = client.evaluate({ text: "b", fallbackText: "", names: [] }, controller.signal);
  controller.abort();
  await assert.rejects(second, { name: "AbortError" });
  assert.equal(worker.terminated, false);
  worker.reply(worker.messages[0].id, { error: null, evaluation: null });
  await first;
  assert.equal(worker.messages.length, 1);
  client.dispose();
});

test("timeout terminates active work and starts the next path with a fresh deadline", async () => {
  const workers: FakeWorker[] = [];
  const client = new QuickFilterWorkerClient(() => { const worker = new FakeWorker(); workers.push(worker); return worker; }, 30);
  const first = client.evaluate({ text: "a", fallbackText: "", names: [] });
  const second = client.evaluate({ text: "b", fallbackText: "", names: [] });
  await assert.rejects(first, /超时/);
  assert.equal(workers[0].terminated, true);
  workers[1].reply(workers[1].messages[0].id, { error: null, evaluation: null });
  await second;
  client.dispose();
});

test("construction, runtime and message errors fail cleanly and allow the next request", async () => {
  for (const failure of ["create", "error", "decode", "send"] as const) {
    let initial = true;
    const workers: FakeWorker[] = [];
    const client = new QuickFilterWorkerClient(() => {
      if (initial && failure === "create") { initial = false; throw new Error("create failed"); }
      const worker = new FakeWorker();
      if (initial && failure === "send") worker.postMessage = () => { throw new Error("send failed"); };
      initial = false;
      workers.push(worker);
      return worker;
    });
    const first = client.evaluate({ text: "a", fallbackText: "", names: [] });
    if (failure === "error") workers[0].onerror?.({ message: "runtime failed" } as ErrorEvent);
    if (failure === "decode") workers[0].onmessageerror?.({} as MessageEvent);
    await assert.rejects(first);
    const second = client.evaluate({ text: "b", fallbackText: "", names: [] });
    const current = workers.at(-1)!;
    current.reply(current.messages[0].id, { error: null, evaluation: null });
    await second;
    client.dispose();
  }
});
