import assert from "node:assert/strict";
import React, { act } from "react";
import { SettingsSurface } from "./SettingsSurface";
import { settingsSurfaceProps } from "./settingsSurfaceTestSupport";
import { installDomEnvironment } from "./workspaceControllerTestHarness";

export const completion = (async () => {
  const dom = installDomEnvironment();
  const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  let now = 0, sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  dom.window.setTimeout = ((callback: () => void, delay = 0) => {
    const id = ++sequence; timers.set(id, { at: now + delay, callback }); return id;
  }) as typeof window.setTimeout;
  dom.window.clearTimeout = id => { if (typeof id === "number") timers.delete(id); };
  const advance = async (ms: number) => act(async () => {
    now += ms;
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); }
  });
  const tip = () => document.querySelector<HTMLElement>('[role="tooltip"]');
  const mouse = async (element: Element, type: string, relatedTarget: EventTarget | null = null) => act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX: 990, clientY: 750, relatedTarget }));
  });
  try {
    const props = settingsSurfaceProps("file-list");
    props.state.settings.model.tooltipHoverDelayMs = 0;
    await act(async () => root.render(<SettingsSurface {...props} />));
    const checkbox = document.querySelector<HTMLInputElement>('[data-setting-id="tree-auto-follow-enabled"]')!;
    const row = checkbox.closest(".settings-row")!;
    await mouse(row, "mouseover");
    await advance(499); assert.equal(tip(), null);
    await advance(1); assert.ok(tip(), "settings descriptions appear exactly after 500ms even if list delay is zero");
    assert.match(tip()!.textContent!, /跟随当前标签页/);
    assert.equal(row.textContent?.includes("跟随当前标签页"), false, "description is absent from the visible setting row");
    assert.ok(Number.parseFloat(tip()!.style.left) >= 8);
    await mouse(row, "mouseout", document.body); assert.equal(tip(), null);
    await mouse(row, "mouseover"); await advance(200);
    await mouse(row, "mouseout", document.body); await advance(500); assert.equal(tip(), null);
    await act(async () => checkbox.focus()); await advance(500); assert.ok(tip(), "keyboard focus exposes the same help");
    await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(tip(), null);
    await mouse(row, "mouseover"); await advance(500); assert.ok(tip());
    await act(async () => row.dispatchEvent(new dom.window.Event("scroll", { bubbles: false }))); assert.equal(tip(), null);
    await mouse(row, "mouseover"); await advance(500);
    await act(async () => checkbox.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true })));
    assert.equal(tip(), null);
    await mouse(row, "mouseover"); await advance(500);
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("blur"))); assert.equal(tip(), null);
    await mouse(row, "mouseover"); await advance(250);
    await act(async () => root.render(<SettingsSurface {...settingsSurfaceProps("appearance")} />));
    await advance(500); assert.equal(tip(), null, "switching pages cancels pending help");
    const appearanceRow = document.querySelector(".settings-row")!;
    await mouse(appearanceRow, "mouseover"); await advance(500); assert.ok(tip());
    await act(async () => root.unmount()); await advance(500); assert.equal(tip(), null);
    console.log("ok - setting help delay, keyboard access, dismissal, portal and unmount lifecycle");
  } finally { dom.window.close(); }
})();
