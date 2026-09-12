import assert from "node:assert/strict";
import { createMockWorkspaceBootstrap } from "./mockData";
import { SettingsSurface } from "./SettingsSurface";
import { installLegacyInputEventPatch, patchLegacyInputEventTarget } from "./testDom";
import { createWorkspaceState } from "./workspaceReducer";
import { readWorkspaceCss } from "./workspaceCssTestUtils";
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
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: dom.window
  });
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
    dirtySections: new Set<SettingsSection>(),
    onSelectSection: () => undefined,
    onUpdateShortcut: () => undefined,
    onUpdateColorRules: () => undefined,
    onUpdateFileAssociations: () => undefined,
    onChooseAssociationProgram: async () => null,
    onInspectAssociationPrograms: async () => [],
    onValidateColorRule: async () => ({ valid: true, message: null, span: null }),
    onOpenColorRulesHelp: () => undefined,
    onUpdatePanelFocusAccent: () => undefined,
    onUpdateActiveTabBackground: () => undefined,
    onUpdateDropHighlightFill: () => undefined,
    onUpdateDropHighlightBorder: () => undefined,
    onUpdateTabMinWidth: () => undefined,
    onUpdateDetailsRowHeight: () => undefined,
    onUpdateFolderExpansionEnabled: () => undefined,
    onUpdateTooltipHoverDelay: () => undefined,
    onUpdateMetadataRetentionHours: () => undefined,
    onUpdateContextMenuDefault: () => undefined,
    onSaveRemoteProfile: (_profile: RemoteConnectionProfile, _password?: string) => undefined,
    onDeleteRemoteProfile: () => undefined,
    onTestRemoteProfile: async (_profile: RemoteConnectionProfile, _password?: string) => ({
      success: true,
      message: "ok",
      adapter: "sftp" as const,
      details: []
    }),
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
        ["shortcuts", "file-list", "menu-mouse", "file-associations", "appearance", "color-rules", "tag-rules", "connections"]
      );
      assert.ok(activeNavItem);

      await act(async () => {
        navItems.find((item) => item.dataset.sectionId === "connections")?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await flushEffects();
      });

      assert.deepEqual(selected, ["connections"]);
    });

    await assertTest("workspace settings styles keep the settings navigation on the left at the 920px default width", async () => {
      const css = readWorkspaceCss();

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
      const activeTabBackgroundUpdates: string[] = [];
      const dropFillUpdates: string[] = [];
      const dropBorderUpdates: string[] = [];
      const rowHeightUpdates: number[] = [];
      const tooltipDelayUpdates: number[] = [];
      const retentionUpdates: Array<number | null> = [];
      const menuUpdates: string[] = [];
      const colorUpdates: string[] = [];

      await act(async () => {
        const appearanceState = createSettingsState("appearance");
        appearanceState.settings.model.theme = {
          ...appearanceState.settings.model.theme,
          panelFocusAccent: "#c02f7a80",
          activeTabBackground: "#ffffffcc",
          dropHighlightFill: "#abcdef80",
          dropHighlightBorder: "#33669940"
        };
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(appearanceState),
            onUpdatePanelFocusAccent: (color: string) => accentUpdates.push(color),
            onUpdateActiveTabBackground: (color: string) => activeTabBackgroundUpdates.push(color),
            onUpdateDropHighlightFill: (color: string) => dropFillUpdates.push(color),
            onUpdateDropHighlightBorder: (color: string) => dropBorderUpdates.push(color),
            onUpdateDetailsRowHeight: (value: number) => rowHeightUpdates.push(value),
            onUpdateTooltipHoverDelay: (value: number) => tooltipDelayUpdates.push(value),
            onUpdateMetadataRetentionHours: (value: number | null) => retentionUpdates.push(value),
            onUpdateContextMenuDefault: (value: "native" | "custom") => menuUpdates.push(value),
            onUpdateColorRules: (rules) => colorUpdates.push(rules[0]?.foregroundColorHex ?? "")
          })
        );
        await flushEffects();
      });

      assert.equal(container.querySelectorAll(".theme-color-control .react-colorful").length, 0);
      assert.equal(container.querySelectorAll<HTMLButtonElement>(".theme-color-control__trigger").length, 6);

      const accentTrigger = container.querySelector<HTMLButtonElement>("[data-setting-id='panel-focus-accent']");
      assert.ok(accentTrigger);
      assert.equal(accentTrigger.getAttribute("aria-expanded"), "false");
      await act(async () => {
        accentTrigger!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await flushEffects();
      });
      assert.equal(accentTrigger.getAttribute("aria-expanded"), "true");
      assert.equal(container.querySelectorAll(".theme-color-control .react-colorful").length, 1);

      const accentInput = container.querySelector<HTMLInputElement>("[data-setting-id='panel-focus-accent-hex']");
      const accentOpacityInput = container.querySelector<HTMLInputElement>("[data-setting-id='panel-focus-accent-opacity']");
      assert.ok(accentInput);
      assert.ok(accentOpacityInput);
      assert.equal(accentInput.value, "#c02f7a80");
      assert.equal(accentOpacityInput.value, "50");
      await act(async () => {
        accentInput!.value = "#112233";
        accentInput!.dispatchEvent(new Event("input", { bubbles: true }));
        accentOpacityInput!.value = "25";
        accentOpacityInput!.dispatchEvent(new Event("input", { bubbles: true }));
        await flushEffects();
      });
      assert.deepEqual(accentUpdates, ["#11223380", "#c02f7a40"]);

      const activeTabBackgroundTrigger = container.querySelector<HTMLButtonElement>("[data-setting-id='active-tab-background']");
      assert.ok(activeTabBackgroundTrigger);
      await act(async () => {
        activeTabBackgroundTrigger!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await flushEffects();
      });
      const activeTabBackgroundInput = container.querySelector<HTMLInputElement>("[data-setting-id='active-tab-background-hex']");
      const activeTabBackgroundOpacityInput = container.querySelector<HTMLInputElement>("[data-setting-id='active-tab-background-opacity']");
      assert.ok(activeTabBackgroundInput);
      assert.ok(activeTabBackgroundOpacityInput);
      assert.equal(activeTabBackgroundInput.value, "#ffffffcc");
      assert.equal(activeTabBackgroundOpacityInput.value, "80");
      await act(async () => {
        activeTabBackgroundInput!.value = "#ddeeff";
        activeTabBackgroundInput!.dispatchEvent(new Event("input", { bubbles: true }));
        activeTabBackgroundOpacityInput!.value = "40";
        activeTabBackgroundOpacityInput!.dispatchEvent(new Event("input", { bubbles: true }));
        await flushEffects();
      });
      assert.deepEqual(activeTabBackgroundUpdates, ["#ddeeffcc", "#ffffff66"]);

      const dropFillTrigger = container.querySelector<HTMLButtonElement>("[data-setting-id='drop-highlight-fill']");
      const dropBorderTrigger = container.querySelector<HTMLButtonElement>("[data-setting-id='drop-highlight-border']");
      assert.ok(dropFillTrigger);
      assert.ok(dropBorderTrigger);
      await act(async () => {
        dropFillTrigger!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await flushEffects();
      });
      const dropFillInput = container.querySelector<HTMLInputElement>("[data-setting-id='drop-highlight-fill-hex']");
      const dropFillOpacityInput = container.querySelector<HTMLInputElement>("[data-setting-id='drop-highlight-fill-opacity']");
      assert.ok(dropFillInput);
      assert.ok(dropFillOpacityInput);
      assert.equal(dropFillInput.value, "#abcdef80");
      assert.equal(dropFillOpacityInput.value, "50");
      await act(async () => {
        dropFillInput!.value = "#123456";
        dropFillInput!.dispatchEvent(new Event("input", { bubbles: true }));
        await flushEffects();
      });
      assert.deepEqual(dropFillUpdates, ["#12345680"]);

      await act(async () => {
        dropBorderTrigger!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await flushEffects();
      });
      const dropBorderInput = container.querySelector<HTMLInputElement>("[data-setting-id='drop-highlight-border-hex']");
      const dropBorderOpacityInput = container.querySelector<HTMLInputElement>("[data-setting-id='drop-highlight-border-opacity']");
      assert.ok(dropBorderInput);
      assert.ok(dropBorderOpacityInput);
      assert.equal(dropBorderInput.value, "#33669940");
      assert.equal(dropBorderOpacityInput.value, "25");
      await act(async () => {
        dropBorderOpacityInput!.value = "75";
        dropBorderOpacityInput!.dispatchEvent(new Event("input", { bubbles: true }));
        dropBorderInput!.value = "#654321";
        dropBorderInput!.dispatchEvent(new Event("input", { bubbles: true }));
        await flushEffects();
      });
      assert.deepEqual(dropBorderUpdates, ["#336699bf", "#65432140"]);

      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(createSettingsState("file-list")),
            onUpdateDetailsRowHeight: (value: number) => rowHeightUpdates.push(value),
            onUpdateTooltipHoverDelay: (value: number) => tooltipDelayUpdates.push(value),
            onUpdateMetadataRetentionHours: (value: number | null) => retentionUpdates.push(value)
          })
        );
        await flushEffects();
      });
      const rowHeightInput = container.querySelector<HTMLInputElement>("[data-setting-id='details-row-height']");
      assert.ok(rowHeightInput);
      assert.equal(rowHeightInput.min, "12");
      assert.equal(rowHeightInput.max, "72");
      rowHeightInput!.value = "32";
      rowHeightInput!.dispatchEvent(new Event("input", { bubbles: true }));
      assert.deepEqual(rowHeightUpdates, [32]);
      assert.equal(container.querySelector(".column-toggle--readonly"), null);

      const tooltipDelayInput = container.querySelector<HTMLInputElement>("[data-setting-id='tooltip-hover-delay']");
      assert.ok(tooltipDelayInput);
      assert.equal(tooltipDelayInput.min, "0");
      assert.equal(tooltipDelayInput.max, "5000");
      tooltipDelayInput!.value = "0";
      tooltipDelayInput!.dispatchEvent(new Event("input", { bubbles: true }));
      assert.deepEqual(tooltipDelayUpdates, [0]);

      const retentionInput = container.querySelector<HTMLInputElement>("[data-setting-id='metadata-retention-hours']");
      const retentionNever = container.querySelector<HTMLInputElement>("[data-setting-id='metadata-retention-never']");
      assert.ok(retentionInput);
      assert.ok(retentionNever);
      assert.equal(retentionInput!.min, "0");
      retentionInput!.value = "48";
      retentionInput!.dispatchEvent(new Event("input", { bubbles: true }));
      retentionNever!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      assert.deepEqual(retentionUpdates, [48, null]);
      const settingsCss = readWorkspaceCss();
      assert.match(settingsCss, /\.settings-check-inline\s*\{[\s\S]*?white-space:\s*nowrap;/);
      assert.match(settingsCss, /\.settings-check-inline input\[type="checkbox"\]\s*\{[\s\S]*?width:\s*14px;/);
      assert.match(settingsCss, /\.settings-check-inline span\s*\{[\s\S]*?white-space:\s*nowrap;/);

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
            onUpdateColorRules: (rules) => colorUpdates.push(rules[0]?.foregroundColorHex ?? "")
          })
        );
        await flushEffects();
      });
      const colorRow = container.querySelector<HTMLLIElement>(".color-rules-list-row[data-rule-id]");
      assert.ok(colorRow);
      const colorInput = container.querySelector<HTMLInputElement>("[aria-label*='文字颜色十六进制值']");
      assert.ok(colorInput);
      // V2 颜色控件在未选中规则时禁用；先选中首条规则再编辑。
      assert.equal(colorInput.disabled, true);
      await act(async () => {
        colorRow!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await flushEffects();
      });
      const enabledColorInput = container.querySelector<HTMLInputElement>("[aria-label*='文字颜色十六进制值']");
      assert.ok(enabledColorInput);
      assert.equal(enabledColorInput.disabled, false);
      await act(async () => {
        patchLegacyInputEventTarget(enabledColorInput);
        enabledColorInput!.value = "#336699";
        enabledColorInput!.dispatchEvent(new Event("input", { bubbles: true }));
        await flushEffects();
      });
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

    await assertTest("SettingsSurface conflict reload resets invalid color drafts and re-enables apply", async () => {
      const events: string[] = [];
      const state = createSettingsState("color-rules");
      const baseProps = createProps(state);

      function Harness() {
        const [conflict, setConflict] = React.useState(true);
        const [resetToken, setResetToken] = React.useState(0);
        const [valid, setValid] = React.useState(true);
        return React.createElement(SettingsSurface, {
          ...baseProps,
          colorRulesConflict: conflict,
          colorRulesResetToken: resetToken,
          colorRulesValid: valid,
          onColorRulesValidityChange: setValid,
          onReloadColorRules: () => {
            events.push("reload");
            setConflict(false);
            setResetToken((current) => current + 1);
          },
          onConfirm: () => events.push("confirm")
        });
      }

      await act(async () => {
        root.render(React.createElement(Harness));
        await flushEffects();
      });
      const colorRow = container.querySelector<HTMLLIElement>(".color-rules-list-row[data-rule-id]")!;
      await act(async () => {
        colorRow.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await flushEffects();
      });
      const colorInput = container.querySelector<HTMLInputElement>("[aria-label*='文字颜色十六进制值']")!;
      assert.equal(colorInput.disabled, false);
      const inputSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        patchLegacyInputEventTarget(colorInput);
        inputSetter.call(colorInput, "#bad");
        colorInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 350));
      });
      const confirmButton = container.querySelector<HTMLButtonElement>("[data-action='confirm-settings']")!;
      assert.equal(confirmButton.disabled, true);

      const reloadButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent === "重新加载")!;
      await act(async () => {
        reloadButton.click();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 350));
      });
      assert.deepEqual(events, ["reload"]);
      assert.equal(colorInput.value, state.settings.model.colorRules[0].foregroundColorHex);
      assert.equal(colorInput.getAttribute("aria-invalid"), "false");
      assert.equal(confirmButton.disabled, false);
      await act(async () => {
        confirmButton.click();
      });
      assert.deepEqual(events, ["reload", "confirm"]);
    });

    await assertTest("SettingsSurface auto-commits remote profile edits without blocking confirm", async () => {
      const events: string[] = [];
      const saved: Array<{ profile: RemoteConnectionProfile; password?: string }> = [];
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
            onSaveRemoteProfile: (nextProfile: RemoteConnectionProfile, password?: string) => saved.push({ profile: nextProfile, password }),
            onConfirm: () => events.push("confirm")
          })
        );
        await flushEffects();
      });

      // Toggle a checkbox — immediateCommit triggers autoCommitToParent synchronously
      const passiveCheckbox = container.querySelector<HTMLInputElement>("#remote-passive");
      assert.ok(passiveCheckbox);
      assert.equal(passiveCheckbox!.checked, true);
      await act(async () => {
        passiveCheckbox!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await flushEffects();
      });

      assert.equal(saved.length, 1);
      assert.equal(saved[0].profile.passiveMode, false);

      // Confirm should NOT be blocked
      const confirmButton = container.querySelector<HTMLButtonElement>("[data-action='confirm-settings']");
      assert.equal(confirmButton?.disabled, false);
    });
    await assertTest("ConnectionsEditor masks saved passwords, toggles visibility, and commits edited passwords", async () => {
      const saved: Array<{ profile: RemoteConnectionProfile; password?: string }> = [];
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
        commandTimeoutSecs: 20,
        password: "existing-password"
      };
      const remoteState = {
        ...createSettingsState("connections"),
        remoteProfiles: [profile]
      };

      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(remoteState),
            onSaveRemoteProfile: (nextProfile: RemoteConnectionProfile, password?: string) => saved.push({ profile: nextProfile, password })
          })
        );
        await flushEffects();
      });

      const passwordInput = container.querySelector<HTMLInputElement>("#remote-password");
      const toggleButton = container.querySelector<HTMLButtonElement>("[data-action='toggle-remote-password']");
      assert.ok(passwordInput);
      assert.ok(toggleButton);
      assert.equal(passwordInput!.type, "password");
      assert.equal(passwordInput!.value, "existing-password");

      await act(async () => {
        toggleButton!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
        await flushEffects();
      });
      assert.equal(passwordInput!.type, "text");
      assert.equal(passwordInput!.value, "existing-password");

      await act(async () => {
        passwordInput!.value = "new-secret";
        passwordInput!.dispatchEvent(new Event("input", { bubbles: true }));
        await flushEffects();
      });
      assert.equal(passwordInput!.type, "text");

      // Toggle a checkbox to trigger immediateCommit which includes the edited password
      const passiveCheckbox = container.querySelector<HTMLInputElement>("#remote-passive");
      assert.ok(passiveCheckbox);
      await act(async () => {
        passiveCheckbox!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await flushEffects();
      });

      assert.equal(saved.length, 1);
      assert.equal(saved[0].password, "new-secret");
    });

    await assertTest("ConnectionsEditor tests connection from list item action button", async () => {
      let resolveProbe: ((value: { success: boolean; message: string; adapter: "sftp"; details: string[] }) => void) | undefined;
      const selected: SettingsSection[] = [];
      const tested: Array<{ profile: RemoteConnectionProfile; password?: string }> = [];
      const profile: RemoteConnectionProfile = {
        id: "remote-1",
        name: "Deploy",
        protocol: "sftp",
        host: "192.168.1.3",
        port: 6666,
        username: "deploy",
        rootPath: "/srv",
        authKind: "password",
        passiveMode: true,
        ignoreHostKey: false,
        connectTimeoutSecs: 10,
        commandTimeoutSecs: 20
      };
      const remoteState = {
        ...createSettingsState("connections"),
        remoteProfiles: [profile]
      };

      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(remoteState),
            onSelectSection: (section: SettingsSection) => selected.push(section),
            onTestRemoteProfile: (nextProfile: RemoteConnectionProfile, password?: string) => {
              tested.push({ profile: nextProfile, password });
              return new Promise<{ success: boolean; message: string; adapter: "sftp"; details: string[] }>((resolve) => {
                resolveProbe = resolve;
              });
            }
          })
        );
        await flushEffects();
      });

      const testButton = container.querySelector<HTMLButtonElement>(".connection-list-item__action[aria-label='测试连接']");
      assert.ok(testButton);
      await act(async () => {
        testButton!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
        await flushEffects();
      });

      assert.equal(testButton!.disabled, true);
      assert.equal(tested.length, 1);
      assert.deepEqual(selected, []);
      assert.ok(container.querySelector(".connection-list-item__spinner"));

      await act(async () => {
        resolveProbe?.({ success: true, message: "Connection probe succeeded", adapter: "sftp", details: [] });
        await flushEffects();
      });

      assert.equal(testButton!.disabled, false);
      assert.ok(container.querySelector(".connection-list-item.is-test-success"));
    });

    await assertTest("ConnectionsEditor retains password in input after auto-commit", async () => {
      const saved: Array<{ profile: RemoteConnectionProfile; password?: string }> = [];
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
        commandTimeoutSecs: 20,
        password: "my-secret-password"
      };
      const remoteState = {
        ...createSettingsState("connections"),
        remoteProfiles: [profile]
      };

      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(remoteState),
            onSaveRemoteProfile: (nextProfile: RemoteConnectionProfile, password?: string) => {
              saved.push({ profile: nextProfile, password });
              remoteState.remoteProfiles = [{ ...nextProfile, password: password || nextProfile.password }];
            }
          })
        );
        await flushEffects();
      });

      const passwordInput = container.querySelector<HTMLInputElement>("#remote-password");
      assert.ok(passwordInput);
      assert.equal(passwordInput!.value, "my-secret-password");

      // Toggle a checkbox to trigger auto-commit
      const passiveCheckbox = container.querySelector<HTMLInputElement>("#remote-passive");
      assert.ok(passiveCheckbox);
      await act(async () => {
        passiveCheckbox!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await flushEffects();
      });

      // Re-render with updated profiles to simulate state update
      await act(async () => {
        root.render(
          React.createElement(SettingsSurface, {
            ...createProps(remoteState),
            onSaveRemoteProfile: (nextProfile: RemoteConnectionProfile, password?: string) => {
              saved.push({ profile: nextProfile, password });
              remoteState.remoteProfiles = [{ ...nextProfile, password: password || nextProfile.password }];
            }
          })
        );
        await flushEffects();
      });

      // Password should still be visible after auto-commit
      assert.equal(passwordInput!.value, "my-secret-password");
      assert.equal(saved.length, 1);
    });

    // TODO: Add test for global password visibility preservation
    // The feature is implemented but the test needs to be fixed to properly verify state

    await assertTest("workspace settings styles support connection list actions and new-profile button", async () => {
      const css = readWorkspaceCss();

      assert.match(css, /\.connection-list-item__actions\s*\{/);
      assert.match(css, /\.connection-list-item__action\s*\{/);
      assert.match(css, /\.connection-list-item\.is-test-success\s*\{/);
      assert.match(css, /\.connection-list-item\.is-test-error\s*\{/);
      assert.match(css, /\.connection-list-add\s*\{/);
      assert.match(css, /\.connection-password-control\s*\{/);

      await act(async () => {
        root.render(React.createElement(SettingsSurface, createProps(createSettingsState("connections"))));
        await flushEffects();
      });

      assert.ok(container.querySelector(".connection-list-add"));
      assert.equal(container.querySelector(".settings-form-actions"), null);
      assert.equal(container.querySelector(".settings-inline-warning-slot"), null);
    });
  } finally {
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.window.close();
  }
})();
