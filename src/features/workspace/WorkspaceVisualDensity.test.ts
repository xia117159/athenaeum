import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function assertTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const css = fs.readFileSync(path.join(process.cwd(), "src/features/workspace/workspace.css"), "utf8");
const workspaceViewSource = fs.readFileSync(path.join(process.cwd(), "src/features/workspace/WorkspaceView.tsx"), "utf8");
const panelChromeSource = fs.readFileSync(path.join(process.cwd(), "src/features/workspace/WorkspacePanelChrome.tsx"), "utf8");
const treeBranchSource = fs.readFileSync(path.join(process.cwd(), "src/features/workspace/WorkspaceTreeBranch.tsx"), "utf8");

function getCssBlock(selector: string) {
  const blocks = Array.from(css.matchAll(/([^{}]+)\{([^}]*)\}/gm));
  const matches = blocks.filter(([, selectorList]) =>
    selectorList
      .split(",")
      .map((item) => item.trim())
      .includes(selector)
  );
  assert.ok(matches.length > 0, `${selector} block should exist`);
  return matches.map((match) => match[2]).join("\n");
}

function assertDeclaration(block: string, property: string, value: string) {
  assert.match(block, new RegExp(`${property}\\s*:\\s*${value}\\s*;`));
}

function assertNoDeclaration(block: string, property: string) {
  assert.doesNotMatch(block, new RegExp(`${property}\\s*:`));
}

assertTest("workspace chrome uses a flat high-density split-pane layout", () => {
  assertDeclaration(getCssBlock(".workspace-main"), "padding", "0");
  assertDeclaration(getCssBlock(".tree-pane"), "border-radius", "0");
  assertDeclaration(getCssBlock(".panel-surface"), "border-radius", "0");
  assertDeclaration(getCssBlock(".file-listing"), "border-radius", "0");
  assertDeclaration(getCssBlock(".split-pane__handle"), "flex", "0 0 var\\(--split-handle-size, 4px\\)");
});

assertTest("workspace tabs and breadcrumbs match the compact Windows target chrome", () => {
  assertDeclaration(getCssBlock(".panel-chrome"), "gap", "0");
  assertDeclaration(getCssBlock(".tab-strip__tab"), "height", "24px");
  assertDeclaration(getCssBlock(".tab-strip__tab.is-active"), "background", "#ffffff");
  assertDeclaration(getCssBlock(".tab-strip__tab.is-active"), "box-shadow", "inset 0 -2px 0 var\\(--accent\\)");
  assertDeclaration(getCssBlock(".tab-strip__title"), "flex", "1 1 auto");
  assertDeclaration(getCssBlock(".tab-strip__close"), "margin-left", "auto");
  assertDeclaration(getCssBlock(".panel-breadcrumbs"), "min-height", "24px");
  assertDeclaration(getCssBlock(".panel-breadcrumbs"), "background", "#f8f9fb");
  assertDeclaration(getCssBlock(".panel-breadcrumbs"), "color", "var\\(--text\\)");
  assertDeclaration(getCssBlock(".panel-breadcrumbs"), "font-family", "\"Microsoft YaHei UI\", \"Segoe UI Variable Text\", \"Segoe UI\", sans-serif");
  assertDeclaration(getCssBlock(".panel-breadcrumbs__segment"), "height", "24px");
  assertDeclaration(getCssBlock(".panel-breadcrumbs__segment"), "line-height", "24px");
  assertDeclaration(getCssBlock(".panel-breadcrumbs__segment"), "font-family", "inherit");
  assertDeclaration(getCssBlock(".panel-breadcrumbs__segment"), "border-radius", "0");
  assertDeclaration(getCssBlock(".panel-breadcrumbs__segment"), "color", "var\\(--text\\)");
  assertDeclaration(getCssBlock(".panel-breadcrumbs__segment:hover"), "background", "#eef4fb");
  assertDeclaration(getCssBlock(".panel-breadcrumbs__segment[aria-current=\"page\"]"), "color", "var\\(--text\\)");
  assertDeclaration(getCssBlock(".panel-breadcrumbs__segment--future"), "color", "#9ca3af");
  assertDeclaration(getCssBlock(".tab-strip__tab"), "min-width", "var\\(--tab-min-width, 96px\\)");
  assertNoDeclaration(getCssBlock(".tab-strip__tab"), "max-width");
});

