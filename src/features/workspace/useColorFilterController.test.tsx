import assert from "node:assert/strict";
import { useReducer } from "react";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createWorkspaceState, workspaceReducer } from "./workspaceReducer";
import { useColorFilterController } from "./useColorFilterController";
import type { ColorFilterConfigSnapshot, ColorFilterMutationResult, ReplaceColorRulesResult } from "./colorFilterTypes";
import type { WorkspaceGateway } from "./workspaceGateway";

const { JSDOM } = require("jsdom") as { JSDOM: new (html?: string, options?: { url?: string }) => { window: Window & typeof globalThis } };

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshot(revision: string, rulesRevision: string, enabled: boolean): ColorFilterConfigSnapshot {
  return { enabled, revision, rulesRevision, rules: [] };
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost" });
  globalThis.window = dom.window as typeof globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

export const completion = (async () => {
  const dom = installDom();
  const React = require("react") as typeof import("react");
  const { act } = React;
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  const toggleRequest = deferred<ColorFilterMutationResult>();
  let replaceRequest = deferred<ReplaceColorRulesResult>();
  const notifications: string[] = [];
  let toggleCalls = 0;
  let refreshCalls = 0;
  let colorFilterListener: ((value: ColorFilterConfigSnapshot) => void) | undefined;
  let rejectToggle = false;
  let latest: ReturnType<typeof useColorFilterController> | undefined;
  let latestEnabled = true;

  const gateway: Pick<
    WorkspaceGateway,
    "getColorFilterSnapshot" | "setColorFilterEnabled" | "replaceColorRules" | "validateColorRule" | "listenColorFilterChanged"
  > = {
    async getColorFilterSnapshot() {
      return snapshot("4", "3", true);
    },
    async setColorFilterEnabled() {
      toggleCalls += 1;
      if (rejectToggle) throw new Error("toggle failed");
      return toggleRequest.promise;
    },
    async replaceColorRules() {
      return replaceRequest.promise;
    },
    async validateColorRule() {
      return { valid: true, message: null, span: null };
    },
    async listenColorFilterChanged(handler) {
      colorFilterListener = handler;
      return () => undefined;
    }
  };

  function Harness() {
    const [state, dispatch] = useReducer(
      workspaceReducer,
      undefined,
      () => createWorkspaceState(createMockWorkspaceBootstrap("tauri"))
    );
    latestEnabled = state.settings.model.colorFilterEnabled !== false;
    latest = useColorFilterController({
      state,
      dispatch,
      workspaceGateway: gateway,
      refreshVisibleEntries: async () => { refreshCalls += 1; },
      pushNotification: (_intent, message) => { notifications.push(message); }
    });
    return null;
  }

  try {
    await act(async () => { root.render(React.createElement(Harness)); });

    await (async () => {
      let first!: Promise<void>;
      let second!: Promise<void>;
      act(() => {
        first = latest!.toggleColorFilter(false);
        second = latest!.toggleColorFilter(false);
      });
      assert.equal(toggleCalls, 1);
      toggleRequest.resolve({ snapshot: snapshot("1", "0", false), warnings: [] });
      await act(async () => { await Promise.all([first, second]); });
      assert.equal(latestEnabled, false);
      console.log("ok - color filter toggle is pessimistic and coalesces concurrent clicks");
    })();

    await (async () => {
      rejectToggle = true;
      await act(async () => { await latest!.toggleColorFilter(true); });
      assert.equal(latestEnabled, false);
      assert.deepEqual(notifications, ["toggle failed"]);
      console.log("ok - color filter toggle failure preserves the accepted state and reports an error");
    })();

    await (async () => {
      let replacement!: Promise<ReplaceColorRulesResult>;
      await act(async () => { replacement = latest!.replaceColorRules([], "0"); });
      await act(async () => { colorFilterListener?.(snapshot("2", "1", false)); });
      replaceRequest.resolve({ status: "applied", snapshot: snapshot("2", "1", false), warnings: [] });
      await act(async () => { await replacement; });
      assert.equal(refreshCalls, 1);
      console.log("ok - color filter event-before-response refreshes visible entries once");
    })();

    await (async () => {
      replaceRequest = deferred<ReplaceColorRulesResult>();
      let replacement!: Promise<ReplaceColorRulesResult>;
      act(() => { replacement = latest!.replaceColorRules([], "1"); });
      replaceRequest.resolve({
        status: "applied",
        snapshot: snapshot("3", "2", false),
        warnings: ["color filter event was not delivered"]
      });
      await act(async () => { await replacement; });
      assert.equal(refreshCalls, 2);
      assert.equal(notifications.at(-1), "color filter event was not delivered");
      await act(async () => { colorFilterListener?.(snapshot("3", "2", false)); });
      assert.equal(refreshCalls, 2);
      console.log("ok - color filter response-before-event refreshes visible entries once");
    })();

    await (async () => {
      await act(async () => {
        window.dispatchEvent(new dom.window.Event("focus"));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(latestEnabled, true);
      assert.equal(refreshCalls, 3);
      console.log("ok - focus reload converges after a missed color filter event");
    })();
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
  }
})();
