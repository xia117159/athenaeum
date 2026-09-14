import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { createMockWorkspaceBootstrap } from "./mockData";
import { WorkspaceFeedback } from "./WorkspaceFeedback";
import { useWorkspaceController } from "./useWorkspaceController";
import { createWorkspaceState, workspaceReducer, type WorkspaceAction } from "./workspaceReducer";
import type { NotificationItem, SettingsModel, WorkspaceState } from "./types";
import type { WorkspaceGateway } from "./workspaceGateway";
import { createTestGateway, flushEffects, installDomEnvironment, waitFor } from "./workspaceControllerTestHarness";

async function mountController(context: TestContext, enabled: boolean) {
  const dom = installDomEnvironment();
  const host = document.getElementById("root")!;
  const root = ReactDOM.createRoot(host);
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  const interactions = {
    resolvedPaths: [], copyCalls: [], moveCalls: [], deleteCalls: [], renameCalls: [],
    createDirectoryCalls: [], createFileCalls: [], treeLoadPaths: [], savedDetailsRowHeights: [],
    nativeContextMenus: [], savedSettingsModels: [] as SettingsModel[]
  };
  const bootstrap = createMockWorkspaceBootstrap("tauri");
  bootstrap.settingsModel.notificationsEnabled = enabled;
  const gateway = createTestGateway(() => {}, interactions, { loadBootstrap: () => bootstrap });
  let listener: Parameters<WorkspaceGateway["listenSettingsChanged"]>[0] | undefined;
  gateway.listenSettingsChanged = async (handler) => {
    listener = handler;
    return () => { if (listener === handler) listener = undefined; };
  };
  let controller!: ReturnType<typeof useWorkspaceController>;
  function Harness() {
    controller = useWorkspaceController(gateway);
    return <WorkspaceFeedback notifications={controller.state.notifications} fileOpens={controller.state.fileOpens ?? []}
      onCancelOpen={controller.actions.cancelFileOpen} onDismiss={controller.actions.dismissNotification} />;
  }
  await act(async () => {
    root.render(<Harness />);
    await flushEffects();
  });
  await waitFor(() => controller?.state.status === "ready" && Boolean(listener), "controller settings listener did not initialize");
  return {
    host, interactions,
    get controller() { return controller; },
    emitSettings(patch: Partial<SettingsModel>) {
      assert.ok(listener, "settings listener must be active");
      const state = controller.state;
      listener({
        settingsModel: { ...state.settings.model, ...patch },
        bookmarks: state.bookmarks,
        hotlist: state.hotlist,
        remoteProfiles: state.remoteProfiles,
        navigationItems: state.navigation.items
      });
    }
  };
}

for (const enabled of [false, true]) {
  test(`notification-only settings sync ${enabled} -> ${!enabled} survives the next column autosave`, async (context) => {
    const fixture = await mountController(context, enabled);
    const savedBeforeSync = fixture.interactions.savedSettingsModels.length;
    await act(async () => {
      fixture.emitSettings({ notificationsEnabled: !enabled });
      await flushEffects();
    });
    assert.equal(fixture.controller.state.settings.model.notificationsEnabled, !enabled);
    assert.equal(fixture.interactions.savedSettingsModels.length, savedBeforeSync,
      "an already persisted settings event must not echo a full-model save");
    await act(async () => {
      fixture.controller.actions.showNotification("danger", "after settings sync");
      await flushEffects();
    });
    assert.equal(fixture.host.querySelectorAll("[role='alert']").length, enabled ? 0 : 1);

    const column = fixture.controller.state.settings.model.navigationColumns.find(item => item.id !== "name");
    assert.ok(column, "the navigation fixture must have a resizable column");
    await act(async () => {
      fixture.controller.actions.setNavigationColumnWidth(column.id, column.width === "222px" ? "223px" : "222px");
      await flushEffects();
    });
    assert.equal(fixture.interactions.savedSettingsModels.length, savedBeforeSync + 1,
      "sync suppression must not consume the subsequent user edit");
    assert.equal(fixture.interactions.savedSettingsModels.at(-1)?.notificationsEnabled, !enabled);
  });

  test(`notifications follow settings ${enabled} -> ${!enabled} queued in the same React batch`, async (context) => {
    const fixture = await mountController(context, enabled);
    const rowHeight = fixture.controller.state.settings.model.detailsRowHeight;
    await act(async () => {
      // Another recognized setting isolates the notification ordering from the sync-comparison regression.
      fixture.emitSettings({ notificationsEnabled: !enabled, detailsRowHeight: rowHeight === 36 ? 24 : 36 });
      fixture.controller.actions.showNotification("danger", "same batch");
      await flushEffects();
    });
    assert.equal(fixture.controller.state.settings.model.notificationsEnabled, !enabled);
    assert.deepEqual(fixture.controller.state.notifications.map(item => item.message), enabled ? [] : ["same batch"]);
  });
}

