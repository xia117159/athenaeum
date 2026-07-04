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

function readWorkspaceMenuSource() {
  return fs.readFileSync(path.join(process.cwd(), "src/features/workspace/WorkspaceMenuBar.tsx"), "utf8");
}

function menuBlock(source: string, id: string, nextId: string) {
  const start = source.indexOf(`id: "${id}"`);
  const end = source.indexOf(`id: "${nextId}"`, start + 1);
  assert.notEqual(start, -1, `${id} menu was not found`);
  assert.notEqual(end, -1, `${nextId} menu was not found`);
  return source.slice(start, end);
}

assertTest("Edit menu exposes separated file-name and content search commands", () => {
  const source = readWorkspaceMenuSource();
  const edit = menuBlock(source, "edit", "view");

  assert.match(edit, /label:\s*"文件查找"/);
  assert.match(edit, /openSearchPanel\("name"\)/);
  assert.match(edit, /label:\s*"根据内容查找"/);
  assert.match(edit, /openSearchPanel\("content"\)/);
  assert.match(edit, /edit-file-search-separator/);
  assert.match(edit, /edit-content-search-separator/);
});

assertTest("View menu removes panel layout and search panel commands, then adds tree, refresh, and item visibility groups", () => {
  const source = readWorkspaceMenuSource();
  const view = menuBlock(source, "view", "go");

  assert.equal(view.includes("...LAYOUT_LABELS.map"), false);
  assert.equal(view.includes("打开搜索面板"), false);
  assert.match(view, /label:\s*"显示目录树"/);
  assert.match(view, /label:\s*"刷新"/);
  assert.match(view, /shortcut:\s*getShortcutBinding\(state\.settings\.model\.shortcuts,\s*"refresh"\)/);
  assert.match(view, /label:\s*"显示项目"/);
  assert.match(view, />显示隐藏文件和文件夹</);
  assert.match(view, />显示系统文件和文件夹</);
  assert.match(view, />隐藏受系统保护的操作系统文件</);
  assert.match(view, /view-tree-separator/);
  assert.match(view, /view-refresh-separator/);
  assert.match(view, /view-items-separator/);
});

assertTest("Tab menu owns panel layout commands and synchronized scrolling", () => {
  const source = readWorkspaceMenuSource();
  const tab = menuBlock(source, "tab", "tools");

  assert.match(tab, /label:\s*"标签页面板"/);
  assert.match(tab, /LAYOUT_LABELS\.map/);
  assert.match(tab, /label:\s*"同步滚动"/);
  assert.match(tab, /checked:\s*state\.syncScroll/);
  assert.match(tab, /tab-panel-layout-separator/);
  assert.match(tab, /tab-sync-scroll-separator/);
});

assertTest("Menu dropdown styling reserves a right-aligned accelerator column", () => {
  const css = fs.readFileSync(path.join(process.cwd(), "src/features/workspace/workspace.shell.css"), "utf8");

  assert.match(css, /menu-dropdown__item[^{]*\{[^}]*grid-template-columns:\s*18px minmax\(0,\s*1fr\) auto;/s);
  assert.match(css, /\.menu-dropdown__shortcut\s*\{[^}]*justify-self:\s*end;/s);
  assert.match(css, /\.menu-dropdown__submenu-items\s*\{[^}]*width:\s*max-content;/s);
  assert.match(css, /\.menu-dropdown__submenu-items\s*\{[^}]*min-width:\s*240px;/s);
});
