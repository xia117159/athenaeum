import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { installDomEnvironment } from "./workspaceControllerTestHarness";

test("hover keeps every file surface and rule color unchanged, including selected/editing items", () => {
  installDomEnvironment();
  const style = document.createElement("style");
  // jsdom cannot drive :hover. Use a class to exercise the real stylesheet's cascade.
  style.textContent = ["workspace.listing.css", "workspace.information.css"].map(name =>
    fs.readFileSync(path.join(process.cwd(), "src/features/workspace", name), "utf8").replaceAll(":hover", ".test-hover")).join("\n");
  document.head.append(style);
  try {
    for (const kind of ["file-row", "file-card", "file-list-item", "file-content-item", "search-results-tab__result"]) {
      for (const state of ["", "has-color-filter has-color-filter--foreground", "is-selected", "has-color-filter is-selected", "is-inline-editing"]) {
        const item = document.createElement("div"); item.className = `${kind} ${state}`;
        item.style.setProperty("--entry-rule-foreground", "#123456");
        item.innerHTML = kind === "file-row" ? '<div class="file-row__grid"><span>Test.txt</span></div>' : '<span>Test.txt</span>';
        document.body.append(item);
        const surface = kind === "file-row" ? item.firstElementChild! : item;
        const before = window.getComputedStyle(surface), background = before.backgroundColor, foreground = before.color;
        item.classList.add("test-hover");
        const after = window.getComputedStyle(surface);
        assert.equal(after.backgroundColor, background, `${kind} ${state}: hover must not replace the background`);
        assert.equal(after.color, foreground, `${kind} ${state}: hover preserves the foreground`);
        assert.match(after.boxShadow, /file-hover-border/, `${kind} ${state}: hover uses the configurable inset border`);
        item.remove();
      }
    }
  } finally { style.remove(); }
});
