import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ABOUT_WINDOW_LABEL,
  ABOUT_WINDOW_URL,
  openAboutWindow,
  type AboutWindowAdapter,
  type AboutWindowConstructor,
  type AboutWindowHandle,
  type AboutWindowOptions
} from "./aboutWindow";

function assertTest(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      console.error(`not ok - ${name}`);
      throw error;
    });
}

function createWindowHandle(events: string[], rejectCreated = false): AboutWindowHandle {
  return {
    async show() {
      events.push("show");
    },
    async setFocus() {
      events.push("setFocus");
    },
    async once(event, handler) {
      events.push(`once:${event}`);
      if (event === "tauri://created" && !rejectCreated) {
        queueMicrotask(() => handler({ event, id: 1, payload: undefined } as Parameters<typeof handler>[0]));
      }
      if (event === "tauri://error" && rejectCreated) {
        queueMicrotask(() => handler({ event, id: 1, payload: "permission denied" } as Parameters<typeof handler>[0]));
      }
      return () => undefined;
    }
  };
}

function createAdapter({
  existing,
  tauri = true,
  rejectCreated = false,
  createdOptions
}: {
  existing?: AboutWindowHandle | null;
  tauri?: boolean;
  rejectCreated?: boolean;
  createdOptions?: AboutWindowOptions[];
}) {
  const events: string[] = [];
  const browserOpens: Array<{ url: string; target: string; features: string }> = [];
  const adapter: AboutWindowAdapter = {
    hasTauriRuntime: () => tauri,
    openBrowserWindow(url, target, features) {
      browserOpens.push({ url, target, features });
    },
    async loadWebviewWindow() {
      const Constructor = function WebviewWindow(label: string, options: AboutWindowOptions) {
        events.push(`create:${label}`);
        createdOptions?.push(options);
        return createWindowHandle(events, rejectCreated);
      } as unknown as AboutWindowConstructor & {
        getByLabel: (label: string) => Promise<AboutWindowHandle | null>;
      };
      Constructor.getByLabel = async (label: string) => {
        events.push(`getByLabel:${label}`);
        return existing ?? null;
      };
      return { WebviewWindow: Constructor };
    }
  };

  return { adapter, events, browserOpens };
}

export const completion = (async () => {
  await assertTest("openAboutWindow focuses an existing about window", async () => {
    const existingEvents: string[] = [];
    const existing = createWindowHandle(existingEvents);
    const { adapter, events } = createAdapter({ existing });

    await openAboutWindow(adapter);

    assert.deepEqual(events, [`getByLabel:${ABOUT_WINDOW_LABEL}`]);
    assert.deepEqual(existingEvents, ["show", "setFocus"]);
  });

  await assertTest("openAboutWindow creates a compact decorated about webview window", async () => {
    const createdOptions: AboutWindowOptions[] = [];
    const { adapter, events } = createAdapter({ createdOptions });

    await openAboutWindow(adapter);

    assert.deepEqual(events, [
      `getByLabel:${ABOUT_WINDOW_LABEL}`,
      `create:${ABOUT_WINDOW_LABEL}`,
      "once:tauri://created",
      "once:tauri://error"
    ]);
    assert.deepEqual(createdOptions[0], {
      url: ABOUT_WINDOW_URL,
      title: "关于 Athenaeum",
      width: 520,
      height: 420,
      minWidth: 480,
      minHeight: 360,
      resizable: false,
      decorations: true,
      focus: true,
      center: true
    });
  });

  await assertTest("openAboutWindow uses browser fallback outside Tauri", async () => {
    const { adapter, browserOpens } = createAdapter({ tauri: false });

    await openAboutWindow(adapter);

    assert.deepEqual(browserOpens, [
      {
        url: ABOUT_WINDOW_URL,
        target: ABOUT_WINDOW_LABEL,
        features: "width=520,height=420,resizable=no"
      }
    ]);
  });

  await assertTest("openAboutWindow reports Tauri creation failures", async () => {
    const { adapter } = createAdapter({ rejectCreated: true });

    await assert.rejects(
      () => openAboutWindow(adapter),
      (error) => error instanceof Error && error.message.includes("permission denied")
    );
  });

  await assertTest("about window is routed through AppShell and allowed by Tauri capabilities", () => {
    const appShellSource = fs.readFileSync(path.join(process.cwd(), "src/app/AppShell.tsx"), "utf8");
    const workspaceSource = fs.readFileSync(path.join(process.cwd(), "src/features/workspace/WorkspaceMenuBar.tsx"), "utf8");
    const capability = JSON.parse(fs.readFileSync(path.join(process.cwd(), "src-tauri/capabilities/default.json"), "utf8")) as {
      windows: string[];
    };

    assert.equal(appShellSource.includes('view === "about"'), true);
    assert.equal(appShellSource.includes("<AboutWindowView />"), true);
    assert.equal(workspaceSource.includes("openAboutWindow"), true);
    assert.equal(workspaceSource.includes('window.alert("简单文件管理器桌面原型'), false);
    assert.equal(capability.windows.includes(ABOUT_WINDOW_LABEL), true);
  });
})();
