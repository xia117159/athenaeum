import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMockWorkspaceBootstrap } from "./mockData";
import { SettingsSurface } from "./SettingsSurface";
import { installLegacyInputEventPatch, patchLegacyInputEventTarget } from "./testDom";
import { createWorkspaceState } from "./workspaceReducer";
import type { RemoteConnectionProfile, SettingsSection, WorkspaceState } from "./types";

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
  const dom = new JSDOM("<!doctype html><html><body><button id=\"before\">before</button><div id=\"root\"></div><button id=\"after\">after</button></body></html>", {
    url: "http://localhost"
  });

  globalThis.window = dom.window as typeof globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLInputElement = dom.window.HTMLInputElement;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  installLegacyInputEventPatch(dom);
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

function getLastCssRuleBody(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = Array.from(css.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "g")));
  return matches.length > 0 ? matches[matches.length - 1][1] : "";
}

function createSettingsState(section: SettingsSection = "shortcuts") {
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
    onUpdateContextMenuDefault: () => undefined,
    onSaveRemoteProfile: (_profile: RemoteConnectionProfile, _password?: string) => undefined,
    onDeleteRemoteProfile: () => undefined,
    onTestRemoteProfile: (_profile: RemoteConnectionProfile, _password?: string) => undefined,
    onConfirm: () => undefined,
    onCancel: () => undefined
  };
}

function key(dom: ReturnType<typeof installDomEnvironment>, type: "keydown" | "keyup", init: KeyboardEventInit) {
  return new dom.window.KeyboardEvent(type, {
    bubbles: false,
    cancelable: true,
    ...init
  });
}

