import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  openSettingsWindow,
  SETTINGS_WINDOW_LABEL,
  SETTINGS_WINDOW_URL,
  type SettingsWindowAdapter,
  type SettingsWindowHandle,
  type SettingsWindowOptions,
  type WebviewWindowConstructor
} from "./settingsWindow";

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

function createWindowHandle(events: string[], rejectCreated = false): SettingsWindowHandle {
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
  existing?: SettingsWindowHandle | null;
  tauri?: boolean;
  rejectCreated?: boolean;
  createdOptions?: SettingsWindowOptions[];
}) {
  const events: string[] = [];
  const browserOpens: Array<{ url: string; target: string; features: string }> = [];
  const adapter: SettingsWindowAdapter = {
    hasTauriRuntime: () => tauri,
    openBrowserWindow(url, target, features) {
      browserOpens.push({ url, target, features });
    },
    async loadWebviewWindow() {
      const Constructor = function WebviewWindow(label: string, options: SettingsWindowOptions) {
        events.push(`create:${label}`);
        createdOptions?.push(options);
        return createWindowHandle(events, rejectCreated);
      } as unknown as WebviewWindowConstructor & {
        getByLabel: (label: string) => Promise<SettingsWindowHandle | null>;
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
  await assertTest("openSettingsWindow focuses an existing settings window", async () => {
    const existingEvents: string[] = [];
    const existing = createWindowHandle(existingEvents);
    const { adapter, events } = createAdapter({ existing });

    await openSettingsWindow(adapter);

    assert.deepEqual(events, [`getByLabel:${SETTINGS_WINDOW_LABEL}`]);
    assert.deepEqual(existingEvents, ["show", "setFocus"]);
  });

  await assertTest("openSettingsWindow creates the settings webview window with stable options", async () => {
    const createdOptions: SettingsWindowOptions[] = [];
    const { adapter, events } = createAdapter({ createdOptions });

    await openSettingsWindow(adapter);

    assert.deepEqual(events, [
      `getByLabel:${SETTINGS_WINDOW_LABEL}`,
      `create:${SETTINGS_WINDOW_LABEL}`,
      "once:tauri://created",
      "once:tauri://error"
    ]);
    assert.deepEqual(createdOptions[0], {
      url: SETTINGS_WINDOW_URL,
      title: "设置",
      width: 920,
      height: 720,
      minWidth: 720,
      minHeight: 520,
      resizable: true,
      decorations: true,
      focus: true,
      center: true
    });
  });

  await assertTest("openSettingsWindow reports Tauri creation failures", async () => {
    const { adapter } = createAdapter({ rejectCreated: true });

    await assert.rejects(
      () => openSettingsWindow(adapter),
      (error) => error instanceof Error && error.message.includes("permission denied")
    );
  });

  await assertTest("openSettingsWindow uses browser fallback outside Tauri", async () => {
    const { adapter, browserOpens } = createAdapter({ tauri: false });

    await openSettingsWindow(adapter);

    assert.deepEqual(browserOpens, [
      {
        url: SETTINGS_WINDOW_URL,
        target: SETTINGS_WINDOW_LABEL,
        features: "width=920,height=720,resizable=yes"
      }
    ]);
  });

  await assertTest("workspace source opens settings from the top menu only", () => {
    const workspaceSource = fs.readFileSync(path.join(process.cwd(), "src/features/workspace/WorkspaceView.tsx"), "utf8");

    assert.equal(workspaceSource.includes("SettingsDialog"), false);
    assert.equal(workspaceSource.includes("<SettingsSurface"), false);
    assert.equal(workspaceSource.includes("openSettingsWindow"), true);
    assert.equal(workspaceSource.includes('{ label: "设置", onSelect: handleOpenSettingsWindow }'), true);
    assert.equal(workspaceSource.includes('onClick={() => actions.toggleSettings(true)}'), false);
  });

  await assertTest("settings window opens without a loading overlay and wires confirm and cancel", () => {
    const settingsWindowSource = fs.readFileSync(path.join(process.cwd(), "src/features/workspace/SettingsWindowView.tsx"), "utf8");

    assert.equal(settingsWindowSource.includes("正在加载设置"), false);
    assert.equal(settingsWindowSource.includes("workspace-loading"), false);
    assert.equal(settingsWindowSource.includes('const settingsReady = state.status === "ready"'), true);
    assert.equal(settingsWindowSource.includes("disabled={!settingsReady}"), true);
    assert.equal(settingsWindowSource.includes("onConfirm"), true);
    assert.equal(settingsWindowSource.includes("onCancel"), true);
    assert.equal(settingsWindowSource.includes("onUpdateTagRule"), false);
    assert.equal(settingsWindowSource.includes("onToggleColumn"), false);

    const remoteUpsertsIndex = settingsWindowSource.indexOf("await applyRemoteProfileUpserts()");
    const settingsModelIndex = settingsWindowSource.indexOf("await actions.applySettingsModel");
    const remoteDeletionsIndex = settingsWindowSource.indexOf("await applyRemoteProfileDeletions()");
    assert.equal(remoteUpsertsIndex > -1, true);
    assert.equal(settingsModelIndex > remoteUpsertsIndex, true);
    assert.equal(remoteDeletionsIndex > settingsModelIndex, true);
  });

  await assertTest("Tauri capability allows the settings child window", () => {
    const capability = JSON.parse(fs.readFileSync(path.join(process.cwd(), "src-tauri/capabilities/default.json"), "utf8")) as {
      windows: string[];
      permissions: string[];
    };

    assert.deepEqual(capability.windows, ["main", SETTINGS_WINDOW_LABEL]);
    assert.equal(capability.permissions.includes("core:webview:allow-create-webview-window"), true);
    assert.equal(capability.permissions.includes("core:window:allow-show"), true);
    assert.equal(capability.permissions.includes("core:window:allow-set-focus"), true);
    assert.equal(capability.permissions.includes("core:window:allow-close"), true);
  });
})();
