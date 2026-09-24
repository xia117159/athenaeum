import assert from "node:assert/strict";
import React, { act, useReducer } from "react";
import ReactDOM from "react-dom/client";
import { createWorkspaceState, workspaceReducer, type WorkspaceAction } from "./workspaceReducer";
import { expansionEntry, expansionFixture, expansionSnapshot } from "./folderExpansionTestSupport";
import { useQuickFilterCompilationScheduler } from "./useQuickFilterCompilationScheduler";
import { installDomEnvironment } from "./workspaceControllerTestHarness";
import { evaluateQuickFilter } from "./quickFilterEvaluator";
import { resolveQuickFilterProgram } from "./quickFilterState";
import type { QuickFilterWorkerEndpoint } from "./quickFilterWorkerClient";
import type { QuickFilterEvaluationRequest } from "./quickFilterTypes";

export const completion = (async () => {
  installDomEnvironment();
  const workers: ControlledWorker[] = [];
  class ControlledWorker implements QuickFilterWorkerEndpoint {
    onmessage: QuickFilterWorkerEndpoint["onmessage"] = null;
    onerror: QuickFilterWorkerEndpoint["onerror"] = null;
    onmessageerror: QuickFilterWorkerEndpoint["onmessageerror"] = null;
    messages: Array<{ id: number; request: QuickFilterEvaluationRequest }> = [];
    terminated = false;
    constructor(url: URL) {
      assert.equal(url.pathname, "/assets/quickFilter.worker.js");
      workers.push(this);
    }
    postMessage(message: typeof this.messages[number]) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    reply() {
      const message = this.messages.at(-1)!;
      this.onmessage?.({ data: { id: message.id, result: evaluateQuickFilter(message.request) } } as MessageEvent);
    }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: ControlledWorker });
  const f = expansionFixture();
  let state = createWorkspaceState(f.bootstrap);
  let dispatch!: React.Dispatch<WorkspaceAction>;
  let enabled = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = ReactDOM.createRoot(container);
  function Harness() {
    [state, dispatch] = useReducer(workspaceReducer, state);
    useQuickFilterCompilationScheduler({ state, dispatch, enabled });
    return null;
  }
  const send = async (action: WorkspaceAction) => act(async () => { dispatch(action); });
  const pause = async (ms = 140) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  const type = async (text: string) => send({ type: "quickFilterTextChanged", payload: { path: f.path, text } });
  try {
    await act(async () => root.render(<Harness />));
    await send({ type: "quickFilterSyntaxChanged", payload: { syntax: "regex" } });
    await send({ type: "quickFilterModeChanged", payload: { mode: "include" } });
    await type("sib");
    await pause(30);
    assert.equal(workers.length, 0, "editing is debounced");
    await type("sibling");
    await pause();
    assert.equal(workers.length, 1);
    assert.equal(workers[0].messages.length, 1, "superseded text never reached Worker");
    await act(async () => workers[0].reply());
    assert.equal(resolveQuickFilterProgram(state, f.path)?.test("parent"), false);
    await send({ type: "quickFilterModeChanged", payload: { mode: "highlight" } });
    assert.deepEqual(resolveQuickFilterProgram(state, f.path)?.ranges("sibling"), [{ start: 0, end: 7 }]);
    await pause();
    assert.equal(workers[0].messages.length, 1, "mode switches reuse ranges");

    await type("(");
    await pause();
    await act(async () => workers[0].reply());
    assert.ok(state.quickFilter.byPath[f.path.toLowerCase()].error);
    assert.equal(resolveQuickFilterProgram(state, f.path)?.text, "sibling");
    await pause();
    assert.equal(workers[0].messages.length, 2, "invalid queries do not retry forever");

    // A snapshot update under an invalid query evaluates the fallback on new names.
    const tab = state.panels["panel-1"].tabs[0];
    await send({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: tab.id, pushHistory: false,
      snapshot: { ...tab.snapshot, entries: [...tab.snapshot.entries, expansionEntry(f.path, "sibling-new")] } } });
    await pause();
    await act(async () => workers[0].reply());
    assert.equal(resolveQuickFilterProgram(state, f.path)?.test("sibling-new"), true);

    await type("parent");
    await pause();
    const late = workers[0].onmessage!;
    const message = workers[0].messages.at(-1)!;
    await type("   ");
    assert.equal(workers[0].terminated, true, "clearing stops physical work");
    await act(async () => late({ data: { id: message.id, result: evaluateQuickFilter(message.request) } } as MessageEvent));
    assert.equal(resolveQuickFilterProgram(state, f.path), null, "late result cannot undo clearing");

    await type("x");
    await pause();
    await act(async () => workers[1].onerror?.({ message: "worker unavailable" } as ErrorEvent));
    await pause();
    assert.equal(workers.length, 2, "worker errors settle without restart loops");
    assert.equal(state.quickFilter.byPath[f.path.toLowerCase()].error, "worker unavailable");
    await type("y");
    await pause();
    assert.equal(workers.length, 3, "an edit retries a failed worker");
    enabled = false;
    await act(async () => root.render(<Harness />));
    assert.equal(workers[2].terminated, true);
    await type("z");
    await pause();
    assert.equal(workers.length, 3, "settings role does not launch filter workers");

    await type("sibling");
    enabled = true;
    await act(async () => root.render(<Harness />));
    await pause();
    await act(async () => workers.at(-1)!.reply());
    await type("(");
    await pause();
    const leaving = workers.at(-1)!;
    const lateNavigationReply = leaving.onmessage!;
    const leavingMessage = leaving.messages.at(-1)!;
    const savedSnapshot = state.panels["panel-1"].tabs[0].snapshot;
    await send({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: f.tabId, pushHistory: true,
      snapshot: expansionSnapshot("C:\\other", []) } });
    assert.equal(leaving.terminated, true, "navigation cancels the path's running evaluation");
    assert.equal(state.quickFilter.byPath[f.path.toLowerCase()].regexEvaluation, undefined);
    await act(async () => lateNavigationReply({ data: {
      id: leavingMessage.id, result: evaluateQuickFilter(leavingMessage.request)
    } } as MessageEvent));
    assert.equal(state.quickFilter.byPath[f.path.toLowerCase()].regexEvaluation, undefined, "late reply cannot refill history");
    const countWhileAway = workers.length;
    await pause();
    assert.equal(workers.length, countWhileAway, "historical paths do not restart work");
    await send({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: f.tabId, pushHistory: true,
      snapshot: savedSnapshot } });
    assert.equal(resolveQuickFilterProgram(state, f.path)?.isPending?.("sibling"), true);
    await pause();
    const returned = workers.at(-1)!;
    assert.notEqual(returned, leaving);
    assert.equal(returned.messages.at(-1)!.request.fallbackText, "sibling");
    await act(async () => returned.reply());
    assert.equal(resolveQuickFilterProgram(state, f.path)?.test("sibling-new"), true);
    assert.equal(resolveQuickFilterProgram(state, f.path)?.isPending?.("sibling-new"), false);
    assert.ok(state.quickFilter.byPath[f.path.toLowerCase()].error, "invalid text retains its diagnostic after rebuilding fallback matches");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
  assert.ok(workers.every(worker => worker.terminated));
  console.log("ok - Worker scheduling, modes, refresh, failure, clearing, settings role and navigation cancellation/rebuild");
})();