function settingsAction(state: WorkspaceState, enabled: boolean, source: "apply" | "sync"): WorkspaceAction {
  const model = { ...state.settings.model, notificationsEnabled: enabled };
  return source === "apply"
    ? { type: "settingsModelApplied", payload: { model } }
    : {
      type: "settingsSnapshotSynced",
      payload: {
        settingsModel: model, bookmarks: state.bookmarks, hotlist: state.hotlist,
        remoteProfiles: state.remoteProfiles, navigationItems: state.navigation.items
      }
    };
}

function stateWithFeedback() {
  const bootstrap = createMockWorkspaceBootstrap("tauri");
  bootstrap.settingsModel.notificationsEnabled = true;
  let state = createWorkspaceState(bootstrap);
  state = workspaceReducer(state, { type: "fileOpenStarted", payload: { requestId: "open-review", path: "sftp://review/review.txt" } });
  state = workspaceReducer(state, {
    type: "fileOpenProgressed",
    payload: { requestId: "open-review", progress: { phase: "downloading", completedBytes: 2048 } }
  });
  for (const intent of ["info", "danger"] as const) {
    state = workspaceReducer(state, { type: "notificationAdded", payload: { id: intent, intent, message: `${intent} before disable` } });
  }
  assert.equal(state.notifications.length, 2);
  return state;
}

for (const source of ["apply", "sync"] as const) {
  test(`${source} clears existing notifications without hiding file-opening progress or cancel`, async (context) => {
    const before = stateWithFeedback();
    const disabled = workspaceReducer(before, settingsAction(before, false, source));
    assert.deepEqual(disabled.notifications, []);
    assert.equal(disabled.fileOpens, before.fileOpens);
    assert.equal(disabled.operations, before.operations);

    const dom = installDomEnvironment();
    const host = document.getElementById("root")!;
    const root = ReactDOM.createRoot(host);
    context.after(async () => {
      await act(async () => root.unmount());
      dom.window.close();
    });
    const cancellations: string[] = [];
    await act(async () => {
      root.render(<WorkspaceFeedback notifications={disabled.notifications} fileOpens={disabled.fileOpens ?? []}
        onCancelOpen={id => cancellations.push(id)} onDismiss={() => {}} />);
      await flushEffects();
    });
    assert.equal(host.querySelectorAll("[role='alert']").length, 0);
    assert.equal(host.querySelectorAll(".workspace-notification").length, 1, "only the file-open progress remains");
    assert.match(host.textContent ?? "", /2 KB/);
    const cancel = host.querySelector<HTMLButtonElement>("button[aria-label='取消打开 review.txt']");
    assert.ok(cancel);
    assert.equal(cancel.disabled, false);
    cancel.click();
    assert.deepEqual(cancellations, ["open-review"]);

    const reenabled = workspaceReducer(disabled, settingsAction(disabled, true, source));
    assert.deepEqual(reenabled.notifications, [], "reenabling must not replay old notifications");
    assert.equal(reenabled.fileOpens, before.fileOpens);
  });

  test(`${source} clears stale notifications even if the received model is already disabled`, () => {
    const before = stateWithFeedback();
    const stale = { ...before, settings: { ...before.settings, model: { ...before.settings.model, notificationsEnabled: false } } };
    const cleaned = workspaceReducer(stale, settingsAction(stale, false, source));
    assert.deepEqual(cleaned.notifications, []);
    assert.equal(cleaned.fileOpens, before.fileOpens);
    assert.equal(workspaceReducer(cleaned, settingsAction(cleaned, false, source)), cleaned,
      "an unchanged disabled model with an empty queue must remain a no-op");
  });
}

test("disabled notification actions leave workspace state untouched for every intent", () => {
  const state = createWorkspaceState(createMockWorkspaceBootstrap("tauri"));
  for (const intent of ["info", "success", "warning", "danger"] satisfies NotificationItem["intent"][]) {
    const next = workspaceReducer(state, { type: "notificationAdded", payload: { id: intent, intent, message: "suppressed" } });
    assert.equal(next, state);
    assert.deepEqual(next.notifications, []);
  }
});
