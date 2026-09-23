import { Worker as NodeWorker } from "node:worker_threads";
import path from "node:path";
import { act } from "react";
import type { QuickFilterWorkerEndpoint } from "./quickFilterWorkerClient";
import type { WorkspaceState } from "./types";
import { getPathComparisonKey } from "./workspacePathRelations";

/** Explicit test-only browser Worker adapter. Runs the production evaluator off-thread. */
export function installQuickFilterTestWorker() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  class TestWorker implements QuickFilterWorkerEndpoint {
    onmessage: QuickFilterWorkerEndpoint["onmessage"] = null;
    onerror: QuickFilterWorkerEndpoint["onerror"] = null;
    onmessageerror: QuickFilterWorkerEndpoint["onmessageerror"] = null;
    private worker = new NodeWorker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { evaluateQuickFilter } = require(workerData);
      parentPort.on('message', ({ id, request }) => {
        try { parentPort.postMessage({ id, result: evaluateQuickFilter(request) }); }
        catch(error) { parentPort.postMessage({ id, failure: error.message }); }
      });`, { eval: true, workerData: path.join(__dirname, "quickFilterEvaluator.js") });
    constructor() {
      this.worker.on("message", data => this.onmessage?.({ data } as MessageEvent));
      this.worker.on("error", error => this.onerror?.({ message: error instanceof Error ? error.message : String(error) } as ErrorEvent));
      this.worker.on("messageerror", () => this.onmessageerror?.({} as MessageEvent));
    }
    postMessage(message: Parameters<QuickFilterWorkerEndpoint["postMessage"]>[0]) { this.worker.postMessage(message); }
    terminate() { void this.worker.terminate(); }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: TestWorker });
  return () => {
    if (original) Object.defineProperty(globalThis, "Worker", original);
    else Reflect.deleteProperty(globalThis, "Worker");
  };
}

export async function settleQuickFilter(state: () => WorkspaceState, path: string) {
  const key = getPathComparisonKey(path);
  const deadline = Date.now() + 5000;
  while (state().quickFilter.byPath[key]?.regexAttempt?.text !== state().quickFilter.byPath[key]?.text) {
    if (Date.now() > deadline) throw new Error("Quick filter Worker did not settle");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}
