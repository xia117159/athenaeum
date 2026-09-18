import assert from "node:assert/strict";
import React, { act } from "react";
import { SettingsSurface } from "./SettingsSurface";
import { settingsSurfaceProps } from "./settingsSurfaceTestSupport";
import { installDomEnvironment } from "./workspaceControllerTestHarness";
import type { SettingsSection } from "./types";
import { requestedSettingsSection } from "./settingsNavigation";

export const completion = (async () => {
  const dom = installDomEnvironment();
  const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const visits: string[] = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function () { visits.push(this.id); };
  try {
    const props = settingsSurfaceProps("general" as SettingsSection);
    await act(async () => root.render(<SettingsSurface {...props} dirtySections={new Set(["templates"])} />));
    assert.deepEqual([...document.querySelectorAll<HTMLElement>("[data-section-id]")].map(e => e.dataset.sectionId),
      ["general", "shortcuts", "file-associations", "appearance", "color-rules", "tag-rules", "connections"]);
    assert.equal(document.querySelector("[aria-current=page]")?.getAttribute("data-section-id"), "general");
    assert.ok(document.querySelector('[data-section-id="general"] .settings-window__nav-dirty'));
    assert.deepEqual([...document.querySelectorAll(".settings-group__header strong")].map(e => e.textContent),
      ["文件列表", "菜单与鼠标", "新建项目"]);
    for (const id of ["tree-auto-follow-enabled", "folder-expansion-enabled", "details-row-height", "size-bar-mode-folder-total",
      "size-bar-mode-folder-max", "tooltip-hover-delay", "metadata-retention-hours", "metadata-retention-never", "notifications-enabled"]) {
      assert.equal(document.querySelectorAll(`[data-setting-id="${id}"]`).length, 1, id);
    }
    assert.equal(document.querySelectorAll("#template-root").length, 1);
    assert.equal(document.querySelectorAll("[data-context-menu-value]").length, 2);
    assert.equal(document.querySelector(".settings-page__header p"), null);
    for (const section of ["file-list", "menu-mouse", "templates"] as const) {
      await act(async () => root.render(<SettingsSurface {...settingsSurfaceProps(section)} dirtySections={new Set([section])} />));
      assert.equal(document.querySelector("[aria-current=page]")?.getAttribute("data-section-id"), "general");
      assert.ok(document.querySelector('[data-section-id="general"] .settings-window__nav-dirty'));
      assert.equal(visits.at(-1), `settings-group-${section}`);
    }
    assert.equal(requestedSettingsSection("?section=general", "shortcuts"), "general");
    console.log("ok - general groups every existing control, aggregates dirty marks and preserves old navigation targets");
  } finally { await act(async () => root.unmount()); dom.window.close(); }
})();
