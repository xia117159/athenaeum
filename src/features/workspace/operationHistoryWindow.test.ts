import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  OPERATION_HISTORY_WINDOW_LABEL,
  OPERATION_HISTORY_WINDOW_URL,
  openOperationHistoryWindow,
  type OperationHistoryWindowAdapter,
  type OperationHistoryWindowConstructor,
  type OperationHistoryWindowHandle,
  type OperationHistoryWindowOptions
} from "./operationHistoryWindow";

function assertTest(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve().then(fn).then(() => console.log(`ok - ${name}`));
}

function createHandle(
  events: string[],
  options: { created?: Promise<void>; rejectOnce?: "tauri://created" | "tauri://error" } = {}
): OperationHistoryWindowHandle {
  return {
    async show() {
      events.push("show");
    },
    async setFocus() {
      events.push("setFocus");
    },
    async once(event, handler) {
      events.push(`once:${event}`);
      if (options.rejectOnce === event) throw new Error(`cannot register ${event}`);
      if (event === "tauri://created") {
        void (options.created ?? Promise.resolve()).then(() => handler({ event, id: 1, payload: undefined } as Parameters<typeof handler>[0]));
      }
      return () => { events.push(`unlisten:${event}`); };
    }
  };
}

function createAdapter(options: {
  existing?: OperationHistoryWindowHandle | null;
  created?: Promise<void>;
  rejectOnce?: "tauri://created" | "tauri://error";
  tauri?: boolean;
} = {}) {
  const events: string[] = [];
  const createdOptions: OperationHistoryWindowOptions[] = [];
  const browserOpens: Array<{ url: string; target: string; features: string }> = [];
  const adapter: OperationHistoryWindowAdapter = {
    hasTauriRuntime: () => options.tauri !== false,
    openBrowserWindow(url, target, features) {
      browserOpens.push({ url, target, features });
    },
    async loadWebviewWindow() {
      const Constructor = function WebviewWindow(label: string, windowOptions: OperationHistoryWindowOptions) {
        events.push(`create:${label}`);
        createdOptions.push(windowOptions);
        return createHandle(events, options);
      } as unknown as OperationHistoryWindowConstructor & {
        getByLabel: (label: string) => Promise<OperationHistoryWindowHandle | null>;
      };
      Constructor.getByLabel = async (label) => {
        events.push(`getByLabel:${label}`);
        return options.existing ?? null;
      };
      return { WebviewWindow: Constructor };
    }
  };
  return { adapter, events, createdOptions, browserOpens };
}

export const completion = (async () => {
  await assertTest("openOperationHistoryWindow focuses an existing native window", async () => {
    const existingEvents: string[] = [];
    const { adapter, events } = createAdapter({ existing: createHandle(existingEvents) });
    await openOperationHistoryWindow(adapter);
    assert.deepEqual(events, [`getByLabel:${OPERATION_HISTORY_WINDOW_LABEL}`]);
    assert.deepEqual(existingEvents, ["show", "setFocus"]);
  });

  await assertTest("openOperationHistoryWindow creates one stable decorated window", async () => {
    const { adapter, events, createdOptions } = createAdapter();
    await openOperationHistoryWindow(adapter);
    assert.deepEqual(events, [
      `getByLabel:${OPERATION_HISTORY_WINDOW_LABEL}`,
      `create:${OPERATION_HISTORY_WINDOW_LABEL}`,
      "once:tauri://created",
      "once:tauri://error",
      "unlisten:tauri://created",
      "unlisten:tauri://error"
    ]);
    assert.deepEqual(createdOptions, [{
      url: OPERATION_HISTORY_WINDOW_URL,
      title: "\u64cd\u4f5c\u5386\u53f2",
      width: 960,
      height: 700,
      minWidth: 720,
      minHeight: 520,
      resizable: true,
      decorations: true,
      focus: true,
      center: true
    }]);
  });

  await assertTest("concurrent operation-history opens share one creation attempt", async () => {
    let releaseCreation: (() => void) | undefined;
    const created = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    const { adapter, events } = createAdapter({ created });
    const first = openOperationHistoryWindow(adapter);
    const second = openOperationHistoryWindow(adapter);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(events.filter((event) => event.startsWith("create:")).length, 1);
    releaseCreation?.();
    await Promise.all([first, second]);
  });

  await assertTest("operation-history uses a stable browser fallback", async () => {
    const { adapter, browserOpens } = createAdapter({ tauri: false });
    await openOperationHistoryWindow(adapter);
    assert.deepEqual(browserOpens, [{
      url: OPERATION_HISTORY_WINDOW_URL,
      target: OPERATION_HISTORY_WINDOW_LABEL,
      features: "width=960,height=700,resizable=yes"
    }]);
  });

  await assertTest("AppShell and a least-privilege capability route the child window", () => {
    const appShell = fs.readFileSync(path.join(process.cwd(), "src/app/AppShell.tsx"), "utf8");
    assert.equal(appShell.includes('view === "operation-history"'), true);
    assert.equal(appShell.includes("<OperationHistoryWindowView />"), true);

    const capability = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), "src-tauri/capabilities/operation-history.json"),
      "utf8"
    )) as { windows: string[]; permissions: string[] };
    assert.deepEqual(capability.windows, [OPERATION_HISTORY_WINDOW_LABEL]);
    assert.deepEqual(capability.permissions, [
      "core:event:allow-emit",
      "core:event:allow-listen",
      "allow-list-file-operation-tasks",
      "allow-cancel-file-operation",
      "allow-list-operation-history",
      "allow-undo-latest-operation",
      "allow-undo-operation",
      "allow-clear-operation-records"
    ]);
    for (const forbidden of [
      "core:default",
      "default",
      "core:webview:allow-create-webview-window",
      "core:window:allow-close",
      "core:window:allow-show",
      "core:window:allow-set-focus",
      "allow-list-directory",
      "allow-get-settings-snapshot",
      "allow-list-remote-profiles",
      "allow-show-native-context-menu"
    ]) {
      assert.equal(capability.permissions.includes(forbidden), false, forbidden);
    }
  });

  for (const event of ["tauri://created", "tauri://error"] as const) {
    await assertTest(`operation-history recovers when ${event} listener registration fails`, async () => {
      const failed = createAdapter({ rejectOnce: event });
      await assert.rejects(
        Promise.race([
          openOperationHistoryWindow(failed.adapter),
          new Promise((_, reject) => setTimeout(() => reject(new Error("open timed out")), 100))
        ]),
        /cannot register/
      );
      assert.equal(failed.events.some((value) => value.startsWith("unlisten:")), true);
      const retry = createAdapter();
      await openOperationHistoryWindow(retry.adapter);
      assert.equal(retry.events.filter((value) => value.startsWith("create:")).length, 1);
    });
  }
})();