assertTest("workspace view no longer renders a bottom status bar", () => {
  assert.equal(workspaceViewSource.includes("workspace-statusbar"), false);
});

assertTest("workspace top chrome separates command and address rows without the legacy brand label", () => {
  assert.equal(workspaceViewSource.includes("workspace-menubar__brand"), false);
  assert.equal(css.includes(".workspace-menubar__brand"), false);
  assert.equal(workspaceViewSource.includes("workspace-commandbar"), true);
  assert.equal(workspaceViewSource.includes("workspace-addressbar"), true);
  assertDeclaration(getCssBlock(".workspace-menubar"), "grid-template-columns", "minmax\\(0, 1fr\\) auto");
  assertDeclaration(getCssBlock(".workspace-commandbar"), "grid-template-columns", "minmax\\(0, 1fr\\) auto");
  assertDeclaration(getCssBlock(".workspace-addressbar"), "grid-template-columns", "minmax\\(0, 1fr\\)");
  assertDeclaration(getCssBlock(".workspace-toolbar__actions"), "justify-content", "flex-start");
  assertDeclaration(getCssBlock(".workspace-toolbar__history"), "justify-content", "flex-end");
  assertDeclaration(getCssBlock(".address-bar"), "width", "100%");
  assert.equal(css.includes(".workspace-error"), false);
});

assertTest("workspace view does not render inline notification labels below the address bar", () => {
  assert.equal(workspaceViewSource.includes("NotificationTray"), false);
  assert.equal(workspaceViewSource.includes("notification-tray"), false);
  assert.equal(workspaceViewSource.includes("notification-pill"), false);
  assert.equal(css.includes(".notification-tray"), false);
  assert.equal(css.includes(".notification-pill"), false);
});

assertTest("directory tree and details list use desktop file-manager density", () => {
  assertDeclaration(getCssBlock(".tree-pane__header"), "display", "none");
  assertDeclaration(getCssBlock(".tree-node__label"), "min-height", "22px");
  assertDeclaration(getCssBlock(".tree-node__toggle"), "width", "14px");
  assertDeclaration(getCssBlock(".tree-node__icon"), "--file-icon-size", "16px");
  assertDeclaration(getCssBlock(".file-listing"), "--details-row-height", "24px");
  assertDeclaration(getCssBlock(".panel-listing"), "display", "grid");
  assertDeclaration(getCssBlock(".panel-listing"), "grid-template-rows", "minmax\\(0, 1fr\\)");
  assertDeclaration(getCssBlock(".panel-listing"), "height", "100%");
  assertDeclaration(getCssBlock(".file-listing__scroll"), "height", "100%");
  assertDeclaration(getCssBlock(".file-listing__header"), "min-height", "24px");
  assertDeclaration(getCssBlock(".file-listing__body"), "box-sizing", "border-box");
  assertDeclaration(getCssBlock(".file-listing__body--details"), "gap", "0");
  assertDeclaration(getCssBlock(".file-listing__body--details"), "padding", "0");
  assertDeclaration(getCssBlock(".file-row"), "user-select", "none");
  assertDeclaration(getCssBlock(".file-card"), "user-select", "none");
  assertDeclaration(getCssBlock(".file-list-item"), "user-select", "none");
  assertDeclaration(getCssBlock(".file-content-item"), "user-select", "none");
  assertDeclaration(getCssBlock(".inline-edit-input"), "user-select", "text");
  assertDeclaration(getCssBlock(".file-row__grid"), "border-radius", "0");
});

assertTest("tab chrome does not render legacy text glyph controls", () => {
  assert.equal(workspaceViewSource.includes("tab-strip--legacy"), false);
  assert.doesNotMatch(panelChromeSource, />\s*[+×xX−-]\s*</u);
  assert.match(panelChromeSource, /lucide-react/u);
  assert.equal(panelChromeSource.includes("&gt;"), false);
  assert.equal(css.includes(".tab-strip__close-icon::before"), false);
  assert.equal(css.includes(".tab-strip__close-icon::after"), false);
  assert.equal(css.includes(".tab-strip__add-icon::before"), false);
  assert.equal(css.includes(".tab-strip__add-icon::after"), false);
  assert.equal(treeBranchSource.includes('isExpanded ? "-" : "+"'), false);
  assert.match(treeBranchSource, /lucide-react/u);
  assert.equal(css.includes(".tree-node__toggle-icon::before"), false);
  assert.equal(css.includes(".tree-node__toggle-icon::after"), false);
});