function inputEvent(dom: ReturnType<typeof installDomEnvironment>, type: string) {
  return new dom.window.Event(type, {
    bubbles: true,
    cancelable: true
  });
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  const React = require("react") as typeof import("react");
  const { act } = React;
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }

  const root = ReactDOM.createRoot(container);

  try {
    await assertTest("SettingsSurface renders a grouped left navigation and property page", async () => {
      const selected: SettingsSection[] = [];
      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(createSettingsState("file-list")),
            onSelectSection: (section: SettingsSection) => selected.push(section)
          })
        );
        await flushEffects();
      });

      const surface = container.querySelector(".settings-window");
      const nav = container.querySelector(".settings-window__nav");
      const content = container.querySelector(".settings-window__content");
      const navItems = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-section-id]"));
      const activeNavItem = container.querySelector("[data-section-id='file-list'].is-active");

      assert.equal(container.querySelector(".settings-modal"), null);
      assert.ok(surface);
      assert.equal(surface?.getAttribute("aria-labelledby"), "settings-window-title");
      assert.ok(nav);
      assert.ok(content);
      assert.equal(nav?.contains(content), false);
      assert.equal(container.querySelectorAll(".settings-window__nav-group").length, 3);
      assert.deepEqual(
        navItems.map((item) => item.dataset.sectionId),
        ["shortcuts", "file-list", "menu-mouse", "appearance", "color-rules", "tag-rules", "connections"]
      );
      assert.ok(activeNavItem);

      await act(async () => {
        navItems.find((item) => item.dataset.sectionId === "connections")?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await flushEffects();
      });

      assert.deepEqual(selected, ["connections"]);
    });

    await assertTest("workspace settings styles keep the settings navigation on the left at the 920px default width", async () => {
      const css = fs.readFileSync(path.join(process.cwd(), "src/features/workspace/workspace.css"), "utf8");

      assert.equal(css.includes(".settings-modal"), false);
      assert.equal(css.includes(".settings-dialog"), false);
      assert.equal(css.includes(".settings-window"), true);
      assert.equal(css.includes(".settings-window__nav-group"), true);
      assert.equal(css.includes("container-name: settings-content"), true);
      assert.match(css, /@container\s+settings-content\s+\(max-width:\s*600px\)[\s\S]*?\.settings-page--connections\s+\.connections-editor[\s\S]*?grid-template-columns:\s*1fr;/);
      assert.equal(/@media\s*\(max-width:\s*960px\)[\s\S]*?settings-window__nav/.test(css), false);

      const navHeadingRule = getLastCssRuleBody(css, ".settings-window__nav-heading");
      const navItemRule = getLastCssRuleBody(css, ".settings-window__nav-item");
      const navItemTextRule = getLastCssRuleBody(css, ".settings-window__nav-item span");
      assert.match(css, /\.settings-window__nav\s*\{[^}]*--settings-nav-font-size:\s*\d+(?:\.\d+)?px;/);
      assert.match(navHeadingRule, /font-size:\s*var\(--settings-nav-font-size\);/);
      assert.match(navHeadingRule, /font-weight:\s*700;/);
      assert.match(navItemRule, /font-size:\s*var\(--settings-nav-font-size\);/);
      assert.match(navItemRule, /font-weight:\s*400;/);
      assert.match(navItemRule, /min-height:\s*0;/);
      assert.doesNotMatch(navItemTextRule, /font-weight:\s*(?:[6-9]00|bold|bolder)\b/);
    });

    await assertTest("ShortcutCaptureInput captures Ctrl+Alt+P once and ignores text input paths", async () => {
      const updates: string[] = [];
      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(createSettingsState("shortcuts")),
            onUpdateShortcut: (_id: string, binding: string) => updates.push(binding)
          })
        );
        await flushEffects();
      });

      const input = container.querySelector<HTMLInputElement>("input[data-shortcut-id='open-search']");
      assert.ok(input);
      patchLegacyInputEventTarget(input);
      assert.equal(input.readOnly, true);

      await act(async () => {
        input!.dispatchEvent(key(dom, "keydown", { key: "Control", ctrlKey: true }));
        input!.dispatchEvent(key(dom, "keydown", { key: "Alt", ctrlKey: true, altKey: true }));
        input!.dispatchEvent(key(dom, "keydown", { key: "p", ctrlKey: true, altKey: true }));
        assert.equal(input!.value, "Ctrl+Alt+P");
        input!.dispatchEvent(key(dom, "keyup", { key: "p", ctrlKey: true, altKey: true }));
        input!.dispatchEvent(new dom.window.FocusEvent("blur", { bubbles: true }));
        await flushEffects();
      });

      assert.deepEqual(updates, ["Ctrl+Alt+P"]);

      await act(async () => {
        input!.dispatchEvent(inputEvent(dom, "beforeinput"));
        input!.value = "typed";
        input!.dispatchEvent(inputEvent(dom, "input"));
        input!.dispatchEvent(inputEvent(dom, "change"));
        input!.dispatchEvent(inputEvent(dom, "paste"));
        input!.dispatchEvent(inputEvent(dom, "dragover"));
        input!.dispatchEvent(inputEvent(dom, "drop"));
        input!.dispatchEvent(inputEvent(dom, "compositionstart"));
        await flushEffects();
      });

      assert.deepEqual(updates, ["Ctrl+Alt+P"]);
    });

    await assertTest("ShortcutCaptureInput ignores capture events while disabled", async () => {
      const updates: string[] = [];
      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(createSettingsState("shortcuts")),
            disabled: true,
            onUpdateShortcut: (_id: string, binding: string) => updates.push(binding)
          })
        );
        await flushEffects();
      });

      const input = container.querySelector<HTMLInputElement>("input[data-shortcut-id='open-search']");
      assert.ok(input);
      patchLegacyInputEventTarget(input);
      assert.equal(input.disabled, true);

      await act(async () => {
        input!.dispatchEvent(new dom.window.FocusEvent("focus", { bubbles: true }));
        input!.dispatchEvent(key(dom, "keydown", { key: "Control", ctrlKey: true }));
        input!.dispatchEvent(key(dom, "keyup", { key: "Control" }));
        input!.dispatchEvent(inputEvent(dom, "paste"));
        input!.dispatchEvent(inputEvent(dom, "drop"));
        input!.dispatchEvent(inputEvent(dom, "compositionstart"));
        await flushEffects();
      });

      assert.deepEqual(updates, []);
    });

    await assertTest("ShortcutCaptureInput lets Tab move focus after a capture is cancelled or committed", async () => {
      const updates: string[] = [];
      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(createSettingsState("shortcuts")),
            onUpdateShortcut: (_id: string, binding: string) => updates.push(binding)
          })
        );
        await flushEffects();
      });

      const input = container.querySelector<HTMLInputElement>("input[data-shortcut-id='drag-move']");
      assert.ok(input);
      patchLegacyInputEventTarget(input);

      await act(async () => {
        input!.dispatchEvent(key(dom, "keyup", { key: "Tab" }));
        const escapeEvent = key(dom, "keydown", { key: "Escape" });
        input!.dispatchEvent(escapeEvent);
        const tabAfterCancel = key(dom, "keydown", { key: "Tab" });
        input!.dispatchEvent(tabAfterCancel);
        assert.equal(tabAfterCancel.defaultPrevented, false);

        input!.dispatchEvent(new dom.window.FocusEvent("blur", { bubbles: true }));
        input!.dispatchEvent(key(dom, "keydown", { key: "Control", ctrlKey: true }));
        input!.dispatchEvent(key(dom, "keyup", { key: "Control" }));
        const tabAfterCommit = key(dom, "keydown", { key: "Tab" });
        input!.dispatchEvent(tabAfterCommit);
        assert.equal(tabAfterCommit.defaultPrevented, false);
        await flushEffects();
      });

      assert.deepEqual(updates, ["Ctrl"]);
    });

    await assertTest("ShortcutCaptureInput cancels reserved system combinations on window blur", async () => {
      const updates: string[] = [];
      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(createSettingsState("shortcuts")),
            onUpdateShortcut: (_id: string, binding: string) => updates.push(binding)
          })
        );
        await flushEffects();
      });

      const input = container.querySelector<HTMLInputElement>("input[data-shortcut-id='refresh']");
      assert.ok(input);
      patchLegacyInputEventTarget(input);

      await act(async () => {
        input!.dispatchEvent(key(dom, "keydown", { key: "Alt", altKey: true }));
        input!.dispatchEvent(key(dom, "keydown", { key: "F4", altKey: true }));
        window.dispatchEvent(new dom.window.Event("blur"));
        await flushEffects();
      });

      assert.deepEqual(updates, []);
    });

    await assertTest("ShortcutCaptureInput rejects reserved system combinations on keyup, Enter, and blur", async () => {
      const updates: string[] = [];
      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(createSettingsState("shortcuts")),
            onUpdateShortcut: (_id: string, binding: string) => updates.push(binding)
          })
        );
        await flushEffects();
      });

      const input = container.querySelector<HTMLInputElement>("input[data-shortcut-id='refresh']");
      assert.ok(input);
      patchLegacyInputEventTarget(input);
      const originalValue = input.value;

      await act(async () => {
        input.dispatchEvent(key(dom, "keydown", { key: "Alt", altKey: true }));
        assert.equal(input.value, "Alt");
        input.dispatchEvent(key(dom, "keyup", { key: "Alt" }));
        await flushEffects();
      });
      assert.deepEqual(updates, []);
      assert.equal(input.value, originalValue);

      await act(async () => {
        input.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        input.dispatchEvent(key(dom, "keydown", { key: "Alt", altKey: true }));
        input.dispatchEvent(key(dom, "keydown", { key: "Tab", altKey: true }));
        input.dispatchEvent(key(dom, "keyup", { key: "Tab", altKey: true }));
        await flushEffects();
      });
      assert.deepEqual(updates, []);
      assert.equal(input.value, originalValue);

      await act(async () => {
        input.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        input.dispatchEvent(key(dom, "keydown", { key: "Alt", altKey: true }));
        input.dispatchEvent(key(dom, "keydown", { key: "F4", altKey: true }));
        input.dispatchEvent(key(dom, "keydown", { key: "Enter", altKey: true }));
        await flushEffects();
      });
      assert.deepEqual(updates, []);
      assert.equal(input.value, originalValue);

      await act(async () => {
        input.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        input.dispatchEvent(key(dom, "keydown", { key: "Control", ctrlKey: true }));
        input.dispatchEvent(key(dom, "keydown", { key: "Alt", ctrlKey: true, altKey: true }));
        input.dispatchEvent(key(dom, "keydown", { key: "Delete", ctrlKey: true, altKey: true }));
        input.dispatchEvent(new dom.window.FocusEvent("blur", { bubbles: true }));
        await flushEffects();
      });
      assert.deepEqual(updates, []);
      assert.equal(input.value, originalValue);
    });

    await assertTest("SettingsSurface exposes appearance, menu, file-list, color, and tag pages without per-shortcut cards", async () => {
      const accentUpdates: string[] = [];
      const rowHeightUpdates: number[] = [];
      const menuUpdates: string[] = [];
      const colorUpdates: string[] = [];

      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(createSettingsState("appearance")),
            onUpdatePanelFocusAccent: (color: string) => accentUpdates.push(color),
            onUpdateDetailsRowHeight: (value: number) => rowHeightUpdates.push(value),
            onUpdateContextMenuDefault: (value: "native" | "custom") => menuUpdates.push(value),
            onUpdateColorRule: (_id: string, color: string) => colorUpdates.push(color)
          })
        );
        await flushEffects();
      });

      const accentInput = container.querySelector<HTMLInputElement>("[data-setting-id='panel-focus-accent']");
      assert.ok(accentInput);
      await act(async () => {
        accentInput!.value = "#c02f7a";
        accentInput!.dispatchEvent(new Event("input", { bubbles: true }));
        await flushEffects();
      });
      assert.deepEqual(accentUpdates, ["#c02f7a"]);

      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(createSettingsState("file-list")),
            onUpdateDetailsRowHeight: (value: number) => rowHeightUpdates.push(value)
          })
        );
        await flushEffects();
      });
      const rowHeightInput = container.querySelector<HTMLInputElement>("[data-setting-id='details-row-height']");
      assert.ok(rowHeightInput);
      rowHeightInput!.value = "32";
      rowHeightInput!.dispatchEvent(new Event("input", { bubbles: true }));
      assert.deepEqual(rowHeightUpdates, [32]);
      assert.ok(container.querySelector(".column-toggle--readonly"));

      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(createSettingsState("menu-mouse")),
            onUpdateContextMenuDefault: (value: "native" | "custom") => menuUpdates.push(value)
          })
        );
        await flushEffects();
      });
      container.querySelector<HTMLButtonElement>("[data-context-menu-value='custom']")?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      assert.deepEqual(menuUpdates, ["custom"]);

      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(createSettingsState("color-rules")),
            onUpdateColorRule: (_id: string, color: string) => colorUpdates.push(color)
          })
        );
        await flushEffects();
      });
      const colorInput = container.querySelector<HTMLInputElement>("[data-color-rule-id]");
      assert.ok(colorInput);
      colorInput!.value = "#336699";
      colorInput!.dispatchEvent(new Event("input", { bubbles: true }));
      assert.deepEqual(colorUpdates, ["#336699"]);

      await act(async () => {
        root.render(React.createElement(SettingsSurface, createProps(createSettingsState("tag-rules"))));
        await flushEffects();
      });
      assert.ok(container.querySelector(".settings-readonly-value"));
      assert.equal(container.querySelector(".settings-card input[data-shortcut-id]"), null);
    });

    await assertTest("SettingsSurface shows shortcut conflicts and blocks confirmation before save", async () => {
      const events: string[] = [];
      const state = createSettingsState("shortcuts");
      const conflictState: WorkspaceState = {
        ...state,
        settings: {
          ...state.settings,
          model: {
            ...state.settings.model,
            shortcuts: state.settings.model.shortcuts.map((shortcut) =>
              shortcut.id === "drag-move" || shortcut.id === "context-menu-toggle"
                ? { ...shortcut, scope: "listing", binding: shortcut.id === "drag-move" ? " Shift " : "shift" }
                : shortcut
            )
          }
        }
      };

      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(conflictState),
            onConfirm: () => events.push("confirm")
          })
        );
        await flushEffects();
      });

      assert.ok(container.querySelector(".shortcut-status--conflict"));
      const confirmButton = container.querySelector<HTMLButtonElement>("[data-action='confirm-settings']");
      assert.equal(confirmButton?.disabled, true);
      assert.match(container.textContent ?? "", /冲突/u);
      confirmButton?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      assert.deepEqual(events, []);
    });

    await assertTest("SettingsSurface blocks confirm when the remote profile form has unstaged edits", async () => {
      const events: string[] = [];
      const state = createSettingsState("connections");
      const profile: RemoteConnectionProfile = {
        id: "remote-1",
        name: "Deploy",
        protocol: "sftp",
        host: "edge.internal",
        port: 22,
        username: "deploy",
        rootPath: "/srv",
        authKind: "password",
        passiveMode: true,
        ignoreHostKey: false,
        connectTimeoutSecs: 10,
        commandTimeoutSecs: 20
      };
      const remoteState = {
        ...state,
        remoteProfiles: [profile]
      };

      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(remoteState),
            onConfirm: () => events.push("confirm")
          })
        );
        await flushEffects();
      });

      const nameInput = container.querySelector<HTMLInputElement>("[data-setting-id='remote-name']");
      assert.ok(nameInput);
      await act(async () => {
        nameInput!.value = "Deploy updated";
        nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
        container.querySelector<HTMLButtonElement>("[data-action='confirm-settings']")?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await flushEffects();
      });

      assert.deepEqual(events, []);
      assert.match(container.textContent ?? "", /暂存/u);
    });
  } finally {
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.window.close();
  }
})();
