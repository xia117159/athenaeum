import assert from "node:assert/strict";
import React, { act } from "react";
import { SettingsSurface } from "./SettingsSurface";
import { settingsSurfaceProps } from "./settingsSurfaceTestSupport";
import { installDomEnvironment } from "./workspaceControllerTestHarness";

export const completion = (async () => {
  const dom = installDomEnvironment();
  Object.defineProperty(globalThis, "self", { configurable: true, value: dom.window });
  const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const original = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("settings-page")) return new dom.window.DOMRect(204, 58, 576, 445);
    if (this.classList.contains("theme-color-control")) return new dom.window.DOMRect(436, 398, 200, 30);
    if (this.classList.contains("theme-color-control__panel")) return new dom.window.DOMRect(406, 432, 230, 260);
    return original.call(this);
  };
  try {
    await act(async () => root.render(<SettingsSurface {...settingsSurfaceProps("appearance")} />));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-setting-id="panel-focus-accent"]')!.click());
    const panel = document.querySelector<HTMLElement>(".theme-color-control__panel")!;
    assert.ok(panel);
    const top = 398 + Number.parseFloat(panel.style.top);
    assert.ok(top >= 58 && top + 260 <= 503, "the complete color editor stays inside the scroll viewport");
    assert.ok(document.querySelector('[data-setting-id="panel-focus-accent-opacity"]'), "opacity remains accessible");
    console.log("ok - color editors are positioned within the compact settings viewport");
  } finally { await act(async () => root.unmount()); dom.window.close(); }
})();
