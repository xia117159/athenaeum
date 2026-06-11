import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { createMockWorkspaceBootstrap } from "./mockData";
import { SettingsSurface } from "./SettingsSurface";
import { createWorkspaceState } from "./workspaceReducer";
import type { RemoteConnectionProfile, WorkspaceState } from "./types";

const { JSDOM } = require("jsdom") as {
  JSDOM: new (
    html?: string,
    options?: {
      url?: string;
    }
  ) => {
    window: Window & typeof globalThis;
  };
};

function assertTest(name: string, fn: () => Promise<void>) {
  return fn()
    .then(() => {
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      console.error(`not ok - ${name}`);
      throw error;
    });
}

function installDomEnvironment() {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost"
  });

  globalThis.window = dom.window as typeof globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  return dom;
}

async function flushEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createSettingsState(section: WorkspaceState["settings"]["section"] = "shortcuts") {
  const state = createWorkspaceState(createMockWorkspaceBootstrap("mock"));
  return {
    ...state,
    settings: {
      ...state.settings,
      section
    }
  };
}

function createProps(state: WorkspaceState) {
  return {
    state,
    onSelectSection: () => undefined,
    onUpdateShortcut: () => undefined,
    onUpdateColorRule: () => undefined,
    onUpdatePanelFocusAccent: () => undefined,
    onUpdateTabMinWidth: () => undefined,
    onUpdateDetailsRowHeight: () => undefined,
    onSaveRemoteProfile: (_profile: RemoteConnectionProfile, _password?: string) => undefined,
    onDeleteRemoteProfile: () => undefined,
    onTestRemoteProfile: (_profile: RemoteConnectionProfile, _password?: string) => undefined,
    onConfirm: () => undefined,
    onCancel: () => undefined
  };
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }

  const root = ReactDOM.createRoot(container);

  try {
    await assertTest("SettingsSurface renders as a standalone settings window", async () => {
      await act(async () => {
        root.render(React.createElement(SettingsSurface, createProps(createSettingsState("rules"))));
        await flushEffects();
      });

      const surface = container.querySelector(".settings-window");
      const nav = container.querySelector(".settings-window__nav");
      const content = container.querySelector(".settings-window__content");
      const activeNavItem = container.querySelector(".settings-window__nav-item.is-active");

      assert.equal(container.querySelector(".settings-modal"), null);
      assert.ok(surface);
      assert.equal(surface?.getAttribute("role"), null);
      assert.equal(surface?.getAttribute("aria-modal"), null);
      assert.equal(surface?.getAttribute("aria-labelledby"), "settings-window-title");
      assert.ok(nav);
      assert.ok(content);
      assert.equal(nav?.contains(content), false);
      assert.equal(activeNavItem?.textContent?.includes("规则与列"), true);
    });

    await assertTest("workspace settings styles describe a standalone window instead of a modal", async () => {
      const css = fs.readFileSync(path.join(process.cwd(), "src/features/workspace/workspace.css"), "utf8");

      assert.equal(css.includes(".settings-modal"), false);
      assert.equal(css.includes(".settings-dialog"), false);
      assert.equal(css.includes(".settings-window"), true);
      assert.equal(css.includes(".settings-window__nav"), true);
      assert.equal(css.includes(".settings-window-shell"), true);
    });

    await assertTest("SettingsSurface exposes theme settings for panel focus accent and tab minimum width", async () => {
      const accentUpdates: string[] = [];
      const tabMinWidthUpdates: number[] = [];
      const state = createSettingsState("theme");
      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(state),
            onUpdatePanelFocusAccent: (color: string) => accentUpdates.push(color),
            onUpdateTabMinWidth: (value: number) => tabMinWidthUpdates.push(value)
          })
        );
        await flushEffects();
      });

      const accentInput = container.querySelector<HTMLInputElement>('input[type="color"][aria-label="面板焦点强调色"]');
      const tabMinWidthInput = container.querySelector<HTMLInputElement>('input[type="number"][aria-label="Tab 选项卡最小宽度"]');
      const activeNavItem = container.querySelector(".settings-window__nav-item.is-active");
      assert.ok(accentInput);
      assert.ok(tabMinWidthInput);
      assert.equal(accentInput.value.toLowerCase(), state.settings.model.theme.panelFocusAccent);
      assert.equal(tabMinWidthInput.value, String(state.settings.model.theme.tabMinWidth));
      assert.equal(tabMinWidthInput.min, "1");
      assert.equal(tabMinWidthInput.hasAttribute("max"), false);
      assert.match(container.textContent ?? "", /Tab 选项卡最小宽度/u);
      assert.match(container.textContent ?? "", /最低 1px/u);
      assert.ok(activeNavItem);

      await act(async () => {
        accentInput.value = "#c02f7a";
        accentInput.dispatchEvent(new Event("input", { bubbles: true }));
        await flushEffects();
      });

      assert.deepEqual(accentUpdates, ["#c02f7a"]);

      await act(async () => {
        tabMinWidthInput.value = "132";
        tabMinWidthInput.dispatchEvent(new Event("input", { bubbles: true }));
        await flushEffects();
      });

      assert.deepEqual(tabMinWidthUpdates, [132]);
    });

    await assertTest("SettingsSurface renders confirm and cancel actions", async () => {
      const events: string[] = [];
      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(createSettingsState("theme")),
            onConfirm: () => events.push("confirm"),
            onCancel: () => events.push("cancel")
          })
        );
        await flushEffects();
      });

      const confirmButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "确定");
      const cancelButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "取消");

      assert.ok(confirmButton);
      assert.ok(cancelButton);

      await act(async () => {
        cancelButton!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        confirmButton!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await flushEffects();
      });

      assert.deepEqual(events, ["cancel", "confirm"]);
    });

    await assertTest("SettingsSurface disables confirmation and inputs until settings are ready", async () => {
      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(createSettingsState("theme")),
            disabled: true
          })
        );
        await flushEffects();
      });

      const confirmButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "确定");
      const cancelButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "取消");
      const tabMinWidthInput = container.querySelector<HTMLInputElement>('input[type="number"][aria-label="Tab 选项卡最小宽度"]');

      assert.equal(container.querySelector(".settings-window")?.getAttribute("aria-busy"), "true");
      assert.equal(confirmButton?.disabled, true);
      assert.equal(cancelButton?.disabled, false);
      assert.equal(tabMinWidthInput?.disabled, true);
    });

    await assertTest("SettingsSurface renders non-persisted tag and column settings as read-only text", async () => {
      await act(async () => {
        root.render(React.createElement(SettingsSurface, createProps(createSettingsState("rules"))));
        await flushEffects();
      });

      assert.equal(container.querySelector('input[type="text"][aria-label$="的过滤条件"]'), null);
      assert.equal(container.querySelector(".column-toggle input[type='checkbox']"), null);
      assert.ok(container.querySelector(".settings-readonly-value"));
      assert.ok(container.querySelector(".column-toggle--readonly"));
    });
  } finally {
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.window.close();
  }
})();
