import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { createMockWorkspaceBootstrap } from "./mockData";
import { useWorkspaceController } from "./useWorkspaceController";
import {
  assertTest,
  createTestGateway,
  flushEffects,
  installDomEnvironment,
  waitFor
} from "./workspaceControllerTestHarness";

// 通知提示由设置项控制（默认关闭）：关闭时 pushNotification 必须静默，
// 通知不进入 state 也就不会渲染到右下角；打开时恢复正常推送。
export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }

  const emptyInteractions = {
    resolvedPaths: [], copyCalls: [], moveCalls: [], deleteCalls: [], renameCalls: [],
    createDirectoryCalls: [], createFileCalls: [], treeLoadPaths: [], savedDetailsRowHeights: [],
    nativeContextMenus: []
  };

  // 返回实时 holder：Harness 每次渲染都会更新 holder.controller，
  // 断言读取 holder.controller.state 才是最新已提交状态。
  async function renderController(options: { enabled: boolean; startupDiagnostics?: string[] }) {
    const { enabled } = options;
    const gateway = createTestGateway(() => undefined, emptyInteractions, {
      loadBootstrap: () => ({
        ...createMockWorkspaceBootstrap("tauri"),
        settingsModel: {
          ...createMockWorkspaceBootstrap("tauri").settingsModel,
          notificationsEnabled: enabled
        },
        startupDiagnostics: options.startupDiagnostics ?? []
      })
    });
    const holder: { controller?: ReturnType<typeof useWorkspaceController> } = {};
    const host = document.createElement("div");
    document.body.appendChild(host);
    function Harness() {
      holder.controller = useWorkspaceController(gateway);
      return React.createElement("div", null, holder.controller.state.layoutMode);
    }
    const root = ReactDOM.createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await flushEffects();
    });
    await waitFor(() => holder.controller?.state.status === "ready", "controller did not bootstrap");
    return { holder, root, host };
  }

  try {
    await assertTest("pushNotification stays silent while notifications are disabled in settings", async () => {
      const { holder, root, host } = await renderController({ enabled: false });
      await act(async () => {
        holder.controller?.actions.showNotification("danger", "should be suppressed");
        holder.controller?.actions.showNotification("warning", "also suppressed");
        await flushEffects();
      });
      assert.equal(holder.controller?.state.notifications.length, 0, "disabled notifications must not enter state");
      await act(async () => {
        root.unmount();
      });
      host.remove();
    });

    await assertTest("startup diagnostics stay silent when notifications are disabled", async () => {
      const { holder, root, host } = await renderController({
        enabled: false,
        startupDiagnostics: ["startup warning must be suppressed"]
      });
      // reducer 先应用 bootstrap 设置，再决定是否接收后续启动诊断。
      await act(async () => {
        await flushEffects();
      });
      assert.equal(
        holder.controller?.state.status,
        "ready",
        "bootstrap must still reach ready while diagnostics are suppressed"
      );
      assert.equal(holder.controller?.state.notifications.length, 0, "startup diagnostics must not leak when disabled");
      await act(async () => {
        root.unmount();
      });
      host.remove();
    });

    await assertTest("pushNotification surfaces notifications once the setting is enabled", async () => {
      const { holder, root, host } = await renderController({ enabled: true });
      assert.equal(
        holder.controller?.state.settings.model.notificationsEnabled,
        true,
        "enabled controller must carry the notification setting"
      );
      await act(async () => {
        holder.controller?.actions.showNotification("danger", "should appear");
        await flushEffects();
      });
      // waitFor 以最新 holder.controller.state 判断，覆盖提交时序。
      await waitFor(
        () => holder.controller?.state.notifications.some((item) => item.message.includes("should appear")) === true,
        "enabled notifications must reach state"
      );
      await act(async () => {
        root.unmount();
      });
      host.remove();
    });
  } finally {
    dom.window.close();
  }
})();
